import fs from "fs";
import path from "path";
import readline from "readline";
import { Config } from "../config";
import { TraceEvent, TraceRecorder, isDateKey } from "./trace";
import { MailBody } from "./mail";

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
  inputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
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
  summary: DailyReportSummaryView;
  html: string;
  htmlFilePath: string;
  emailed: boolean;
}

export interface DailyReportSummaryView {
  requests: number;
  successes: number;
  failures: number;
  successRate: string;
  latency: {
    p50: string;
    p95: string;
    p99: string;
  };
  providerDistribution: Array<{ key: string; count: number }>;
  endpointDistribution: Array<{ key: string; count: number }>;
  failureKinds: Array<{ key: string; count: number }>;
  cache: {
    modelRouteHits: number;
    modelRouteMisses: number;
    modelRouteHitRate: string;
    sessionRouteHits: number;
    sessionRouteMisses: number;
    sessionRouteHitRate: string;
    promptCacheReadTokens: string;
    promptCacheCreationTokens: string;
  };
  tokens: {
    inputTokens: string;
    outputTokens: string;
    reasoningOutputTokens: string;
    promptCacheReadTokens: string;
    promptCacheCreationTokens: string;
    totalTokens: string;
  };
  slowRequests: Array<{
    traceId: string;
    latency: string;
    statusCode: number;
    provider: string;
    model: string;
    endpoint: string;
    failureKind: string | null;
  }>;
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
    inputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
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

function sortedEntries(
  map: Map<string, number>,
  limit = 10,
): Array<{ key: string; count: number }> {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100) / 100}%`;
}

function formatMs(value: number): string {
  if (value >= 1000) {
    const seconds = value / 1000;
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(2)}s`;
  }
  return `${value}ms`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function buildSummaryView(summary: DailySummary): DailyReportSummaryView {
  const successRate =
    summary.requests === 0 ? 0 : (summary.successes / summary.requests) * 100;
  const modelRouteTotal = summary.modelRouteHits + summary.modelRouteMisses;
  const sessionRouteTotal =
    summary.sessionRouteHits + summary.sessionRouteMisses;
  const modelRouteHitRate =
    modelRouteTotal === 0
      ? 0
      : (summary.modelRouteHits / modelRouteTotal) * 100;
  const sessionRouteHitRate =
    sessionRouteTotal === 0
      ? 0
      : (summary.sessionRouteHits / sessionRouteTotal) * 100;

  return {
    requests: summary.requests,
    successes: summary.successes,
    failures: summary.failures,
    successRate: formatPercent(successRate),
    latency: {
      p50: formatMs(percentile(summary.latencies, 50)),
      p95: formatMs(percentile(summary.latencies, 95)),
      p99: formatMs(percentile(summary.latencies, 99)),
    },
    providerDistribution: sortedEntries(summary.byProvider),
    endpointDistribution: sortedEntries(summary.byEndpoint),
    failureKinds: sortedEntries(summary.failureKinds),
    cache: {
      modelRouteHits: summary.modelRouteHits,
      modelRouteMisses: summary.modelRouteMisses,
      modelRouteHitRate: formatPercent(modelRouteHitRate),
      sessionRouteHits: summary.sessionRouteHits,
      sessionRouteMisses: summary.sessionRouteMisses,
      sessionRouteHitRate: formatPercent(sessionRouteHitRate),
      promptCacheReadTokens: formatNumber(summary.promptCacheReadTokens),
      promptCacheCreationTokens: formatNumber(
        summary.promptCacheCreationTokens,
      ),
    },
    tokens: {
      inputTokens: formatNumber(summary.inputTokens),
      outputTokens: formatNumber(summary.outputTokens),
      reasoningOutputTokens: formatNumber(summary.reasoningOutputTokens),
      promptCacheReadTokens: formatNumber(summary.promptCacheReadTokens),
      promptCacheCreationTokens: formatNumber(
        summary.promptCacheCreationTokens,
      ),
      totalTokens: formatNumber(
        summary.inputTokens +
          summary.outputTokens +
          summary.reasoningOutputTokens,
      ),
    },
    slowRequests: summary.slowRequests.map((r) => ({
      traceId: r.traceId,
      latency: formatMs(r.latencyMs),
      statusCode: r.statusCode,
      provider: r.provider || "unknown",
      model: r.model || "unknown",
      endpoint: r.endpoint,
      failureKind: r.failureKind,
    })),
  };
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
  summary.inputTokens += event.usage?.inputTokens || 0;
  summary.outputTokens += event.usage?.outputTokens || 0;
  summary.reasoningOutputTokens += event.usage?.reasoningOutputTokens || 0;
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
  const view = buildSummaryView(summary);

  const slow =
    view.slowRequests.length === 0
      ? "- 无\n"
      : view.slowRequests
          .map(
            (r) =>
              `- ${r.traceId} ${r.latency} ${r.statusCode} ${r.provider} ${r.model} ${r.endpoint}${r.failureKind ? ` (${r.failureKind})` : ""}`,
          )
          .join("\n") + "\n";

  return `# auth2api 日报 ${summary.date}

## 总览

- 请求数: ${summary.requests}
- 成功: ${summary.successes}
- 失败: ${summary.failures}
- 成功率: ${view.successRate}

## 延迟

- P50: ${view.latency.p50}
- P95: ${view.latency.p95}
- P99: ${view.latency.p99}

## 服务商分布

${topEntries(summary.byProvider)}
## 接口分布

${topEntries(summary.byEndpoint)}
## 失败类型

${topEntries(summary.failureKinds)}
## Token 用量

- 输入 token: ${view.tokens.inputTokens}
- 输出 token: ${view.tokens.outputTokens}
- 推理输出 token: ${view.tokens.reasoningOutputTokens}
- 输入缓存命中 token: ${view.tokens.promptCacheReadTokens}
- 输入缓存写入 token: ${view.tokens.promptCacheCreationTokens}
- 总 token: ${view.tokens.totalTokens}

## 缓存与路由

- 模型路由缓存命中/未命中: ${summary.modelRouteHits}/${summary.modelRouteMisses} (${view.cache.modelRouteHitRate})
- 会话路由缓存命中/未命中: ${summary.sessionRouteHits}/${summary.sessionRouteMisses} (${view.cache.sessionRouteHitRate})

## 慢请求 Top 20

${slow}`;
}

