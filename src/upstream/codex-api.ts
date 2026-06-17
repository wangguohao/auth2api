import { Request } from "express";
import { Config } from "../config";
import { AvailableAccount } from "../accounts/manager";
import { withTimeoutSignal } from "../utils/abort";
import { fetchWithAccountProxy } from "../utils/account-proxy";

const BASE_URL = "https://chatgpt.com/backend-api";
const RESPONSES_PATH = "/codex/responses";

const DEFAULT_ORIGINATOR = "codex_cli_rs";
// Bumped from 0.40.0 — backend now version-gates `gpt-5.3-codex` and rejects
// older versions with "requires a newer version of Codex". Matches latest
// @openai/codex on npm at the time of writing. Override via
// `cloaking.codex.cli-version` if upstream's minimum changes again.
const DEFAULT_CLI_VERSION = "0.125.0";

function buildUserAgent(config: Config): string {
  const codex = config.cloaking.codex || {};
  if (codex["user-agent"]) return codex["user-agent"];
  const originator = codex.originator || DEFAULT_ORIGINATOR;
  const version = codex["cli-version"] || DEFAULT_CLI_VERSION;
  const platform =
    process.platform === "darwin"
      ? "macos"
      : process.platform === "win32"
        ? "windows"
        : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x86_64";
  return `${originator}/${version} (${platform}; ${arch})`;
}

/** @internal — exported for unit tests; do not use from app code. */
export function __buildCodexHeaders(
  account: AvailableAccount,
  stream: boolean,
  config: Config,
): Record<string, string> {
  return buildHeaders(account, stream, config);
}

function buildHeaders(
  account: AvailableAccount,
  stream: boolean,
  config: Config,
): Record<string, string> {
  const codex = config.cloaking.codex || {};
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${account.token.accessToken}`,
    Accept: stream ? "text/event-stream" : "application/json",
    "User-Agent": buildUserAgent(config),
    originator: codex.originator || DEFAULT_ORIGINATOR,
    // Provider-level header sent by the official codex CLI on every request:
    // codex-rs/model-provider-info/src/lib.rs:324-328 sets
    //   http_headers = { "version": env!("CARGO_PKG_VERSION") }
    // The current ChatGPT backend doesn't enforce it, but matching the
    // official client makes us less brittle to future Cloudflare/upstream
    // rules. Reuses cli-version so it stays in sync with the User-Agent.
    version: codex["cli-version"] || DEFAULT_CLI_VERSION,
  };
  if (account.chatgptAccountId) {
    headers["ChatGPT-Account-ID"] = account.chatgptAccountId;
  }
  if (codex["openai-beta"]) {
    headers["OpenAI-Beta"] = codex["openai-beta"];
  }
  return headers;
}

/**
 * Codex's `/codex/responses` endpoint rejects requests that omit any of:
 *   - stream: true        (must be SSE)
 *   - store: false        (CLI requests don't persist)
 *   - instructions: <any> (system prompt placeholder; empty string is fine)
 *
 * These are protocol requirements, not identity faking — same category as the
 * `Authorization` and `ChatGPT-Account-ID` headers. Most off-the-shelf OpenAI
 * Responses clients won't send all three by default, so we fill the missing
 * ones. Explicitly-set values are preserved (so a client that wants stream
 * false will still get the upstream's "Stream must be set to true" 400 — we
 * don't second-guess explicit intent).
 */
export function normalizeCodexResponsesBody(body: any): any {
  if (!body || typeof body !== "object") return body;
  const next: any = { ...body };
  if (next.stream === undefined) next.stream = true;
  if (next.store === undefined) next.store = false;
  if (next.instructions === undefined) next.instructions = "";
  return next;
}

export interface CallCodexResponsesOptions {
  body?: any;
  request: Request;
  account: AvailableAccount;
  config: Config;
  signal?: AbortSignal;
}

export async function callCodexResponses(
  options: CallCodexResponsesOptions,
): Promise<Response> {
  const { request, account, config } = options;
  const body = options.body ?? request.body;
  const stream = !!body.stream;
  const url = `${BASE_URL}${RESPONSES_PATH}`;
  const timeoutMs = stream
    ? config.timeouts["stream-messages-ms"]
    : config.timeouts["messages-ms"];

  try {
    return await fetchWithAccountProxy(
      url,
      {
        method: "POST",
        headers: buildHeaders(account, stream, config),
        body: JSON.stringify(body),
        signal: withTimeoutSignal(timeoutMs, options.signal),
      },
      account,
    );
  } catch (err: any) {
    // undici's "fetch failed" hides the real cause — surface it.
    const cause = err?.cause;
    const detail = cause
      ? `${cause.code || cause.name || "error"}: ${cause.message || String(cause)}`
      : err?.message || String(err);
    throw new Error(`codex upstream fetch failed: ${detail}`);
  }
}
