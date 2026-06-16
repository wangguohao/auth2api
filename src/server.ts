import express from "express";
import {
  Config,
  isDebugLevel,
  resolveTierLimit,
} from "./config";
import { ProviderRegistry } from "./providers/registry";
import { extractApiKey, hashApiKey } from "./utils/common";
import { ApiKeyRegistry } from "./auth/api-key-registry";
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
  apiKeyRegistry: ApiKeyRegistry,
  statsRecorder?: StatsRecorder,
): express.Application {
  const app = express();
  const ipRateLimitMap = new Map<string, { count: number; resetAt: number }>();
  const apiKeyRateLimitMap = new Map<string, { count: number; resetAt: number }>();
  const apiKeyConcurrencyMap = new Map<string, number>();

  // Cleanup stale entries every 5 minutes.
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of ipRateLimitMap) {
      if (now > entry.resetAt) ipRateLimitMap.delete(ip);
    }
    for (const [apiKeyHash, entry] of apiKeyRateLimitMap) {
      if (now > entry.resetAt) apiKeyRateLimitMap.delete(apiKeyHash);
    }
  }, 5 * 60 * 1000);
  cleanupTimer.unref();

  app.use(express.json({ limit: config["body-limit"] }));

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
      "Content-Type, Authorization, x-api-key",
    );
    if (_req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Rate limiting middleware
  app.use("/v1", (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const result = bumpFixedWindowCounter(ipRateLimitMap, ip, 60 * 1000, 60);
    if (!result.allowed) {
      res.status(429).json({ error: { message: "Too many requests" } });
      return;
    }
    next();
  });

  // API key auth middleware — accepts both OpenAI style (Authorization: Bearer)
  // and Anthropic style (x-api-key), so Claude Code and OpenAI clients both work
  const requireApiKey: express.RequestHandler = (req, res, next) => {
    const key = extractApiKey(req.headers);
    if (!key) {
      res.status(401).json({ error: { message: "Missing API key" } });
      return;
    }
    const auth = apiKeyRegistry.authenticate(key);
    if (!auth) {
      res.status(403).json({ error: { message: "Invalid API key" } });
      return;
    }
    // Seed res.locals.stats so the stats-finish middleware can record this
    // request even if the downstream handler aborts before filling in the
    // upstream account / model / usage fields.
    res.locals.authApiKey = key;
    res.locals.authApiKeyHash = hashApiKey(key);
    res.locals.authApiKeyTier = auth.record.tier;
    res.locals.authApiKeyRecord = auth.record;
    if (statsRecorder) {
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const ua = (req.headers["user-agent"] as string) || "";
      res.locals.stats = {
        apiKeyHash: res.locals.authApiKeyHash,
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

  const apiKeyRateLimitMiddleware: express.RequestHandler = (_req, res, next) => {
    const apiKeyHash = res.locals.authApiKeyHash as string | undefined;
    const apiKeyTier = res.locals.authApiKeyTier as ApiKeyTier | undefined;
    if (!apiKeyHash || !apiKeyTier) return next();

    const limits = apiKeyRegistry.resolveLimits(apiKeyTier);
    const result = bumpFixedWindowCounter(
      apiKeyRateLimitMap,
      apiKeyHash,
      5 * 60 * 60 * 1000,
      limits.maxRequests5h,
    );
    if (result.allowed) return next();

    if (res.locals.stats) {
      res.locals.stats.failureKind = "rate_limit";
    }
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((result.resetAt - Date.now()) / 1000),
    );
    res.setHeader("Retry-After", String(retryAfterSeconds));
    res.status(429).json({
      error: {
        message: "API key request limit exceeded for the configured tier window",
      },
    });
  };

  const apiKeyConcurrencyMiddleware: express.RequestHandler = (_req, res, next) => {
    const apiKeyHash = res.locals.authApiKeyHash as string | undefined;
    const apiKeyTier = res.locals.authApiKeyTier as ApiKeyTier | undefined;
    if (!apiKeyHash || !apiKeyTier) return next();

    const limits = apiKeyRegistry.resolveLimits(apiKeyTier);
    const current = apiKeyConcurrencyMap.get(apiKeyHash) || 0;
    if (current >= limits.concurrency) {
      if (res.locals.stats) {
        res.locals.stats.failureKind = "rate_limit";
      }
      res.setHeader("Retry-After", "1");
      res.status(429).json({
        error: {
          message: "API key concurrent request limit exceeded for the configured tier",
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
  app.get("/health", (_req, res) => {
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
  app.use("/admin", statsFinishMiddleware);

  // GET /admin/stats — three-axis aggregated call statistics.
  //   byClient — keyed by sha256(api-key); show short hex prefix to operator
  //   byAccount — keyed by `${provider}:${email}` (upstream OAuth account)
  //   byApi — keyed by `${endpoint}|${model}|${provider}`
  app.get("/admin/stats", (_req, res) => {
    if (!statsRecorder) {
      res.json({ enabled: false });
      return;
    }
    res.json({
      ...statsRecorder.getSnapshot(),
      generated_at: new Date().toISOString(),
    });
  });

  app.get("/admin/accounts", (_req, res) => {
    const providers: Record<
      string,
      { accounts: unknown[]; account_count: number }
    > = {};
    for (const p of registry.all()) {
      providers[p.id] = {
        accounts: p.manager.getSnapshots(),
        account_count: p.manager.accountCount,
      };
    }
    res.json({
      providers,
      generated_at: new Date().toISOString(),
    });
  });

  app.get("/admin/api-keys", (_req, res) => {
    res.json({
      keys: apiKeyRegistry.list().map(({ secret, ...rest }) => rest),
      generated_at: new Date().toISOString(),
    });
  });

  app.post("/admin/api-keys", (req, res) => {
    const tier = req.body?.tier as ApiKeyTier | undefined;
    const name = typeof req.body?.name === "string" ? req.body.name : undefined;
    const enabled = req.body?.enabled === undefined ? true : !!req.body.enabled;
    if (tier && tier !== "lite" && tier !== "pro" && tier !== "admin") {
      res.status(400).json({ error: { message: "Invalid tier" } });
      return;
    }
    if (tier === "admin" && enabled === false) {
      res.status(400).json({ error: { message: "Admin key cannot be disabled" } });
      return;
    }
    const created = apiKeyRegistry.createKey({ tier, name, enabled });
    res.status(201).json({
      key: {
        ...created.record,
        secret: created.secret,
      },
      generated_at: new Date().toISOString(),
    });
  });

  app.post("/admin/api-keys/:id/enable", (req, res) => {
    const id = req.params.id;
    try {
      const updated = apiKeyRegistry.updateKeyState(id, true);
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
      res.status(400).json({ error: { message } });
    }
  });

  app.post("/admin/api-keys/:id/disable", (req, res) => {
    const id = req.params.id;
    try {
      const updated = apiKeyRegistry.updateKeyState(id, false);
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
      res.status(400).json({ error: { message } });
    }
  });

  // POST /admin/reload — re-reads token files from auth-dir and reconciles
  // each provider's in-memory state. Called automatically by `--login` after
  // a successful re-auth (see notifyServerReload in src/index.ts), and
  // available for manual use via curl. See AccountManager.reload() for
  // upsert semantics.
  app.post("/admin/reload", async (_req, res) => {
    const reloaded: Record<string, unknown> = {};
    try {
      apiKeyRegistry.reload();
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

  app.use("/v1", requireApiKey);
  app.use("/v1", statsFinishMiddleware);
  app.use("/v1", apiKeyRateLimitMiddleware);
  app.use("/v1", apiKeyConcurrencyMiddleware);
  app.get("/v1/models", async (_req, res) => {
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
    "/v1/chat/completions",
    createChatCompletionsHandler(config, registry),
  );
  app.post("/v1/responses", createResponsesHandler(config, registry));

  // Routes — Anthropic native passthrough
  app.post("/v1/messages", createMessagesHandler(config, registry));
  app.post(
    "/v1/messages/count_tokens",
    createCountTokensHandler(config, registry),
  );

  return app;
}
