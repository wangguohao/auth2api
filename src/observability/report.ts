import fs from "fs";
import path from "path";
import readline from "readline";
import { Config } from "../config";
import { TraceEvent, TraceRecorder, isDateKey } from "./trace";

interface ReportOptions {
  date: string;
  sendEmail: boolean;
}

interface DailySummary {
  date: string;
  requests: number;
  successes: number;
  failures: number;
  failureKinds: Map<string, number>;
  byProvider: Map<string, number>;
  byEndpoint: Map<string, number>;
  modelRouteHits: number;
  modelRouteMisses: number;
  sessionRouteHits: number;
  sessionRouteMisses: number;
  promptCacheReadTokens: number;
  promptCacheCreationTokens: number;
  latencies: number[];
  slowRequests: Array<{
    traceId: string;
    endpoint: string;
    model: string | null;
    provider: string | null;
    statusCode: number;
    latencyMs: number;
    failureKind: string | null;
  }>;
}

export interface DailyReportResult {
  date: string;
  markdown: string;
  filePath: string;
  emailed: boolean;
}

function emptySummary(date: string): DailySummary {
  return {
    date,
    requests: 0,
    successes: 0,
    failures: 0,
    failureKinds: new Map(),
    byProvider: new Map(),
    byEndpoint: new Map(),
    modelRouteHits: 0,
    modelRouteMisses: 0,
    sessionRouteHits: 0,
    sessionRouteMisses: 0,
    promptCacheReadTokens: 0,
    promptCacheCreationTokens: 0,
    latencies: [],
    slowRequests: [],
  };
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) || 0) + 1);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx];
}

function topEntries(map: Map<string, number>, limit = 10): string {
  const entries = [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
  if (entries.length === 0) return "- 无\n";
  return entries.map(([key, count]) => `- ${key}: ${count}`).join("\n") + "\n";
}

function applyEvent(summary: DailySummary, event: TraceEvent): void {
  summary.requests++;
  if (event.status === "success") summary.successes++;
  else summary.failures++;
  if (event.failureKind) increment(summary.failureKinds, event.failureKind);
  increment(summary.byProvider, event.provider || "unknown");
  increment(summary.byEndpoint, event.endpoint);
  if (event.cache.modelRoute === "hit") summary.modelRouteHits++;
  if (event.cache.modelRoute === "miss") summary.modelRouteMisses++;
  if (event.cache.sessionRoute === "hit") summary.sessionRouteHits++;
  if (event.cache.sessionRoute === "miss") summary.sessionRouteMisses++;
  summary.promptCacheReadTokens += event.cache.promptCacheReadTokens || 0;
  summary.promptCacheCreationTokens +=
    event.cache.promptCacheCreationTokens || 0;
  summary.latencies.push(event.latencyMs);
  summary.slowRequests.push({
    traceId: event.traceId,
    endpoint: event.endpoint,
    model: event.model,
    provider: event.provider,
    statusCode: event.statusCode,
    latencyMs: event.latencyMs,
    failureKind: event.failureKind,
  });
  summary.slowRequests.sort((a, b) => b.latencyMs - a.latencyMs);
  if (summary.slowRequests.length > 20) summary.slowRequests.length = 20;
}

function renderMarkdown(summary: DailySummary): string {
  const successRate =
    summary.requests === 0
      ? 0
      : Math.round((summary.successes / summary.requests) * 10000) / 100;
  const modelRouteTotal = summary.modelRouteHits + summary.modelRouteMisses;
  const sessionRouteTotal =
    summary.sessionRouteHits + summary.sessionRouteMisses;
  const modelRouteHitRate =
    modelRouteTotal === 0
      ? 0
      : Math.round((summary.modelRouteHits / modelRouteTotal) * 10000) / 100;
  const sessionRouteHitRate =
    sessionRouteTotal === 0
      ? 0
      : Math.round((summary.sessionRouteHits / sessionRouteTotal) * 10000) /
        100;

  const slow =
    summary.slowRequests.length === 0
      ? "- 无\n"
      : summary.slowRequests
          .map(
            (r) =>
              `- ${r.traceId} ${r.latencyMs}ms ${r.statusCode} ${r.provider || "unknown"} ${r.model || "unknown"} ${r.endpoint}${r.failureKind ? ` (${r.failureKind})` : ""}`,
          )
          .join("\n") + "\n";

  return `# auth2api 日报 ${summary.date}

## 总览

- 请求数: ${summary.requests}
- 成功: ${summary.successes}
- 失败: ${summary.failures}
- 成功率: ${successRate}%

## 延迟

- P50: ${percentile(summary.latencies, 50)}ms
- P95: ${percentile(summary.latencies, 95)}ms
- P99: ${percentile(summary.latencies, 99)}ms

## Provider 分布

${topEntries(summary.byProvider)}
## Endpoint 分布

${topEntries(summary.byEndpoint)}
## 失败类型

${topEntries(summary.failureKinds)}
## Cache

- model route hit/miss: ${summary.modelRouteHits}/${summary.modelRouteMisses} (${modelRouteHitRate}% hit)
- session route hit/miss: ${summary.sessionRouteHits}/${summary.sessionRouteMisses} (${sessionRouteHitRate}% hit)
- prompt cache read tokens: ${summary.promptCacheReadTokens}
- prompt cache creation tokens: ${summary.promptCacheCreationTokens}

## 慢请求 Top 20

${slow}`;
}

async function readDailySummary(
  recorder: TraceRecorder,
  date: string,
): Promise<DailySummary> {
  const summary = emptySummary(date);
  const filePath = recorder.traceFilePath(date);
  if (!fs.existsSync(filePath)) return summary;

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, "utf-8"),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    try {
      const event = JSON.parse(line) as TraceEvent;
      if (event?.v === 1 && typeof event.traceId === "string") {
        applyEvent(summary, event);
      }
    } catch {
      // Skip partial/corrupt lines; reports should be best-effort.
    }
  }
  return summary;
}

export async function generateDailyReport(
  config: Config,
  recorder: TraceRecorder,
  options: ReportOptions,
  sendMail?: (
    subject: string,
    body: string,
    recipients: string[],
  ) => Promise<void>,
): Promise<DailyReportResult> {
  if (!isDateKey(options.date)) {
    throw new Error("date must be YYYY-MM-DD");
  }

  const summary = await readDailySummary(recorder, options.date);
  const markdown = renderMarkdown(summary);
  const filePath = recorder.reportFilePath(options.date);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, markdown, { mode: 0o600 });

  let emailed = false;
  const recipients = config.observability.report.recipients;
  if (options.sendEmail && recipients.length > 0) {
    if (!sendMail) throw new Error("mail sender is not configured");
    await sendMail(`auth2api 日报 ${options.date}`, markdown, recipients);
    emailed = true;
  }

  return { date: options.date, markdown, filePath, emailed };
}