function renderHtml(summary: DailySummary): string {
  const view = buildSummaryView(summary);
  const listSection = (
    title: string,
    entries: Array<{ key: string; count: number }>,
    empty = "无",
  ) => `
    <section class="panel">
      <h2>${title}</h2>
      ${
        entries.length === 0
          ? `<div class="empty">${empty}</div>`
          : `<ul>${entries
              .map(
                (entry) =>
                  `<li><span>${escapeHtml(entry.key)}</span><strong>${formatNumber(entry.count)}</strong></li>`,
              )
              .join("")}</ul>`
      }
    </section>
  `;
  const slowRows =
    view.slowRequests.length === 0
      ? `<tr><td colspan="6" class="empty-cell">无</td></tr>`
      : view.slowRequests
          .map(
            (item) => `<tr>
              <td class="mono">${escapeHtml(item.traceId)}</td>
              <td>${escapeHtml(item.latency)}</td>
              <td>${item.statusCode}</td>
              <td>${escapeHtml(item.provider)}</td>
              <td>${escapeHtml(item.model)}</td>
              <td>${escapeHtml(item.endpoint)}${item.failureKind ? ` <span class="muted">(${escapeHtml(item.failureKind)})</span>` : ""}</td>
            </tr>`,
          )
          .join("");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>auth2api 日报 ${summary.date}</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f7fb; color: #172033; }
    .wrap { max-width: 1120px; margin: 0 auto; padding: 32px 20px 48px; }
    h1 { margin: 0 0 8px; font-size: 30px; }
    .sub { color: #5b6475; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 20px; }
    .card, .panel { background: #fff; border: 1px solid #e4e8f0; border-radius: 8px; box-shadow: 0 1px 2px rgba(16,24,40,.04); }
    .card { padding: 16px; }
    .label { color: #667085; font-size: 13px; margin-bottom: 8px; }
    .value { font-size: 28px; font-weight: 700; }
    .panel { padding: 18px; margin-bottom: 16px; }
    .panel h2 { margin: 0 0 14px; font-size: 18px; }
    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    ul { list-style: none; padding: 0; margin: 0; }
    li { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-top: 1px solid #eef2f7; }
    li:first-child { border-top: none; padding-top: 0; }
    strong { font-weight: 600; }
    .kv { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 20px; }
    .kv-item { border-top: 1px solid #eef2f7; padding-top: 10px; }
    .kv-item:nth-child(-n+2) { border-top: none; padding-top: 0; }
    .kv-label { color: #667085; font-size: 13px; margin-bottom: 4px; }
    .kv-value { font-size: 20px; font-weight: 600; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { text-align: left; padding: 10px 12px; border-top: 1px solid #eef2f7; vertical-align: top; }
    th { color: #667085; font-weight: 600; font-size: 13px; background: #fafbfc; }
    tr:first-child th { border-top: none; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; word-break: break-all; }
    .muted, .empty, .empty-cell { color: #667085; }
    .empty-cell { text-align: center; padding: 20px 12px; }
    @media (max-width: 960px) {
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .two-col { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>auth2api 日报</h1>
    <div class="sub">${summary.date}</div>

    <div class="grid">
      <div class="card"><div class="label">请求数</div><div class="value">${formatNumber(view.requests)}</div></div>
      <div class="card"><div class="label">成功率</div><div class="value">${view.successRate}</div></div>
      <div class="card"><div class="label">P95 延迟</div><div class="value">${view.latency.p95}</div></div>
      <div class="card"><div class="label">总 Token</div><div class="value">${view.tokens.totalTokens}</div></div>
    </div>

    <section class="panel">
      <h2>总览</h2>
      <div class="kv">
        <div class="kv-item"><div class="kv-label">成功</div><div class="kv-value">${formatNumber(view.successes)}</div></div>
        <div class="kv-item"><div class="kv-label">失败</div><div class="kv-value">${formatNumber(view.failures)}</div></div>
        <div class="kv-item"><div class="kv-label">P50</div><div class="kv-value">${view.latency.p50}</div></div>
        <div class="kv-item"><div class="kv-label">P99</div><div class="kv-value">${view.latency.p99}</div></div>
      </div>
    </section>

    <div class="two-col">
      ${listSection("服务商分布", view.providerDistribution)}
      ${listSection("接口分布", view.endpointDistribution)}
    </div>

    <section class="panel">
      <h2>Token 用量</h2>
      <div class="kv">
        <div class="kv-item"><div class="kv-label">输入 token</div><div class="kv-value">${view.tokens.inputTokens}</div></div>
        <div class="kv-item"><div class="kv-label">输出 token</div><div class="kv-value">${view.tokens.outputTokens}</div></div>
        <div class="kv-item"><div class="kv-label">推理输出 token</div><div class="kv-value">${view.tokens.reasoningOutputTokens}</div></div>
        <div class="kv-item"><div class="kv-label">总 token</div><div class="kv-value">${view.tokens.totalTokens}</div></div>
        <div class="kv-item"><div class="kv-label">输入缓存命中 token</div><div class="kv-value">${view.tokens.promptCacheReadTokens}</div></div>
        <div class="kv-item"><div class="kv-label">输入缓存写入 token</div><div class="kv-value">${view.tokens.promptCacheCreationTokens}</div></div>
      </div>
    </section>

    <div class="two-col">
      ${listSection("失败类型", view.failureKinds)}
      <section class="panel">
        <h2>缓存与路由</h2>
        <div class="kv">
          <div class="kv-item"><div class="kv-label">模型路由缓存</div><div class="kv-value">${view.cache.modelRouteHits}/${view.cache.modelRouteMisses} (${view.cache.modelRouteHitRate})</div></div>
          <div class="kv-item"><div class="kv-label">会话路由缓存</div><div class="kv-value">${view.cache.sessionRouteHits}/${view.cache.sessionRouteMisses} (${view.cache.sessionRouteHitRate})</div></div>
        </div>
      </section>
    </div>

    <section class="panel">
      <h2>慢请求 Top 20</h2>
      <table>
        <thead>
          <tr>
            <th>追踪 ID</th>
            <th>延迟</th>
            <th>状态码</th>
            <th>服务商</th>
            <th>模型</th>
            <th>接口</th>
          </tr>
        </thead>
        <tbody>${slowRows}</tbody>
      </table>
    </section>
  </div>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
    body: MailBody,
    recipients: string[],
  ) => Promise<void>,
): Promise<DailyReportResult> {
  if (!isDateKey(options.date)) {
    throw new Error("date must be YYYY-MM-DD");
  }

  const summary = await readDailySummary(recorder, options.date);
  const summaryView = buildSummaryView(summary);
  const html = renderHtml(summary);
  const htmlFilePath = recorder.reportHtmlFilePath(options.date);
  fs.mkdirSync(path.dirname(htmlFilePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(htmlFilePath, html, { mode: 0o600 });

  let emailed = false;
  const recipients = config.observability.report.recipients;
  if (options.sendEmail && recipients.length > 0) {
    if (!sendMail) throw new Error("mail sender is not configured");
    const markdown = renderMarkdown(summary);
    await sendMail(
      `auth2api 日报 ${options.date}`,
      { text: markdown, html },
      recipients,
    );
    emailed = true;
  }

  return {
    date: options.date,
    summary: summaryView,
    html,
    htmlFilePath,
    emailed,
  };
}
