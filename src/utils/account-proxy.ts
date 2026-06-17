import { Dispatcher, ProxyAgent } from "undici";
import { AvailableAccount } from "../accounts/manager";
import { TokenData } from "../auth/types";

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
    dispatcher = new ProxyAgent(proxyUrl);
    proxyDispatcherCache.set(proxyUrl, dispatcher);
  }
  return dispatcher;
}

/** 用账号级代理执行 fetch；未配置代理时回落到全局 dispatcher。 */
export function fetchWithAccountProxy(
  input: string | URL | Request,
  init: RequestInit,
  source?: AvailableAccount | TokenData,
): Promise<Response> {
  const dispatcher = getProxyDispatcher(getAccountProxyUrl(source));
  if (!dispatcher) return fetch(input, init);
  return fetch(input, {
    ...init,
    dispatcher,
  } as RequestInit & { dispatcher: Dispatcher });
}
