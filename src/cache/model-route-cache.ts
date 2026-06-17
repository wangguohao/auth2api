import { Provider } from "../providers/types";

/** model -> provider 缓存条目，签名变化时自动失效。 */
interface ModelRouteCacheEntry {
  signature: string;
  provider: Provider;
}

/** model route cache 配置。 */
export interface ModelRouteCacheOptions {
  maxEntries: number;
  maxKeyLength: number;
}

/**
 * 模型路由缓存。
 *
 * 该缓存只优化 model family 判断，不绑定具体账号；失效依赖调用方传入的
 * account signature，不使用 TTL，避免无意义的时间驱动抖动。
 */
export class ModelRouteCache {
  private entries: Map<string, ModelRouteCacheEntry> = new Map();
  private maxEntries: number;
  private maxKeyLength: number;

  constructor(options: ModelRouteCacheOptions) {
    this.maxEntries = options.maxEntries;
    this.maxKeyLength = options.maxKeyLength;
  }

  /** 查询指定模型在当前账号签名下的 provider。 */
  get(resolvedModel: string, signature: string): Provider | null {
    const entry = this.entries.get(resolvedModel);
    if (entry?.signature !== signature) return null;
    this.set(resolvedModel, signature, entry.provider);
    return entry.provider;
  }

  /** 写入模型路由结果，并维护 LRU 容量。 */
  set(resolvedModel: string, signature: string, provider: Provider): void {
    if (resolvedModel.length > this.maxKeyLength) return;
    if (this.entries.has(resolvedModel)) this.entries.delete(resolvedModel);
    this.entries.set(resolvedModel, { signature, provider });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
