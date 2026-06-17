import {
  ApiKeyTier,
  ProviderId,
  RoutingConfig,
  RoutingLevel,
  TokenData,
  TokenUsageSnapshot,
} from "../auth/types";
import { saveToken, loadAllTokens } from "../auth/token-storage";
import { getDeviceId } from "../utils/common";
import { RefreshTokenExhaustedError } from "../auth/refresh-errors";
import { StickySessionCache } from "../cache/sticky-session-cache";
import { recordAuthError } from "../observability/auth-errors";
import {
  buildRoutingPlan,
  computeResetUrgency,
  inferResetPeriodMs,
  inferWindowType,
  RoutingPlan,
} from "../routing/codex-smart-router";
import { isAccountAllowedForTier } from "../routing/account-router";

// Reauth-required cooldown: long enough that the account doesn't keep
// hitting the upstream, but bounded so a re-login auto-recovers next sweep.
const REAUTH_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** 代理账号网络失败时固定冷却 5 分钟，避免坏代理被连续重试。 */
const PROXY_NETWORK_COOLDOWN_MS = 5 * 60 * 1000;

const DEFAULT_REFRESH_LEAD_MS = 4 * 60 * 60 * 1000; // anthropic default
const REFRESH_CHECK_INTERVAL_MS = 60 * 1000; // check every 60s

/**
 * Per-provider refresh trigger. Anthropic tokens have a known TTL so the
 * "expires-lead" policy works (refresh N ms before expiresAt). Codex tokens
 * have a short access-token TTL but a long refresh-token idle window, so
 * the official codex CLI refreshes once every 8 days regardless of TTL —
 * `since-last-refresh` mirrors that behaviour.
 */
export type RefreshPolicy =
  | { kind: "expires-lead"; leadMs: number }
  | { kind: "since-last-refresh"; maxAgeMs: number };

const DEFAULT_REFRESH_POLICY: RefreshPolicy = {
  kind: "expires-lead",
  leadMs: DEFAULT_REFRESH_LEAD_MS,
};

export type AccountFailureKind =
  | "rate_limit"
  | "auth"
  | "forbidden"
  | "server"
  | "network";

const FAILURE_BACKOFF: Record<
  AccountFailureKind,
  { baseMs: number; maxMs: number }
> = {
  rate_limit: { baseMs: 60 * 1000, maxMs: 15 * 60 * 1000 },
  auth: { baseMs: 10 * 60 * 1000, maxMs: 60 * 60 * 1000 },
  forbidden: { baseMs: 10 * 60 * 1000, maxMs: 60 * 60 * 1000 },
  server: { baseMs: 5 * 1000, maxMs: 5 * 60 * 1000 },
  network: { baseMs: 5 * 1000, maxMs: 5 * 60 * 1000 },
};

/** 为单次失败计算冷却时长；代理网络故障优先走固定 5 分钟冷处理。 */
function resolveFailureCooldownMs(
  token: TokenData,
  kind: AccountFailureKind,
  failureCount: number,
): number {
  if (kind === "network" && token.routing?.proxy) {
    return PROXY_NETWORK_COOLDOWN_MS;
  }
  const { baseMs, maxMs } = FAILURE_BACKOFF[kind];
  return Math.min(baseMs * 2 ** Math.max(0, failureCount - 1), maxMs);
}

export interface UsageData {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** Reasoning-model output tokens (codex Responses output_tokens_details.reasoning_tokens). */
  reasoningOutputTokens: number;
}

export type AccountUsageRefreshStatus = "never" | "success" | "failure";

export interface AccountUsageBucket {
  id: string;
  label: string;
  window: string | null;
  usedPercent: number | null;
  resetsAt: string | null;
  valueLabel: string | null;
  detail: string | null;
}

export interface AccountUsageSnapshot {
  status: AccountUsageRefreshStatus;
  source: string | null;
  buckets: AccountUsageBucket[];
  lastRefreshAt: string | null;
  lastWeeklyRefreshAt: string | null;
  nextRefreshAt: string | null;
  nextIdleRefreshAt: string | null;
  lastError: string | null;
}

export interface AccountSelectionContext {
  sessionKey?: string;
  model?: string;
  path?: string;
  apiKeyTier?: ApiKeyTier;
}

export interface AccountRoutingDecision {
  mode: "default" | "codex-smart";
  reason: string;
  sessionCache: "hit" | "miss" | "none";
  candidateCount?: number;
  selectedLevel?: RoutingLevel;
}

export interface AccountDecisionCandidateDiagnostic {
  email: string;
  selected: boolean;
  available: boolean;
  allowedForTier: boolean;
  cooldownUntil: string | null;
  lastFailureKind: AccountFailureKind | null;
  lastError: string | null;
  routingLevel: RoutingLevel;
  planType?: string;
  baseScore?: number;
  resetUrgency?: number | null;
  finalScore?: number | null;
  sessionBinding: {
    requested: boolean;
    matched: boolean;
    reusable: boolean;
    expiresAt: string | null;
  };
  reasons: string[];
}

export interface AccountDecisionInspection {
  provider: ProviderId;
  mode: RoutingMode;
  now: string;
  context: {
    sessionKey: string | null;
    model: string | null;
    path: string | null;
    apiKeyTier: ApiKeyTier | null;
  };
  sticky: {
    lastUsedEmail: string | null;
    stickyUntil: string | null;
    active: boolean;
  };
  result: {
    selectedAccountEmail: string | null;
    failureKind: AccountFailureKind | null;
    retryAfterMs: number | null;
    decision?: AccountRoutingDecision;
  };
  accounts: AccountDecisionCandidateDiagnostic[];
}

type RoutingMode = "default" | "codex-smart";
type MetadataConfidence = "unknown" | "estimated" | "observed";

interface RoutingMetadata {
  resetAt: string | null;
  lastQuotaSyncAt: string | null;
  lastActiveAt: string | null;
  nextRefreshAt: number;
  confidence: MetadataConfidence;
  windowType: string | null;
  resetPeriodMs: number | null;
}

/** 账号当前可用性快照，统一封装 cooldown 与 quota 用尽两类不可用原因。 */
interface AccountAvailabilityState {
  available: boolean;
  unavailableUntil: number;
  failureKind: AccountFailureKind | null;
  reason: "cooldown" | "usage_exhausted" | null;
}

/**
 * Extract usage from a non-streamed JSON response. Handles both Anthropic
 * Messages shape (input_tokens / cache_creation_input_tokens / …) and OpenAI
 * Responses shape (input_tokens_details.cached_tokens / …).
 */
export function extractUsage(resp: any): UsageData {
  const u = resp?.usage ?? resp?.response?.usage;
  if (!u) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningOutputTokens: 0,
    };
  }
  return {
    inputTokens: u.input_tokens || 0,
    outputTokens: u.output_tokens || 0,
    // Anthropic-only field; OpenAI Responses has no equivalent.
    cacheCreationInputTokens: u.cache_creation_input_tokens || 0,
    // Anthropic: cache_read_input_tokens. OpenAI Responses: input_tokens_details.cached_tokens.
    cacheReadInputTokens:
      u.cache_read_input_tokens ?? u.input_tokens_details?.cached_tokens ?? 0,
    // OpenAI Responses only.
    reasoningOutputTokens: u.output_tokens_details?.reasoning_tokens || 0,
  };
}

interface AccountState {
  token: TokenData;
  cooldownUntil: number;
  failureCount: number;
  lastFailureKind: AccountFailureKind | null;
  lastError: string | null;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  lastRefreshAt: string | null;
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationInputTokens: number;
  totalCacheReadInputTokens: number;
  totalReasoningOutputTokens: number;
  refreshPromise: Promise<boolean> | null;
  usage: AccountUsageSnapshot;
  usageRefreshPromise: Promise<AccountUsageSnapshot> | null;
  usageActiveRefreshAt: number | null;
  usageIdleRefreshAt: number | null;
  routing: RoutingMetadata;
  routingPlan: RoutingPlan;
}

