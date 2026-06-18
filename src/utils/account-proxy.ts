import { Agent, Dispatcher, ProxyAgent } from "undici";
import { AvailableAccount } from "../accounts/manager";
import { ProviderId, TokenData } from "../auth/types";

/**
 * TLS ClientHello 模拟配置 — 匹配官方 codex-rs CLI（Rust / rustls + ring）。
 *
 * OpenAI / Cloudflare 通过 TLS 指纹（JA3 / JA4）识别客户端类型。
 * Node.js 默认的 OpenSSL 指纹与 Rust/rustls 差异明显，容易被标记为
 * 非官方客户端。以下配置将 cipher suite 顺序和 signature algorithm
 * 对齐到 rustls+ring 的默认值，降低被识别的概率。
 *
 * 注意：ALPNProtocols 和 allowH2 已禁用，因为它们在 HTTP CONNECT 代理
 * （mihomo）隧道中会导致 ECONNRESET — undici 的实验性 H2 支持与代理
 * 隧道的 TLS 握手不兼容。cipher/sigalgs 调整仍能显著改变 JA3/JA4 指纹。
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
};

/** Codex 专用直连 dispatcher，仅用于需要 TLS 指纹伪装的 OpenAI/Codex 链路。 */
const codexDirectAgent = new Agent({
  connect: CODEX_TLS_CONNECT_OPTIONS as any,
});

/** 非 Codex provider 的默认直连 dispatcher，保持 undici/Node 的原生行为。 */
const defaultDirectAgent = new Agent();

/** Codex 代理 dispatcher 缓存，代理出口后的 TLS 握手仍保持 Codex 指纹伪装。 */
const codexProxyDispatcherCache = new Map<string, Dispatcher>();

/** 普通代理 dispatcher 缓存，供 Anthropic / Cursor 等 provider 使用。 */
const defaultProxyDispatcherCache = new Map<string, Dispatcher>();

/** 判断入参是否为 `AvailableAccount`，用于安全读取 `token.routing`。 */
function isAvailableAccount(
  source: AvailableAccount | TokenData | undefined,
): source is AvailableAccount {
  return !!source && "token" in source;
}

/** 提取请求来源所属 provider；缺省时按历史兼容逻辑视为 anthropic。 */
function getSourceProvider(
  source: AvailableAccount | TokenData | undefined,
): ProviderId {
  if (!source) return "anthropic";
  if (isAvailableAccount(source)) {
    return source.token.provider || source.provider || "anthropic";
  }
  return source.provider || "anthropic";
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

/** 按 provider 和代理地址返回可复用的 dispatcher。 */
export function getProxyDispatcher(
  provider: ProviderId,
  proxyUrl?: string,
): Dispatcher | undefined {
  if (!proxyUrl) return undefined;
  const cache =
    provider === "codex"
      ? codexProxyDispatcherCache
      : defaultProxyDispatcherCache;
  let dispatcher = cache.get(proxyUrl);
  if (!dispatcher) {
    dispatcher =
      provider === "codex"
        ? new ProxyAgent({
            uri: proxyUrl,
            connect: CODEX_TLS_CONNECT_OPTIONS as any,
          })
        : new ProxyAgent(proxyUrl);
    cache.set(proxyUrl, dispatcher);
  }
  return dispatcher;
}

/** 返回指定 provider 的直连 dispatcher。 */
function getDirectDispatcher(provider: ProviderId): Dispatcher {
  return provider === "codex" ? codexDirectAgent : defaultDirectAgent;
}

/** 导出 Codex 专用 dispatcher，供无账号上下文的 OAuth code exchange 使用。 */
export function getCodexDispatcher(): Dispatcher {
  return codexDirectAgent;
}

/** 用账号级代理执行 fetch；仅 Codex 链路启用 TLS 指纹伪装。 */
export function fetchWithAccountProxy(
  input: string | URL | Request,
  init: RequestInit,
  source?: AvailableAccount | TokenData,
): Promise<Response> {
  const provider = getSourceProvider(source);
  const dispatcher =
    getProxyDispatcher(provider, getAccountProxyUrl(source)) ??
    getDirectDispatcher(provider);
  return fetch(input, {
    ...init,
    dispatcher,
  } as RequestInit & { dispatcher: Dispatcher });
}
