import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { ProviderId } from "../auth/types";

/** 认证错误日志事件版本，便于后续演进字段结构。 */
export const AUTH_ERROR_EVENT_VERSION = 1;

/** 单条认证错误事件，落盘到 auth-errors JSONL。 */
export interface AuthErrorEvent {
  v: 1;
  ts: string;
  provider: ProviderId;
  email: string;
  accountUuid: string | null;
  planType: string | null;
  source: "refresh";
  terminal: boolean;
  action: "retry" | "reauthorize";
  kind: string;
  reason: string | null;
  httpStatus: number | null;
  message: string;
  detail: string | null;
  refreshTokenHash: string;
  accessTokenHash: string;
  lastRefreshAt: string | null;
  cooldownUntil: string | null;
  pid: number;
  hostname: string;
}

/** 记录认证错误事件时所需的最小输入。 */
export interface RecordAuthErrorInput {
  provider: ProviderId;
  email: string;
  accountUuid?: string | null;
  planType?: string | null;
  terminal: boolean;
  action: "retry" | "reauthorize";
  kind: string;
  reason?: string | null;
  httpStatus?: number | null;
  message: string;
  detail?: string | null;
  refreshToken: string;
  accessToken: string;
  lastRefreshAt?: string | null;
  cooldownUntil?: string | null;
}

/** 生成按日分片的本地日期键，格式为 YYYY-MM-DD。 */
function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 计算 token 指纹，避免在日志里直接写入敏感 token。 */
export function fingerprintToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/** 返回认证错误日志目录。 */
export function authErrorDir(authDir: string): string {
  return path.join(authDir, "observability", "auth-errors");
}

/** 返回指定日期的认证错误 JSONL 路径。 */
export function authErrorFilePath(authDir: string, dateKey: string): string {
  return path.join(authErrorDir(authDir), `auth-error-${dateKey}.jsonl`);
}

/** 将认证错误追加写入本地 JSONL，默认始终开启，便于排查 refresh 问题。 */
export function recordAuthError(
  authDir: string,
  input: RecordAuthErrorInput,
): AuthErrorEvent {
  const now = new Date();
  const event: AuthErrorEvent = {
    v: AUTH_ERROR_EVENT_VERSION,
    ts: now.toISOString(),
    provider: input.provider,
    email: input.email,
    accountUuid: input.accountUuid || null,
    planType: input.planType || null,
    source: "refresh",
    terminal: input.terminal,
    action: input.action,
    kind: input.kind,
    reason: input.reason || null,
    httpStatus: input.httpStatus ?? null,
    message: input.message,
    detail: input.detail || null,
    refreshTokenHash: fingerprintToken(input.refreshToken),
    accessTokenHash: fingerprintToken(input.accessToken),
    lastRefreshAt: input.lastRefreshAt || null,
    cooldownUntil: input.cooldownUntil || null,
    pid: process.pid,
    hostname: os.hostname(),
  };
  fs.mkdirSync(authErrorDir(authDir), { recursive: true, mode: 0o700 });
  fs.appendFileSync(
    authErrorFilePath(authDir, localDateKey(now)),
    JSON.stringify(event) + "\n",
    { mode: 0o600 },
  );
  return event;
}

/** 流式读取认证错误日志，跳过半写入或手工损坏的 JSON 行。 */
export async function readAuthErrorEvents(
  filePath: string,
  onEvent: (event: AuthErrorEvent) => void,
): Promise<number> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`auth error file not found: ${filePath}`);
  }
  let count = 0;
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, "utf-8"),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as AuthErrorEvent;
      if (
        parsed?.v === AUTH_ERROR_EVENT_VERSION &&
        typeof parsed.provider === "string" &&
        typeof parsed.email === "string"
      ) {
        count++;
        onEvent(parsed);
      }
    } catch {
      // Ignore partial writes or manually edited bad lines.
    }
  }
  return count;
}
