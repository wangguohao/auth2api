/** 路由缓存统计快照。 */
export interface RoutingCacheStats {
  size: number;
  hits: number;
  misses: number;
  hitRate: number;
}

/** 路由缓存命中统计器。 */
export class RoutingCacheStatsTracker {
  private hits = 0;
  private misses = 0;

  /** 记录一次命中。 */
  recordHit(): void {
    this.hits++;
  }

  /** 记录一次未命中。 */
  recordMiss(): void {
    this.misses++;
  }

  /** 生成当前统计快照。 */
  snapshot(size: number): RoutingCacheStats {
    const total = this.hits + this.misses;
    return {
      size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : this.hits / total,
    };
  }
}
