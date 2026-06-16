import {
  ApiKeyTier,
  ProviderId,
  RoutingConfig,
  RoutingLevel,
  TokenData,
} from "../auth/types";
import { saveToken, loadAllTokens } from "../auth/token-storage";
import { getDeviceId } from "../utils/common";
import { RefreshTokenExhaustedError } from "../auth/refresh-errors";

// Reauth-required cooldown: long enough that the account doesn't keep
// hitting the upstream, but bounded so a re-login auto-recovers next sweep.
const REAUTH_COOLDOWN_MS = 24 * 60 * 60 * 1000;

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

export interface UsageData {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** Reasoning-model output tokens (codex Responses output_tokens_details.reasoning_tokens). */
  reasoningOutputTokens: number;
}

export interface AccountSelectionContext {
  sessionKey?: string;
  model?: string;
  path?: string;
  apiKeyTier?: ApiKeyTier;
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

interface SessionBinding {
  email: string;
  stickyUntil: number;
  lastSeenAt: string;
  model: string | null;
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
  routing: RoutingMetadata;
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
  | { account: AvailableAccount }
  | {
      account: null;
      failureKind: AccountFailureKind | null;
      retryAfterMs: number | null;
    };

const STICKY_MIN_MS = 20 * 60 * 1000; // 20 minutes
const STICKY_MAX_MS = 60 * 60 * 1000; // 60 minutes

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

export type RefreshFn = (refreshToken: string) => Promise<TokenData>;

export interface AccountManagerOptions {
  provider: ProviderId;
  refresh: RefreshFn;
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

export class AccountManager {
  private accounts: Map<string, AccountState> = new Map();
  private accountOrder: string[] = []; // emails in insertion order for round-robin
  private lastUsedIndex: number = -1;
  private stickyUntil: number = 0; // timestamp until which current account is sticky
  private authDir: string;
  private refreshTimer: NodeJS.Timeout | null = null;
  private statsTimer: NodeJS.Timeout | null = null;
  private refreshing = false;
  readonly provider: ProviderId;
  private refreshFn: RefreshFn;
  private refreshPolicy: RefreshPolicy;
  private reloadPromise: Promise<ReloadStats> | null = null;
  private routingMode: RoutingMode;
  private sessionBindings: Map<string, SessionBinding> = new Map();

  constructor(authDir: string, opts: AccountManagerOptions) {
    this.authDir = authDir;
    this.provider = opts.provider;
    this.refreshFn = opts.refresh;
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
    } else {
      const state = this.createAccountState(token);
      state.lastSuccessAt = new Date().toISOString();
      state.lastRefreshAt = new Date().toISOString();
      this.accounts.set(token.email, state);
      this.accountOrder.push(token.email);
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
      return { account: null, failureKind: null, retryAfterMs: null };
    }

    const now = Date.now();

    // Try to keep using the current sticky account
    if (this.lastUsedIndex >= 0 && now < this.stickyUntil) {
      const email = this.accountOrder[this.lastUsedIndex];
      const acct = this.accounts.get(email)!;
      if (
        acct.cooldownUntil <= now &&
        this.isAccountAllowedForTier(acct.token.routing?.level, ctx?.apiKeyTier)
      ) {
        return {
          account: buildAvailableAccount(
            this.authDir,
            email,
            acct.token,
            this.provider,
          ),
        };
      }
    }

    // Pick the next available account
    const startIdx = this.lastUsedIndex >= 0 ? this.lastUsedIndex + 1 : 0;
    for (let i = 0; i < count; i++) {
      const idx = (startIdx + i) % count;
      const email = this.accountOrder[idx];
      const acct = this.accounts.get(email)!;
      if (
        acct.cooldownUntil <= now &&
        this.isAccountAllowedForTier(acct.token.routing?.level, ctx?.apiKeyTier)
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
        };
      }
    }

    if (ctx?.apiKeyTier) {
      const tierEligible = this.accountOrder.filter((email) => {
        const acct = this.accounts.get(email)!;
        return this.isAccountAllowedForTier(acct.token.routing?.level, ctx.apiKeyTier);
      });
      if (tierEligible.length === 0) {
        return {
          account: null,
          failureKind: "forbidden",
          retryAfterMs: null,
        };
      }
      return this.buildCooldownUnavailable(tierEligible, now);
    }

    // All accounts in cooldown — find the most recoverable one
    return this.buildCooldownUnavailable(this.accountOrder, now);
  }

