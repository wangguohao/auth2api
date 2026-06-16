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
    if (key !== "bias" && key !== "level") {
      throw new Error(`Unsupported --routingExtra field: ${key}`);
    }
  }

  const bias = parseNumber(parsed.bias, "bias");
  const level = parseLevel(parsed.level);

  if (bias === undefined && level === undefined) return undefined;
  if (bias !== undefined && bias < 0) {
    throw new Error("--routingExtra.bias must be greater than or equal to 0");
  }

  const routing: RoutingConfig = {};
  if (bias !== undefined) routing.bias = bias;
  if (level !== undefined) routing.level = level;
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
  };
  return token;
}
