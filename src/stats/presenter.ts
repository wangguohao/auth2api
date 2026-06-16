import {
  AccountBucket,
  ApiBucket,
  BaseBucket,
  ClientBucket,
  StatsSnapshot,
} from "./recorder";

const ZH_CN_DATE_TIME = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function formatDateTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return ZH_CN_DATE_TIME.format(date).replace("T", " ");
}

function formatCompactNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 999_500_000) return `${(value / 1_000_000_000).toFixed(1)}b`;
  if (abs >= 999_500) return `${(value / 1_000_000).toFixed(1)}m`;
  if (abs >= 999.5) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function trimCompact(value: string): string {
  return value.replace(/\.0([kmb])$/, "$1");
}

function formatTokenCount(value: number): string {
  return trimCompact(formatCompactNumber(value));
}

function formatLatencyMs(value: number): string {
  if (value >= 1000) {
    const seconds = value / 1000;
    return Number.isInteger(seconds)
      ? `${seconds}s`
      : `${seconds.toFixed(1).replace(/\.0$/, "")}s`;
  }
  return `${value}ms`;
}

function formatBaseBucket(bucket: BaseBucket) {
  return {
    请求数: bucket.requests,
    成功数: bucket.successes,
    失败数: bucket.failures,
    输入Token: formatTokenCount(bucket.totalInputTokens),
    输出Token: formatTokenCount(bucket.totalOutputTokens),
    缓存创建输入Token: formatTokenCount(bucket.totalCacheCreationInputTokens),
    缓存命中输入Token: formatTokenCount(bucket.totalCacheReadInputTokens),
    推理输出Token: formatTokenCount(bucket.totalReasoningOutputTokens),
    总耗时: formatLatencyMs(bucket.totalLatencyMs),
    首次时间: formatDateTime(bucket.firstSeenAt),
    最后时间: formatDateTime(bucket.lastSeenAt),
  };
}

function formatClientBucket(bucket: ClientBucket) {
  return {
    ...formatBaseBucket(bucket),
    名称: bucket.name,
    最近IP: bucket.lastIp,
    最近UA: bucket.lastUa,
  };
}

function formatAccountBucket(bucket: AccountBucket) {
  return {
    ...formatBaseBucket(bucket),
    提供方: bucket.provider,
    账号: bucket.email,
  };
}

function formatApiBucket(bucket: ApiBucket) {
  return {
    ...formatBaseBucket(bucket),
    接口: bucket.endpoint,
    模型: bucket.model,
    提供方: bucket.provider ?? "unknown",
  };
}

function mapValues<T, R>(
  input: Record<string, T>,
  mapper: (value: T) => R,
): Record<string, R> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, mapper(value)]),
  );
}

export function presentStatsSnapshot(
  snapshot: StatsSnapshot,
  generatedAt: string,
) {
  return {
    按客户端: mapValues(snapshot.byClient, formatClientBucket),
    按账号: mapValues(snapshot.byAccount, formatAccountBucket),
    按接口: mapValues(snapshot.byApi, formatApiBucket),
    汇总: formatBaseBucket(snapshot.totals),
    生成时间: formatDateTime(generatedAt),
  };
}
