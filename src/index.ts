import crypto from "crypto";
import readline from "readline";
import { Config, loadConfig, resolveAuthDir, resolveTierLimit } from "./config";
import { ProviderId, RoutingConfig } from "./auth/types";
import { generatePKCECodes } from "./auth/pkce";
import { waitForCallback } from "./auth/callback-server";
import { importCursorTokenFromLocalStorage } from "./auth/cursor/storage";
import { runCursorBrowserLogin } from "./auth/cursor/browser-oauth";
import { ApiKeyStore } from "./registry/api-key-store";
import { applyRoutingExtra, parseRoutingExtraArg } from "./auth/routing-extra";
import { buildRegistry, ProviderRegistry } from "./providers/registry";
import { getRouteLines } from "./routes";
import { createServer } from "./server";
import { notifyServerReload } from "./utils/notify-reload";
import { StatsRecorder } from "./stats/recorder";
import { installFetchKeepAliveAgent } from "./utils/fetch-agent";
import { TraceRecorder } from "./observability/trace";
import { createMailSender } from "./observability/mail";
import { DailyReportScheduler } from "./observability/scheduler";

installFetchKeepAliveAgent();

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function parseProviderArg(args: string[]): ProviderId {
  const flag = args.find((a) => a.startsWith("--provider="));
  if (!flag) return "anthropic";
  const value = flag.split("=", 2)[1];
  if (value === "anthropic" || value === "codex" || value === "cursor")
    return value;
  throw new Error(
    `Unknown provider "${value}". Supported: anthropic, codex, cursor`,
  );
}

function buildApiKeyRegistry(config: Config, authDir: string): ApiKeyStore {
  const tierLimits = config["api-key-tier-limits"] ?? {
    lite: { concurrency: 5, "max-requests-5h": 300 },
    pro: { concurrencyMultiplier: 2, "max-requests-multiplier": 2 },
    admin: { concurrencyMultiplier: 2, "max-requests-multiplier": 2 },
  };
  return new ApiKeyStore(authDir, {
    bootstrapAdminKey: config["bootstrap-admin-key"],
    tierLimits: {
      lite: resolveTierLimit(tierLimits, "lite"),
      pro: resolveTierLimit(tierLimits, "pro"),
      admin: resolveTierLimit(tierLimits, "admin"),
    },
  });
}

async function importCursorLogin(
  config: Config,
  registry: ProviderRegistry,
  apiKeys: ApiKeyStore,
  storagePath?: string,
  extra?: RoutingConfig,
): Promise<void> {
  const provider = registry.get("cursor");
  const tokenData = importCursorTokenFromLocalStorage(storagePath);
  provider.manager.addAccount(applyRoutingExtra(tokenData, extra));
  console.log("\nCursor local login imported.");
  console.log(`Account: ${tokenData.email}`);
  console.log(`Token expires: ${tokenData.expiresAt}`);
  console.log(
    "Note: Cursor provider support is experimental and uses non-public APIs.",
  );
  await notifyServerReload(config, apiKeys.getAdminSecret() || undefined);
}

async function browserCursorLogin(
  config: Config,
  registry: ProviderRegistry,
  apiKeys: ApiKeyStore,
  extra?: RoutingConfig,
): Promise<void> {
  const provider = registry.get("cursor");
  console.log("\nLogging in to cursor (browser flow).");
  const result = await runCursorBrowserLogin({
    pollTimeoutMs: 15 * 60 * 1000,
    onLoginUrl: (url) => {
      console.log("\nOpen this URL in your browser to authorize Cursor:\n");
      console.log(url);
      console.log(
        '\nAfter signing in, click "Yes, Log In" — auth2api will pick up the token automatically.\n',
      );
    },
  });
  provider.manager.addAccount(applyRoutingExtra(result.token, extra));
  console.log("Cursor browser login complete.");
  console.log(`Account: ${result.token.email}`);
  console.log(`Token expires: ${result.token.expiresAt}`);
  console.log(
    "Note: Cursor provider support is experimental and uses non-public APIs.",
  );
  await notifyServerReload(config, apiKeys.getAdminSecret() || undefined);
}