export interface AccountSnapshot {
  email: string;
  available: boolean;
  cooldownUntil: number;
  failureCount: number;
  lastError: string | null;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  lastRefreshAt: string | null;
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationInputTokens: number;
  totalCacheReadInputTokens: number;
  totalReasoningOutputTokens: number;
  expiresAt: string;
  refreshing: boolean;
  routingExtra?: RoutingConfig;
  /** Codex only — chatgpt_plan_type claim ("plus", "pro", "free", …). */
  planType?: string;
  usage?: AccountUsageSnapshot;
  routing?: RoutingMetadata;
}

export interface AvailableAccount {
  token: TokenData;
  deviceId: string;
  accountUuid: string;
  provider: ProviderId;
  chatgptAccountId?: string;
}

export type AccountResult =
  | { account: AvailableAccount; decision?: AccountRoutingDecision }
  | {
      account: null;
      failureKind: AccountFailureKind | null;
      retryAfterMs: number | null;
      decision?: AccountRoutingDecision;
    };

const STICKY_MIN_MS = 20 * 60 * 1000; // 20 minutes
const STICKY_MAX_MS = 60 * 60 * 1000; // 60 minutes
const STICKY_SESSION_TTL_MS = 4 * 60 * 60 * 1000;
const ROUTING_CACHE_MAX_ENTRIES = 2048;
const USAGE_ACTIVE_IDLE_REFRESH_MS = 10 * 60 * 1000;
const USAGE_IDLE_REFRESH_MS = 60 * 60 * 1000;
const USAGE_REFRESH_CHECK_INTERVAL_MS = 60 * 1000;

function randomStickyDuration(): number {
  return STICKY_MIN_MS + Math.random() * (STICKY_MAX_MS - STICKY_MIN_MS);
}

// Lower = more recoverable, preferred when all accounts are unavailable
const FAILURE_PRIORITY: Record<AccountFailureKind, number> = {
  rate_limit: 0,
  server: 1,
  network: 2,
  forbidden: 3,
  auth: 4,
};

export type RefreshFn = (token: TokenData) => Promise<TokenData>;
export type UsageRefreshFn = (
  token: TokenData,
) => Promise<
  Omit<
    AccountUsageSnapshot,
    | "status"
    | "lastRefreshAt"
    | "lastWeeklyRefreshAt"
    | "nextRefreshAt"
    | "nextIdleRefreshAt"
    | "lastError"
  >
>;

export interface AccountManagerOptions {
  provider: ProviderId;
  refresh: RefreshFn;
  usageRefresh?: UsageRefreshFn;
  /** Default: expires-lead 4h. Codex should pass since-last-refresh 8d. */
  refreshPolicy?: RefreshPolicy;
  routingMode?: RoutingMode;
}

export interface ReloadStats {
  /** Emails that were not in memory before reload — newly loaded from disk. */
  added: string[];
  /** Existing emails whose access token differed on disk and was replaced. */
  updated: string[];
  /** Existing emails identical to disk — no change. */
  unchanged: string[];
}

function buildAvailableAccount(
  authDir: string,
  email: string,
  token: TokenData,
  provider: ProviderId,
): AvailableAccount {
  return {
    token,
    deviceId: getDeviceId(authDir, email),
    accountUuid: token.accountUuid,
    provider,
    chatgptAccountId:
      provider === "codex" ? token.accountUuid || undefined : undefined,
  };
}

function emptyUsageSnapshot(): AccountUsageSnapshot {
  return {
    status: "never",
    source: null,
    buckets: [],
    lastRefreshAt: null,
    lastWeeklyRefreshAt: null,
    nextRefreshAt: null,
    nextIdleRefreshAt: null,
    lastError: null,
  };
}

/** 克隆用量快照，避免内存对象与持久化 token 共享引用。 */
function cloneUsageSnapshot(
  usage: TokenUsageSnapshot | AccountUsageSnapshot,
): AccountUsageSnapshot {
  return {
    ...usage,
    buckets: (usage.buckets || []).map((bucket) => ({ ...bucket })),
  };
}

export class AccountManager {
  private accounts: Map<string, AccountState> = new Map();
  private accountOrder: string[] = []; // emails in insertion order for round-robin
  private lastUsedIndex: number = -1;
  private stickyUntil: number = 0; // timestamp until which current account is sticky
  private authDir: string;
  private refreshTimer: NodeJS.Timeout | null = null;
  private statsTimer: NodeJS.Timeout | null = null;
  private usageTimer: NodeJS.Timeout | null = null;
  private refreshing = false;
  readonly provider: ProviderId;
  private refreshFn: RefreshFn;
  private usageRefreshFn?: UsageRefreshFn;
  private refreshPolicy: RefreshPolicy;
  private reloadPromise: Promise<ReloadStats> | null = null;
  private routingMode: RoutingMode;
  private sessionCache = new StickySessionCache({
    ttlMs: STICKY_SESSION_TTL_MS,
    maxEntries: ROUTING_CACHE_MAX_ENTRIES,
  });

  constructor(authDir: string, opts: AccountManagerOptions) {
    this.authDir = authDir;
    this.provider = opts.provider;
    this.refreshFn = opts.refresh;
    this.usageRefreshFn = opts.usageRefresh;
    this.refreshPolicy = opts.refreshPolicy ?? DEFAULT_REFRESH_POLICY;
    this.routingMode = opts.routingMode ?? "default";
  }

  load(): void {
    const tokens = loadAllTokens(this.authDir, this.provider);
    for (const token of tokens) {
      // Backfill provider in case storage layer missed it (defensive).
      if (!token.provider) token.provider = this.provider;
      this.accounts.set(token.email, this.createAccountState(token));
      this.accountOrder.push(token.email);
    }
    if (this.accounts.size > 0) {
      this.startUsageRefresher();
    }
    console.log(`[${this.provider}] loaded ${this.accounts.size} account(s)`);
  }

  /**
   * Re-read tokens from disk and reconcile with in-memory state. Used to pick
   * up new tokens written by `--login` while the server is running, fixing
   * the race where the server's pending refresh would otherwise consume a
   * just-rotated refresh token (codex `refresh_token_reused`).
   *
   * Semantics: upsert only.
   *   - new email on disk → added
   *   - existing email, accessToken changed → token replaced, cooldown +
   *     lastError cleared, stats preserved
   *   - existing email, accessToken identical → unchanged
   *   - existing in memory but absent on disk → kept (preserves stats; user
   *     must restart to drop)
   *
   * Concurrent calls share one in-flight promise. In-flight refreshes are
   * awaited first so a refresh's post-await `acct.token = newToken` cannot
   * clobber freshly reconciled state.
   */
  reload(): Promise<ReloadStats> {
    if (!this.reloadPromise) {
      this.reloadPromise = this.performReload().finally(() => {
        this.reloadPromise = null;
      });
    }
    return this.reloadPromise;
  }

