import path from "node:path";
import {
  AuthErrorEvent,
  authErrorFilePath,
  readAuthErrorEvents,
} from "../src/observability/auth-errors";
import { loadConfig, resolveAuthDir } from "../src/config";

/** CLI 参数解析后的结构。 */
interface Args {
  command: string;
  help: boolean;
  date?: string;
  email?: string;
  accountUuid?: string;
  reason?: string;
  limit: number;
  configPath?: string;
}

/** 认证错误摘要聚合结果。 */
interface AuthErrorSummaryRow {
  key: string;
  provider: string;
  email: string;
  accountUuid: string;
  reason: string;
  total: number;
  terminal: number;
  actions: Set<string>;
  hosts: Set<string>;
  pids: Set<number>;
  refreshTokenHashes: Set<string>;
  latestAt: string;
}

/** 解析 npm script 透传的命令行参数。 */
function parseArgs(argv: string[]): Args {
  const [command = "help", ...rest] = argv;
  const args: Args = { command, help: false, limit: 20 };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const next = rest[i + 1];
    if (arg === "--help") {
      args.help = true;
    } else if (arg === "--date" && next) {
      args.date = next;
      i++;
    } else if (arg === "--email" && next) {
      args.email = next;
      i++;
    } else if (arg === "--account-uuid" && next) {
      args.accountUuid = next;
      i++;
    } else if (arg === "--reason" && next) {
      args.reason = next;
      i++;
    } else if (arg === "--limit" && next) {
      args.limit = Math.max(1, Number(next) || args.limit);
      i++;
    } else if (arg === "--config" && next) {
      args.configPath = next;
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

/** 按条件过滤认证错误事件。 */
function matchEvent(event: AuthErrorEvent, args: Args): boolean {
  if (args.email && event.email !== args.email) return false;
  if (args.accountUuid && event.accountUuid !== args.accountUuid) return false;
  if (args.reason && (event.reason || event.kind) !== args.reason) return false;
  return true;
}

/** 汇总认证错误，方便快速识别同账号/同 UUID 的重复失效模式。 */
function summarize(events: AuthErrorEvent[]): AuthErrorSummaryRow[] {
  const map = new Map<string, AuthErrorSummaryRow>();
  for (const event of events) {
    const reason = event.reason || event.kind;
    const key = [
      event.provider,
      event.email,
      event.accountUuid || "none",
      reason,
    ].join("|");
    const row = map.get(key) || {
      key,
      provider: event.provider,
      email: event.email,
      accountUuid: event.accountUuid || "none",
      reason,
      total: 0,
      terminal: 0,
      actions: new Set<string>(),
      hosts: new Set<string>(),
      pids: new Set<number>(),
      refreshTokenHashes: new Set<string>(),
      latestAt: event.ts,
    };
    row.total++;
    if (event.terminal) row.terminal++;
    row.actions.add(event.action);
    row.hosts.add(event.hostname);
    row.pids.add(event.pid);
    row.refreshTokenHashes.add(event.refreshTokenHash);
    if (event.ts > row.latestAt) row.latestAt = event.ts;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return b.latestAt.localeCompare(a.latestAt);
  });
}

/** 打印摘要结果。 */
function printSummary(rows: AuthErrorSummaryRow[], limit: number): void {
  for (const row of rows.slice(0, limit)) {
    console.log(
      [
        row.latestAt,
        `provider=${row.provider}`,
        `email=${row.email}`,
        `accountUuid=${row.accountUuid}`,
        `reason=${row.reason}`,
        `total=${row.total}`,
        `terminal=${row.terminal}`,
        `actions=${[...row.actions].join(",")}`,
        `hosts=${[...row.hosts].join(",")}`,
        `pids=${[...row.pids].join(",")}`,
        `refreshTokens=${row.refreshTokenHashes.size}`,
      ].join("  "),
    );
  }
}

/** 打印原始事件明细，便于人工逐条排查。 */
function printTrace(events: AuthErrorEvent[], limit: number): void {
  const rows = events
    .slice()
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, limit);
  for (const event of rows) {
    console.log(JSON.stringify(event, null, 2));
  }
}

/** 输出 CLI 使用说明。 */
function printHelp(): void {
  console.log(`Usage:
  npm run auth:error-summary -- --date YYYY-MM-DD [--email <email>] [--account-uuid <uuid>] [--reason <reason>] [--limit 20]
  npm run auth:error-trace -- --date YYYY-MM-DD [--email <email>] [--account-uuid <uuid>] [--reason <reason>] [--limit 20]

Options:
  --config <path>        config file path, defaults to config.yaml
  --email <email>        filter by exact account email
  --account-uuid <uuid>  filter by exact account UUID
  --reason <reason>      filter by reason or kind, e.g. invalidated / reused / refresh_failed
`);
}

/** CLI 主入口。 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.command === "help" || args.command === "--help") {
    printHelp();
    return;
  }
  const config = loadConfig(args.configPath);
  const date = args.date || todayKey();
  if (!isDateKey(date)) throw new Error("--date must be YYYY-MM-DD");
  const filePath = authErrorFilePath(resolveAuthDir(config["auth-dir"]), date);
  const events: AuthErrorEvent[] = [];
  await readAuthErrorEvents(filePath, (event) => {
    if (matchEvent(event, args)) events.push(event);
  });

  if (args.command === "summary") {
    printSummary(summarize(events), args.limit);
    return;
  }
  if (args.command === "trace") {
    printTrace(events, args.limit);
    return;
  }
  printHelp();
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
