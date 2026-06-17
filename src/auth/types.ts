export type ProviderId = "anthropic" | "codex" | "cursor";

export interface PKCECodes {
  codeVerifier: string;
  codeChallenge: string;
}

export interface TokenData {
  accessToken: string;
  refreshToken: string;
  email: string;
  expiresAt: string; // ISO 8601
  accountUuid: string; // anthropic: data.account.uuid; codex: chatgpt_account_id
  provider?: ProviderId; // missing on legacy files → treated as "anthropic"
  idToken?: string; // codex only
  /** ISO 8601 of last successful refresh (or initial token issuance). */
  lastRefreshAt?: string;
  /**
   * Optional routing preference used by codex smart routing. Higher values are
   * favored when selecting an account.
   */
  routing?: RoutingConfig;
  /** Codex only — raw chatgpt_plan_type claim from id_token (free/plus/pro/…). */
  planType?: string;
  /** 持久化的账号用量快照，供重启后继续参与路由。 */
  usage?: TokenUsageSnapshot;
  /** Cursor only — stable machine id read from Cursor's local storage. */
  cursorServiceMachineId?: string;
  /** Cursor only — client version accepted by Cursor's internal API. */
  cursorClientVersion?: string;
  /** Cursor only — config version header value. */
  cursorConfigVersion?: string;
  /** Cursor only — OAuth client id used for refresh. */
  cursorClientId?: string;
  /** Cursor only — membership tier from Cursor local storage. */
  cursorMembershipType?: string;
}

export type RoutingLevel = "lite" | "pro";

export interface RoutingConfig {
  bias?: number;
  level?: RoutingLevel;
}

/** 持久化到 token JSON 的单个用量窗口快照。 */
export interface TokenUsageBucket {
  id: string;
  label: string;
  window: string | null;
  usedPercent: number | null;
  resetsAt: string | null;
  valueLabel: string | null;
  detail: string | null;
}

/** 持久化到 token JSON 的账号用量快照。 */
export interface TokenUsageSnapshot {
  status: "never" | "success" | "failure";
  source: string | null;
  buckets: TokenUsageBucket[];
  lastRefreshAt: string | null;
  lastWeeklyRefreshAt: string | null;
  nextRefreshAt: string | null;
  nextIdleRefreshAt: string | null;
  lastError: string | null;
}

export interface TokenStorage {
  access_token: string;
  refresh_token: string;
  last_refresh: string;
  email: string;
  type: ProviderId | "claude"; // "claude" retained for legacy files
  expired: string; // ISO 8601
  account_uuid?: string;
  id_token?: string;
  plan_type?: string;
  routing?: RoutingConfig;
  usage?: TokenUsageSnapshot;
  cursor_service_machine_id?: string;
  cursor_client_version?: string;
  cursor_config_version?: string;
  cursor_client_id?: string;
  cursor_membership_type?: string;
}

export type ApiKeyTier = "lite" | "pro" | "admin";

export interface ApiKeyRecord {
  id: string;
  secret: string;
  tier: ApiKeyTier;
  name?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKeyFile {
  version: 1;
  keys: ApiKeyRecord[];
}
