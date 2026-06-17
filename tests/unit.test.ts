import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";

import { extractApiKey, hashApiKey, timeout } from "../src/utils/common";
import { combineAbortSignals } from "../src/utils/abort";
import { classifyFailure, proxyWithRetry } from "../src/utils/http";
import { handleStreamingResponse } from "../src/upstream/streaming";
import {
  resolveModel,
  openaiToAnthropic,
  anthropicToOpenai,
  createStreamState,
  anthropicSSEToChat,
  responsesToAnthropic,
  anthropicToResponses,
  makeResponsesState,
  anthropicSSEToResponses,
} from "../src/upstream/translator";
import {
  loadConfig,
  isDebugLevel,
  resolveApiKeyRateLimit,
  resolveAuthDir,
} from "../src/config";
import { AccountManager, UsageData } from "../src/accounts/manager";
import { ApiKeyRegistry } from "../src/auth/api-key-registry";
import { buildSessionBindingKey } from "../src/routing/session";
import { parseRoutingExtraArg } from "../src/auth/routing-extra";
import { createMailSender } from "../src/observability/mail";

// ══════════════════════════════════════════════════
// utils/common.ts
// ══════════════════════════════════════════════════

test("extractApiKey extracts Bearer token", () => {
  assert.equal(
    extractApiKey({ authorization: "Bearer sk-test-123" }),
    "sk-test-123",
  );
});

test("extractApiKey extracts x-api-key header", () => {
  assert.equal(extractApiKey({ "x-api-key": "sk-test-456" }), "sk-test-456");
});

test("buildSessionBindingKey scopes session ids by client key hash", () => {
  assert.equal(
    buildSessionBindingKey("client-hash", "session-1"),
    "client-hash:session-1",
  );
  assert.equal(buildSessionBindingKey(undefined, "session-1"), "session-1");
  assert.equal(buildSessionBindingKey("client-hash", undefined), undefined);
});

test("parseRoutingExtraArg parses routing bias and level", () => {
  assert.equal(parseRoutingExtraArg(undefined), undefined);
  assert.deepEqual(parseRoutingExtraArg('{"bias":1}'), { bias: 1 });
  assert.deepEqual(parseRoutingExtraArg('{"level":"pro"}'), { level: "pro" });
  assert.deepEqual(parseRoutingExtraArg('{"bias":1,"level":"lite"}'), {
    bias: 1,
    level: "lite",
  });
});

test("parseRoutingExtraArg rejects invalid JSON and legacy fields", () => {
  assert.throws(() => parseRoutingExtraArg("{"), /Invalid --routingExtra JSON/);
  assert.throws(
    () => parseRoutingExtraArg('{"weight":1}'),
    /Unsupported --routingExtra field: weight/,
  );
  assert.throws(
    () => parseRoutingExtraArg('{"routingBias":1}'),
    /Unsupported --routingExtra field: routingBias/,
  );
});

test("extractApiKey prefers Bearer over x-api-key", () => {
  assert.equal(
    extractApiKey({
      authorization: "Bearer sk-bearer",
      "x-api-key": "sk-xapi",
    }),
    "sk-bearer",
  );
});

test("extractApiKey returns empty string when no key", () => {
  assert.equal(extractApiKey({}), "");
});

test("extractApiKey handles x-api-key as array", () => {
  assert.equal(
    extractApiKey({ "x-api-key": ["sk-first", "sk-second"] }),
    "sk-first",
  );
});

test("hashApiKey returns consistent sha256 hex", () => {
  const hash1 = hashApiKey("test-key");
  const hash2 = hashApiKey("test-key");
  assert.equal(hash1, hash2);
  assert.equal(hash1.length, 64);
  assert.match(hash1, /^[a-f0-9]{64}$/);
});

test("hashApiKey returns different hashes for different keys", () => {
  assert.notEqual(hashApiKey("key-a"), hashApiKey("key-b"));
});

test("timeout resolves after delay", async () => {
  const start = Date.now();
  await timeout(50);
  assert.ok(Date.now() - start >= 45);
});

test("combineAbortSignals aborts when any input signal aborts", async () => {
  const first = new AbortController();
  const second = new AbortController();
  const combined = combineAbortSignals([first.signal, second.signal]);

  assert.equal(combined.aborted, false);
  second.abort(new Error("client disconnected"));

  assert.equal(combined.aborted, true);
  assert.match(String(combined.reason), /client disconnected/);
});

// ══════════════════════════════════════════════════
// utils/http.ts
// ══════════════════════════════════════════════════

test("classifyFailure maps status codes correctly", () => {
  assert.equal(classifyFailure(429), "rate_limit");
  assert.equal(classifyFailure(401), "auth");
  assert.equal(classifyFailure(403), "forbidden");
  assert.equal(classifyFailure(500), "server");
  assert.equal(classifyFailure(502), "server");
  assert.equal(classifyFailure(503), "server");
  assert.equal(classifyFailure(418), "server");
});

function makeMockResponse(): any {
  const resp = new EventEmitter() as any;
  resp.headers = {};
  resp.chunks = [];
  resp.locals = {};
  resp.headersSent = false;
  resp.destroyed = false;
  resp.setHeader = (key: string, value: string) => {
    resp.headers[key.toLowerCase()] = value;
    return resp;
  };
  resp.status = (code: number) => {
    resp.statusCode = code;
    return resp;
  };
  resp.json = (body: any) => {
    resp.body = body;
    resp.headersSent = true;
    return resp;
  };
  resp.flushHeaders = () => {
    resp.headersSent = true;
  };
  resp.write = (chunk: Uint8Array | string) => {
    resp.chunks.push(chunk);
    return true;
  };
  resp.end = () => {
    resp.ended = true;
    resp.headersSent = true;
    return resp;
  };
  return resp;
}

test("handleStreamingResponse does not complete when client disconnects", async () => {
  const encoder = new TextEncoder();
  const upstream = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: message_delta\ndata: {"usage":{"output_tokens":1}}\n\n',
          ),
        );
      },
      cancel() {
        /* expected when the client disconnects */
      },
    }),
  );
  const resp = makeMockResponse();
  resp.write = (chunk: Uint8Array | string) => {
    resp.chunks.push(chunk);
    resp.emit("close");
    return true;
  };

  const result = await handleStreamingResponse(upstream, resp);

  assert.equal(result.clientDisconnected, true);
  assert.equal(result.completed, false);
});

test("handleStreamingResponse flushes the final un-terminated SSE event through onEvent", async () => {
  // Regression cover for: "transformed streaming still drops an
  // unterminated final event". When the upstream closes the stream
  // without a trailing newline after the last `data:` line, the
  // transformer (e.g. responsesSSEToChat) must still receive that
  // final event so it can emit the [DONE]/finish_reason chunk and so
  // usage tracking lands. Previously `handleStreamingResponse` did an
  // `if (done) break;` which silently dropped the leftover line.
  const encoder = new TextEncoder();
  const upstream = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: response.output_text.delta\ndata: {"delta":"hi"}\n\n',
          ),
        );
        // Final event has NO trailing \n\n on purpose.
        controller.enqueue(
          encoder.encode(
            'event: response.completed\ndata: {"response":{"status":"completed","usage":{"input_tokens":7,"output_tokens":3}}}',
          ),
        );
        controller.close();
      },
    }),
  );

  const resp = makeMockResponse();
  const observed: Array<{ event: string; data: any }> = [];
  const result = await handleStreamingResponse(upstream, resp, {
    onEvent: (event, data) => {
      observed.push({ event, data });
      // Emit the equivalent of a finish chunk on completed.
      if (event === "response.completed") {
        return ["data: [DONE]\n\n"];
      }
      return [];
    },
  });

  // The completed event must reach the transformer.
  assert.ok(
    observed.some((e) => e.event === "response.completed"),
    "response.completed must be observed even without trailing newline",
  );
  // [DONE] chunk must have been written to the client.
  const written = resp.chunks.map((c: any) => String(c)).join("");
  assert.match(written, /data: \[DONE\]/);
  // Usage must have been extracted from the final completed event.
  assert.equal(result.completed, true);
  assert.equal(result.usage.inputTokens, 7);
  assert.equal(result.usage.outputTokens, 3);
});

test("handleStreamingResponse extracts usage from final un-terminated event in pass-through mode", async () => {
  // Pass-through (no onEvent) writes raw bytes immediately so the
  // client always sees them, but `extractUsageFromSSE` also needs to
  // run on the final un-terminated event so the upstream's reported
  // usage lands in result.usage. Without the flush fix, the final
  // line stayed in `buffer` and usage was zero.
  const encoder = new TextEncoder();
  const upstream = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: message_delta\ndata: {"usage":{"input_tokens":11,"output_tokens":5}}',
          ),
        );
        controller.close();
      },
    }),
  );
  const resp = makeMockResponse();
  const result = await handleStreamingResponse(upstream, resp);
  assert.equal(result.completed, true);
  assert.equal(result.usage.inputTokens, 11);
  assert.equal(result.usage.outputTokens, 5);
});

