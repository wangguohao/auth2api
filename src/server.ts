import express from "express";
import { Config, isDebugLevel, resolveTierLimit } from "./config";
import { ProviderRegistry } from "./providers/registry";
import { extractApiKey, hashApiKey } from "./utils/common";
import { ApiKeyStore } from "./registry/api-key-store";
import { ApiKeyTier } from "./auth/types";
import {
  createChatCompletionsHandler,
  createResponsesHandler,
} from "./handlers/openai";
import {
  createMessagesHandler,
  createCountTokensHandler,
} from "./handlers/anthropic";
import { StatsRecorder } from "./stats/recorder";
import { presentStatsSnapshot } from "./stats/presenter";
import { ROUTES } from "./routes";
import {
  addTraceStep,
  makeTraceId,
  RequestTraceContext,
  TraceRecorder,
} from "./observability/trace";
import { generateDailyReport } from "./observability/report";
import { snapshotAccountStore } from "./registry/account-store";

/** 统计接口允许查询的最大自然日跨度。 */
const STATS_QUERY_MAX_DAYS = 7;
/** 统计接口接受的日期参数格式。 */
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 统计查询的半开时间区间，以及对外回显的自然日。 */
interface StatsDateRange {
  startAt: Date;
  endAt: Date;
  startDate: string;
  endDate: string;
}