async function doLogin(
  config: Config,
  registry: ProviderRegistry,
  apiKeys: ApiKeyStore,
  providerId: ProviderId,
  manual: boolean,
  extra?: RoutingConfig,
): Promise<void> {
  const provider = registry.get(providerId);

  const pkce = generatePKCECodes();
  const state = crypto.randomBytes(16).toString("hex");

  const authURL = provider.buildAuthUrl(state, pkce);
  console.log(`\nLogging in to ${provider.id}.`);
  console.log("Open this URL in your browser to login:\n");
  console.log(authURL);

  let code: string;
  let returnedState: string;

  if (manual) {
    console.log(
      "\nAfter login, your browser will redirect to a localhost URL that may fail to load.",
    );
    console.log(
      "Copy the FULL URL from your browser address bar and paste it here.\n",
    );
    const callbackURL = await prompt("Paste callback URL: ");

    const url = new URL(callbackURL);
    code = url.searchParams.get("code") || "";
    returnedState = url.searchParams.get("state") || "";

    if (!code) {
      console.error("Error: No authorization code found in URL");
      process.exit(1);
    }
    if (returnedState !== state) {
      console.error("Error: State mismatch — possible CSRF attack");
      process.exit(1);
    }
  } else {
    console.log("\nWaiting for OAuth callback...\n");
    const result = await waitForCallback({
      port: provider.oauth.callbackPort,
      callbackPath: provider.oauth.callbackPath,
    });
    code = result.code;
    returnedState = result.state;
  }

  console.log("Exchanging code for tokens...");
  const tokenData = await provider.exchangeCode(
    code,
    returnedState,
    state,
    pkce,
  );
  if (!tokenData.provider) tokenData.provider = provider.id;
  provider.manager.addAccount(applyRoutingExtra(tokenData, extra));
  console.log(`\nLogin successful! Account: ${tokenData.email}`);
  console.log(`Token expires: ${tokenData.expiresAt}`);
  await notifyServerReload(config, apiKeys.getAdminSecret() || undefined);
}

async function startServer(): Promise<void> {
  const configPath = process.argv
    .find((a) => a.startsWith("--config="))
    ?.split("=")[1];
  const config = loadConfig(configPath);
  const authDir = resolveAuthDir(config["auth-dir"]);
  const apiKeys = buildApiKeyRegistry(config, authDir);
  apiKeys.load();
  const registry = buildRegistry(authDir);
  for (const p of registry.all()) p.manager.load();

  const totalAccounts = registry
    .all()
    .reduce((sum, p) => sum + p.manager.accountCount, 0);
  if (totalAccounts === 0) {
    console.log(
      "No accounts found. Run with --login (and optionally --provider=codex) to add an account first.",
    );
    process.exit(1);
  }

  for (const p of registry.all()) {
    if (p.manager.accountCount > 0) {
      p.manager.startAutoRefresh();
      p.manager.startStatsLogger();
      p.manager.startUsageRefresher();
    }
  }

  let statsRecorder: StatsRecorder | undefined;
  if (config.stats.enabled) {
    statsRecorder = new StatsRecorder(apiKeys.getNameByHash());
    statsRecorder.start(authDir);
  }
  let traceRecorder: TraceRecorder | undefined;
  let reportScheduler: DailyReportScheduler | undefined;
  const sendMail = createMailSender(config.mail);
  if (config.observability.enabled && config.observability.trace.enabled) {
    traceRecorder = new TraceRecorder(authDir, config.observability);
    traceRecorder.prune();
    reportScheduler = new DailyReportScheduler(config, traceRecorder, sendMail);
    reportScheduler.start();
  }

  const app = createServer(
    config,
    registry,
    apiKeys,
    statsRecorder,
    traceRecorder,
    sendMail,
  );
  const host = config.host || "127.0.0.1";
  const port = config.port;

  app.listen(port, host, () => {
    console.log(`auth2api running on http://${host}:${port}`);
    console.log(`Endpoints:`);
    for (const line of getRouteLines(!!statsRecorder)) {
      console.log(line);
    }
  });

  process.on("SIGINT", () => {
    for (const p of registry.all()) {
      p.manager.stopAutoRefresh();
      p.manager.stopStatsLogger();
      p.manager.stopUsageRefresher();
    }
    reportScheduler?.stop();
    Promise.all([
      statsRecorder?.stop() ?? Promise.resolve(),
      traceRecorder?.close() ?? Promise.resolve(),
    ]).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configPath = args.find((a) => a.startsWith("--config="))?.split("=")[1];
  const config = loadConfig(configPath);
  const authDir = resolveAuthDir(config["auth-dir"]);
  const apiKeys = buildApiKeyRegistry(config, authDir);
  apiKeys.load();

  if (args.includes("--login")) {
    const manual = args.includes("--manual");
    const providerId = parseProviderArg(args);
    const cursorStorage = args
      .find((a) => a.startsWith("--cursor-storage="))
      ?.split("=", 2)[1];
    const extra = parseRoutingExtraArg(
      args
        .find((a) => a.startsWith("--routingExtra="))
        ?.slice("--routingExtra=".length),
    );
    const registry = buildRegistry(authDir);
    for (const p of registry.all()) p.manager.load();
    if (providerId === "cursor") {
      if (cursorStorage || args.includes("--cursor-import-local")) {
        await importCursorLogin(
          config,
          registry,
          apiKeys,
          cursorStorage,
          extra,
        );
      } else {
        await browserCursorLogin(config, registry, apiKeys, extra);
      }
    } else {
      await doLogin(config, registry, apiKeys, providerId, manual, extra);
    }
  } else {
    await startServer();
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