  private buildCooldownUnavailable(emails: string[], now: number): AccountResult {
    const firstAcct = this.accounts.get(emails[0])!;
    let bestKind: AccountFailureKind = firstAcct.lastFailureKind ?? "network";
    let bestRemainingMs = Math.max(0, firstAcct.cooldownUntil - now);
    for (const email of emails.slice(1)) {
      const acct = this.accounts.get(email)!;
      const kind = acct.lastFailureKind ?? "network";
      const remainingMs = Math.max(0, acct.cooldownUntil - now);
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
      return { account: null, failureKind: null, retryAfterMs: null };
    }

    const now = Date.now();
    this.reapExpiredSessionBindings(now);

    if (ctx?.sessionKey) {
      const binding = this.sessionBindings.get(ctx.sessionKey);
      if (binding && binding.stickyUntil > now) {
        const acct = this.accounts.get(binding.email);
        if (
          acct &&
          this.isStickyReusable(acct, now) &&
          this.isAccountAllowedForTier(acct.token.routing?.level, ctx?.apiKeyTier)
        ) {
          acct.routing.lastActiveAt = new Date(now).toISOString();
          this.maybeRefreshRoutingMetadata(acct, now, "activity");
          return {
            account: buildAvailableAccount(
              this.authDir,
              binding.email,
              acct.token,
              this.provider,
            ),
          };
        }
      }
    }

    const candidates = this.accountOrder
      .map((email, idx) => ({ email, idx, acct: this.accounts.get(email)! }))
      .filter(
        ({ acct }) =>
          acct.cooldownUntil <= now &&
          this.isAccountAllowedForTier(acct.token.routing?.level, ctx?.apiKeyTier),
      );
    if (candidates.length === 0) {
      const tierEligible = this.accountOrder.filter((email) => {
        const acct = this.accounts.get(email)!;
        return this.isAccountAllowedForTier(acct.token.routing?.level, ctx?.apiKeyTier);
      });
      if (ctx?.apiKeyTier && tierEligible.length === 0) {
        return {
          account: null,
          failureKind: "forbidden",
          retryAfterMs: null,
        };
      }
      return this.buildCooldownUnavailable(
        tierEligible.length > 0 ? tierEligible : this.accountOrder,
        now,
      );
    }

    let best = candidates[0];
    let bestScore = this.scoreCodexCandidate(best.acct, now);
    for (const candidate of candidates.slice(1)) {
      const score = this.scoreCodexCandidate(candidate.acct, now);
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
      this.sessionBindings.set(ctx.sessionKey, {
        email: best.email,
        stickyUntil: now + this.computeSessionStickyDuration(best.acct, now),
        lastSeenAt: new Date(now).toISOString(),
        model: ctx.model ?? null,
      });
    }

    return {
      account: buildAvailableAccount(
        this.authDir,
        best.email,
        best.acct.token,
        this.provider,
      ),
    };
  }

