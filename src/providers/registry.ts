import { ProviderId } from "../auth/types";
import { resolveModel } from "../upstream/translator";
import { buildAnthropicProvider } from "./anthropic";
import { buildCodexProvider } from "./codex";
import { buildCursorProvider } from "./cursor";
import { Provider } from "./types";

const MODEL_ROUTE_CACHE_MAX_ENTRIES = 256;
const MODEL_ROUTE_CACHE_MAX_KEY_LENGTH = 128;

export interface ProviderRegistry {
  get(id: ProviderId): Provider;
  /** Provider that should serve `model`. Falls back to anthropic. */
  forModel(model: string): Provider;
  forModelWithDecision(model: string): ProviderRouteResult;
  all(): Provider[];
  /** Providers that have at least one logged-in account. */
  withAccounts(): Provider[];
}

export interface ProviderRouteDecision {
  model: string;
  resolvedModel: string;
  provider: ProviderId;
  reason: string;
  cacheHit: boolean;
}

export interface ProviderRouteResult {
  provider: Provider;
  decision: ProviderRouteDecision;
}

export function buildRegistry(authDir: string): ProviderRegistry {
  const anthropic = buildAnthropicProvider(authDir);
  const codex = buildCodexProvider(authDir);
  const cursor = buildCursorProvider(authDir);
  const byId: Record<ProviderId, Provider> = { anthropic, codex, cursor };
  const ordered: Provider[] = [anthropic, codex, cursor];
  const modelRouteCache = new Map<
    string,
    { signature: string; provider: Provider }
  >();

  const accountSignature = () =>
    `${anthropic.manager.accountCount}:${codex.manager.accountCount}:${cursor.manager.accountCount}`;

  const setCachedProvider = (
    resolved: string,
    signature: string,
    provider: Provider,
  ): void => {
    if (resolved.length > MODEL_ROUTE_CACHE_MAX_KEY_LENGTH) return;
    if (modelRouteCache.has(resolved)) modelRouteCache.delete(resolved);
    modelRouteCache.set(resolved, { signature, provider });
    while (modelRouteCache.size > MODEL_ROUTE_CACHE_MAX_ENTRIES) {
      const oldest = modelRouteCache.keys().next().value;
      if (oldest === undefined) break;
      modelRouteCache.delete(oldest);
    }
  };

  const selectProvider = (
    resolved: string,
  ): { provider: Provider; reason: string } => {
    // Explicit `cursor-` / `cr/` prefix always wins so users can force the
    // Cursor backend when they have multiple providers logged in.
    if (cursor.matchesModel(resolved)) {
      return { provider: cursor, reason: "cursor_model_prefix" };
    }

    // "Cursor exclusive" mode: when only Cursor has accounts, route every
    // unknown / Anthropic-style / OpenAI-style model through Cursor. This
    // lets clients with hard-coded names (`claude-sonnet-4-5`, `gpt-5.5`,
    // `opus`) work against auth2api without a `cursor-` prefix.
    const cursorOnly =
      cursor.manager.accountCount > 0 &&
      anthropic.manager.accountCount === 0 &&
      codex.manager.accountCount === 0;
    if (cursorOnly) return { provider: cursor, reason: "cursor_exclusive" };

    // Multi-provider setups: fall back to the explicit family routes.
    if (codex.matchesModel(resolved)) {
      return { provider: codex, reason: "codex_model_family" };
    }
    if (anthropic.matchesModel(resolved)) {
      return { provider: anthropic, reason: "anthropic_model_family" };
    }
    // Unknown model + multi-provider: keep historical behaviour and
    // dispatch to anthropic so the client gets a clear "no account" error
    // for the right provider.
    return { provider: anthropic, reason: "unknown_model_fallback" };
  };

  const forModelWithDecision = (model: string): ProviderRouteResult => {
    const resolved = resolveModel(model);
    const signature = accountSignature();
    const cached = modelRouteCache.get(resolved);
    if (cached?.signature === signature) {
      setCachedProvider(resolved, signature, cached.provider);
      return {
        provider: cached.provider,
        decision: {
          model,
          resolvedModel: resolved,
          provider: cached.provider.id,
          reason: "model_route_cache",
          cacheHit: true,
        },
      };
    }
    const selected = selectProvider(resolved);
    setCachedProvider(resolved, signature, selected.provider);
    return {
      provider: selected.provider,
      decision: {
        model,
        resolvedModel: resolved,
        provider: selected.provider.id,
        reason: selected.reason,
        cacheHit: false,
      },
    };
  };

  return {
    get: (id) => {
      const p = byId[id];
      if (!p) throw new Error(`Unknown provider: ${id}`);
      return p;
    },
    forModel: (model) => forModelWithDecision(model).provider,
    forModelWithDecision,
    all: () => ordered.slice(),
    withAccounts: () => ordered.filter((p) => p.manager.accountCount > 0),
  };
}
