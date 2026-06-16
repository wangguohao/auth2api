import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { ProviderId } from "../auth/types";
import { ObservabilityConfig } from "../config";
import { UsageData } from "../accounts/manager";

export interface TraceStep {
  name: string;
  ms: number;
}

export interface TraceCacheInfo {
  modelRoute?: "hit" | "miss" | "skip";
  sessionRoute?: "hit" | "miss" | "none";
  promptCacheReadTokens?: number;
  promptCacheCreationTokens?: number;
}

export interface TraceRoutingInfo {
  model?: string;
  resolvedModel?: string;
  provider?: ProviderId;
  providerReason?: string;
  accountReason?: string;
  accountEmailHash?: string;
  attemptCount?: number;
}

export interface TraceAttempt {
  attempt: number;
  provider: ProviderId;
  accountEmailHash: string;
  statusCode?: number;
  failureKind?: string | null;
  upstreamMs?: number;
  retryAfter?: string | null;
}

export interface RequestTraceContext {
  traceId: string;
  startedAt: number;
  startedAtIso: string;
  endpoint: string;
  method: string;
  path: string;
  apiKeyHash?: string;
  apiKeyName?: string;
  ip: string;
  ua: string;
  model: string | null;
  provider: ProviderId | null;
  accountEmailHash: string | null;
  routing: TraceRoutingInfo;
  cache: TraceCacheInfo;
  steps: TraceStep[];
  attempts: TraceAttempt[];
  failureKind: string | null;
  usage: UsageData | null;
}

export interface TraceEvent {
  v: 1;
  ts: string;
  traceId: string;
  endpoint: string;
  method: string;
  path: string;
  apiKeyHash?: string;
  apiKeyName?: string;
  ip: string;
  ua: string;
  model: string | null;
  provider: ProviderId | null;
  accountEmailHash: string | null;
  status: "success" | "failure";
  failureKind: string | null;
  statusCode: number;
  latencyMs: number;
  routing: TraceRoutingInfo;
  cache: TraceCacheInfo;
  steps: TraceStep[];
  attempts: TraceAttempt[];
  usage: UsageData | null;
}

type ResLike = { locals: { trace?: RequestTraceContext; stats?: any } };

export function makeTraceId(headerValue: unknown): string {
  if (typeof headerValue === "string" && headerValue.trim()) {
    return headerValue.trim().slice(0, 128);
  }
  if (Array.isArray(headerValue)) {
    const first = headerValue.find((v) => typeof v === "string" && v.trim());
    if (first) return first.trim().slice(0, 128);
  }
  return randomUUID();
}

export function roundMs(ms: number): number {
  return Math.max(0, Math.round(ms * 100) / 100);
}

export function addTraceStep(
  res: ResLike,
  name: string,
  startedAt: number,
): void {
  const trace = res.locals.trace;
  if (!trace) return;
  trace.steps.push({ name, ms: roundMs(performance.now() - startedAt) });
}

export function markTraceModel(
  res: ResLike,
  model: string,
  provider: ProviderId,
): void {
  const trace = res.locals.trace;
  if (!trace) return;
  trace.model = model;
  trace.provider = provider;
  trace.routing.model = model;
  trace.routing.provider = provider;
}

export function mergeTraceRouting(
  res: ResLike,
  patch: Partial<TraceRoutingInfo>,
): void {
  const trace = res.locals.trace;
  if (!trace) return;
  trace.routing = { ...trace.routing, ...patch };
  if (patch.provider) trace.provider = patch.provider;
  if (patch.model) trace.model = patch.model;
}

export function mergeTraceCache(
  res: ResLike,
  patch: Partial<TraceCacheInfo>,
): void {
  const trace = res.locals.trace;
  if (!trace) return;
  trace.cache = { ...trace.cache, ...patch };
}

export function addTraceAttempt(res: ResLike, attempt: TraceAttempt): void {
  const trace = res.locals.trace;
  if (!trace) return;
  trace.attempts.push(attempt);
  trace.routing.attemptCount = trace.attempts.length;
}

export function tagTraceUsage(res: ResLike, usage: UsageData): void {
  const trace = res.locals.trace;
  if (!trace) return;
  trace.usage = usage;
  trace.cache.promptCacheReadTokens = usage.cacheReadInputTokens;
  trace.cache.promptCacheCreationTokens = usage.cacheCreationInputTokens;
}

export function traceDateKey(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function previousDateKey(date: Date, timezone: string): string {
  return traceDateKey(new Date(date.getTime() - 24 * 60 * 60 * 1000), timezone);
}

export function isDateKey(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export class TraceRecorder {
  private authDir: string;
  private config: ObservabilityConfig;
  private stream: fs.WriteStream | null = null;
  private streamDateKey: string | null = null;

  constructor(authDir: string, config: ObservabilityConfig) {
    this.authDir = authDir;
    this.config = config;
  }

  get enabled(): boolean {
    return this.config.enabled && this.config.trace.enabled;
  }

  traceDir(): string {
    return path.join(this.authDir, "observability", "traces");
  }

  traceFilePath(dateKey: string): string {
    return path.join(this.traceDir(), `trace-${dateKey}.jsonl`);
  }

  reportDir(): string {
    return path.join(this.authDir, "observability", "reports");
  }

  reportFilePath(dateKey: string): string {
    return path.join(this.reportDir(), `daily-${dateKey}.md`);
  }

  record(input: Omit<TraceEvent, "v" | "ts">): void {
    if (!this.enabled) return;
    const event: TraceEvent = {
      v: 1,
      ts: new Date().toISOString(),
      ...input,
    };
    const dateKey = traceDateKey(new Date(), this.config.report.timezone);
    const stream = this.openStream(dateKey);
    stream.write(JSON.stringify(event) + "\n");
  }

  prune(): void {
    this.pruneDir(
      this.traceDir(),
      /^trace-(\d{4}-\d{2}-\d{2})\.jsonl$/,
      this.config.trace.retentionDays,
    );
    this.pruneDir(
      this.reportDir(),
      /^daily-(\d{4}-\d{2}-\d{2})\.md$/,
      this.config.report.retentionDays,
    );
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.stream) return resolve();
      this.stream.end(() => resolve());
      this.stream = null;
      this.streamDateKey = null;
    });
  }

  private openStream(dateKey: string): fs.WriteStream {
    if (this.stream && this.streamDateKey === dateKey) return this.stream;
    if (this.stream) this.stream.end();
    fs.mkdirSync(this.traceDir(), { recursive: true, mode: 0o700 });
    this.stream = fs.createWriteStream(this.traceFilePath(dateKey), {
      flags: "a",
      mode: 0o600,
    });
    this.stream.on("error", (err) => {
      console.error("[observability] trace write stream error:", err.message);
    });
    this.streamDateKey = dateKey;
    return this.stream;
  }

  private pruneDir(dir: string, pattern: RegExp, retentionDays: number): void {
    if (!fs.existsSync(dir)) return;
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      const match = pattern.exec(name);
      if (!match) continue;
      const fileDate = new Date(`${match[1]}T00:00:00.000Z`).getTime();
      if (Number.isFinite(fileDate) && fileDate < cutoff) {
        fs.unlinkSync(path.join(dir, name));
      }
    }
  }
}