test("proxyWithRetry stops retry backoff when client disconnects", async () => {
  const resp = makeMockResponse();
  const account: any = {
    token: { email: "x@y.z" },
  };
  let upstreamCalls = 0;
  const manager: any = {
    provider: "anthropic",
    getNextAccount: () => ({ account }),
    recordAttempt: () => {},
    recordFailure: () => {},
    refreshAccount: async () => false,
  };

  const proxyPromise = proxyWithRetry(
    "TestProxy",
    resp,
    {
      debug: "off",
    } as any,
    {
      manager,
      maxRetries: 2,
      upstream: async () => {
        upstreamCalls++;
        return new Response("temporarily unavailable", { status: 500 });
      },
      success: async () => {},
    },
  );

  setTimeout(() => resp.emit("close"), 10);
  await proxyPromise;

  assert.equal(upstreamCalls, 1);
  assert.equal(resp.body, undefined);
});

test("proxyWithRetry does not write terminal error after client disconnects", async () => {
  const resp = makeMockResponse();
  const account: any = { token: { email: "x@y.z" } };
  const manager: any = {
    provider: "anthropic",
    getNextAccount: () => ({ account }),
    recordAttempt: () => {},
    recordFailure: () => {},
    refreshAccount: async () => false,
  };

  let writes = 0;
  resp.setHeader = (key: string, value: string) => {
    writes++;
    resp.headers[key.toLowerCase()] = value;
    return resp;
  };
  const origJson = resp.json;
  resp.json = (body: any) => {
    writes++;
    return origJson.call(resp, body);
  };

  const proxyPromise = proxyWithRetry(
    "TestProxy",
    resp,
    { debug: "off" } as any,
    {
      manager,
      maxRetries: 1,
      upstream: async () => {
        // Client disconnects right as the upstream resolves; the catch in
        // upstream.text() path may swallow read errors, but the terminal
        // error response must NOT be written either way.
        resp.emit("close");
        return new Response("server boom", {
          status: 500,
          headers: { "retry-after": "1" },
        });
      },
      success: async () => {},
    },
  );
  await proxyPromise;

  assert.equal(writes, 0, "no headers/body should be written after disconnect");
  assert.equal(resp.body, undefined);
});

test("proxyWithRetry tags stats failure kind for upstream server errors", async () => {
  const resp = makeMockResponse();
  resp.locals.stats = {};
  const account: any = { token: { email: "x@y.z" } };
  const manager: any = {
    provider: "anthropic",
    getNextAccount: () => ({ account }),
    recordAttempt: () => {},
    recordFailure: () => {},
    refreshAccount: async () => false,
  };

  await proxyWithRetry("TestProxy", resp, { debug: "off" } as any, {
    manager,
    maxRetries: 1,
    upstream: async () => new Response("server boom", { status: 500 }),
    success: async () => {},
  });

  assert.equal(resp.locals.stats.accountEmail, "x@y.z");
  assert.equal(resp.locals.stats.provider, "anthropic");
  assert.equal(resp.locals.stats.failureKind, "server");
});

// ══════════════════════════════════════════════════
// config.ts
// ══════════════════════════════════════════════════

test("isDebugLevel returns correct values", () => {
  assert.equal(isDebugLevel("off", "errors"), false);
  assert.equal(isDebugLevel("errors", "errors"), true);
  assert.equal(isDebugLevel("errors", "verbose"), false);
  assert.equal(isDebugLevel("verbose", "errors"), true);
  assert.equal(isDebugLevel("verbose", "verbose"), true);
});

test("resolveAuthDir expands tilde", () => {
  const result = resolveAuthDir("~/.auth2api");
  assert.ok(!result.startsWith("~"));
  assert.ok(result.endsWith(".auth2api"));
});

test("resolveAuthDir resolves relative paths", () => {
  const result = resolveAuthDir("./data");
  assert.ok(path.isAbsolute(result));
});

test("loadConfig uses defaults when file missing", () => {
  const config = loadConfig("/tmp/nonexistent-config-" + Date.now() + ".yaml");
  assert.equal(config.port, 8317);
  assert.equal(config["body-limit"], "200mb");
  assert.equal(config["api-key-rate-limit"]["window-ms"], 18000000);
  assert.equal(config["api-key-rate-limit"]["max-requests"], 300);
  assert.equal(config.debug, "off");
  assert.ok(config["bootstrap-admin-key"]);
  assert.ok(config["bootstrap-admin-key"]!.startsWith("sk-"));
});

test("loadConfig normalizes debug mode", () => {
  const configPath = path.join(
    os.tmpdir(),
    `auth2api-debug-test-${Date.now()}.yaml`,
  );
  fs.writeFileSync(configPath, 'bootstrap-admin-key: "sk-test"\ndebug: true\n');
  try {
    const config = loadConfig(configPath);
    assert.equal(config.debug, "errors"); // true → "errors"
  } finally {
    fs.unlinkSync(configPath);
  }
});

test("loadConfig merges api-key rate limit overrides", () => {
  const configPath = path.join(
    os.tmpdir(),
    `auth2api-rate-limit-test-${Date.now()}.yaml`,
  );
  fs.writeFileSync(
    configPath,
    [
      "api-key-rate-limit:",
      "  max-requests: 42",
      "  overrides:",
      '    "sk-test":',
      "      window-ms: 60000",
      'debug: "off"',
      "",
    ].join("\n"),
  );
  try {
    const config = loadConfig(configPath);
    assert.equal(config["api-key-rate-limit"]["max-requests"], 42);
    assert.equal(config["api-key-rate-limit"]["window-ms"], 18000000);
    assert.equal(
      config["api-key-rate-limit"].overrides?.["sk-test"]?.["window-ms"],
      60000,
    );
  } finally {
    fs.unlinkSync(configPath);
  }
});

test("resolveApiKeyRateLimit applies per-key overrides", () => {
  const config = {
    "window-ms": 18000000,
    "max-requests": 300,
    overrides: {
      "sk-a": {
        "max-requests": 50,
      },
      "sk-b": {
        "window-ms": 60000,
        "max-requests": 5,
      },
    },
  };
  assert.deepEqual(resolveApiKeyRateLimit(config, "sk-a"), {
    "window-ms": 18000000,
    "max-requests": 50,
  });
  assert.deepEqual(resolveApiKeyRateLimit(config, "sk-b"), {
    "window-ms": 60000,
    "max-requests": 5,
  });
  assert.deepEqual(resolveApiKeyRateLimit(config, "sk-c"), {
    "window-ms": 18000000,
    "max-requests": 300,
  });
});