  private async performReload(): Promise<ReloadStats> {
    // Wait for any in-flight refresh to finish before reconciling. Otherwise:
    //   t0  refresh in flight: acct.refreshPromise pending, awaiting refreshFn
    //   t1  reload reads disk, replaces acct.token = T_disk
    //   t2  refresh's await resolves with T_refresh, sets acct.token = T_refresh
    //       → reload's effect is silently overwritten
    const inFlight = Array.from(this.accounts.values())
      .map((a) => a.refreshPromise)
      .filter((p): p is Promise<boolean> => p !== null);
    if (inFlight.length) {
      await Promise.allSettled(inFlight);
    }

    const tokens = loadAllTokens(this.authDir, this.provider);
    const stats: ReloadStats = { added: [], updated: [], unchanged: [] };

    for (const token of tokens) {
      if (!token.provider) token.provider = this.provider;
      const existing = this.accounts.get(token.email);
      if (!existing) {
        this.accounts.set(token.email, this.createAccountState(token));
        this.accountOrder.push(token.email);
        this.startUsageRefresher();
        stats.added.push(token.email);
        continue;
      }
      // Compare BOTH accessToken and refreshToken: the precise race we're
      // fixing is about a rotated refresh token, and OAuth doesn't forbid the
      // server returning the same access_token + a new refresh_token (rare in
      // OpenAI's current behaviour but defensive coding here costs nothing).
      const tokenChanged =
        existing.token.accessToken !== token.accessToken ||
        existing.token.refreshToken !== token.refreshToken;
      if (!tokenChanged) {
        stats.unchanged.push(token.email);
        continue;
      }
      // Token rotated on disk — replace in place and clear failure state, but
      // preserve stats (operational continuity for the operator).
      existing.token = token;
      existing.cooldownUntil = 0;
      existing.failureCount = 0;
      existing.lastFailureKind = null;
      existing.lastError = null;
      existing.lastFailureAt = null;
      existing.routingPlan = buildRoutingPlan(token);
      existing.usage.lastError = null;
      stats.updated.push(token.email);
    }

    console.log(
      `[${this.provider}] reload: +${stats.added.length} added, ${stats.updated.length} updated, ${stats.unchanged.length} unchanged`,
    );
    return stats;
  }

  addAccount(token: TokenData): void {
    if (!token.provider) token.provider = this.provider;
    if (token.provider !== this.provider) {
      throw new Error(
        `addAccount: token.provider=${token.provider} does not match manager.provider=${this.provider}`,
      );
    }
    const existing = this.accounts.get(token.email);
    if (existing) {
      existing.token = token;
      existing.cooldownUntil = 0;
      existing.failureCount = 0;
      existing.lastFailureKind = null;
      existing.lastError = null;
      existing.lastFailureAt = null;
      existing.lastSuccessAt = new Date().toISOString();
      existing.lastRefreshAt = new Date().toISOString();
      existing.routingPlan = buildRoutingPlan(token);
      existing.usage.lastError = null;
    } else {
      const state = this.createAccountState(token);
      state.lastSuccessAt = new Date().toISOString();
      state.lastRefreshAt = new Date().toISOString();
      this.accounts.set(token.email, state);
      this.accountOrder.push(token.email);
      this.startUsageRefresher();
    }

    saveToken(this.authDir, token);
  }

  /**
   * Sticky account selection. Keeps using the same account for STICKY_DURATION_MS
   * before rotating to the next one. Rotates early only when the current account
   * enters cooldown (e.g. rate-limited).
   */
  getNextAccount(ctx?: AccountSelectionContext): AccountResult {
    if (this.routingMode === "codex-smart") {
      return this.getNextCodexAccount(ctx);
    }
    return this.getNextDefaultAccount(ctx);
  }

  private getNextDefaultAccount(ctx?: AccountSelectionContext): AccountResult {
    const count = this.accountOrder.length;
    if (count === 0) {
      return {
        account: null,
        failureKind: null,
        retryAfterMs: null,
        decision: {
          mode: "default",
          reason: "no_accounts",
          sessionCache: "none",
          candidateCount: 0,
        },
      };
    }

    const now = Date.now();

    if (count === 1 && !ctx?.apiKeyTier) {
      const email = this.accountOrder[0];
      const acct = this.accounts.get(email)!;
      const availability = this.getAccountAvailability(acct, now);
      if (availability.available) {
        this.lastUsedIndex = 0;
        this.stickyUntil = now + randomStickyDuration();
        return {
          account: buildAvailableAccount(
            this.authDir,
            email,
            acct.token,
            this.provider,
          ),
          decision: {
            mode: "default",
            reason: "single_available_account",
            sessionCache: "none",
            candidateCount: 1,
            selectedLevel: acct.routingPlan.level,
          },
        };
      }
      return this.buildCooldownUnavailable(this.accountOrder, now);
    }

    // Try to keep using the current sticky account
    if (this.lastUsedIndex >= 0 && now < this.stickyUntil) {
      const email = this.accountOrder[this.lastUsedIndex];
      const acct = this.accounts.get(email)!;
      const availability = this.getAccountAvailability(acct, now);
      if (
        availability.available &&
        this.isAccountAllowedForTier(acct.routingPlan.level, ctx?.apiKeyTier)
      ) {
        return {
          account: buildAvailableAccount(
            this.authDir,
            email,
            acct.token,
            this.provider,
          ),
          decision: {
            mode: "default",
            reason: "sticky_account",
            sessionCache: "none",
            candidateCount: count,
            selectedLevel: acct.routingPlan.level,
          },
        };
      }
    }

    // Pick the next available account
    const startIdx = this.lastUsedIndex >= 0 ? this.lastUsedIndex + 1 : 0;
    for (let i = 0; i < count; i++) {
      const idx = (startIdx + i) % count;
      const email = this.accountOrder[idx];
      const acct = this.accounts.get(email)!;
      const availability = this.getAccountAvailability(acct, now);
      if (
        availability.available &&
        this.isAccountAllowedForTier(acct.routingPlan.level, ctx?.apiKeyTier)
      ) {
        this.lastUsedIndex = idx;
        this.stickyUntil = now + randomStickyDuration();
        return {
          account: buildAvailableAccount(
            this.authDir,
            email,
            acct.token,
            this.provider,
          ),
          decision: {
            mode: "default",
            reason: "round_robin_available_account",
            sessionCache: "none",
            candidateCount: count,
            selectedLevel: acct.routingPlan.level,
          },
        };
      }
    }

    if (ctx?.apiKeyTier) {
      const tierEligible = this.accountOrder.filter((email) => {
        const acct = this.accounts.get(email)!;
        return this.isAccountAllowedForTier(
          acct.routingPlan.level,
          ctx.apiKeyTier,
        );
      });
      if (tierEligible.length === 0) {
        return {
          account: null,
          failureKind: "forbidden",
          retryAfterMs: null,
          decision: {
            mode: "default",
            reason: "tier_not_allowed",
            sessionCache: "none",
            candidateCount: 0,
          },
        };
      }
      return this.buildCooldownUnavailable(tierEligible, now);
    }

    // All accounts in cooldown — find the most recoverable one
    return this.buildCooldownUnavailable(this.accountOrder, now);
  }

  private buildCooldownUnavailable(
    emails: string[],
    now: number,
  ): AccountResult {
    const firstAcct = this.accounts.get(emails[0])!;
    const firstAvailability = this.getAccountAvailability(firstAcct, now);
    let bestKind: AccountFailureKind =
      firstAvailability.failureKind ??
      firstAcct.lastFailureKind ??
      "network";
    let bestRemainingMs = Math.max(
      0,
      firstAvailability.unavailableUntil - now,
    );
    for (const email of emails.slice(1)) {
      const acct = this.accounts.get(email)!;
      const availability = this.getAccountAvailability(acct, now);
      const kind =
        availability.failureKind ?? acct.lastFailureKind ?? "network";
      const remainingMs = Math.max(0, availability.unavailableUntil - now);
      if (
        FAILURE_PRIORITY[kind] < FAILURE_PRIORITY[bestKind] ||
        (FAILURE_PRIORITY[kind] === FAILURE_PRIORITY[bestKind] &&
          remainingMs < bestRemainingMs)
      ) {
        bestKind = kind;
        bestRemainingMs = remainingMs;
      }
    }

    const isRecoverable = bestKind !== "auth" && bestKind !== "forbidden";
    return {
      account: null,
      failureKind: bestKind,
      retryAfterMs: isRecoverable ? bestRemainingMs : null,
    };
  }

