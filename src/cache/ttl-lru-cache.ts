/** TTL LRU 缓存配置。 */
export interface TtlLruCacheOptions {
  ttlMs: number;
  maxEntries: number;
}

/** TTL LRU 缓存条目。 */
interface TtlLruCacheEntry<V> {
  value: V;
  expiresAt: number;
}

/**
 * 通用 TTL + LRU 缓存。
 *
 * 访问命中会滚动刷新 TTL，并通过 Map 重插维护 LRU 顺序。
 */
export class TtlLruCache<K, V> {
  private entries: Map<K, TtlLruCacheEntry<V>> = new Map();
  private ttlMs: number;
  private maxEntries: number;

  constructor(options: TtlLruCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries;
  }

  /** 查询并滚动刷新缓存条目。 */
  get(key: K, now: number): V | null {
    const entry = this.getEntry(key, now);
    return entry?.value ?? null;
  }

  /** 查询并滚动刷新缓存条目，同时返回新的过期时间。 */
  getEntry(
    key: K,
    now: number,
  ): { value: V; expiresAt: number } | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return null;
    }
    this.entries.delete(key);
    entry.expiresAt = now + this.ttlMs;
    this.entries.set(key, entry);
    return { value: entry.value, expiresAt: entry.expiresAt };
  }

  /** 只读查询缓存条目，不刷新 TTL，也不改变 LRU 顺序。 */
  peekEntry(
    key: K,
    now: number,
  ): { value: V; expiresAt: number } | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return null;
    }
    return { value: entry.value, expiresAt: entry.expiresAt };
  }

  /** 写入缓存条目。 */
  set(key: K, value: V, now: number): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
    this.enforceLimit();
  }

  /** 删除指定缓存条目。 */
  delete(key: K): void {
    this.entries.delete(key);
  }

  /** 清理过期条目。 */
  reapExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  /** 当前缓存条目数。 */
  get size(): number {
    return this.entries.size;
  }

  /** 超过容量时删除最早未访问条目。 */
  private enforceLimit(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
