import crypto from "crypto";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";

/**
 * Cloaking configuration for request fingerprinting.
 * Controls how auth2api mimics Claude Code CLI's request signature.
 */
export interface CloakingConfig {
  /** CLI version to impersonate in User-Agent and fingerprint (default: 2.1.88) */
  "cli-version"?: string;
  /** Entrypoint value for billing header (default: cli) */
  entrypoint?: string;
  /**
   * Codex (ChatGPT) provider — protocol-required headers, NOT identity faking.
   * Strings live here so upstream flag-name drift can ship as a YAML edit.
   */
  codex?: {
    "user-agent"?: string;
    originator?: string;
    "cli-version"?: string;
    /** Optional: only set if upstream begins requiring an OpenAI-Beta header. */
    "openai-beta"?: string;
  };
  /**
   * Cursor provider — reverse-engineered, unstable headers for personal local
   * experiments only. Cursor version-gates requests, so keep these overrideable.
   */
  cursor?: {
    "client-version"?: string;
    "client-type"?: string;
    "agent-base-url"?: string;
    "api-base-url"?: string;
    "config-version"?: string;
    timezone?: string;
    "ghost-mode"?: string;
  };
}

export interface TimeoutConfig {
  "messages-ms": number;
  "stream-messages-ms": number;
  "count-tokens-ms": number;
}

export interface StatsConfig {
  /** Default true. Set false to disable per-request stats recording entirely. */
  enabled: boolean;
}

export interface ApiKeyTierLimitSpec {
  concurrency?: number;
  "max-requests-5h"?: number;
}

export interface ApiKeyTierLimitsConfig {
  lite: ApiKeyTierLimitSpec;
  pro: { concurrencyMultiplier?: number; "max-requests-multiplier"?: number };
  admin: { concurrencyMultiplier?: number; "max-requests-multiplier"?: number };
}

export interface ApiKeyRateLimitConfig {
  /** Rolling/fixed window size in milliseconds for each client API key. */
  "window-ms": number;
  /** Maximum accepted requests per API key within one window. */
  "max-requests": number;
  /** Optional per-key overrides; keys are matched against configured API keys verbatim. */
  overrides?: Record<
    string,
    Partial<Pick<ApiKeyRateLimitConfig, "window-ms" | "max-requests">>
  >;
}

export type DebugMode = "off" | "errors" | "verbose";

export interface Config {
  host: string;
  port: number;
  "auth-dir": string;
  "bootstrap-admin-key"?: string;
  "api-key-tier-limits"?: ApiKeyTierLimitsConfig;
  "api-key-rate-limit": ApiKeyRateLimitConfig;
  "body-limit": string;
  cloaking: CloakingConfig;
  timeouts: TimeoutConfig;
  stats: StatsConfig;
  debug: DebugMode;
}

// Raw config shape from YAML.
type RawConfig = Config & {
  "api-keys"?: string[];
};

const DEFAULT_RAW: RawConfig = {
  host: "",
  port: 8317,
  "auth-dir": "~/.auth2api",
  "bootstrap-admin-key": "",
  "api-key-tier-limits": {
    lite: {
      concurrency: 5,
      "max-requests-5h": 300,
    },
    pro: {
      concurrencyMultiplier: 2,
      "max-requests-multiplier": 2,
    },
    admin: {
      concurrencyMultiplier: 2,
      "max-requests-multiplier": 2,
    },
  },
  "api-key-rate-limit": {
    "window-ms": 5 * 60 * 60 * 1000,
    "max-requests": 300,
  },
  "body-limit": "200mb",
  cloaking: {
    "cli-version": "2.1.88",
    entrypoint: "cli",
  },
  timeouts: {
    "messages-ms": 120000,
    "stream-messages-ms": 600000,
    "count-tokens-ms": 30000,
  },
  stats: {
    enabled: true,
  },
  debug: "off",
};

function normalizeDebugMode(value: unknown): DebugMode {
  if (value === true) return "errors";
  if (value === false || value == null) return "off";
  if (value === "off" || value === "errors" || value === "verbose")
    return value;
  return "off";
}

export function isDebugLevel(
  debug: DebugMode,
  level: Exclude<DebugMode, "off">,
): boolean {
  if (debug === "verbose") return true;
  return debug === level;
}