/** 将本地时区日期格式化为 YYYY-MM-DD。 */
function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 解析 YYYY-MM-DD，并返回本地时区当天 00:00:00。 */
function startOfLocalDate(value: string): Date | null {
  if (!DATE_ONLY_PATTERN.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

/** 按本地日历增加天数，避免调用方手写毫秒计算。 */
function addLocalDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** Express query 可能是数组或对象，这里只接受单个字符串。 */
function queryStringParam(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** 解析 /admin/stats 的日期参数，默认当天，且限制在最近 7 天内。 */
function resolveStatsDateRange(
  query: express.Request["query"],
): { ok: true; range: StatsDateRange } | { ok: false; message: string } {
  const now = new Date();
  const today = startOfLocalDate(formatLocalDate(now))!;
  const earliest = addLocalDays(today, -(STATS_QUERY_MAX_DAYS - 1));
  const todayText = formatLocalDate(today);
  const date = queryStringParam(query.date);
  const startDateParam = queryStringParam(query.start_date ?? query.startDate);
  const endDateParam = queryStringParam(query.end_date ?? query.endDate);

  if (date && (startDateParam || endDateParam)) {
    return {
      ok: false,
      message: "date cannot be combined with start_date/end_date",
    };
  }

  const startDate = date || startDateParam || todayText;
  const endDate = date || endDateParam || startDate;
  const startAt = startOfLocalDate(startDate);
  const endDayStart = startOfLocalDate(endDate);
  if (!startAt || !endDayStart) {
    return { ok: false, message: "date must use YYYY-MM-DD format" };
  }

  const endAt = addLocalDays(endDayStart, 1);
  if (startAt > endDayStart) {
    return { ok: false, message: "start_date must be before end_date" };
  }
  if (startAt < earliest || endDayStart > today) {
    return { ok: false, message: "date range must be within the last 7 days" };
  }
  if (endAt.getTime() - startAt.getTime() > STATS_QUERY_MAX_DAYS * 86_400_000) {
    return { ok: false, message: "date range cannot exceed 7 days" };
  }

  return {
    ok: true,
    range: {
      startAt,
      endAt,
      startDate: formatLocalDate(startAt),
      endDate: formatLocalDate(endDayStart),
    },
  };
}

function bumpFixedWindowCounter(
  counters: Map<string, { count: number; resetAt: number }>,
  key: string,
  windowMs: number,
  maxCount: number,
): { allowed: boolean; resetAt: number } {
  const now = Date.now();
  const entry = counters.get(key);
  if (!entry || now > entry.resetAt) {
    const resetAt = now + windowMs;
    counters.set(key, { count: 1, resetAt });
    return { allowed: true, resetAt };
  }
  entry.count++;
  return { allowed: entry.count <= maxCount, resetAt: entry.resetAt };
}

export function createServer(
  config: Config,
  registry: ProviderRegistry,
  apiKeyRegistry: ApiKeyStore,
  statsRecorder?: StatsRecorder,
  traceRecorder?: TraceRecorder,
  sendMail?: (
    subject: string,
    body: { text: string; html?: string },
    recipients: string[],
  ) => Promise<void>,
): express.Application {
  const app = express();

  // nginx 反代后需要信任一层代理，Express 才能从 X-Forwarded-For
  // 中提取真实客户端 IP（而非 127.0.0.1）。值 1 表示信任紧邻的
  // 一跳（nginx），不信任更外层的 Cloudflare。
  app.set("trust proxy", 1);

  const ipRateLimitMap = new Map<string, { count: number; resetAt: number }>();
  const apiKeyRateLimitMap = new Map<
    string,
    { count: number; resetAt: number }
  >();
  const apiKeyConcurrencyMap = new Map<string, number>();

  // Cleanup stale entries every 5 minutes.
  const cleanupTimer = setInterval(
    () => {
      const now = Date.now();
      for (const [ip, entry] of ipRateLimitMap) {
        if (now > entry.resetAt) ipRateLimitMap.delete(ip);
      }
      for (const [apiKeyHash, entry] of apiKeyRateLimitMap) {
        if (now > entry.resetAt) apiKeyRateLimitMap.delete(apiKeyHash);
      }
    },
    5 * 60 * 1000,
  );
  cleanupTimer.unref();

  app.use(express.json({ limit: config["body-limit"] }));

  const traceStartMiddleware: express.RequestHandler = (req, res, next) => {
    if (!traceRecorder?.enabled) return next();
    const traceId = makeTraceId(req.headers["x-request-id"]);
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const ua = (req.headers["user-agent"] as string) || "";
    res.setHeader("x-request-id", traceId);
    res.locals.trace = {
      traceId,
      startedAt: performance.now(),
      startedAtIso: new Date().toISOString(),
      endpoint: `${req.method} ${req.baseUrl}${req.path}`,
      method: req.method,
      path: `${req.baseUrl}${req.path}`,
      ip,
      ua,
      model: null,
      provider: null,
      accountEmailHash: null,
      routing: {},
      cache: {
        sessionRoute: "none",
      },
      steps: [],
      attempts: [],
      failureKind: null,
      usage: null,
    } satisfies RequestTraceContext;
    let recorded = false;
    const recordTrace = (override?: {
      status: "success" | "failure";
      statusCode: number;
      failureKind: string | null;
    }) => {
      if (recorded) return;
      recorded = true;
      const ctx = res.locals.trace as RequestTraceContext | undefined;
      if (!ctx) return;
      const latencyMs = Date.now() - Date.parse(ctx.startedAtIso);
      const status =
        override?.status ??
        (res.statusCode >= 200 && res.statusCode < 300 ? "success" : "failure");
      traceRecorder.record({
        traceId: ctx.traceId,
        endpoint: ctx.endpoint,
        method: ctx.method,
        path: ctx.path,
        apiKeyHash: ctx.apiKeyHash,
        apiKeyName: ctx.apiKeyName,
        ip: ctx.ip,
        ua: ctx.ua,
        model: ctx.model,
        provider: ctx.provider,
        accountEmailHash: ctx.accountEmailHash,
        status,
        failureKind: override?.failureKind ?? ctx.failureKind,
        statusCode: override?.statusCode ?? res.statusCode,
        latencyMs,
        routing: ctx.routing,
        cache: ctx.cache,
        steps: [...ctx.steps, { name: "total", ms: latencyMs }],
        attempts: ctx.attempts,
        usage: ctx.usage,
      });
    };
    res.on("finish", () => recordTrace());
    res.on("close", () => {
      if (!res.writableEnded) {
        recordTrace({
          status: "failure",
          statusCode: 499,
          failureKind: "client_disconnect",
        });
      }
    });
    next();
  };

  if (isDebugLevel(config.debug, "verbose")) {
    app.use((req, res, next) => {
      const startedAt = Date.now();
      console.error(`[debug] ${req.method} ${req.originalUrl} started`);
      res.on("finish", () => {
        console.error(
          `[debug] ${req.method} ${req.originalUrl} -> ${res.statusCode} in ${Date.now() - startedAt}ms`,
        );
      });
      next();
    });
  }

  // CORS - restrict to localhost origins only
  const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
  app.use((_req, res, next) => {
    const origin = _req.headers.origin;
    if (origin && LOCALHOST_RE.test(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, x-api-key, x-request-id",
    );
    res.setHeader("Access-Control-Expose-Headers", "x-request-id");
    if (_req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Rate limiting middleware
  app.use("/v1", traceStartMiddleware);
  app.use("/v1", (req, res, next) => {
    const startedAt = performance.now();
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const result = bumpFixedWindowCounter(ipRateLimitMap, ip, 60 * 1000, 60);
    addTraceStep(res as any, "ip_rate_limit", startedAt);
    if (!result.allowed) {
      if (res.locals.trace) res.locals.trace.failureKind = "rate_limit";
      res.status(429).json({ error: { message: "Too many requests" } });
      return;
    }
    next();
  });

  // API key auth middleware — accepts both OpenAI style (Authorization: Bearer)
  // and Anthropic style (x-api-key), so Claude Code and OpenAI clients both work
  const requireApiKey: express.RequestHandler = (req, res, next) => {
    const startedAt = performance.now();
    const key = extractApiKey(req.headers);
    if (!key) {
      addTraceStep(res as any, "auth", startedAt);
      if (res.locals.trace) res.locals.trace.failureKind = "auth";
      res.status(401).json({ error: { message: "Missing API key" } });
      return;
    }
    const auth = apiKeyRegistry.authenticate(key);
    if (!auth) {
      addTraceStep(res as any, "auth", startedAt);
      if (res.locals.trace) res.locals.trace.failureKind = "auth";
      res.status(403).json({ error: { message: "Invalid API key" } });
      return;
    }
    // Seed res.locals.stats so the stats-finish middleware can record this
    // request even if the downstream handler aborts before filling in the
    // upstream account / model / usage fields.
    res.locals.authApiKey = key;
    res.locals.authApiKeyHash = hashApiKey(key);
    res.locals.authApiKeyName = auth.record.name || auth.record.id;
    res.locals.authApiKeyTier = auth.record.tier;
    res.locals.authApiKeyRecord = auth.record;
    if (res.locals.trace) {
      res.locals.trace.apiKeyHash = res.locals.authApiKeyHash;
      res.locals.trace.apiKeyName = res.locals.authApiKeyName;
    }
    addTraceStep(res as any, "auth", startedAt);
    if (statsRecorder) {
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const ua = (req.headers["user-agent"] as string) || "";
      res.locals.stats = {
        apiKeyHash: res.locals.authApiKeyHash,
        apiKeyName: res.locals.authApiKeyName,
        ip,
        ua,
        endpoint: `${req.method} ${req.baseUrl}${req.path}`,
        startedAt: Date.now(),
        model: null,
        provider: null,
        accountEmail: null,
        usage: null,
        failureKind: null,
      };
    }
    next();
  };

  const apiKeyRateLimitMiddleware: express.RequestHandler = (
    _req,
    res,
    next,
  ) => {
    const startedAt = performance.now();
    const apiKeyHash = res.locals.authApiKeyHash as string | undefined;
    const apiKeyTier = res.locals.authApiKeyTier as ApiKeyTier | undefined;
    if (!apiKeyHash || !apiKeyTier) {
      addTraceStep(res as any, "api_key_rate_limit", startedAt);
      return next();
    }

    const limits = apiKeyRegistry.resolveLimits(apiKeyTier);
    const result = bumpFixedWindowCounter(
      apiKeyRateLimitMap,
      apiKeyHash,
      5 * 60 * 60 * 1000,
      limits.maxRequests5h,
    );
    addTraceStep(res as any, "api_key_rate_limit", startedAt);
    if (result.allowed) return next();

    if (res.locals.stats) {
      res.locals.stats.failureKind = "rate_limit";
    }
    if (res.locals.trace) res.locals.trace.failureKind = "rate_limit";
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((result.resetAt - Date.now()) / 1000),
    );
    res.setHeader("Retry-After", String(retryAfterSeconds));
    res.status(429).json({
      error: {
        message:
          "API key request limit exceeded for the configured tier window",
      },
    });
  };

  const apiKeyConcurrencyMiddleware: express.RequestHandler = (
    _req,
    res,
    next,
  ) => {
    const startedAt = performance.now();
    const apiKeyHash = res.locals.authApiKeyHash as string | undefined;
    const apiKeyTier = res.locals.authApiKeyTier as ApiKeyTier | undefined;
    if (!apiKeyHash || !apiKeyTier) {
      addTraceStep(res as any, "api_key_concurrency", startedAt);
      return next();
    }

    const limits = apiKeyRegistry.resolveLimits(apiKeyTier);
    const current = apiKeyConcurrencyMap.get(apiKeyHash) || 0;
    if (current >= limits.concurrency) {
      addTraceStep(res as any, "api_key_concurrency", startedAt);
      if (res.locals.stats) {
        res.locals.stats.failureKind = "rate_limit";
      }
      if (res.locals.trace) res.locals.trace.failureKind = "rate_limit";
      res.setHeader("Retry-After", "1");
      res.status(429).json({
        error: {
          message:
            "API key concurrent request limit exceeded for the configured tier",
        },
      });
      return;
    }

    apiKeyConcurrencyMap.set(apiKeyHash, current + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = (apiKeyConcurrencyMap.get(apiKeyHash) || 1) - 1;
      if (next <= 0) apiKeyConcurrencyMap.delete(apiKeyHash);
      else apiKeyConcurrencyMap.set(apiKeyHash, next);
    };
    res.on("finish", release);
    res.on("close", release);
    addTraceStep(res as any, "api_key_concurrency", startedAt);
    next();
  };

  // Record one stats event per request that made it past auth. `finish`
  // covers normal responses; `close` covers client disconnects before the
  // response completed. A guard prevents the normal finish->close sequence
  // from double-counting.
  const statsFinishMiddleware: express.RequestHandler = (req, res, next) => {
    if (!statsRecorder) return next();
    let recorded = false;
    const recordStats = (override?: {
      status: "success" | "failure";
      statusCode: number;
      failureKind: string | null;
    }) => {
      if (recorded) return;
      recorded = true;
      const ctx = res.locals.stats as
        | {
            apiKeyHash: string;
            apiKeyName: string;
            ip: string;
            ua: string;
            endpoint: string;
            startedAt: number;
            model: string | null;
            provider: string | null;
            accountEmail: string | null;
            usage: any;
            failureKind: string | null;
          }
        | undefined;
      if (!ctx) return;
      const status: "success" | "failure" =
        override?.status ??
        (res.statusCode >= 200 && res.statusCode < 300 ? "success" : "failure");
      statsRecorder.record({
        apiKeyHash: ctx.apiKeyHash,
        apiKeyName: ctx.apiKeyName,
        ip: ctx.ip,
        ua: ctx.ua,
        endpoint: ctx.endpoint,
        model: ctx.model,
        provider: ctx.provider as any,
        accountEmail: ctx.accountEmail,
        status,
        failureKind: override?.failureKind ?? ctx.failureKind,
        statusCode: override?.statusCode ?? res.statusCode,
        latencyMs: Date.now() - ctx.startedAt,
        usage: ctx.usage,
      });
    };
    res.on("finish", () => recordStats());
    res.on("close", () => {
      if (!res.writableEnded) {
        recordStats({
          status: "failure",
          statusCode: 499,
          failureKind: "client_disconnect",
        });
      }
    });
    next();
  };

  // Health check (no account count to avoid info leak)
  app.get(ROUTES.health.path, (_req, res) => {
    res.json({ status: "ok" });
  });

  const requireAdminApiKey: express.RequestHandler = (req, res, next) => {
    requireApiKey(req, res, () => {
      const record = res.locals.authApiKeyRecord as
        | { tier?: ApiKeyTier; enabled?: boolean }
        | undefined;
      if (!record || record.tier !== "admin" || record.enabled === false) {
        res.status(403).json({ error: { message: "Admin API key required" } });
        return;
      }
      next();
    });
  };

  app.use("/admin", requireAdminApiKey);

  // GET /admin/stats — three-axis aggregated call statistics.
  //   byClient — keyed by API key name
  //   byAccount — keyed by `${provider}:${email}` (upstream OAuth account)
  //   byApi — keyed by `${endpoint}|${model}|${provider}`
  app.get(ROUTES.adminStats.path, (req, res) => {
    const locale = req.query.locale;
    if (!statsRecorder) {
      if (locale === "zh-CN") {
        res.json({ 已启用: false });
        return;
      }
      res.json({ enabled: false });
      return;
    }
    const rangeResult = resolveStatsDateRange(req.query);
    if (!rangeResult.ok) {
      res.status(400).json({ error: { message: rangeResult.message } });
      return;
    }
    const generatedAt = new Date().toISOString();
    const snapshot = statsRecorder.getSnapshotForRange(
      rangeResult.range.startAt,
      rangeResult.range.endAt,
    );
    if (locale === "zh-CN") {
      res.json({
        ...presentStatsSnapshot(snapshot, generatedAt),
        查询范围: {
          开始日期: rangeResult.range.startDate,
          结束日期: rangeResult.range.endDate,
        },
      });
      return;
    }
    res.json({
      ...snapshot,
      range: {
        start_date: rangeResult.range.startDate,
        end_date: rangeResult.range.endDate,
      },
      generated_at: generatedAt,
    });
  });

  app.get(ROUTES.adminAccounts.path, (_req, res) => {
    res.json({
      providers: snapshotAccountStore(registry.all()),
      generated_at: new Date().toISOString(),
    });
  });

  app.post(ROUTES.adminAccountsUsageRefresh.path, async (req, res) => {
    const providerId = req.body?.provider;
    const email =
      typeof req.body?.email === "string" ? req.body.email : undefined;
    if (
      providerId !== undefined &&
      providerId !== "anthropic" &&
      providerId !== "codex" &&
      providerId !== "cursor"
    ) {
      res.status(400).json({ error: { message: "Invalid provider" } });
      return;
    }

    const providers = providerId
      ? registry.all().filter((provider) => provider.id === providerId)
      : registry.all();
    const refreshed: Record<string, unknown> = {};
    for (const provider of providers) {
      try {
        refreshed[provider.id] = await provider.manager.refreshUsage(email);
      } catch (err: any) {
        refreshed[provider.id] = { error: err?.message || String(err) };
      }
    }

    res.json({
      refreshed,
      generated_at: new Date().toISOString(),
    });
  });

  app.get(ROUTES.adminAccountsDecision.path, (req, res) => {
    const explicitProvider = req.query.provider;
    const model = typeof req.query.model === "string" ? req.query.model : null;
    const sessionKey =
      typeof req.query.sessionKey === "string"
        ? req.query.sessionKey
        : undefined;
    const path =
      typeof req.query.path === "string" ? req.query.path : undefined;
    const apiKeyTier =
      req.query.apiKeyTier === "lite" ||
      req.query.apiKeyTier === "pro" ||
      req.query.apiKeyTier === "admin"
        ? req.query.apiKeyTier
        : undefined;

    let providerId: "anthropic" | "codex" | "cursor";
    let providerRoute:
      | {
          model: string;
          resolvedModel: string;
          provider: string;
          reason: string;
          cacheHit: boolean;
        }
      | undefined;

    if (
      explicitProvider === "anthropic" ||
      explicitProvider === "codex" ||
      explicitProvider === "cursor"
    ) {
      providerId = explicitProvider;
    } else if (model) {
      const routed = registry.forModelWithDecision(model);
      providerId = routed.provider.id;
      providerRoute = routed.decision;
    } else {
      res.status(400).json({
        error: { message: "provider or model is required" },
      });
      return;
    }

    const provider = registry.get(providerId);
    const inspection = provider.manager.inspectNextAccount({
      sessionKey,
      model: model || undefined,
      path,
      apiKeyTier,
    });
    res.json({
      provider: providerId,
      provider_route: providerRoute,
      inspection,
      generated_at: new Date().toISOString(),
    });
  });

  app.get(ROUTES.adminApiKeys.path, (_req, res) => {
    res.json({
      keys: apiKeyRegistry.list().map(({ secret, ...rest }) => rest),
      generated_at: new Date().toISOString(),
    });
  });

  app.post(ROUTES.adminApiKeysCreate.path, async (req, res) => {
    const tier = req.body?.tier as ApiKeyTier | undefined;
    const name = typeof req.body?.name === "string" ? req.body.name : undefined;
    const enabled = req.body?.enabled === undefined ? true : !!req.body.enabled;
    if (tier && tier !== "lite" && tier !== "pro" && tier !== "admin") {
      res.status(400).json({ error: { message: "Invalid tier" } });
      return;
    }
    if (tier === "admin" && enabled === false) {
      res
        .status(400)
        .json({ error: { message: "Admin key cannot be disabled" } });
      return;
    }
    try {
      const created = apiKeyRegistry.createKey({ tier, name, enabled });
      await apiKeyRegistry.flushPending();
      res.status(201).json({
        key: {
          ...created.record,
          secret: created.secret,
        },
        generated_at: new Date().toISOString(),
      });
    } catch (err: any) {
      const message = err?.message || "Failed to persist API key";
      if (
        message.startsWith("API key name already exists:") ||
        message === "API key name cannot be empty"
      ) {
        res.status(400).json({ error: { message } });
        return;
      }
      res.status(500).json({
        error: { message },
      });
    }
  });

  app.post(ROUTES.adminApiKeysEnable.path, async (req, res) => {
    const id = req.params.id;
    try {
      const updated = apiKeyRegistry.updateKeyState(id, true);
      await apiKeyRegistry.flushPending();
      res.json({
        key: updated.record,
        generated_at: new Date().toISOString(),
      });
    } catch (err: any) {
      const message = err?.message || String(err);
      if (message.startsWith("API key not found:")) {
        res.status(404).json({ error: { message } });
        return;
      }
      const status = message === "Admin key cannot be disabled" ? 400 : 500;
      res.status(status).json({ error: { message } });
    }
  });

  app.post(ROUTES.adminApiKeysDisable.path, async (req, res) => {
    const id = req.params.id;
    try {
      const updated = apiKeyRegistry.updateKeyState(id, false);
      await apiKeyRegistry.flushPending();
      res.json({
        key: updated.record,
        generated_at: new Date().toISOString(),
      });
    } catch (err: any) {
      const message = err?.message || String(err);
      if (message.startsWith("API key not found:")) {
        res.status(404).json({ error: { message } });
        return;
      }
      const status = message === "Admin key cannot be disabled" ? 400 : 500;
      res.status(status).json({ error: { message } });
    }
  });

  // POST /admin/reload — re-reads token files from auth-dir and reconciles
  // each provider's in-memory state. Called automatically by `--login` after
  // a successful re-auth (see notifyServerReload in src/index.ts), and
  // available for manual use via curl. See AccountManager.reload() for
  // upsert semantics.
  app.post(ROUTES.adminReload.path, async (_req, res) => {
    const reloaded: Record<string, unknown> = {};
    try {
      await apiKeyRegistry.reload();
      statsRecorder?.setApiKeyNamesByHash(apiKeyRegistry.getNameByHash());
      reloaded["api-keys"] = { ok: true };
    } catch (err: any) {
      reloaded["api-keys"] = { error: err?.message || String(err) };
    }
    for (const p of registry.all()) {
      try {
        reloaded[p.id] = await p.manager.reload();
      } catch (err: any) {
        reloaded[p.id] = { error: err?.message || String(err) };
      }
    }
    res.json({
      reloaded,
      generated_at: new Date().toISOString(),
    });
  });

  app.post(ROUTES.adminDailyReport.path, async (req, res) => {
    if (!traceRecorder) {
      res.status(503).json({ error: { message: "Observability is disabled" } });
      return;
    }
    const date = req.body?.date;
    const sendEmail = req.body?.sendEmail !== false;
    if (typeof date !== "string") {
      res.status(400).json({ error: { message: "date is required" } });
      return;
    }
    try {
      const result = await generateDailyReport(
        config,
        traceRecorder,
        { date, sendEmail },
        sendMail,
      );
      traceRecorder.prune();
      res.json({
        date: result.date,
        summary: result.summary,
        htmlFilePath: result.htmlFilePath,
        emailed: result.emailed,
        html: result.html,
      });
    } catch (err: any) {
      res.status(400).json({ error: { message: err?.message || String(err) } });
    }
  });

  app.use("/v1", requireApiKey);
  app.use("/v1", statsFinishMiddleware);
  app.use("/v1", apiKeyRateLimitMiddleware);
  app.use("/v1", apiKeyConcurrencyMiddleware);
  app.get(ROUTES.v1Models.path, async (_req, res) => {
    const created = Math.floor(Date.now() / 1000);
    const providers = registry.withAccounts();
    const lists = await Promise.all(providers.map((p) => p.listModels()));
    const data = lists.flatMap((models) =>
      models.map((m) => ({
        id: m.id,
        object: "model",
        created,
        owned_by: m.owned_by,
      })),
    );
    res.json({ object: "list", data });
  });

  // Routes — OpenAI compatible
  app.post(
    ROUTES.v1ChatCompletions.path,
    createChatCompletionsHandler(config, registry),
  );
  app.post(ROUTES.v1Responses.path, createResponsesHandler(config, registry));

  // Routes — Anthropic native passthrough
  app.post(ROUTES.v1Messages.path, createMessagesHandler(config, registry));
  app.post(
    ROUTES.v1CountTokens.path,
    createCountTokensHandler(config, registry),
  );

  return app;
}