  private getNextCodexAccount(ctx?: AccountSelectionContext): AccountResult {
    const count = this.accountOrder.length;
    if (count === 0) {
      return {
        account: null,
        failureKind: null,
        retryAfterMs: null,
        decision: {
          mode: "codex-smart",
          reason: "no_accounts",
          sessionCache: "none",
          candidateCount: 0,
        },
      };
    }

    const now = Date.now();
    this.sessionCache.reapExpired(now);

    if (ctx?.sessionKey) {
      const binding = this.sessionCache.get(ctx.sessionKey, now);
      if (binding && binding.expiresAt > now) {
        const acct = this.accounts.get(binding.email);
        if (
          acct &&
          this.isStickyReusable(acct, now) &&
          this.isAccountAllowedForTier(acct.routingPlan.level, ctx?.apiKeyTier)
        ) {
          this.sessionCache.recordHit(ctx.sessionKey, binding, now);
          acct.routing.lastActiveAt = new Date(now).toISOString();
          this.maybeRefreshRoutingMetadata(acct, now, "activity");
          return {
            account: buildAvailableAccount(
              this.authDir,
              binding.email,
              acct.token,
              this.provider,
            ),
            decision: {
              mode: "codex-smart",
              reason: "session_binding",
              sessionCache: "hit",
              candidateCount: count,
              selectedLevel: acct.routingPlan.level,
            },
          };
        }
      }
      this.sessionCache.recordMiss();
    }

    const candidates = this.accountOrder
      .map((email, idx) => ({ email, idx, acct: this.accounts.get(email)! }))
      .filter(
        ({ acct }) => {
          const availability = this.getAccountAvailability(acct, now);
          return (
            availability.available &&
            this.isAccountAllowedForTier(acct.routingPlan.level, ctx?.apiKeyTier)
          );
        },
      );
    if (candidates.length === 0) {
      const tierEligible = this.accountOrder.filter((email) => {
        const acct = this.accounts.get(email)!;
        return this.isAccountAllowedForTier(
          acct.routingPlan.level,
          ctx?.apiKeyTier,
        );
      });
      if (ctx?.apiKeyTier && tierEligible.length === 0) {
        return {
          account: null,
          failureKind: "forbidden",
          retryAfterMs: null,
          decision: {
            mode: "codex-smart",
            reason: "tier_not_allowed",
            sessionCache: ctx?.sessionKey ? "miss" : "none",
            candidateCount: 0,
          },
        };
      }
      return this.buildCooldownUnavailable(
        tierEligible.length > 0 ? tierEligible : this.accountOrder,
        now,
      );
    }

    let best = candidates[0];
    let bestScore = this.scoreCodexAccount(best.acct, now);
    for (const candidate of candidates.slice(1)) {
      const score = this.scoreCodexAccount(candidate.acct, now);
      if (score > bestScore + 1e-9) {
        best = candidate;
        bestScore = score;
      }
    }

    this.lastUsedIndex = best.idx;
    this.stickyUntil = now + randomStickyDuration();
    best.acct.routing.lastActiveAt = new Date(now).toISOString();
    this.maybeRefreshRoutingMetadata(best.acct, now, "activity");

    if (ctx?.sessionKey) {
      this.sessionCache.set(
        ctx.sessionKey,
        { email: best.email, model: ctx.model ?? null },
        now,
      );
    }

    return {
      account: buildAvailableAccount(
        this.authDir,
        best.email,
        best.acct.token,
        this.provider,
      ),
      decision: {
        mode: "codex-smart",
        reason: "smart_score",
        sessionCache: ctx?.sessionKey ? "miss" : "none",
        candidateCount: candidates.length,
        selectedLevel: best.acct.routingPlan.level,
      },
    };
  }

  recordAttempt(email: string): void {
    const acct = this.accounts.get(email);
    if (acct) {
      acct.totalRequests++;
      const now = Date.now();
      acct.routing.lastActiveAt = new Date(now).toISOString();
      this.scheduleUsageRefresh(acct, now);
      this.maybeRefreshRoutingMetadata(acct, now, "activity");
    }
  }

  recordSuccess(email: string, usage?: UsageData): void {
    const acct = this.accounts.get(email);
    if (!acct) return;

    acct.cooldownUntil = 0;
    acct.failureCount = 0;
    acct.lastFailureKind = null;
    acct.lastError = null;
    acct.lastFailureAt = null;
    acct.lastSuccessAt = new Date().toISOString();
    acct.totalSuccesses++;
    this.maybeRefreshRoutingMetadata(acct, Date.now(), "success");

    if (usage) {
      acct.totalInputTokens += usage.inputTokens;
      acct.totalOutputTokens += usage.outputTokens;
      acct.totalCacheCreationInputTokens += usage.cacheCreationInputTokens;
      acct.totalCacheReadInputTokens += usage.cacheReadInputTokens;
      acct.totalReasoningOutputTokens += usage.reasoningOutputTokens;
    }
  }

  recordFailure(
    email: string,
    kind: AccountFailureKind,
    detail?: string,
  ): void {
    const acct = this.accounts.get(email);
    if (!acct) return;

    acct.failureCount++;
    acct.totalFailures++;
    acct.lastFailureKind = kind;
    acct.lastFailureAt = new Date().toISOString();
    acct.lastError = detail ? `${kind}: ${detail}` : kind;

    const cooldownMs = resolveFailureCooldownMs(
      acct.token,
      kind,
      acct.failureCount,
    );
    acct.cooldownUntil = Date.now() + cooldownMs;
    this.maybeRefreshRoutingMetadata(acct, Date.now(), "failure");
    console.log(
      `[${this.provider}] account ${email} cooled down for ${Math.round(
        cooldownMs / 1000,
      )}s (${kind})`,
    );
  }

  /**
   * Refresh an account's token. Concurrent callers share a single in-flight
   * promise — critical for providers (e.g. Codex) where refresh tokens rotate
   * and any second concurrent refresh would invalidate the first.
   */
  refreshAccount(email: string): Promise<boolean> {
    const acct = this.accounts.get(email);
    if (!acct) return Promise.resolve(false);
    // Assignment must be synchronous (before any await) so concurrent callers
    // see the in-flight promise.
    if (!acct.refreshPromise) {
      acct.refreshPromise = this.performRefresh(acct);
    }
    return acct.refreshPromise;
  }

  observeRetryAfter(email: string, retryAfterHeader: string | null): void {
    if (this.routingMode !== "codex-smart" || !retryAfterHeader) return;
    const acct = this.accounts.get(email);
    if (!acct) return;
    const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
    if (retryAfterMs == null) return;
    const now = Date.now();
    acct.routing.resetAt = new Date(now + retryAfterMs).toISOString();
    acct.routing.lastQuotaSyncAt = new Date(now).toISOString();
    acct.routing.confidence = "observed";
    acct.routing.windowType =
      acct.routing.windowType ?? inferWindowType(acct.token.planType);
    acct.routing.resetPeriodMs =
      acct.routing.resetPeriodMs ?? inferResetPeriodMs(acct.token.planType);
    acct.routing.nextRefreshAt =
      now + this.metadataRefreshIntervalMs(acct, now);
  }

  getSnapshots(): AccountSnapshot[] {
    const now = Date.now();
    const snapshots: AccountSnapshot[] = [];
    for (const acct of this.accounts.values()) {
      snapshots.push({
        email: acct.token.email,
        available: this.getAccountAvailability(acct, now).available,
        cooldownUntil: acct.cooldownUntil,
        failureCount: acct.failureCount,
        lastError: acct.lastError,
        lastFailureAt: acct.lastFailureAt,
        lastSuccessAt: acct.lastSuccessAt,
        lastRefreshAt: acct.lastRefreshAt,
        totalRequests: acct.totalRequests,
        totalSuccesses: acct.totalSuccesses,
        totalFailures: acct.totalFailures,
        totalInputTokens: acct.totalInputTokens,
        totalOutputTokens: acct.totalOutputTokens,
        totalCacheCreationInputTokens: acct.totalCacheCreationInputTokens,
        totalCacheReadInputTokens: acct.totalCacheReadInputTokens,
        totalReasoningOutputTokens: acct.totalReasoningOutputTokens,
        expiresAt: acct.token.expiresAt,
        refreshing: acct.refreshPromise !== null,
        routingExtra: acct.token.routing,
        planType: acct.token.planType,
        usage: {
          ...acct.usage,
          buckets: acct.usage.buckets.map((b) => ({ ...b })),
        },
        routing:
          this.routingMode === "codex-smart" ? { ...acct.routing } : undefined,
      });
    }
    return snapshots;
  }