export function resolveAuthDir(dir: string): string {
  if (dir.startsWith("~")) {
    return path.join(process.env.HOME || "/root", dir.slice(1));
  }
  return path.resolve(dir);
}

export function generateApiKey(): string {
  return "sk-" + crypto.randomBytes(32).toString("hex");
}

export function loadConfig(configPath?: string): Config {
  const filePath = configPath || "config.yaml";
  let raw: RawConfig;

  if (!fs.existsSync(filePath)) {
    console.log(`Config file not found at ${filePath}, using defaults`);
    raw = { ...DEFAULT_RAW };
  } else {
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = yaml.load(content) as Partial<RawConfig>;
    const { ["api-keys"]: _legacyApiKeys, ...parsedWithoutLegacyKeys } =
      parsed as Partial<RawConfig> & { "api-keys"?: unknown };
    const parsedTierLimits = (parsed["api-key-tier-limits"] || {}) as Partial<ApiKeyTierLimitsConfig>;
    const defaultTierLimits = DEFAULT_RAW["api-key-tier-limits"]!;
    raw = {
      ...DEFAULT_RAW,
      ...parsedWithoutLegacyKeys,
      "api-key-rate-limit": {
        ...DEFAULT_RAW["api-key-rate-limit"],
        ...(parsed["api-key-rate-limit"] || {}),
        overrides: {
          ...(DEFAULT_RAW["api-key-rate-limit"].overrides || {}),
          ...((parsed["api-key-rate-limit"]?.overrides as Record<
            string,
            Partial<Pick<ApiKeyRateLimitConfig, "window-ms" | "max-requests">>
          > | undefined) || {}),
        },
      },
      "api-key-tier-limits": {
        ...defaultTierLimits,
        ...parsedTierLimits,
        lite: {
          ...defaultTierLimits.lite,
          ...(parsedTierLimits.lite || {}),
        },
        pro: {
          ...defaultTierLimits.pro,
          ...(parsedTierLimits.pro || {}),
        },
        admin: {
          ...defaultTierLimits.admin,
          ...(parsedTierLimits.admin || {}),
        },
      },
      cloaking: { ...DEFAULT_RAW.cloaking, ...(parsed.cloaking || {}) },
      timeouts: { ...DEFAULT_RAW.timeouts, ...(parsed.timeouts || {}) },
      stats: { ...DEFAULT_RAW.stats, ...(parsed.stats || {}) },
    };
  }

  raw.debug = normalizeDebugMode(raw.debug);

  // Auto-generate bootstrap admin key if missing.
  if (!raw["bootstrap-admin-key"]) {
    raw["bootstrap-admin-key"] = generateApiKey();
    fs.writeFileSync(filePath, yaml.dump(raw, { lineWidth: -1 }), {
      mode: 0o600,
    });
    console.log(
      `\nGenerated bootstrap admin key (saved to ${filePath}):\n\n  ${raw["bootstrap-admin-key"]}\n`,
    );
  }

  return { ...raw };
}

export function resolveApiKeyRateLimit(
  config: ApiKeyRateLimitConfig,
  apiKey: string,
): Pick<ApiKeyRateLimitConfig, "window-ms" | "max-requests"> {
  const override = config.overrides?.[apiKey];
  return {
    "window-ms": override?.["window-ms"] ?? config["window-ms"],
    "max-requests": override?.["max-requests"] ?? config["max-requests"],
  };
}

export function resolveTierLimit(
  limits: ApiKeyTierLimitsConfig,
  tier: "lite" | "pro" | "admin",
): { concurrency: number; maxRequests5h: number } {
  const lite = limits.lite;
  const liteConcurrency = lite.concurrency ?? 5;
  const liteRequests = lite["max-requests-5h"] ?? 300;
  if (tier === "lite") {
    return { concurrency: liteConcurrency, maxRequests5h: liteRequests };
  }

  const spec = limits[tier];
  const concurrencyMultiplier = spec.concurrencyMultiplier ?? 2;
  const requestsMultiplier = spec["max-requests-multiplier"] ?? 2;
  return {
    concurrency: Math.max(1, Math.round(liteConcurrency * concurrencyMultiplier)),
    maxRequests5h: Math.max(1, Math.round(liteRequests * requestsMultiplier)),
  };
}
