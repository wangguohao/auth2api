import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { loadConfig, resolveAuthDir } from "../src/config";

/** trace 内记录的 token 用量字段。 */
interface TraceUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  reasoningOutputTokens?: number;
}

/** trace 内记录的路由决策字段。 */
interface TraceRouting {
  providerReason?: string;
  accountReason?: string;
}

/** trace 内记录的缓存命中字段。 */
interface TraceCache {
  modelRoute?: string;
  sessionRoute?: string;
  promptCacheReadTokens?: number;
  promptCacheCreationTokens?: number;
}

/** trace 内记录的单次上游请求尝试。 */
interface TraceAttempt {
  attempt: number;
  provider: string;
  statusCode?: number;
  failureKind?: string | null;
  upstreamMs?: number;
  retryAfter?: string | null;
}

/** trace 内记录的单个耗时步骤。 */
interface TraceStep {
  name: string;
  ms: number;
}

/** CLI 读取 trace JSONL 时需要的最小事件结构。 */
interface TraceEvent {
  v: 1;
  traceId: string;
  endpoint: string;
  model: string | null;
  provider: string | null;
  statusCode: number;
  latencyMs: number;
  failureKind: string | null;
  routing?: TraceRouting;
  cache?: TraceCache;
  steps?: TraceStep[];
  attempts?: TraceAttempt[];
  usage?: TraceUsage | null;
}

/** CLI 参数解析后的结构。 */
interface Args {
  command: string;
  date?: string;
  traceId?: string;
  limit: number;
  configPath?: string;
  sendEmail: boolean;
  adminKey?: string;
}

/** 单个 trace step 的聚合耗时。 */
interface StepSummary {
  name: string;
  ms: number;
}

/** 解析 npm script 透传的命令行参数。 */
function parseArgs(argv: string[]): Args {
  const [command = "help", ...rest] = argv;
  const args: Args = { command, limit: 20, sendEmail: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const next = rest[i + 1];
    if (arg === "--date" && next) {
      args.date = next;
      i++;
    } else if (arg === "--trace-id" && next) {
      args.traceId = next;
      i++;
    } else if (arg === "--limit" && next) {
      args.limit = Math.max(1, Number(next) || args.limit);
      i++;
    } else if (arg === "--config" && next) {
      args.configPath = next;
      i++;
    } else if (arg === "--send-email") {
      args.sendEmail = true;
    } else if (arg === "--admin-key" && next) {
      args.adminKey = next;
      i++;
    }
  }
  return args;
}

/** 返回本地时区下的当天日期键。 */
function todayKey(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 校验日期参数是否为 YYYY-MM-DD。 */
function isDateKey(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** 根据 auth-dir 与日期定位 trace JSONL 文件。 */
function traceFilePath(authDir: string, date: string): string {
  return path.join(authDir, "observability", "traces", `trace-${date}.jsonl`);
}

/** 流式读取 trace 文件，跳过半写入或损坏的 JSON 行。 */
async function readTraceEvents(
  filePath: string,
  onEvent: (event: TraceEvent) => void,
): Promise<number> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`trace file not found: ${filePath}`);
  }
  let count = 0;
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, "utf-8"),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as TraceEvent;
      if (parsed?.v === 1 && parsed.traceId) {
        count++;
        onEvent(parsed);
      }
    } catch {
      // Ignore partial writes or manually edited bad lines.
    }
  }
  return count;
}