  startAutoRefresh(): void {
    const timer = setInterval(
      () =>
        this.refreshAll().catch((err) =>
          console.error(
            `[${this.provider}] refresh cycle failed:`,
            err.message,
          ),
        ),
      REFRESH_CHECK_INTERVAL_MS,
    );
    timer.unref();
    this.refreshTimer = timer;
    this.refreshAll().catch((err) =>
      console.error(`[${this.provider}] initial refresh failed:`, err.message),
    );
  }

  stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  startStatsLogger(): void {
    const timer = setInterval(() => this.logStats(), 5 * 60 * 1000);
    timer.unref();
    this.statsTimer = timer;
  }

  stopStatsLogger(): void {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  startUsageRefresher(): void {
    if (!this.usageRefreshFn || this.usageTimer) return;
    const timer = setInterval(() => {
      this.refreshUsageDue().catch((err) =>
        console.error(
          `[${this.provider}] usage refresh cycle failed:`,
          err.message,
        ),
      );
    }, USAGE_REFRESH_CHECK_INTERVAL_MS);
    timer.unref();
    this.usageTimer = timer;
  }

  stopUsageRefresher(): void {
    if (this.usageTimer) {
      clearInterval(this.usageTimer);
      this.usageTimer = null;
    }
  }

  private logStats(): void {
    if (this.accounts.size === 0) return;
    console.log(
      `\n===== [${this.provider}] account stats (${new Date().toISOString()}) =====`,
    );
    for (const acct of this.accounts.values()) {
      const available = this.getAccountAvailability(acct, Date.now()).available;
      console.log(
        `  ${acct.token.email}: ` +
          `available=${available}, ` +
          `requests=${acct.totalRequests}, ` +
          `successes=${acct.totalSuccesses}, ` +
          `failures=${acct.totalFailures}, ` +
          `input_tokens=${acct.totalInputTokens}, ` +
          `output_tokens=${acct.totalOutputTokens}, ` +
          `cache_creation=${acct.totalCacheCreationInputTokens}, ` +
          `cache_read=${acct.totalCacheReadInputTokens}, ` +
          `reasoning=${acct.totalReasoningOutputTokens}, ` +
          `total_tokens=${acct.totalInputTokens + acct.totalOutputTokens + acct.totalCacheCreationInputTokens + acct.totalCacheReadInputTokens}`,
      );
    }
    console.log(`====================================================\n`);
  }

  async refreshUsage(
    email?: string,
  ): Promise<Record<string, AccountUsageSnapshot>> {
    const result: Record<string, AccountUsageSnapshot> = {};
    if (!this.usageRefreshFn) return result;
    const targets = email
      ? [this.accounts.get(email)].filter((acct): acct is AccountState => !!acct)
      : Array.from(this.accounts.values());
    for (const acct of targets) {
      result[acct.token.email] = await this.refreshAccountUsage(acct, true);
    }
    return result;
  }

  get accountCount(): number {
    return this.accounts.size;
  }

  getRoutingCacheStats(): {
    size: number;
    hits: number;
    misses: number;
    hitRate: number;
  } {
    return this.sessionCache.stats();
  }

  inspectNextAccount(ctx?: AccountSelectionContext): AccountDecisionInspection {
    return this.routingMode === "codex-smart"
      ? this.inspectCodexAccountSelection(ctx)
      : this.inspectDefaultAccountSelection(ctx);
  }

  private shouldRefresh(acct: AccountState, now: number): boolean {
    const policy = this.refreshPolicy;
    if (policy.kind === "expires-lead") {
      const expiresAt = new Date(acct.token.expiresAt).getTime();
      return expiresAt - now <= policy.leadMs;
    }
    // since-last-refresh: refresh when lastRefreshAt is older than maxAgeMs.
    // No timestamp known → treat as "fresh" (just loaded; give it time).
    if (!acct.lastRefreshAt) return false;
    const last = new Date(acct.lastRefreshAt).getTime();
    return now - last >= policy.maxAgeMs;
  }

  private inspectDefaultAccountSelection(
    ctx?: AccountSelectionContext,
  ): AccountDecisionInspection {
    const now = Date.now();
    const accounts = this.accountOrder.map((email) =>
      this.buildDiagnosticCandidate(email, now, ctx, false),
    );
    const base = this.buildInspectionBase(now, ctx, accounts);
    const count = this.accountOrder.length;
    if (count === 0) {
      base.result = {
        selectedAccountEmail: null,
        failureKind: null,
        retryAfterMs: null,
        decision: {
          mode: "default",
          reason: "no_accounts",
          sessionCache: "none",
          candidateCount: 0,
        },
      };
      return base;
    }

    if (count === 1 && !ctx?.apiKeyTier) {
      const only = accounts[0];
      if (only.available) {
        only.selected = true;
        only.reasons.push("selected:single_available_account");
        base.result = {
          selectedAccountEmail: only.email,
          failureKind: null,
          retryAfterMs: null,
          decision: {
            mode: "default",
            reason: "single_available_account",
            sessionCache: "none",
            candidateCount: 1,
            selectedLevel: only.routingLevel,
          },
        };
        return base;
      }
      only.reasons.push(this.buildUnavailableReason(only.email, now));
      return this.attachCooldownResult(base, accounts, now, "default", "none");
    }

    const stickyEmail =
      this.lastUsedIndex >= 0 ? this.accountOrder[this.lastUsedIndex] : null;
    const sticky = stickyEmail
      ? accounts.find((item) => item.email === stickyEmail) || null
      : null;
    if (sticky && now < this.stickyUntil) {
      if (sticky.available && sticky.allowedForTier) {
        sticky.selected = true;
        sticky.reasons.push("selected:sticky_account");
        base.result = {
          selectedAccountEmail: sticky.email,
          failureKind: null,
          retryAfterMs: null,
          decision: {
            mode: "default",
            reason: "sticky_account",
            sessionCache: "none",
            candidateCount: count,
            selectedLevel: sticky.routingLevel,
          },
        };
        return base;
      }
      sticky.reasons.push(
        sticky.available
          ? "rejected:tier_not_allowed"
          : this.buildUnavailableReason(sticky.email, now),
      );
    }

    const startIdx = this.lastUsedIndex >= 0 ? this.lastUsedIndex + 1 : 0;
    for (let i = 0; i < count; i++) {
      const idx = (startIdx + i) % count;
      const candidate = accounts[idx];
      if (candidate.available && candidate.allowedForTier) {
        candidate.selected = true;
        candidate.reasons.push("selected:round_robin_available_account");
        base.result = {
          selectedAccountEmail: candidate.email,
          failureKind: null,
          retryAfterMs: null,
          decision: {
            mode: "default",
            reason: "round_robin_available_account",
            sessionCache: "none",
            candidateCount: count,
            selectedLevel: candidate.routingLevel,
          },
        };
        return base;
      }
      candidate.reasons.push(
        candidate.allowedForTier
          ? "rejected:cooldown_active"
          : "rejected:tier_not_allowed",
      );
    }

    if (ctx?.apiKeyTier) {
      const tierEligible = accounts.filter((item) => item.allowedForTier);
      if (tierEligible.length === 0) {
        base.result = {
          selectedAccountEmail: null,
          failureKind: "forbidden",
          retryAfterMs: null,
          decision: {
            mode: "default",
            reason: "tier_not_allowed",
            sessionCache: "none",
            candidateCount: 0,
          },
        };
        return base;
      }
    }

    return this.attachCooldownResult(base, accounts, now, "default", "none");
  }

  private inspectCodexAccountSelection(
    ctx?: AccountSelectionContext,
  ): AccountDecisionInspection {
    const now = Date.now();
    const accounts = this.accountOrder.map((email) =>
      this.buildDiagnosticCandidate(email, now, ctx, true),
    );
    const base = this.buildInspectionBase(now, ctx, accounts);
    const count = this.accountOrder.length;
    if (count === 0) {
      base.result = {
        selectedAccountEmail: null,
        failureKind: null,
        retryAfterMs: null,
        decision: {
          mode: "codex-smart",
          reason: "no_accounts",
          sessionCache: "none",
          candidateCount: 0,
        },
      };
      return base;
    }

    let sessionCache: "hit" | "miss" | "none" = "none";
    if (ctx?.sessionKey) {
      const binding = this.sessionCache.get(ctx.sessionKey, now);
      if (binding && binding.expiresAt > now) {
        const bound = accounts.find((item) => item.email === binding.email) || null;
        if (bound) {
          bound.sessionBinding.matched = true;
          bound.sessionBinding.expiresAt = new Date(binding.expiresAt).toISOString();
          bound.sessionBinding.reusable =
            bound.available &&
            bound.allowedForTier &&
            !(
              bound.lastFailureKind === "auth" ||
              bound.lastFailureKind === "forbidden"
            );
          if (bound.sessionBinding.reusable) {
            sessionCache = "hit";
            bound.selected = true;
            bound.reasons.push("selected:session_binding");
            base.result = {
              selectedAccountEmail: bound.email,
              failureKind: null,
              retryAfterMs: null,
              decision: {
                mode: "codex-smart",
                reason: "session_binding",
                sessionCache,
                candidateCount: count,
                selectedLevel: bound.routingLevel,
              },
            };
            return base;
          }
          bound.reasons.push("rejected:session_binding_not_reusable");
        }
      }
      sessionCache = "miss";
    }

    const candidates = accounts.filter(
      (item) => item.available && item.allowedForTier,
    );
    if (candidates.length === 0) {
      if (ctx?.apiKeyTier && accounts.every((item) => !item.allowedForTier)) {
        base.result = {
          selectedAccountEmail: null,
          failureKind: "forbidden",
          retryAfterMs: null,
          decision: {
            mode: "codex-smart",
            reason: "tier_not_allowed",
            sessionCache,
            candidateCount: 0,
          },
        };
        return base;
      }
      return this.attachCooldownResult(
        base,
        accounts,
        now,
        "codex-smart",
        sessionCache,
      );
    }

    let best = candidates[0];
    let bestScore = best.finalScore ?? Number.NEGATIVE_INFINITY;
    for (const candidate of candidates.slice(1)) {
      const score = candidate.finalScore ?? Number.NEGATIVE_INFINITY;
      if (score > bestScore + 1e-9) {
        best = candidate;
        bestScore = score;
      }
    }

    best.selected = true;
    best.reasons.push("selected:smart_score");
    base.result = {
      selectedAccountEmail: best.email,
      failureKind: null,
      retryAfterMs: null,
      decision: {
        mode: "codex-smart",
        reason: "smart_score",
        sessionCache,
        candidateCount: candidates.length,
        selectedLevel: best.routingLevel,
      },
    };
    for (const account of accounts) {
      if (account.selected) continue;
      if (!account.allowedForTier) {
        account.reasons.push("rejected:tier_not_allowed");
      } else if (!account.available) {
        account.reasons.push("rejected:cooldown_active");
      } else {
        account.reasons.push("rejected:lower_smart_score");
      }
    }
    return base;
  }

  private buildInspectionBase(
    now: number,
    ctx: AccountSelectionContext | undefined,
    accounts: AccountDecisionCandidateDiagnostic[],
  ): AccountDecisionInspection {
    const stickyEmail =
      this.lastUsedIndex >= 0 ? this.accountOrder[this.lastUsedIndex] || null : null;
    return {
      provider: this.provider,
      mode: this.routingMode,
      now: new Date(now).toISOString(),
      context: {
        sessionKey: ctx?.sessionKey || null,
        model: ctx?.model || null,
        path: ctx?.path || null,
        apiKeyTier: ctx?.apiKeyTier || null,
      },
      sticky: {
        lastUsedEmail: stickyEmail,
        stickyUntil: this.stickyUntil > 0 ? new Date(this.stickyUntil).toISOString() : null,
        active: this.lastUsedIndex >= 0 && now < this.stickyUntil,
      },
      result: {
        selectedAccountEmail: null,
        failureKind: null,
        retryAfterMs: null,
      },
      accounts,
    };
  }

  private attachCooldownResult(
    inspection: AccountDecisionInspection,
    accounts: AccountDecisionCandidateDiagnostic[],
    now: number,
    mode: RoutingMode,
    sessionCache: "hit" | "miss" | "none",
  ): AccountDecisionInspection {
    const emails = accounts
      .filter((item) => item.allowedForTier)
      .map((item) => item.email);
    const unavailable = this.buildCooldownUnavailable(
      emails.length > 0 ? emails : this.accountOrder,
      now,
    );
    if (unavailable.account) {
      throw new Error("internal error: cooldown result unexpectedly selected an account");
    }
    inspection.result = {
      selectedAccountEmail: null,
      failureKind: unavailable.failureKind,
      retryAfterMs: unavailable.retryAfterMs,
      decision: unavailable.decision ?? {
        mode,
        reason: "all_candidates_unavailable",
        sessionCache,
      },
    };
    for (const account of accounts) {
      if (!account.allowedForTier) {
        account.reasons.push("rejected:tier_not_allowed");
      } else if (!account.available) {
        account.reasons.push(this.buildUnavailableReason(account.email, now));
      }
    }
    return inspection;
  }

  private buildDiagnosticCandidate(
    email: string,
    now: number,
    ctx: AccountSelectionContext | undefined,
    includeScore: boolean,
  ): AccountDecisionCandidateDiagnostic {
    const acct = this.accounts.get(email)!;
    const availability = this.getAccountAvailability(acct, now);
    const allowedForTier = this.isAccountAllowedForTier(
      acct.routingPlan.level,
      ctx?.apiKeyTier,
    );
    const available = availability.available;
    const scoringRouting = includeScore
      ? this.resolveScoringRoutingMetadata(acct, now)
      : null;
    const resetUrgency = includeScore
      ? computeResetUrgency(scoringRouting, now)
      : null;
    const finalScore = includeScore ? this.scoreCodexAccount(acct, now) : null;
    return {
      email,
      selected: false,
      available,
      allowedForTier,
      cooldownUntil:
        availability.unavailableUntil > now
          ? new Date(availability.unavailableUntil).toISOString()
          : null,
      lastFailureKind: acct.lastFailureKind,
      lastError: acct.lastError,
      routingLevel: acct.routingPlan.level,
      planType: acct.token.planType,
      baseScore: includeScore ? acct.routingPlan.baseScore : undefined,
      resetUrgency,
      finalScore,
      sessionBinding: {
        requested: !!ctx?.sessionKey,
        matched: false,
        reusable: false,
        expiresAt: null,
      },
      reasons: [],
    };
  }

  /**
   * 为打分构造“可用的”重置元数据。
   *
   * 说明：
   * - 运行中已有 `routing.resetAt` 时，直接沿用；
   * - 没有 `routing.resetAt` 但已经刷新到 usage 时，优先使用主窗口的 `resetsAt`；
   * - 这样 team / plus / pro 账号在首次进入决策时也能拿到非零的重置紧迫度。
   */
  private resolveScoringRoutingMetadata(
    acct: AccountState,
    now: number,
  ): { resetAt: string | null; resetPeriodMs: number | null } {
    const resetPeriodMs =
      acct.routing.resetPeriodMs ?? inferResetPeriodMs(acct.token.planType);
    const usageResetAt = this.resolveUsageResetAt(acct);
    if (acct.routing.resetAt || !usageResetAt) {
      return {
        resetAt: acct.routing.resetAt,
        resetPeriodMs,
      };
    }
    if (resetPeriodMs) {
      const usageResetAtMs = new Date(usageResetAt).getTime();
      if (Number.isFinite(usageResetAtMs) && usageResetAtMs > now) {
        return {
          resetAt: usageResetAt,
          resetPeriodMs,
        };
      }
    }
    return {
      resetAt: acct.routing.resetAt,
      resetPeriodMs,
    };
  }

  /**
   * 从 usage 快照中挑出最有代表性的重置时间，优先主窗口，其次任意
   * 仍在未来的窗口。
   */
  private resolveUsageResetAt(acct: AccountState): string | null {
    const now = Date.now();
    const primaryBucket = acct.usage.buckets.find((bucket) => {
      if (bucket.id !== "primary" || !bucket.resetsAt) return false;
      const resetAtMs = new Date(bucket.resetsAt).getTime();
      return Number.isFinite(resetAtMs) && resetAtMs > now;
    });
    if (primaryBucket?.resetsAt) {
      return primaryBucket.resetsAt;
    }
    const futureBucket = acct.usage.buckets.find((bucket) => {
      if (!bucket.resetsAt) return false;
      const resetAtMs = new Date(bucket.resetsAt).getTime();
      return Number.isFinite(resetAtMs) && resetAtMs > now;
    });
    return futureBucket?.resetsAt ?? null;
  }

  /** 统一 Codex 账号的实际选取与诊断打分，避免两个路径出现分歧。 */
  private scoreCodexAccount(acct: AccountState, now: number): number {
    const routing = this.resolveScoringRoutingMetadata(acct, now);
    const resetUrgency = computeResetUrgency(routing, now);
    const healthPenalty = Math.min(acct.failureCount * 0.15, 0.6);
    return resetUrgency * 0.75 + acct.routingPlan.baseScore - healthPenalty;
  }

  private scheduleUsageRefresh(acct: AccountState, now: number): void {
    if (!this.usageRefreshFn) return;
    acct.usageActiveRefreshAt = now + USAGE_ACTIVE_IDLE_REFRESH_MS;
    acct.usageIdleRefreshAt = now + USAGE_IDLE_REFRESH_MS;
    acct.usage.nextRefreshAt = new Date(acct.usageActiveRefreshAt).toISOString();
    acct.usage.nextIdleRefreshAt = new Date(
      acct.usageIdleRefreshAt,
    ).toISOString();
  }

  private async refreshUsageDue(): Promise<void> {
    if (!this.usageRefreshFn) return;
    const now = Date.now();
    for (const acct of this.accounts.values()) {
      const dueAt =
        acct.usageActiveRefreshAt !== null
          ? acct.usageActiveRefreshAt
          : acct.usageIdleRefreshAt;
      if (dueAt !== null && now >= dueAt) {
        await this.refreshAccountUsage(acct, false);
      }
    }
  }

  private async refreshAccountUsage(
    acct: AccountState,
    force: boolean,
  ): Promise<AccountUsageSnapshot> {
    if (!this.usageRefreshFn) {
      return {
        ...acct.usage,
        buckets: acct.usage.buckets.map((bucket) => ({ ...bucket })),
      };
    }
    if (!force && acct.usageRefreshPromise) return acct.usageRefreshPromise;
    if (force && acct.usageRefreshPromise) {
      await acct.usageRefreshPromise.catch(() => null);
    }
    if (!force && acct.usageRefreshPromise) return acct.usageRefreshPromise;

    const run = (async () => {
      const refreshedAt = new Date().toISOString();
      try {
        const next = await this.usageRefreshFn!(acct.token);
        const weeklyBucket = next.buckets.find((bucket) =>
          /week/i.test(bucket.id) || /week/i.test(bucket.label),
        );
        acct.usage = {
          ...next,
          status: "success",
          lastRefreshAt: refreshedAt,
          lastWeeklyRefreshAt: weeklyBucket
            ? refreshedAt
            : acct.usage.lastWeeklyRefreshAt,
          nextRefreshAt: null,
          nextIdleRefreshAt: null,
          lastError: null,
        };
        this.persistAccountUsage(acct);
      } catch (err: any) {
        acct.usage = {
          ...acct.usage,
          status: "failure",
          lastError: err?.message || String(err),
          lastRefreshAt: refreshedAt,
        };
        this.persistAccountUsage(acct);
      } finally {
        const now = Date.now();
        acct.usageRefreshPromise = null;
        acct.usageActiveRefreshAt = null;
        acct.usageIdleRefreshAt = now + USAGE_IDLE_REFRESH_MS;
        acct.usage.nextRefreshAt = null;
        acct.usage.nextIdleRefreshAt = new Date(
          acct.usageIdleRefreshAt,
        ).toISOString();
      }
      return {
        ...acct.usage,
        buckets: acct.usage.buckets.map((b) => ({ ...b })),
      };
    })();
    acct.usageRefreshPromise = run;
    return run;
  }

  /** 将最新用量快照写回 token JSON，保证重启后仍能参与路由。 */
  private persistAccountUsage(acct: AccountState): void {
    acct.token.usage = cloneUsageSnapshot(acct.usage);
    saveToken(this.authDir, acct.token);
  }

  private async refreshAll(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const now = Date.now();
      for (const acct of this.accounts.values()) {
        if (this.shouldRefresh(acct, now)) {
          await this.refreshAccount(acct.token.email);
        }
      }
    } finally {
      this.refreshing = false;
    }
  }

