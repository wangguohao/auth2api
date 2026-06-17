/**
 * 请求指纹缓存被显式禁用。
 *
 * 没有稳定 sessionId 时，用 body 指纹猜测会话容易误粘账号，反而可能损害
 * 上游输入缓存和隔离语义；保留这个模块是为了记录架构决策，避免后续误接入。
 */
export const REQUEST_FINGERPRINT_CACHE_ENABLED = false;
