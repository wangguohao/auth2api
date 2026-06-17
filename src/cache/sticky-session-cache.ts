import {
  RoutingCacheStats,
  RoutingCacheStatsTracker,
} from "./routing-cache-stats";
import { TtlLruCache } from "./ttl-lru-cache";

/** 会话粘性缓存条目，记录某个下游会话当前绑定的上游账号。 */
export interface StickySessionBinding {
  email: string;
  expiresAt: number;
  lastSeenAt: string;
  model: string | null;
}

/** 会话粘性缓存配置。 */
export interface StickySessionCacheOptions {
  ttlMs: number;
  maxEntries: number;
}

/**
 * TTL + LRU 的会话粘性缓存。
 *
 * 这里只保存短期路由状态，不参与账号健康判断；调用方必须在命中后继续校验
 * cooldown、tier、provider pool 等实时条件，避免缓存把请求粘到不可用账号。
 */
export class StickySessionCache {
  private bindings: TtlLruCache<string, StickySessionBinding>;
  private statsTracker = new RoutingCacheStatsTracker();

  constructor(options: StickySessionCacheOptions) {
    this.bindings = new TtlLruCache(options);
  }

  /** 查询缓存但不计入命中统计，调用方完成可复用校验后再记录 hit/miss。 */
  get(key: string, now: number): StickySessionBinding | null {
    const entry = this.bindings.peekEntry(key, now);
    if (!entry) return null;
    return { ...entry.value, expiresAt: entry.expiresAt };
  }

  /** 记录一次可复用命中，并滚动刷新有效期和 LRU 顺序。 */
  recordHit(key: string, binding: StickySessionBinding, now: number): void {
    this.statsTracker.recordHit();
    this.bindings.set(
      key,
      { ...binding, lastSeenAt: new Date(now).toISOString() },
      now,
    );
  }

  /** 记录一次未命中或命中后不可复用。 */
  recordMiss(): void {
    this.statsTracker.recordMiss();
  }

  /** 写入新的会话绑定。 */
  set(
    key: string,
    value: { email: string; model?: string | null },
    now: number,
  ): void {
    this.bindings.set(
      key,
      {
        email: value.email,
        expiresAt: now,
        lastSeenAt: new Date(now).toISOString(),
        model: value.model ?? null,
      },
      now,
    );
  }

  /** 清理过期条目，避免低流量场景长期保留旧 session。 */
  reapExpired(now: number): void {
    this.bindings.reapExpired(now);
  }

  /** 返回当前缓存容量和命中率。 */
  stats(): RoutingCacheStats {
    return this.statsTracker.snapshot(this.bindings.size);
  }
}