  recordAttempt(email: string): void {
    const acct = this.accounts.get(email);
    if (acct) {
      acct.totalRequests++;
      const now = Date.now();
      acct.routing.lastActiveAt = new Date(now).toISOString();
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

    const { baseMs, maxMs } = FAILURE_BACKOFF[kind];
    const cooldownMs = Math.min(
      baseMs * 2 ** Math.max(0, acct.failureCount - 1),
      maxMs,
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
    acct.routing.nextRefreshAt = now + this.metadataRefreshIntervalMs(acct, now);
  }

  getSnapshots(): AccountSnapshot[] {
    const now = Date.now();
    const snapshots: AccountSnapshot[] = [];
    for (const acct of this.accounts.values()) {
      snapshots.push({
        email: acct.token.email,
        available: acct.cooldownUntil <= now,
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
        routing:
          this.routingMode === "codex-smart"
            ? { ...acct.routing }
            : undefined,
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

  private logStats(): void {
    if (this.accounts.size === 0) return;
    console.log(
      `\n===== [${this.provider}] account stats (${new Date().toISOString()}) =====`,
    );
    for (const acct of this.accounts.values()) {
      const available = acct.cooldownUntil <= Date.now();
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

  get accountCount(): number {
    return this.accounts.size;
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
      const refreshed = await this.refreshFn(acct.token.refreshToken);
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
      console.log(
        `[${this.provider}] token refreshed for ${newToken.email}, expires ${newToken.expiresAt}`,
      );
      return true;
    } catch (err: any) {
      if (err instanceof RefreshTokenExhaustedError) {
        // Terminal — refresh token cannot be reused. Long cooldown + clear
        // operator-facing message; don't keep hammering the upstream.
        const message = `refresh token ${err.reason}; re-run \`auth2api --login --provider=${this.provider}\` to re-authorize`;
        acct.failureCount++;
        acct.totalFailures++;
        acct.lastFailureKind = "auth";
        acct.lastFailureAt = new Date().toISOString();
        acct.lastError = message;
        acct.cooldownUntil = Date.now() + REAUTH_COOLDOWN_MS;
        console.error(
          `[${this.provider}] account ${acct.token.email} needs re-auth: ${message}`,
        );
      } else {
        this.recordFailure(acct.token.email, "auth", err.message);
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
      routing: {
        resetAt: null,
        lastQuotaSyncAt: null,
        lastActiveAt: null,
        nextRefreshAt: 0,
        confidence: "unknown",
        windowType: inferWindowType(token.planType),
        resetPeriodMs: inferResetPeriodMs(token.planType),
      },
    };
  }

  private reapExpiredSessionBindings(now: number): void {
    for (const [key, binding] of this.sessionBindings) {
      if (binding.stickyUntil <= now) this.sessionBindings.delete(key);
    }
  }

  private isStickyReusable(acct: AccountState, now: number): boolean {
    if (acct.cooldownUntil > now) return false;
    if (acct.lastFailureKind === "auth" || acct.lastFailureKind === "forbidden")
      return false;
    return true;
  }

  private isAccountAllowedForTier(
    accountLevel: RoutingLevel | undefined,
    apiKeyTier: ApiKeyTier | undefined,
  ): boolean {
    if (!apiKeyTier) return true;
    const level = (accountLevel || "lite").toLowerCase() as RoutingLevel;
    switch (apiKeyTier) {
      case "admin":
        return true;
      case "pro":
        return level === "lite" || level === "pro";
      case "lite":
        return level === "lite";
      default:
        return false;
    }
  }

  private scoreCodexCandidate(acct: AccountState, now: number): number {
    const resetUrgency = this.computeResetUrgency(acct, now);
    const planBias = planTypeBias(acct.token.planType);
    const routingBias = acct.token.routing?.bias ?? 0;
    const healthPenalty = Math.min(acct.failureCount * 0.15, 0.6);
    return resetUrgency * 0.75 + planBias + routingBias - healthPenalty;
  }

  private computeResetUrgency(acct: AccountState, now: number): number {
    const { resetAt, resetPeriodMs } = acct.routing;
    if (!resetAt || !resetPeriodMs || resetPeriodMs <= 0) return 0;
    const remainingMs = new Date(resetAt).getTime() - now;
    const clamped = Math.max(0, Math.min(remainingMs, resetPeriodMs));
    return 1 - clamped / resetPeriodMs;
  }

  private computeSessionStickyDuration(acct: AccountState, now: number): number {
    const resetAtMs = acct.routing.resetAt
      ? new Date(acct.routing.resetAt).getTime()
      : null;
    if (resetAtMs) {
      const remainingMs = resetAtMs - now;
      if (remainingMs > 0 && remainingMs <= 60 * 60 * 1000) {
        return Math.max(
          3 * 60 * 1000,
          Math.min(15 * 60 * 1000, Math.floor(remainingMs / 4)),
        );
      }
    }
    return randomStickyDuration();
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
    acct.routing.nextRefreshAt = now + this.metadataRefreshIntervalMs(acct, now);
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

function inferResetPeriodMs(planType: string | undefined): number | null {
  switch ((planType || "").toLowerCase()) {
    case "plus":
    case "pro":
      return 5 * 60 * 60 * 1000;
    case "team":
      return 30 * 24 * 60 * 60 * 1000;
    default:
      return null;
  }
}

function inferWindowType(planType: string | undefined): string | null {
  switch ((planType || "").toLowerCase()) {
    case "plus":
      return "plus_5h";
    case "pro":
      return "pro_5h";
    case "team":
      return "team_monthly";
    default:
      return null;
  }
}

function planTypeBias(planType: string | undefined): number {
    switch ((planType || "").toLowerCase()) {
      case "plus":
        return 0.08;
      case "pro":
        return 0.05;
      case "team":
        return 0.03;
      case "free":
        return 1;
      default:
        return 0;
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
