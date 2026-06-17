import { RoutingConfig, RoutingLevel } from "./types";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`--routingExtra.${name} must be a finite number`);
  }
  return value;
}

function parseLevel(value: unknown): RoutingLevel | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "lite" || value === "pro") return value;
  throw new Error(`--routingExtra.level must be "lite" or "pro"`);
}

/** 解析并校验账号级代理地址；当前仅支持 HTTP(S) 代理入口。 */
function parseProxy(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`--routingExtra.proxy must be a non-empty string`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (err: any) {
    throw new Error(
      `--routingExtra.proxy must be a valid URL: ${err?.message || String(err)}`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`--routingExtra.proxy only supports http:// or https://`);
  }
  return parsed.toString();
}

export function parseRoutingExtraArg(arg?: string): RoutingConfig | undefined {
  if (!arg) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(arg);
  } catch (err: any) {
    throw new Error(`Invalid --routingExtra JSON: ${err?.message || String(err)}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error("--routingExtra must be a JSON object");
  }

  for (const key of Object.keys(parsed)) {
    if (key !== "bias" && key !== "level" && key !== "proxy") {
      throw new Error(`Unsupported --routingExtra field: ${key}`);
    }
  }

  const bias = parseNumber(parsed.bias, "bias");
  const level = parseLevel(parsed.level);
  const proxy = parseProxy(parsed.proxy);

  if (bias === undefined && level === undefined && proxy === undefined) {
    return undefined;
  }
  if (bias !== undefined && bias < 0) {
    throw new Error("--routingExtra.bias must be greater than or equal to 0");
  }

  const routing: RoutingConfig = {};
  if (bias !== undefined) routing.bias = bias;
  if (level !== undefined) routing.level = level;
  if (proxy !== undefined) routing.proxy = proxy;
  return routing;
}

export function applyRoutingExtra<T extends { routing?: RoutingConfig }>(
  token: T,
  extra?: RoutingConfig,
): T {
  if (!extra) return token;
  token.routing = {
    ...(token.routing || {}),
    ...(extra.bias !== undefined ? { bias: extra.bias } : {}),
    ...(extra.level !== undefined ? { level: extra.level } : {}),
    ...(extra.proxy !== undefined ? { proxy: extra.proxy } : {}),
  };
  return token;
}