  private async performRefresh(acct: AccountState): Promise<boolean> {
    try {
      console.log(
        `[${this.provider}] refreshing token for ${acct.token.email}…`,
      );
      const refreshed = await this.refreshFn(acct.token);
      const refreshAt = new Date().toISOString();
      // Compose the new token preserving fields the provider may not return.
      const newToken: TokenData = {
        ...acct.token,
        ...refreshed,
        email: refreshed.email || acct.token.email,
        provider: this.provider,
        // Some providers omit accountUuid on refresh — keep the original.
        accountUuid: refreshed.accountUuid || acct.token.accountUuid,
        lastRefreshAt: refreshAt,
      };
      // Persist BEFORE mutating in-memory state or releasing the lock — if the
      // disk write fails we want the old token to remain in-memory so the next
      // attempt can retry from a known state.
      saveToken(this.authDir, newToken);
      acct.token = newToken;
      acct.cooldownUntil = 0;
      acct.failureCount = 0;
      acct.lastFailureKind = null;
      acct.lastError = null;
      acct.lastFailureAt = null;
      acct.lastSuccessAt = refreshAt;
      acct.lastRefreshAt = refreshAt;
      acct.routingPlan = buildRoutingPlan(newToken);
      console.log(
        `[${this.provider}] token refreshed for ${newToken.email}, expires ${newToken.expiresAt}`,
      );
      return true;
    } catch (err: any) {
      if (err instanceof RefreshTokenExhaustedError) {
        // Terminal — refresh token cannot be reused. Long cooldown + clear
        // operator-facing message; don't keep hammering the upstream.
        const message = `refresh token ${err.reason}; re-run \`auth2api --login --provider=${this.provider}\` to re-authorize`;
        const cooldownUntil = new Date(
          Date.now() + REAUTH_COOLDOWN_MS,
        ).toISOString();
        acct.failureCount++;
        acct.totalFailures++;
        acct.lastFailureKind = "auth";
        acct.lastFailureAt = new Date().toISOString();
        acct.lastError = message;
        acct.cooldownUntil = new Date(cooldownUntil).getTime();
        /** 认证错误单独落盘，便于分析 team 账号、多实例与 token 轮换问题。 */
        recordAuthError(this.authDir, {
          provider: this.provider,
          email: acct.token.email,
          accountUuid: acct.token.accountUuid || null,
          planType: acct.token.planType || null,
          terminal: true,
          action: "reauthorize",
          kind: "refresh_token_exhausted",
          reason: err.reason,
          httpStatus: err.httpStatus,
          message,
          detail: err.message,
          refreshToken: acct.token.refreshToken,
          accessToken: acct.token.accessToken,
          lastRefreshAt: acct.lastRefreshAt,
          cooldownUntil,
        });
        console.error(
          `[${this.provider}] account ${acct.token.email} needs re-auth: ${message}`,
        );
      } else {
        this.recordFailure(acct.token.email, "auth", err.message);
        /** 普通 refresh 失败同样保留现场，方便区分网络抖动和服务端作废。 */
        recordAuthError(this.authDir, {
          provider: this.provider,
          email: acct.token.email,
          accountUuid: acct.token.accountUuid || null,
          planType: acct.token.planType || null,
          terminal: false,
          action: "retry",
          kind: "refresh_failed",
          message: err?.message || String(err),
          detail: err?.stack || null,
          refreshToken: acct.token.refreshToken,
          accessToken: acct.token.accessToken,
          lastRefreshAt: acct.lastRefreshAt,
          cooldownUntil:
            acct.cooldownUntil > 0
              ? new Date(acct.cooldownUntil).toISOString()
              : null,
        });
        console.error(
          `[${this.provider}] token refresh failed for ${acct.token.email}: ${err.message}`,
        );
      }
      return false;
    } finally {
      // Release the lock LAST so concurrent waiters always observe a completed
      // refresh (success: new token persisted; failure: cooldown set).
      acct.refreshPromise = null;
    }
  }

