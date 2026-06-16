import { TokenData } from "../auth/types";
import {
  AccountUsageBucket,
  AccountUsageSnapshot,
} from "../accounts/manager";
import { withTimeoutSignal } from "../utils/abort";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_USAGE_TIMEOUT_MS = 10_000;

type UsageRefreshResult = Omit<
  AccountUsageSnapshot,
  | "status"
  | "lastRefreshAt"
  | "lastWeeklyRefreshAt"
  | "nextRefreshAt"
  | "nextIdleRefreshAt"
  | "lastError"
>;

function toIsoFromUnixSeconds(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return new Date(value * 1000).toISOString();
}

function normalizeUsedPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value < 1 ? value * 100 : value)));
}

function buildRateLimitBucket(args: {
  id: string;
  label: string;
  window: string;
  raw: any;
}): AccountUsageBucket | null {
  if (!args.raw || typeof args.raw !== "object") return null;
  return {
    id: args.id,
    label: args.label,
    window: args.window,
    usedPercent: normalizeUsedPercent(args.raw.used_percent),
    resetsAt:
      typeof args.raw.reset_at === "string"
        ? args.raw.reset_at
        : toIsoFromUnixSeconds(args.raw.reset_at),
    valueLabel: null,
    detail: null,
  };
}

function buildCreditsBucket(raw: any): AccountUsageBucket | null {
  if (!raw || typeof raw !== "object" || raw.unlimited === true) return null;
  const balance =
    typeof raw.balance === "number" && Number.isFinite(raw.balance)
      ? raw.balance
      : null;
  return {
    id: "credits",
    label: "Credits",
    window: null,
    usedPercent: null,
    resetsAt: null,
    valueLabel:
      balance === null ? null : `$${(balance / 100).toFixed(2)} remaining`,
    detail: null,
  };
}

export async function fetchCodexUsage(
  token: TokenData,
): Promise<UsageRefreshResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token.accessToken}`,
  };
  if (token.accountUuid) {
    headers["ChatGPT-Account-ID"] = token.accountUuid;
  }

  let resp: Response;
  try {
    resp = await fetch(CODEX_USAGE_URL, {
      method: "GET",
      headers,
      signal: withTimeoutSignal(CODEX_USAGE_TIMEOUT_MS),
    });
  } catch (err: any) {
    throw new Error(
      `codex usage fetch failed: ${err?.message || String(err)}`,
    );
  }

  if (!resp.ok) {
    throw new Error(`codex usage api returned ${resp.status}`);
  }

  const body = await resp.json();
  const buckets: AccountUsageBucket[] = [];
  const primary = buildRateLimitBucket({
    id: "primary",
    label: "5h limit",
    window: "5h",
    raw: body?.rate_limit?.primary_window,
  });
  if (primary) buckets.push(primary);

  const weekly = buildRateLimitBucket({
    id: "weekly",
    label: "Weekly limit",
    window: "7d",
    raw: body?.rate_limit?.secondary_window,
  });
  if (weekly) buckets.push(weekly);

  const credits = buildCreditsBucket(body?.credits);
  if (credits) buckets.push(credits);

  return {
    source: "chatgpt_wham_usage",
    buckets,
  };
}