test("ApiKeyRegistry keeps bootstrap admin record even when another admin already exists", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-api-keys-"));
  try {
    fs.writeFileSync(
      path.join(tmpDir, "api-keys.json"),
      JSON.stringify(
        {
          version: 1,
          keys: [
            {
              id: "ak_existing",
              secret: "sk-existing-admin",
              tier: "admin",
              name: "existing",
              enabled: true,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
    );

    const registry = new ApiKeyRegistry(tmpDir, {
      bootstrapAdminKey: "sk-bootstrap-admin",
      tierLimits: {
        lite: { concurrency: 5, maxRequests5h: 300 },
        pro: { concurrency: 10, maxRequests5h: 600 },
        admin: { concurrency: 10, maxRequests5h: 600 },
      },
    });
    registry.load();

    const keys = registry.list();
    assert.ok(keys.some((k) => k.secret === "sk-bootstrap-admin"));
    assert.equal(keys.filter((k) => k.tier === "admin" && k.enabled).length, 1);
    assert.equal(registry.getAdminSecret(), "sk-existing-admin");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ApiKeyRegistry supports enabling and disabling non-admin keys", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-api-keys-"));
  try {
    const registry = new ApiKeyRegistry(tmpDir, {
      bootstrapAdminKey: "sk-bootstrap-admin",
      tierLimits: {
        lite: { concurrency: 5, maxRequests5h: 300 },
        pro: { concurrency: 10, maxRequests5h: 600 },
        admin: { concurrency: 10, maxRequests5h: 600 },
      },
    });
    registry.load();

    const created = registry.createKey({
      tier: "lite",
      name: "client",
      enabled: false,
    });
    assert.equal(created.record.enabled, false);
    assert.equal(registry.authenticate(created.secret), null);

    const disabled = registry.updateKeyState(created.record.id, true);
    assert.equal(disabled.record.enabled, true);
    assert.ok(registry.authenticate(created.secret));

    const disabledAgain = registry.updateKeyState(created.record.id, false);
    assert.equal(disabledAgain.record.enabled, false);
    assert.equal(registry.authenticate(created.secret), null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ApiKeyRegistry rejects duplicate API key names", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-api-keys-"));
  try {
    const registry = new ApiKeyRegistry(tmpDir, {
      bootstrapAdminKey: "sk-bootstrap-admin",
      tierLimits: {
        lite: { concurrency: 5, maxRequests5h: 300 },
        pro: { concurrency: 10, maxRequests5h: 600 },
        admin: { concurrency: 10, maxRequests5h: 600 },
      },
    });
    registry.load();

    registry.createKey({ tier: "lite", name: "client" });
    assert.throws(
      () => registry.createKey({ tier: "pro", name: " client " }),
      /API key name already exists: client/,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ApiKeyRegistry generates unique default names", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-api-keys-"));
  try {
    const registry = new ApiKeyRegistry(tmpDir, {
      bootstrapAdminKey: "sk-bootstrap-admin",
      tierLimits: {
        lite: { concurrency: 5, maxRequests5h: 300 },
        pro: { concurrency: 10, maxRequests5h: 600 },
        admin: { concurrency: 10, maxRequests5h: 600 },
      },
    });
    registry.load();

    const first = registry.createKey({ tier: "lite" });
    const second = registry.createKey({ tier: "lite" });
    assert.equal(first.record.name, "lite");
    assert.equal(second.record.name, "lite-2");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ApiKeyRegistry reconciles duplicate names on load", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-api-keys-"));
  try {
    fs.writeFileSync(
      path.join(tmpDir, "api-keys.json"),
      JSON.stringify(
        {
          version: 1,
          keys: [
            {
              id: "ak_1",
              secret: "sk-1",
              tier: "lite",
              name: "client",
              enabled: true,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
            {
              id: "ak_2",
              secret: "sk-2",
              tier: "lite",
              name: " client ",
              enabled: true,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
            {
              id: "ak_3",
              secret: "sk-3",
              tier: "pro",
              name: "   ",
              enabled: true,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
    );

    const registry = new ApiKeyRegistry(tmpDir, {
      tierLimits: {
        lite: { concurrency: 5, maxRequests5h: 300 },
        pro: { concurrency: 10, maxRequests5h: 600 },
        admin: { concurrency: 10, maxRequests5h: 600 },
      },
    });
    registry.load();

    assert.deepEqual(
      registry.list().map((k) => k.name),
      ["client", "client-2", "pro"],
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ApiKeyRegistry reload flushes pending changes before reading disk", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-api-keys-"));
  try {
    const registry = new ApiKeyRegistry(tmpDir, {
      bootstrapAdminKey: "sk-bootstrap-admin",
      flushDebounceMs: 60_000,
      tierLimits: {
        lite: { concurrency: 5, maxRequests5h: 300 },
        pro: { concurrency: 10, maxRequests5h: 600 },
        admin: { concurrency: 10, maxRequests5h: 600 },
      },
    });
    registry.load();

    const created = registry.createKey({
      tier: "lite",
      name: "client",
    });
    await registry.reload();

    assert.ok(registry.authenticate(created.secret));
    const persisted = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "api-keys.json"), "utf-8"),
    );
    assert.ok(
      persisted.keys.some(
        (key: { secret: string }) => key.secret === created.secret,
      ),
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ApiKeyRegistry rejects disabling the admin key", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-api-keys-"));
  try {
    const registry = new ApiKeyRegistry(tmpDir, {
      bootstrapAdminKey: "sk-bootstrap-admin",
      tierLimits: {
        lite: { concurrency: 5, maxRequests5h: 300 },
        pro: { concurrency: 10, maxRequests5h: 600 },
        admin: { concurrency: 10, maxRequests5h: 600 },
      },
    });
    registry.load();
    const admin = registry.list().find((k) => k.tier === "admin" && k.enabled);
    assert.ok(admin);
    assert.throws(
      () => registry.updateKeyState(admin!.id, false),
      /cannot be disabled/,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("default account selection respects api key tier filters", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-tier-"));
  try {
    const manager = new AccountManager(tmpDir, {
      provider: "anthropic",
      refresh: async () => {
        throw new Error("unexpected refresh");
      },
    });
    manager.addAccount({
      accessToken: "pro",
      refreshToken: "rt-pro",
      email: "pro@example.com",
      expiresAt: "2030-01-01T00:00:00.000Z",
      accountUuid: "up",
      provider: "anthropic",
      routing: { level: "pro" },
    });
    manager.addAccount({
      accessToken: "lite",
      refreshToken: "rt-lite",
      email: "lite@example.com",
      expiresAt: "2030-01-01T00:00:00.000Z",
      accountUuid: "ul",
      provider: "anthropic",
      routing: { level: "lite" },
    });

    const chosen = manager.getNextAccount({ apiKeyTier: "lite" });
    assert.equal(chosen.account?.token.email, "lite@example.com");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════
// translator.ts — model resolution
// ══════════════════════════════════════════════════

test("resolveModel maps aliases", () => {
  assert.equal(resolveModel("opus"), "claude-opus-4-7");
  assert.equal(resolveModel("sonnet"), "claude-sonnet-4-6");
  assert.equal(resolveModel("haiku"), "claude-haiku-4-5-20251001");
});

test("resolveModel passes through unknown models", () => {
  assert.equal(resolveModel("gpt-4o"), "gpt-4o");
  assert.equal(resolveModel("claude-sonnet-4-6"), "claude-sonnet-4-6");
  assert.equal(resolveModel("claude-opus-4-7"), "claude-opus-4-7");
  assert.equal(resolveModel("claude-opus-4-6"), "claude-opus-4-6");
});

// ══════════════════════════════════════════════════
// translator.ts — OpenAI Chat → Anthropic
// ══════════════════════════════════════════════════

test("openaiToAnthropic translates basic request", () => {
  const result = openaiToAnthropic({
    model: "sonnet",
    messages: [{ role: "user", content: "hello" }],
    stream: false,
  });
  assert.equal(result.model, "claude-sonnet-4-6");
  assert.equal(result.stream, false);
  assert.equal(result.max_tokens, 8192);
  assert.deepEqual(result.messages, [{ role: "user", content: "hello" }]);
});

test("openaiToAnthropic uses max_completion_tokens over max_tokens", () => {
  const result = openaiToAnthropic({
    model: "sonnet",
    max_tokens: 100,
    max_completion_tokens: 500,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(result.max_tokens, 500);
});

test("openaiToAnthropic translates temperature and top_p", () => {
  const result = openaiToAnthropic({
    model: "sonnet",
    temperature: 0.5,
    top_p: 0.9,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(result.temperature, 0.5);
  assert.equal(result.top_p, 0.9);
});

test("openaiToAnthropic translates stop sequences", () => {
  const result = openaiToAnthropic({
    model: "sonnet",
    stop: ["END", "STOP"],
    messages: [{ role: "user", content: "hi" }],
  });
  assert.deepEqual(result.stop_sequences, ["END", "STOP"]);
});

test("openaiToAnthropic translates single stop string", () => {
  const result = openaiToAnthropic({
    model: "sonnet",
    stop: "END",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.deepEqual(result.stop_sequences, ["END"]);
});

test("openaiToAnthropic translates system messages", () => {
  const result = openaiToAnthropic({
    model: "sonnet",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hi" },
    ],
  });
  assert.deepEqual(result.system, [{ type: "text", text: "You are helpful." }]);
  assert.equal(result.messages.length, 1);
});

test("openaiToAnthropic translates reasoning_effort to thinking", () => {
  const result = openaiToAnthropic({
    model: "sonnet",
    reasoning_effort: "high",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(result.thinking.type, "enabled");
  assert.equal(result.thinking.budget_tokens, 24576);
});

test("openaiToAnthropic translates tools", () => {
  const result = openaiToAnthropic({
    model: "sonnet",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  });
  assert.equal(result.tools[0].name, "get_weather");
  assert.equal(result.tools[0].description, "Get weather");
  assert.ok(result.tools[0].input_schema);
});

test("openaiToAnthropic translates tool_choice", () => {
  const auto = openaiToAnthropic({
    model: "sonnet",
    messages: [{ role: "user", content: "hi" }],
    tool_choice: "auto",
  });
  assert.deepEqual(auto.tool_choice, { type: "auto" });

  const required = openaiToAnthropic({
    model: "sonnet",
    messages: [{ role: "user", content: "hi" }],
    tool_choice: "required",
  });
  assert.deepEqual(required.tool_choice, { type: "any" });
});

test("openaiToAnthropic translates parallel_tool_calls", () => {
  const result = openaiToAnthropic({
    model: "sonnet",
    messages: [{ role: "user", content: "hi" }],
    tool_choice: "auto",
    parallel_tool_calls: false,
  });
  assert.equal(result.tool_choice.disable_parallel_tool_use, true);
});

test("openaiToAnthropic translates response_format json_schema", () => {
  const result = openaiToAnthropic({
    model: "sonnet",
    messages: [{ role: "user", content: "hi" }],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "test",
        schema: { type: "object", properties: { name: { type: "string" } } },
      },
    },
  });
  assert.equal(result.output_config.format.type, "json_schema");
  assert.equal(result.output_config.format.name, "test");
});

test("openaiToAnthropic translates tool role messages", () => {
  const result = openaiToAnthropic({
    model: "sonnet",
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"NYC"}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: '{"temp":72}',
      },
    ],
  });
  // assistant message with tool_use
  assert.equal(result.messages[1].role, "assistant");
  assert.equal(result.messages[1].content[0].type, "tool_use");
  // tool result
  assert.equal(result.messages[2].role, "user");
  assert.equal(result.messages[2].content[0].type, "tool_result");
  assert.equal(result.messages[2].content[0].tool_use_id, "call_1");
});

// ══════════════════════════════════════════════════
// translator.ts — Anthropic → OpenAI Chat
// ══════════════════════════════════════════════════

test("anthropicToOpenai translates basic response", () => {
  const result = anthropicToOpenai(
    {
      content: [{ type: "text", text: "Hello!" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    "claude-sonnet-4-6",
  );
  assert.equal(result.object, "chat.completion");
  assert.equal(result.choices[0].message.content, "Hello!");
  assert.equal(result.choices[0].message.role, "assistant");
  assert.equal(result.choices[0].finish_reason, "stop");
  assert.equal(result.usage.prompt_tokens, 10);
  assert.equal(result.usage.completion_tokens, 5);
  assert.equal(result.usage.total_tokens, 15);
});

test("anthropicToOpenai maps stop reasons correctly", () => {
  const endTurn = anthropicToOpenai(
    { content: [], stop_reason: "end_turn", usage: {} },
    "sonnet",
  );
  assert.equal(endTurn.choices[0].finish_reason, "stop");

  const maxTokens = anthropicToOpenai(
    { content: [], stop_reason: "max_tokens", usage: {} },
    "sonnet",
  );
  assert.equal(maxTokens.choices[0].finish_reason, "length");

  const toolUse = anthropicToOpenai(
    { content: [], stop_reason: "tool_use", usage: {} },
    "sonnet",
  );
  assert.equal(toolUse.choices[0].finish_reason, "tool_calls");
});

test("anthropicToOpenai translates tool_use blocks", () => {
  const result = anthropicToOpenai(
    {
      content: [
        {
          type: "tool_use",
          id: "call_1",
          name: "get_weather",
          input: { city: "NYC" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 20 },
    },
    "sonnet",
  );
  assert.equal(result.choices[0].message.tool_calls.length, 1);
  assert.equal(result.choices[0].message.tool_calls[0].id, "call_1");
  assert.equal(
    result.choices[0].message.tool_calls[0].function.name,
    "get_weather",
  );
  assert.equal(
    result.choices[0].message.tool_calls[0].function.arguments,
    '{"city":"NYC"}',
  );
});

test("anthropicToOpenai includes usage details", () => {
  const result = anthropicToOpenai(
    {
      content: [],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 30,
      },
    },
    "sonnet",
  );
  assert.equal(result.usage.prompt_tokens_details.cached_tokens, 30);
  assert.equal(result.usage.completion_tokens_details.reasoning_tokens, 0);
});

// ══════════════════════════════════════════════════
// translator.ts — Chat SSE streaming
// ══════════════════════════════════════════════════

function parseChatSSE(chunk: string): any {
  const json = chunk.replace(/^data: /, "").trim();
  return JSON.parse(json);
}

test("anthropicSSEToChat handles message_start", () => {
  const state = createStreamState("sonnet", false);
  const chunks = anthropicSSEToChat(
    "message_start",
    { message: { usage: { input_tokens: 10 } } },
    state,
  );
  assert.equal(chunks.length, 1);
  const parsed = parseChatSSE(chunks[0]);
  assert.equal(parsed.choices[0].delta.role, "assistant");
});

test("anthropicSSEToChat handles text_delta", () => {
  const state = createStreamState("sonnet", false);
  const chunks = anthropicSSEToChat(
    "content_block_delta",
    { delta: { type: "text_delta", text: "Hello" } },
    state,
  );
  assert.equal(chunks.length, 1);
  const parsed = parseChatSSE(chunks[0]);
  assert.equal(parsed.choices[0].delta.content, "Hello");
});

test("anthropicSSEToChat handles thinking_delta", () => {
  const state = createStreamState("sonnet", false);
  const chunks = anthropicSSEToChat(
    "content_block_delta",
    { delta: { type: "thinking_delta", thinking: "Let me think..." } },
    state,
  );
  const parsed = parseChatSSE(chunks[0]);
  assert.equal(parsed.choices[0].delta.reasoning_content, "Let me think...");
});

test("anthropicSSEToChat handles message_stop with usage", () => {
  const state = createStreamState("sonnet", true);
  const usage: UsageData = {
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 2,
  };
  const chunks = anthropicSSEToChat("message_stop", {}, state, usage);
  assert.equal(chunks.length, 2); // usage chunk + [DONE]
  const usageChunk = parseChatSSE(chunks[0]);
  assert.deepEqual(usageChunk.choices, []);
  assert.equal(usageChunk.usage.prompt_tokens, 10);
  assert.equal(usageChunk.usage.completion_tokens, 5);
  assert.equal(usageChunk.usage.prompt_tokens_details.cached_tokens, 2);
  assert.equal(chunks[1], "data: [DONE]\n\n");
});

test("anthropicSSEToChat skips usage when includeUsage is false", () => {
  const state = createStreamState("sonnet", false);
  const usage: UsageData = {
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
  const chunks = anthropicSSEToChat("message_stop", {}, state, usage);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], "data: [DONE]\n\n");
});

test("anthropicSSEToChat handles tool_use streaming", () => {
  const state = createStreamState("sonnet", false);

  // tool block start
  const startChunks = anthropicSSEToChat(
    "content_block_start",
    {
      content_block: { type: "tool_use", id: "call_1", name: "get_weather" },
      index: 1,
    },
    state,
  );
  assert.equal(startChunks.length, 1);
  const startParsed = parseChatSSE(startChunks[0]);
  assert.equal(startParsed.choices[0].delta.tool_calls[0].id, "call_1");
  assert.equal(startParsed.choices[0].delta.tool_calls[0].index, 0);

  // tool delta
  const deltaChunks = anthropicSSEToChat(
    "content_block_delta",
    { delta: { type: "input_json_delta", partial_json: '{"city"' }, index: 1 },
    state,
  );
  assert.equal(deltaChunks.length, 1);
  const deltaParsed = parseChatSSE(deltaChunks[0]);
  assert.equal(
    deltaParsed.choices[0].delta.tool_calls[0].function.arguments,
    '{"city"',
  );
  assert.equal(deltaParsed.choices[0].delta.tool_calls[0].index, 0);
});

test("anthropicSSEToChat returns empty for unknown events", () => {
  const state = createStreamState("sonnet", false);
  assert.deepEqual(anthropicSSEToChat("ping", {}, state), []);
  assert.deepEqual(anthropicSSEToChat("unknown_event", {}, state), []);
});

// ══════════════════════════════════════════════════
// translator.ts — Responses API
// ══════════════════════════════════════════════════

test("responsesToAnthropic translates basic request", () => {
  const result = responsesToAnthropic({
    model: "sonnet",
    input: [{ role: "user", content: "hello" }],
    stream: false,
  });
  assert.equal(result.model, "claude-sonnet-4-6");
  assert.equal(result.stream, false);
  assert.deepEqual(result.messages, [{ role: "user", content: "hello" }]);
});

test("responsesToAnthropic translates temperature and top_p", () => {
  const result = responsesToAnthropic({
    model: "sonnet",
    input: [{ role: "user", content: "hi" }],
    temperature: 0.7,
    top_p: 0.8,
  });
  assert.equal(result.temperature, 0.7);
  assert.equal(result.top_p, 0.8);
});

test("responsesToAnthropic translates instructions to system", () => {
  const result = responsesToAnthropic({
    model: "sonnet",
    instructions: "Be helpful",
    input: [{ role: "user", content: "hi" }],
  });
  assert.deepEqual(result.system, [{ type: "text", text: "Be helpful" }]);
});

test("responsesToAnthropic translates reasoning with summary", () => {
  const result = responsesToAnthropic({
    model: "sonnet",
    input: [{ role: "user", content: "hi" }],
    reasoning: { effort: "high", summary: "concise" },
  });
  assert.equal(result.thinking.type, "enabled");
  assert.equal(result.thinking.budget_tokens, 24576);
  assert.equal(result.thinking.display, "summarized");
});

test("anthropicToResponses translates basic response", () => {
  const result = anthropicToResponses(
    {
      content: [{ type: "text", text: "Hello!" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    "claude-sonnet-4-6",
  );
  assert.equal(result.object, "response");
  assert.equal(result.status, "completed");
  assert.equal(result.output[0].type, "message");
  assert.equal(result.output[0].content[0].type, "output_text");
  assert.equal(result.output[0].content[0].text, "Hello!");
  assert.equal(result.output_text, "Hello!");
  assert.equal(result.usage.input_tokens, 10);
  assert.equal(result.usage.output_tokens, 5);
});

test("anthropicToResponses sets incomplete status on max_tokens", () => {
  const result = anthropicToResponses(
    {
      content: [{ type: "text", text: "partial" }],
      stop_reason: "max_tokens",
      usage: {},
    },
    "sonnet",
  );
  assert.equal(result.status, "incomplete");
});

test("anthropicToResponses includes usage details", () => {
  const result = anthropicToResponses(
    {
      content: [],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 20,
      },
    },
    "sonnet",
  );
  assert.equal(result.usage.input_tokens_details.cached_tokens, 20);
  assert.equal(result.usage.output_tokens_details.reasoning_tokens, 0);
});

// ══════════════════════════════════════════════════
// translator.ts — Responses SSE streaming
// ══════════════════════════════════════════════════

test("anthropicSSEToResponses handles message_start", () => {
  const state = makeResponsesState();
  const usage: UsageData = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
  const events = anthropicSSEToResponses(
    "message_start",
    {},
    state,
    "sonnet",
    usage,
  );
  assert.equal(events.length, 2);
  assert.ok(events[0].includes("response.created"));
  assert.ok(events[1].includes("response.in_progress"));
});

test("anthropicSSEToResponses handles text streaming", () => {
  const state = makeResponsesState();
  const usage: UsageData = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };

  // text block start
  const startEvents = anthropicSSEToResponses(
    "content_block_start",
    { content_block: { type: "text", text: "" }, index: 0 },
    state,
    "sonnet",
    usage,
  );
  assert.ok(startEvents.some((e) => e.includes("response.output_item.added")));
  assert.ok(startEvents.some((e) => e.includes("response.content_part.added")));

  // text delta
  const deltaEvents = anthropicSSEToResponses(
    "content_block_delta",
    { delta: { type: "text_delta", text: "Hello" }, index: 0 },
    state,
    "sonnet",
    usage,
  );
  assert.ok(deltaEvents.some((e) => e.includes("response.output_text.delta")));
  assert.ok(deltaEvents.some((e) => e.includes('"Hello"')));

  // text block stop
  const stopEvents = anthropicSSEToResponses(
    "content_block_stop",
    { index: 0 },
    state,
    "sonnet",
    usage,
  );
  assert.ok(stopEvents.some((e) => e.includes("response.output_text.done")));
  assert.ok(stopEvents.some((e) => e.includes("response.output_item.done")));
});

test("anthropicSSEToResponses handles message_stop with usage", () => {
  const state = makeResponsesState();
  const usage: UsageData = {
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 10,
  };
  const events = anthropicSSEToResponses(
    "message_stop",
    {},
    state,
    "sonnet",
    usage,
  );
  assert.ok(events.some((e) => e.includes("response.completed")));
  assert.ok(events.some((e) => e.includes("response.done")));
  assert.ok(events.some((e) => e.includes('"input_tokens":100')));
});

test("anthropicSSEToResponses returns empty for unknown events", () => {
  const state = makeResponsesState();
  const usage: UsageData = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
  assert.deepEqual(
    anthropicSSEToResponses("ping", {}, state, "sonnet", usage),
    [],
  );
});

// ══════════════════════════════════════════════════
// stats/recorder.ts
// ══════════════════════════════════════════════════

import { StatsRecorder, StatsEvent } from "../src/stats/recorder";
import { presentStatsSnapshot } from "../src/stats/presenter";
import { replayStatsEvents, statsFilePath } from "../src/stats/storage";
import { createServer } from "../src/server";
import { ApiKeyRegistry } from "../src/auth/api-key-registry";
import { TraceEvent, TraceRecorder } from "../src/observability/trace";
import { generateDailyReport } from "../src/observability/report";

function makeApiKeyRegistry(authDir: string): ApiKeyRegistry {
  const registry = new ApiKeyRegistry(authDir, {
    bootstrapAdminKey: "sk-test",
    seededKeys: ["sk-test"],
    tierLimits: {
      lite: { concurrency: 5, maxRequests5h: 300 },
      pro: { concurrency: 10, maxRequests5h: 600 },
      admin: { concurrency: 10, maxRequests5h: 600 },
    },
  });
  registry.load();
  return registry;
}

/** 将测试日期格式化为接口接受的 YYYY-MM-DD。 */
function formatTestDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 基于当前本地日期偏移生成测试日期。 */
function testDateWithOffset(offsetDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return formatTestDate(date);
}

/** 将测试日期转换为当天本地中午的 ISO 时间，避免跨时区边界。 */
function testIsoAtLocalNoon(dateText: string): string {
  const [year, month, day] = dateText.split("-").map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0).toISOString();
}

function makeStatsEvent(over: Partial<StatsEvent> = {}): StatsEvent {
  return {
    v: 1,
    ts: "2026-05-09T12:00:00.000Z",
    apiKeyHash: "a".repeat(64),
    apiKeyName: "client-a",
    ip: "127.0.0.1",
    ua: "test-ua",
    endpoint: "POST /v1/chat/completions",
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    accountEmail: "alice@example.com",
    status: "success",
    failureKind: null,
    statusCode: 200,
    latencyMs: 250,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningOutputTokens: 0,
    },
    ...over,
  };
}

test("StatsRecorder aggregates across all three views", () => {
  const recorder = new StatsRecorder();
  recorder.applyEvent(makeStatsEvent());
  recorder.applyEvent(makeStatsEvent({ ts: "2026-05-09T12:00:01.000Z" }));
  recorder.applyEvent(
    makeStatsEvent({
      ts: "2026-05-09T12:00:02.000Z",
      status: "failure",
      statusCode: 502,
      usage: null,
    }),
  );
  const snapshot = recorder.getSnapshot();
  assert.equal(snapshot.totals.requests, 3);
  assert.equal(snapshot.totals.successes, 2);
  assert.equal(snapshot.totals.failures, 1);
  assert.equal(snapshot.totals.totalInputTokens, 20);
  assert.equal(snapshot.totals.totalOutputTokens, 10);
  assert.equal(snapshot.totals.firstSeenAt, "2026-05-09T12:00:00.000Z");

  const clientKey = "client-a";
  assert.equal(snapshot.byClient[clientKey].requests, 3);
  assert.equal(snapshot.byClient[clientKey].name, "client-a");

  const accKey = "anthropic:alice@example.com";
  assert.equal(snapshot.byAccount[accKey].requests, 3);
  assert.equal(snapshot.byAccount[accKey].provider, "anthropic");

  const apiKey = "POST /v1/chat/completions|claude-sonnet-4-6|anthropic";
  assert.equal(snapshot.byApi[apiKey].requests, 3);
});

test("StatsRecorder splits buckets by client / account / api key", () => {
  const recorder = new StatsRecorder();
  recorder.applyEvent(makeStatsEvent());
  recorder.applyEvent(
    makeStatsEvent({
      apiKeyHash: "b".repeat(64),
      apiKeyName: "client-b",
      accountEmail: "bob@example.com",
      endpoint: "POST /v1/messages",
      model: "claude-opus-4-7",
    }),
  );
  const snapshot = recorder.getSnapshot();
  assert.equal(Object.keys(snapshot.byClient).length, 2);
  assert.equal(Object.keys(snapshot.byAccount).length, 2);
  assert.equal(Object.keys(snapshot.byApi).length, 2);
});

test("StatsRecorder builds snapshots for a recent date range", () => {
  const recorder = new StatsRecorder();
  const today = testDateWithOffset(0);
  const yesterday = testDateWithOffset(-1);
  recorder.applyEvent(
    makeStatsEvent({
      ts: testIsoAtLocalNoon(today),
      apiKeyName: "today-client",
    }),
  );
  recorder.applyEvent(
    makeStatsEvent({
      ts: testIsoAtLocalNoon(yesterday),
      apiKeyName: "yesterday-client",
    }),
  );

  const [year, month, day] = yesterday.split("-").map(Number);
  const startAt = new Date(year, month - 1, day);
  const endAt = new Date(year, month - 1, day + 1);
  const snapshot = recorder.getSnapshotForRange(startAt, endAt);

  assert.equal(snapshot.totals.requests, 1);
  assert.equal(snapshot.byClient["yesterday-client"].requests, 1);
  assert.equal(snapshot.byClient["today-client"], undefined);
});

test("StatsRecorder skips byAccount when provider/email missing", () => {
  const recorder = new StatsRecorder();
  recorder.applyEvent(
    makeStatsEvent({ accountEmail: null, provider: null, usage: null }),
  );
  const snapshot = recorder.getSnapshot();
  assert.equal(Object.keys(snapshot.byAccount).length, 0);
  assert.equal(Object.keys(snapshot.byClient).length, 1);
  assert.equal(
    snapshot.byApi["POST /v1/chat/completions|claude-sonnet-4-6|unknown"]
      .requests,
    1,
  );
  assert.equal(snapshot.totals.requests, 1);
});

test("StatsRecorder ignores admin endpoints during replay", () => {
  const recorder = new StatsRecorder();
  recorder.applyEvent(
    makeStatsEvent({
      endpoint: "GET /admin/stats",
      model: null,
      provider: null,
      accountEmail: null,
      usage: null,
    }),
  );
  const snapshot = recorder.getSnapshot();
  assert.equal(snapshot.totals.requests, 0);
  assert.deepEqual(snapshot.byApi, {});
});

test("StatsRecorder maps legacy client hashes to API key names", () => {
  const recorder = new StatsRecorder(
    new Map([[hashApiKey("sk-client"), "client"]]),
  );
  recorder.applyEvent(
    makeStatsEvent({
      apiKeyHash: hashApiKey("sk-client"),
      apiKeyName: undefined,
    }),
  );
  const snapshot = recorder.getSnapshot();
  assert.equal(snapshot.byClient.client.requests, 1);
  assert.equal(snapshot.byClient.client.name, "client");
});

test("StatsRecorder omits byClient for unmapped legacy hashes", () => {
  const recorder = new StatsRecorder();
  recorder.applyEvent(
    makeStatsEvent({
      apiKeyName: undefined,
    }),
  );
  const snapshot = recorder.getSnapshot();
  assert.equal(snapshot.totals.requests, 1);
  assert.deepEqual(snapshot.byClient, {});
});

test("presentStatsSnapshot formats chinese labels, compact tokens, and datetime", () => {
  const snapshot = {
    byClient: {
      client: {
        requests: 12,
        successes: 11,
        failures: 1,
        totalInputTokens: 12_345,
        totalOutputTokens: 2_300_000,
        totalCacheCreationInputTokens: 0,
        totalCacheReadInputTokens: 987,
        totalReasoningOutputTokens: 21_500,
        totalLatencyMs: 4_200,
        firstSeenAt: "2026-06-16T01:02:03.000Z",
        lastSeenAt: "2026-06-16T04:05:06.000Z",
        name: "client",
        lastIp: "127.0.0.1",
        lastUa: "ua",
      },
    },
    byAccount: {},
    byApi: {},
    totals: {
      requests: 12,
      successes: 11,
      failures: 1,
      totalInputTokens: 12_345,
      totalOutputTokens: 2_300_000,
      totalCacheCreationInputTokens: 0,
      totalCacheReadInputTokens: 987,
      totalReasoningOutputTokens: 21_500,
      totalLatencyMs: 4_200,
      firstSeenAt: "2026-06-16T01:02:03.000Z",
      lastSeenAt: "2026-06-16T04:05:06.000Z",
    },
  };

  const presented = presentStatsSnapshot(
    snapshot as any,
    "2026-06-16T08:09:10.000Z",
  );
  assert.equal(presented.按客户端.client.输入Token, "12.3k");
  assert.equal(presented.按客户端.client.输出Token, "2.3m");
  assert.equal(presented.按客户端.client.推理输出Token, "21.5k");
  assert.equal(presented.按客户端.client.总耗时, "4.2s");
  assert.equal(presented.按客户端.client.首次时间, "2026-06-16 09:02:03");
  assert.equal(presented.生成时间, "2026-06-16 16:09:10");
});

test("presentStatsSnapshot promotes compact token units near thresholds", () => {
  const snapshot = {
    byClient: {},
    byAccount: {},
    byApi: {},
    totals: {
      requests: 1,
      successes: 1,
      failures: 0,
      totalInputTokens: 999_950,
      totalOutputTokens: 999_950_000,
      totalCacheCreationInputTokens: 0,
      totalCacheReadInputTokens: 0,
      totalReasoningOutputTokens: 0,
      totalLatencyMs: 10,
      firstSeenAt: "2026-06-16T00:00:00.000Z",
      lastSeenAt: "2026-06-16T00:00:00.000Z",
    },
  };
  const presented = presentStatsSnapshot(
    snapshot as any,
    "2026-06-16T00:00:00.000Z",
  );
  assert.equal(presented.汇总.输入Token, "1m");
  assert.equal(presented.汇总.输出Token, "1b");
});

test("createServer stats does not record admin endpoints", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-stats-"));
  const recorder = new StatsRecorder();
  recorder.start(tmp);
  const apiKeys = makeApiKeyRegistry(tmp);
  const app = createServer(
    {
      host: "",
      port: 0,
      "auth-dir": tmp,
      "api-key-rate-limit": {
        "window-ms": 5 * 60 * 60 * 1000,
        "max-requests": 300,
      },
      "body-limit": "1mb",
      cloaking: {},
      timeouts: {
        "messages-ms": 1000,
        "stream-messages-ms": 1000,
        "count-tokens-ms": 1000,
      },
      stats: { enabled: true },
      debug: "off",
    } as any,
    {} as any,
    apiKeys,
    recorder,
  );
  const server = app.listen(0);
  try {
    const port = (server.address() as any).port;
    const headers = { Authorization: "Bearer sk-test" };
    await fetch(`http://127.0.0.1:${port}/admin/stats`, { headers });
    const second = await fetch(`http://127.0.0.1:${port}/admin/stats`, {
      headers,
    });
    const body = await second.json();
    assert.deepEqual(body.byApi, {});
    assert.equal(body.totals.requests, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await recorder.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("createServer supports manual account usage refresh", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-stats-"));
  const apiKeys = makeApiKeyRegistry(tmp);
  let calledWithEmail: string | undefined;
  const app = createServer(
    {
      host: "",
      port: 0,
      "auth-dir": tmp,
      "api-key-rate-limit": {
        "window-ms": 5 * 60 * 60 * 1000,
        "max-requests": 300,
      },
      "body-limit": "1mb",
      cloaking: {},
      timeouts: {
        "messages-ms": 1000,
        "stream-messages-ms": 1000,
        "count-tokens-ms": 1000,
      },
      stats: { enabled: true },
      debug: "off",
    } as any,
    {
      all: () => [
        {
          id: "codex",
          manager: {
            refreshUsage: async (email?: string) => {
              calledWithEmail = email;
              return {
                "codex@example.com": {
                  status: "success",
                  source: "test",
                  buckets: [],
                  lastRefreshAt: "2030-01-01T00:00:00.000Z",
                  lastWeeklyRefreshAt: null,
                  nextRefreshAt: null,
                  nextIdleRefreshAt: "2030-01-01T01:00:00.000Z",
                  lastError: null,
                },
              };
            },
          },
        },
        {
          id: "anthropic",
          manager: {
            refreshUsage: async () => ({}),
          },
        },
      ],
      withAccounts: () => [],
    } as any,
    apiKeys,
  );
  const server = app.listen(0);
  try {
    const port = (server.address() as any).port;
    const resp = await fetch(
      `http://127.0.0.1:${port}/admin/accounts/usage/refresh`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer sk-test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: "codex",
          email: "codex@example.com",
        }),
      },
    );
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(calledWithEmail, "codex@example.com");
    assert.equal(body.refreshed.codex["codex@example.com"].status, "success");
    assert.equal(body.refreshed.anthropic, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("createServer exposes account decision diagnostics without mutating selection state", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-stats-"));
  const apiKeys = makeApiKeyRegistry(tmp);
  const manager = new AccountManager(tmp, {
    provider: "codex",
    refresh: async () => {
      throw new Error("should not refresh");
    },
    routingMode: "codex-smart",
  });
  manager.addAccount({
    accessToken: "at-1",
    refreshToken: "rt-1",
    email: "a@example.com",
    expiresAt: "2030-01-01T00:00:00.000Z",
    accountUuid: "acct-a",
    provider: "codex",
    planType: "plus",
    routing: { bias: 0.1, level: "lite" },
  });
  manager.addAccount({
    accessToken: "at-2",
    refreshToken: "rt-2",
    email: "b@example.com",
    expiresAt: "2030-01-01T00:00:00.000Z",
    accountUuid: "acct-b",
    provider: "codex",
    planType: "team",
    routing: { bias: 0.2, level: "pro" },
  });
  const seeded = manager.getNextAccount({
    sessionKey: "session-1",
    apiKeyTier: "pro",
  });
  assert.equal(seeded.account?.token.email, "b@example.com");

  const app = createServer(
    {
      host: "",
      port: 0,
      "auth-dir": tmp,
      "api-key-rate-limit": {
        "window-ms": 5 * 60 * 60 * 1000,
        "max-requests": 300,
      },
      "body-limit": "1mb",
      cloaking: {},
      timeouts: {
        "messages-ms": 1000,
        "stream-messages-ms": 1000,
        "count-tokens-ms": 1000,
      },
      stats: { enabled: true },
      debug: "off",
    } as any,
    {
      get: () => ({ id: "codex", manager }),
      forModelWithDecision: (model: string) => ({
        provider: { id: "codex", manager },
        decision: {
          model,
          resolvedModel: model,
          provider: "codex",
          reason: "codex_model_family",
          cacheHit: false,
        },
      }),
      all: () => [],
      withAccounts: () => [],
    } as any,
    apiKeys,
  );
  const server = app.listen(0);
  try {
    const port = (server.address() as any).port;
    const resp = await fetch(
      `http://127.0.0.1:${port}/admin/accounts/decision?model=gpt-5&sessionKey=session-1&apiKeyTier=pro`,
      { headers: { Authorization: "Bearer sk-test" } },
    );
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.provider, "codex");
    assert.equal(body.provider_route.reason, "codex_model_family");
    assert.equal(body.inspection.result.selectedAccountEmail, "b@example.com");
    assert.equal(body.inspection.result.decision.reason, "session_binding");
    const selected = body.inspection.accounts.find(
      (item: any) => item.email === "b@example.com",
    );
    assert.equal(selected.selected, true);
    assert.equal(selected.sessionBinding.matched, true);
    assert.match(selected.reasons.join(","), /selected:session_binding/);

    const after = manager.getNextAccount({
      sessionKey: "session-2",
      apiKeyTier: "pro",
    });
    assert.equal(after.account?.token.email, "b@example.com");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("createServer account decision requires provider or model", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-stats-"));
  const apiKeys = makeApiKeyRegistry(tmp);
  const app = createServer(
    {
      host: "",
      port: 0,
      "auth-dir": tmp,
      "api-key-rate-limit": {
        "window-ms": 5 * 60 * 60 * 1000,
        "max-requests": 300,
      },
      "body-limit": "1mb",
      cloaking: {},
      timeouts: {
        "messages-ms": 1000,
        "stream-messages-ms": 1000,
        "count-tokens-ms": 1000,
      },
      stats: { enabled: true },
      debug: "off",
    } as any,
    {
      all: () => [],
      withAccounts: () => [],
    } as any,
    apiKeys,
  );
  const server = app.listen(0);
  try {
    const port = (server.address() as any).port;
    const resp = await fetch(
      `http://127.0.0.1:${port}/admin/accounts/decision`,
      { headers: { Authorization: "Bearer sk-test" } },
    );
    assert.equal(resp.status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("createServer admin stats returns chinese fields and formatted values", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-stats-"));
  const recorder = new StatsRecorder();
  recorder.start(tmp);
  const today = testDateWithOffset(0);
  recorder.applyEvent(
    makeStatsEvent({
      ts: testIsoAtLocalNoon(today),
      apiKeyName: "client-a",
      provider: "codex",
      accountEmail: "a@example.com",
      usage: {
        inputTokens: 12_345,
        outputTokens: 2_300_000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 987,
        reasoningOutputTokens: 21_500,
      },
    }),
  );
  const apiKeys = makeApiKeyRegistry(tmp);
  const app = createServer(
    {
      host: "",
      port: 0,
      "auth-dir": tmp,
      "api-key-rate-limit": {
        "window-ms": 5 * 60 * 60 * 1000,
        "max-requests": 300,
      },
      "body-limit": "1mb",
      cloaking: {},
      timeouts: {
        "messages-ms": 1000,
        "stream-messages-ms": 1000,
        "count-tokens-ms": 1000,
      },
      stats: { enabled: true },
      debug: "off",
    } as any,
    {} as any,
    apiKeys,
    recorder,
  );
  const server = app.listen(0);
  try {
    const port = (server.address() as any).port;
    const resp = await fetch(
      `http://127.0.0.1:${port}/admin/stats?locale=zh-CN`,
      {
        headers: { Authorization: "Bearer sk-test" },
      },
    );
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.byClient, undefined);
    assert.equal(body.查询范围.开始日期, today);
    assert.equal(body.按客户端["client-a"].输入Token, "12.3k");
    assert.equal(body.按客户端["client-a"].输出Token, "2.3m");
    assert.equal(body.按客户端["client-a"].缓存命中输入Token, "987");
    assert.match(
      body.按客户端["client-a"].最后时间,
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    );
    assert.match(body.生成时间, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await recorder.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("createServer admin stats keeps english schema by default", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-stats-"));
  const recorder = new StatsRecorder();
  recorder.start(tmp);
  const today = testDateWithOffset(0);
  recorder.applyEvent(
    makeStatsEvent({
      ts: testIsoAtLocalNoon(today),
      apiKeyName: "client-a",
    }),
  );
  const apiKeys = makeApiKeyRegistry(tmp);
  const app = createServer(
    {
      host: "",
      port: 0,
      "auth-dir": tmp,
      "api-key-rate-limit": {
        "window-ms": 5 * 60 * 60 * 1000,
        "max-requests": 300,
      },
      "body-limit": "1mb",
      cloaking: {},
      timeouts: {
        "messages-ms": 1000,
        "stream-messages-ms": 1000,
        "count-tokens-ms": 1000,
      },
      stats: { enabled: true },
      debug: "off",
    } as any,
    {} as any,
    apiKeys,
    recorder,
  );
  const server = app.listen(0);
  try {
    const port = (server.address() as any).port;
    const resp = await fetch(`http://127.0.0.1:${port}/admin/stats`, {
      headers: { Authorization: "Bearer sk-test" },
    });
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(typeof body.generated_at, "string");
    assert.equal(body.range.start_date, today);
    assert.equal(body.生成时间, undefined);
    assert.equal(body.byClient["client-a"].name, "client-a");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await recorder.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("createServer admin stats filters by date query", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-stats-"));
  const recorder = new StatsRecorder();
  recorder.start(tmp);
  const today = testDateWithOffset(0);
  const yesterday = testDateWithOffset(-1);
  recorder.applyEvent(
    makeStatsEvent({
      ts: testIsoAtLocalNoon(today),
      apiKeyName: "today-client",
    }),
  );
  recorder.applyEvent(
    makeStatsEvent({
      ts: testIsoAtLocalNoon(yesterday),
      apiKeyName: "yesterday-client",
    }),
  );
  const apiKeys = makeApiKeyRegistry(tmp);
  const app = createServer(
    {
      host: "",
      port: 0,
      "auth-dir": tmp,
      "api-key-rate-limit": {
        "window-ms": 5 * 60 * 60 * 1000,
        "max-requests": 300,
      },
      "body-limit": "1mb",
      cloaking: {},
      timeouts: {
        "messages-ms": 1000,
        "stream-messages-ms": 1000,
        "count-tokens-ms": 1000,
      },
      stats: { enabled: true },
      debug: "off",
    } as any,
    {} as any,
    apiKeys,
    recorder,
  );
  const server = app.listen(0);
  try {
    const port = (server.address() as any).port;
    const resp = await fetch(
      `http://127.0.0.1:${port}/admin/stats?date=${yesterday}`,
      { headers: { Authorization: "Bearer sk-test" } },
    );
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.range.start_date, yesterday);
    assert.equal(body.totals.requests, 1);
    assert.equal(body.byClient["yesterday-client"].requests, 1);
    assert.equal(body.byClient["today-client"], undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await recorder.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("createServer admin stats rejects dates outside the last week", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-stats-"));
  const recorder = new StatsRecorder();
  recorder.start(tmp);
  const apiKeys = makeApiKeyRegistry(tmp);
  const app = createServer(
    {
      host: "",
      port: 0,
      "auth-dir": tmp,
      "api-key-rate-limit": {
        "window-ms": 5 * 60 * 60 * 1000,
        "max-requests": 300,
      },
      "body-limit": "1mb",
      cloaking: {},
      timeouts: {
        "messages-ms": 1000,
        "stream-messages-ms": 1000,
        "count-tokens-ms": 1000,
      },
      stats: { enabled: true },
      debug: "off",
    } as any,
    {} as any,
    apiKeys,
    recorder,
  );
  const server = app.listen(0);
  try {
    const port = (server.address() as any).port;
    const tooOld = testDateWithOffset(-7);
    const resp = await fetch(
      `http://127.0.0.1:${port}/admin/stats?date=${tooOld}`,
      { headers: { Authorization: "Bearer sk-test" } },
    );
    assert.equal(resp.status, 400);
    const body = await resp.json();
    assert.match(body.error.message, /last 7 days/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await recorder.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("createServer stats records client disconnects on close", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-stats-"));
  const recorder = new StatsRecorder();
  recorder.start(tmp);
  const apiKeys = makeApiKeyRegistry(tmp);
  const app = createServer(
    {
      host: "",
      port: 0,
      "auth-dir": tmp,
      "api-key-rate-limit": {
        "window-ms": 5 * 60 * 60 * 1000,
        "max-requests": 300,
      },
      "body-limit": "1mb",
      cloaking: {},
      timeouts: {
        "messages-ms": 1000,
        "stream-messages-ms": 1000,
        "count-tokens-ms": 1000,
      },
      stats: { enabled: true },
      debug: "off",
    } as any,
    {} as any,
    apiKeys,
    recorder,
  );
  let resolveReached!: () => void;
  const reached = new Promise<void>((resolve) => {
    resolveReached = resolve;
  });
  app.get("/v1/hang", (_req, res) => {
    if (res.locals.stats) res.locals.stats.model = "hang";
    resolveReached();
    // Intentionally never write a response; the client abort below should
    // hit the stats close-path rather than finish-path.
  });

  const server = app.listen(0);
  try {
    const port = (server.address() as any).port;
    const controller = new AbortController();
    const request = fetch(`http://127.0.0.1:${port}/v1/hang`, {
      headers: { Authorization: "Bearer sk-test" },
      signal: controller.signal,
    }).catch(() => null);
    await reached;
    controller.abort();
    await request;
    await timeout(25);

    const snap = recorder.getSnapshot();
    assert.equal(snap.totals.requests, 1);
    assert.equal(snap.totals.failures, 1);
    assert.equal(snap.byApi["GET /v1/hang|hang|unknown"].failures, 1);

    await recorder.stop();
    const event = JSON.parse(fs.readFileSync(statsFilePath(tmp), "utf-8"));
    assert.equal(event.status, "failure");
    assert.equal(event.statusCode, 499);
    assert.equal(event.failureKind, "client_disconnect");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await recorder.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("createServer stats records api-key rate-limited requests", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-stats-"));
  const recorder = new StatsRecorder();
  recorder.start(tmp);
  const apiKeys = new ApiKeyRegistry(tmp, {
    bootstrapAdminKey: "sk-admin",
    seededKeys: ["sk-lite"],
    tierLimits: {
      lite: { concurrency: 5, maxRequests5h: 1 },
      pro: { concurrency: 10, maxRequests5h: 2 },
      admin: { concurrency: 10, maxRequests5h: 2 },
    },
  });
  apiKeys.load();
  const app = createServer(
    {
      host: "",
      port: 0,
      "auth-dir": tmp,
      "api-key-rate-limit": {
        "window-ms": 5 * 60 * 60 * 1000,
        "max-requests": 1,
      },
      "body-limit": "1mb",
      cloaking: {},
      timeouts: {
        "messages-ms": 1000,
        "stream-messages-ms": 1000,
        "count-tokens-ms": 1000,
      },
      stats: { enabled: true },
      debug: "off",
    } as any,
    {
      withAccounts: () => [],
      all: () => [],
    } as any,
    apiKeys,
    recorder,
  );
  const server = app.listen(0);
  try {
    const port = (server.address() as any).port;
    const headers = { Authorization: "Bearer sk-lite" };
    const first = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers,
    });
    const second = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers,
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 429);

    const snap = recorder.getSnapshot();
    const apiBucket = snap.byApi["GET /v1/models|unknown|unknown"];
    assert.equal(apiBucket.requests, 2);
    assert.equal(apiBucket.failures, 1);
    assert.equal(snap.totals.failures, 1);

    await recorder.stop();
    const events = fs
      .readFileSync(statsFilePath(tmp), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.length, 2);
    assert.equal(events[0].apiKeyName, "lite");
    assert.equal(events[1].statusCode, 429);
    assert.equal(events[1].failureKind, "rate_limit");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await recorder.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("StatsRecorder persists to JSONL and replays on restart", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-stats-"));
  try {
    const recorder = new StatsRecorder();
    recorder.start(tmp);
    recorder.record({
      apiKeyHash: "a".repeat(64),
      ip: "127.0.0.1",
      ua: "test-ua",
      endpoint: "POST /v1/chat/completions",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      accountEmail: "alice@example.com",
      status: "success",
      failureKind: null,
      statusCode: 200,
      latencyMs: 100,
      usage: {
        inputTokens: 7,
        outputTokens: 3,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        reasoningOutputTokens: 0,
      },
    });
    await recorder.stop();

    // Verify the JSONL was written.
    const content = fs.readFileSync(statsFilePath(tmp), "utf-8").trim();
    assert.equal(content.split("\n").length, 1);
    const parsed = JSON.parse(content);
    assert.equal(parsed.endpoint, "POST /v1/chat/completions");
    assert.equal(parsed.usage.inputTokens, 7);

    // Replay into a fresh recorder.
    const recovered = new StatsRecorder();
    recovered.start(tmp);
    const snap = recovered.getSnapshot();
    assert.equal(snap.totals.requests, 1);
    assert.equal(snap.totals.totalInputTokens, 7);
    await recovered.stop();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("replayStatsEvents skips corrupted lines", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-stats-"));
  try {
    const file = path.join(tmp, "stats.jsonl");
    const valid = JSON.stringify(makeStatsEvent());
    fs.writeFileSync(
      file,
      `${valid}\n{not-json}\n{"endpoint":"x"}\n${valid}\n`,
    );
    let applied = 0;
    const result = replayStatsEvents(file, () => {
      applied++;
    });
    assert.equal(applied, 2);
    assert.equal(result.lines, 4);
    assert.equal(result.skipped, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("StatsRecorder replay ignores partial schema rows without polluting aggregates", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-stats-"));
  try {
    fs.writeFileSync(statsFilePath(tmp), '{"endpoint":"x"}\n');
    const recorder = new StatsRecorder();
    recorder.start(tmp);
    const snap = recorder.getSnapshot();
    assert.equal(snap.totals.requests, 0);
    assert.deepEqual(snap.byClient, {});
    await recorder.stop();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("generateDailyReport renders chinese token usage", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-report-"));
  try {
    const date = "2026-06-17";
    let sentBody: { text: string; html: string } | null = null;
    const recorder = new TraceRecorder(tmp, {
      enabled: true,
      trace: { enabled: true, retentionDays: 14 },
      report: {
        enabled: true,
        scheduleHour: 2,
        timezone: "Asia/Shanghai",
        retentionDays: 14,
        recipients: ["ops@example.com"],
      },
    });
    fs.mkdirSync(path.dirname(recorder.traceFilePath(date)), {
      recursive: true,
    });
    const event: TraceEvent = {
      v: 1,
      ts: "2026-06-17T12:00:00.000Z",
      traceId: "trace-token",
      endpoint: "POST /v1/chat/completions",
      method: "POST",
      path: "/v1/chat/completions",
      apiKeyHash: "a".repeat(64),
      apiKeyName: "client-a",
      ip: "127.0.0.1",
      ua: "test",
      model: "gpt-5.5",
      provider: "codex",
      accountEmailHash: "acct",
      status: "success",
      failureKind: null,
      statusCode: 200,
      latencyMs: 1234,
      routing: {},
      cache: {
        modelRoute: "hit",
        sessionRoute: "miss",
        promptCacheReadTokens: 30,
        promptCacheCreationTokens: 4,
      },
      steps: [],
      attempts: [],
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 4,
        cacheReadInputTokens: 30,
        reasoningOutputTokens: 7,
      },
    };
    fs.writeFileSync(
      recorder.traceFilePath(date),
      `${JSON.stringify(event)}\n`,
    );

    const result = await generateDailyReport(
      {
        observability: {
          enabled: true,
          trace: { enabled: true, retentionDays: 14 },
          report: {
            enabled: true,
            scheduleHour: 2,
            timezone: "Asia/Shanghai",
            retentionDays: 14,
            recipients: ["ops@example.com"],
          },
        },
      } as any,
      recorder,
      { date, sendEmail: true },
      async (_subject, body) => {
        sentBody = body;
      },
    );

    assert.equal(result.emailed, true);
    assert.equal(result.summary.tokens.inputTokens, "100");
    assert.equal(result.summary.tokens.outputTokens, "50");
    assert.equal(result.summary.tokens.reasoningOutputTokens, "7");
    assert.equal(result.summary.tokens.promptCacheReadTokens, "30");
    assert.equal(result.summary.tokens.promptCacheCreationTokens, "4");
    assert.equal(result.summary.tokens.totalTokens, "157");
    assert.match(result.html, /Token 用量/);
    assert.match(result.html, /输入 token/);
    assert.match(result.html, /输入缓存命中 token/);
    assert.match(result.html, /缓存与路由/);
    assert.match(result.html, /服务商分布/);
    assert.doesNotMatch(result.html, /Cache Read Tokens/);
    assert.doesNotMatch(result.html, /Provider 分布/);
    assert.ok(sentBody);
    assert.match(sentBody.text, /服务商分布/);
    assert.match(sentBody.text, /输入 token: 100/);
    assert.doesNotMatch(sentBody.text, /Provider 分布/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("createMailSender sends report through Resend", async () => {
  const originalFetch = globalThis.fetch;
  let captured: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = (async (url: any, init?: any) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify({ id: "email_123" }), { status: 200 });
  }) as typeof fetch;
  try {
    const sendMail = createMailSender({
      provider: "resend",
      resend: {
        apiKey: "re_test",
        from: "auth2api <report@example.com>",
        endpoint: "https://api.resend.test/emails",
      },
    });
    assert.ok(sendMail);
    await sendMail("日报", { text: "plain", html: "<b>html</b>" }, [
      "ops@example.com",
    ]);
    assert.equal(captured?.url, "https://api.resend.test/emails");
    assert.equal(
      (captured?.init.headers as Record<string, string>).Authorization,
      "Bearer re_test",
    );
    const body = JSON.parse(String(captured?.init.body));
    assert.deepEqual(body.to, ["ops@example.com"]);
    assert.equal(body.from, "auth2api <report@example.com>");
    assert.equal(body.subject, "日报");
    assert.equal(body.text, "plain");
    assert.equal(body.html, "<b>html</b>");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createMailSender surfaces Resend errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('{"message":"bad key"}', { status: 401 })) as typeof fetch;
  try {
    const sendMail = createMailSender({
      resend: {
        apiKey: "re_bad",
        from: "auth2api <report@example.com>",
      },
    });
    assert.ok(sendMail);
    await assert.rejects(
      () => sendMail("日报", { text: "plain" }, ["ops@example.com"]),
      /Resend email failed: 401/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