  private createAccountState(token: TokenData): AccountState {
    return {
      token,
      cooldownUntil: 0,
      failureCount: 0,
      lastFailureKind: null,
      lastError: null,
      lastFailureAt: null,
      lastSuccessAt: null,
      // Seed from the persisted last_refresh so refresh policies that depend
      // on the timestamp (e.g. codex's since-last-refresh) work after a restart.
      lastRefreshAt: token.lastRefreshAt ?? null,
      totalRequests: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationInputTokens: 0,
      totalCacheReadInputTokens: 0,
      totalReasoningOutputTokens: 0,
      refreshPromise: null,
      usage: token.usage ? cloneUsageSnapshot(token.usage) : emptyUsageSnapshot(),
      usageRefreshPromise: null,
      usageActiveRefreshAt: null,
      usageIdleRefreshAt: null,
      routing: {
        resetAt: null,
        lastQuotaSyncAt: null,
        lastActiveAt: null,
        nextRefreshAt: 0,
        confidence: "unknown",
        windowType: inferWindowType(token.planType),
        resetPeriodMs: inferResetPeriodMs(token.planType),
      },
      routingPlan: buildRoutingPlan(token),
    };
  }

  /** 解析限流桶是否已耗尽，任意桶耗尽都视为不可用，直到所有已耗尽桶都恢复。 */
  private getUsageExhaustedUntil(acct: AccountState, now: number): number | null {
    let exhaustedUntil: number | null = null;
    for (const bucket of acct.usage.buckets) {
      if (bucket.usedPercent === null || bucket.usedPercent < 100) continue;
      if (!bucket.resetsAt) continue;
      const resetsAtMs = new Date(bucket.resetsAt).getTime();
      if (!Number.isFinite(resetsAtMs) || resetsAtMs <= now) continue;
      exhaustedUntil =
        exhaustedUntil === null
          ? resetsAtMs
          : Math.max(exhaustedUntil, resetsAtMs);
    }
    return exhaustedUntil;
  }