/** 将毫秒耗时格式化成人类可读文本。 */
function formatMs(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "n/a";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms * 100) / 100}ms`;
}

/** 按 step 名称聚合同名步骤耗时。 */
function stepMap(event: TraceEvent): Map<string, number> {
  const map = new Map<string, number>();
  for (const step of event.steps || []) {
    map.set(step.name, (map.get(step.name) || 0) + step.ms);
  }
  return map;
}

/** 返回按耗时倒序排列的步骤列表。 */
function sortedSteps(event: TraceEvent): StepSummary[] {
  return [...stepMap(event).entries()]
    .map(([name, ms]) => ({ name, ms }))
    .sort((a, b) => b.ms - a.ms);
}

/** 打印指定日期内最慢的 trace 摘要。 */
function printSlow(events: TraceEvent[], limit: number): void {
  const rows = events
    .slice()
    .sort((a, b) => b.latencyMs - a.latencyMs)
    .slice(0, limit);
  for (const ev of rows) {
    const topStep = sortedSteps(ev).find((s) => s.name !== "total");
    console.log(
      [
        ev.traceId,
        formatMs(ev.latencyMs),
        ev.statusCode,
        ev.provider || "unknown",
        ev.model || "unknown",
        ev.endpoint,
        topStep ? `top=${topStep.name}:${formatMs(topStep.ms)}` : "",
        ev.failureKind ? `failure=${ev.failureKind}` : "",
      ]
        .filter(Boolean)
        .join("  "),
    );
  }
}

/** 打印单个 trace 的完整 JSON。 */
function printTrace(event: TraceEvent): void {
  console.log(JSON.stringify(event, null, 2));
}

/** 基于 trace step、重试与缓存信息给出慢请求的启发式归因。 */
function explain(event: TraceEvent): string[] {
  const steps = stepMap(event);
  const attempts = event.attempts || [];
  const upstreamMs = steps.get("upstream_fetch_headers") || 0;
  const successMs = steps.get("success_handler") || 0;
  const totalMs = event.latencyMs || steps.get("total") || 0;
  const retryCount = Math.max(0, attempts.length - 1);
  const failedAttempts = attempts.filter(
    (a) => a.statusCode && a.statusCode >= 400,
  );
  const top = sortedSteps(event)
    .filter((s) => s.name !== "total")
    .slice(0, 5);

  let verdict = "未识别到单一主因，需要结合原始 trace 查看";
  if (retryCount > 0 || failedAttempts.length > 0) {
    verdict = "上游失败/限流后重试导致请求变慢";
  } else if (upstreamMs > Math.max(1000, totalMs * 0.6)) {
    verdict = "上游首包慢或上游排队耗时高";
  } else if (successMs > Math.max(1000, totalMs * 0.5)) {
    verdict = "响应转换/流式转发阶段耗时高";
  } else if ((steps.get("account_select") || 0) > 100) {
    verdict = "账号选择阶段异常偏慢";
  } else if (
    (event.cache?.promptCacheReadTokens || 0) === 0 &&
    event.usage?.inputTokens
  ) {
    verdict = "prompt cache 未命中，若输入较大可能推高耗时和成本";
  }

  const lines = [
    `traceId: ${event.traceId}`,
    `判断: ${verdict}`,
    "",
    "基本信息:",
    `- endpoint: ${event.endpoint}`,
    `- model/provider: ${event.model || "unknown"} / ${event.provider || "unknown"}`,
    `- status: ${event.statusCode} ${event.failureKind ? `(${event.failureKind})` : ""}`,
    `- total: ${formatMs(totalMs)}`,
    "",
    "主要耗时步骤:",
    ...top.map((s) => `- ${s.name}: ${formatMs(s.ms)}`),
    "",
    "路由/cache:",
    `- providerReason: ${event.routing?.providerReason || "n/a"}`,
    `- accountReason: ${event.routing?.accountReason || "n/a"}`,
    `- modelRoute: ${event.cache?.modelRoute || "n/a"}`,
    `- sessionRoute: ${event.cache?.sessionRoute || "n/a"}`,
    `- promptCacheReadTokens: ${event.cache?.promptCacheReadTokens ?? 0}`,
    "",
    "attempts:",
  ];
  if (attempts.length === 0) {
    lines.push("- 无");
  } else {
    for (const attempt of attempts) {
      lines.push(
        `- #${attempt.attempt} ${attempt.provider} status=${attempt.statusCode ?? "n/a"} failure=${attempt.failureKind ?? "none"} upstream=${formatMs(attempt.upstreamMs)} retryAfter=${attempt.retryAfter || "n/a"}`,
      );
    }
  }
  return lines;
}

/** 在指定 trace 文件内按 traceId 查找单个事件。 */
async function findTrace(
  filePath: string,
  traceId: string,
): Promise<TraceEvent | null> {
  let found: TraceEvent | null = null;
  await readTraceEvents(filePath, (event) => {
    if (event.traceId === traceId) found = event;
  });
  return found;
}

/** 调用运行中服务的管理接口生成日报。 */
async function triggerReport(
  args: Args,
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  const date = args.date || todayKey();
  const key = args.adminKey || config["bootstrap-admin-key"];
  if (!key)
    throw new Error(
      "--admin-key is required when bootstrap-admin-key is empty",
    );
  const host = config.host || "127.0.0.1";
  const response = await fetch(
    `http://${host}:${config.port}/admin/reports/daily`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ date, sendEmail: args.sendEmail }),
    },
  );
  const text = await response.text();
  if (!response.ok)
    throw new Error(`report request failed: ${response.status} ${text}`);
  console.log(text);
}

/** 输出可观测性 CLI 的使用说明。 */
function printHelp(): void {
  console.log(`Usage:
  npm run obs:slow -- --date YYYY-MM-DD --limit 20
  npm run obs:trace -- --date YYYY-MM-DD --trace-id <id>
  npm run obs:explain -- --date YYYY-MM-DD --trace-id <id>
  npm run obs:report -- --date YYYY-MM-DD [--send-email]

Options:
  --config <path>      config file path, defaults to config.yaml
  --admin-key <key>   admin key for obs:report, defaults to bootstrap-admin-key
`);
}

/** CLI 主入口。 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help" || args.command === "--help") {
    printHelp();
    return;
  }
  const config = loadConfig(args.configPath);
  if (args.command === "report") {
    await triggerReport(args, config);
    return;
  }

  const date = args.date || todayKey();
  if (!isDateKey(date)) throw new Error("--date must be YYYY-MM-DD");
  const filePath = traceFilePath(resolveAuthDir(config["auth-dir"]), date);

  if (args.command === "slow") {
    const events: TraceEvent[] = [];
    await readTraceEvents(filePath, (event) => events.push(event));
    printSlow(events, args.limit);
    return;
  }

  if (args.command === "trace" || args.command === "explain") {
    if (!args.traceId) throw new Error("--trace-id is required");
    const event = await findTrace(filePath, args.traceId);
    if (!event) throw new Error(`trace not found: ${args.traceId}`);
    if (args.command === "trace") printTrace(event);
    else console.log(explain(event).join("\n"));
    return;
  }

  printHelp();
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
