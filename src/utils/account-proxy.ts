import { Agent, Dispatcher, ProxyAgent } from "undici";
import { AvailableAccount } from "../accounts/manager";
import { TokenData } from "../auth/types";

/**
 * TLS ClientHello 模拟配置 — 匹配官方 codex-rs CLI（Rust / rustls + ring）。
 *
 * OpenAI / Cloudflare 通过 TLS 指纹（JA3 / JA4）识别客户端类型。
 * Node.js 默认的 OpenSSL 指纹与 Rust/rustls 差异明显，容易被标记为
 * 非官方客户端。以下配置将 cipher suite 顺序、signature algorithm、
 * ALPN 协议对齐到 rustls+ring 的默认值，降低被识别的概率。
 */
const CODEX_TLS_CONNECT_OPTIONS = {
  ciphers: [
    "TLS_AES_256_GCM_SHA384",
    "TLS_CHACHA20_POLY1305_SHA256",
    "TLS_AES_128_GCM_SHA256",
    "ECDHE-ECDSA-AES128-GCM-SHA256",
    "ECDHE-RSA-AES128-GCM-SHA256",
    "ECDHE-ECDSA-AES256-GCM-SHA384",
    "ECDHE-RSA-AES256-GCM-SHA384",
    "ECDHE-ECDSA-CHACHA20-POLY1305",
    "ECDHE-RSA-CHACHA20-POLY1305",
  ].join(":"),
  sigalgs: [
    "ecdsa_secp256r1_sha256",
    "ecdsa_secp384r1_sha384",
    "ecdsa_secp521r1_sha512",
    "ed25519",
    "rsa_pss_rsae_sha256",
    "rsa_pss_rsae_sha384",
    "rsa_pss_rsae_sha512",
    "rsa_pkcs1_sha256",
    "rsa_pkcs1_sha384",
    "rsa_pkcs1_sha512",
  ].join(":"),
  minVersion: "TLSv1.2" as const,
  maxVersion: "TLSv1.3" as const,
  // 官方 codex-rs CLI 通过 ALPN 协商 HTTP/2；Node.js 默认不发 ALPN，
  // 导致降级为 HTTP/1.1 — 这本身就是一个显著的指纹差异。
  ALPNProtocols: ["h2", "http/1.1"] as string[],
  // 启用 HTTP/2 — 官方客户端使用 HTTP/2，不启用会导致协议层指纹不匹配。
  allowH2: true,
};

/** 全局默认 dispatcher — 直连时使用，TLS 指纹已伪装。 */
const defaultAgent = new Agent({
  connect: CODEX_TLS_CONNECT_OPTIONS as any,
});

/** 导出 defaultAgent 供 OAuth 等无账号上下文的场景使用。 */
export function getDefaultAgent(): Dispatcher {
  return defaultAgent;
}

/** 复用代理 dispatcher，避免每次请求都新建隧道连接池。 */
const proxyDispatcherCache = new Map<string, Dispatcher>();

/** 判断入参是否为 `AvailableAccount`，用于安全读取 `token.routing`。 */
function isAvailableAccount(
  source: AvailableAccount | TokenData | undefined,
): source is AvailableAccount {
  return !!source && "token" in source;
}

/** 从账号或 token 上提取账号级代理地址。 */
export function getAccountProxyUrl(
  source: AvailableAccount | TokenData | undefined,
): string | undefined {
  const proxy = isAvailableAccount(source)
    ? source.token.routing?.proxy
    : source?.routing?.proxy;
  if (!proxy) return undefined;
  const normalized = proxy.trim();
  return normalized.length > 0 ? normalized : undefined;
}

/** 按代理地址返回可复用的 undici dispatcher。 */
export function getProxyDispatcher(proxyUrl?: string): Dispatcher | undefined {
  if (!proxyUrl) return undefined;
  let dispatcher = proxyDispatcherCache.get(proxyUrl);
  if (!dispatcher) {
    dispatcher = new ProxyAgent({
      uri: proxyUrl,
      connect: CODEX_TLS_CONNECT_OPTIONS as any,
    });
    proxyDispatcherCache.set(proxyUrl, dispatcher);
  }
  return dispatcher;
}

/** 用账号级代理执行 fetch；未配置代理时回落到伪装过 TLS 的全局 dispatcher。 */
export function fetchWithAccountProxy(
  input: string | URL | Request,
  init: RequestInit,
  source?: AvailableAccount | TokenData,
): Promise<Response> {
  const dispatcher = getProxyDispatcher(getAccountProxyUrl(source)) ?? defaultAgent;
  return fetch(input, {
    ...init,
    dispatcher,
  } as RequestInit & { dispatcher: Dispatcher });
}