  /**
   * 统一账号可用性判断。
   * 复杂逻辑说明：
   * 1. cooldown 优先，保留既有失败退避行为；
   * 2. 当任意限流桶已达 100% 且 resetsAt 仍在未来时，直接视为不可用；
   * 3. 管理接口与真实路由共用这一判断，避免展示和选路不一致。
   */
  private getAccountAvailability(
    acct: AccountState,
    now: number,
  ): AccountAvailabilityState {
    if (acct.cooldownUntil > now) {
      return {
        available: false,
        unavailableUntil: acct.cooldownUntil,
        failureKind: acct.lastFailureKind ?? "network",
        reason: "cooldown",
      };
    }

    const usageExhaustedUntil = this.getUsageExhaustedUntil(acct, now);
    if (usageExhaustedUntil !== null) {
      return {
        available: false,
        unavailableUntil: usageExhaustedUntil,
        failureKind: "rate_limit",
        reason: "usage_exhausted",
      };
    }

    return {
      available: true,
      unavailableUntil: 0,
      failureKind: null,
      reason: null,
    };
  }

  /** 为管理接口生成更精确的不可用原因，避免将 quota 用尽误报为 cooldown。 */
  private buildUnavailableReason(email: string, now: number): string {
    const acct = this.accounts.get(email)!;
    const availability = this.getAccountAvailability(acct, now);
    return availability.reason === "usage_exhausted"
      ? "rejected:usage_exhausted"
      : "rejected:cooldown_active";
  }

  private isStickyReusable(acct: AccountState, now: number): boolean {
    if (!this.getAccountAvailability(acct, now).available) return false;
    if (acct.lastFailureKind === "auth" || acct.lastFailureKind === "forbidden")
      return false;
    return true;
  }

  private isAccountAllowedForTier(
    accountLevel: RoutingLevel | undefined,
    apiKeyTier: ApiKeyTier | undefined,
  ): boolean {
    return isAccountAllowedForTier(accountLevel, apiKeyTier);
  }

  private maybeRefreshRoutingMetadata(
    acct: AccountState,
    now: number,
    trigger: "activity" | "success" | "failure",
  ): void {
    if (this.routingMode !== "codex-smart") return;
    if (trigger === "failure" && acct.lastFailureKind === "rate_limit") return;
    if (now < acct.routing.nextRefreshAt) return;

    acct.routing.windowType =
      acct.routing.windowType ?? inferWindowType(acct.token.planType);
    acct.routing.resetPeriodMs =
      acct.routing.resetPeriodMs ?? inferResetPeriodMs(acct.token.planType);
    if (!acct.routing.resetPeriodMs) {
      acct.routing.lastQuotaSyncAt = new Date(now).toISOString();
      acct.routing.nextRefreshAt = now + 10 * 60 * 1000;
      return;
    }

    if (!acct.routing.resetAt) {
      acct.routing.resetAt = new Date(
        now + acct.routing.resetPeriodMs,
      ).toISOString();
      acct.routing.confidence = "estimated";
    } else {
      let resetAtMs = new Date(acct.routing.resetAt).getTime();
      while (resetAtMs <= now) resetAtMs += acct.routing.resetPeriodMs;
      acct.routing.resetAt = new Date(resetAtMs).toISOString();
    }
    acct.routing.lastQuotaSyncAt = new Date(now).toISOString();
    acct.routing.nextRefreshAt =
      now + this.metadataRefreshIntervalMs(acct, now);
  }

  private metadataRefreshIntervalMs(acct: AccountState, now: number): number {
    const resetAtMs = acct.routing.resetAt
      ? new Date(acct.routing.resetAt).getTime()
      : null;
    if (resetAtMs && resetAtMs - now <= 60 * 60 * 1000) {
      return 5 * 60 * 1000;
    }
    return 10 * 60 * 1000;
  }
}

function parseRetryAfterMs(header: string): number | null {
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.floor(seconds * 1000);
  }
  const when = new Date(header).getTime();
  if (Number.isFinite(when)) {
    return Math.max(0, when - Date.now());
  }
  return null;
}
