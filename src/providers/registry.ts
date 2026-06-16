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
  all(): Provider[];
  /** Providers that have at least one logged-in account. */
  withAccounts(): Provider[];
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

  const selectProvider = (resolved: string): Provider => {
    // Explicit `cursor-` / `cr/` prefix always wins so users can force the
    // Cursor backend when they have multiple providers logged in.
    if (cursor.matchesModel(resolved)) return cursor;

    // "Cursor exclusive" mode: when only Cursor has accounts, route every
    // unknown / Anthropic-style / OpenAI-style model through Cursor. This
    // lets clients with hard-coded names (`claude-sonnet-4-5`, `gpt-5.5`,
    // `opus`) work against auth2api without a `cursor-` prefix.
    const cursorOnly =
      cursor.manager.accountCount > 0 &&
      anthropic.manager.accountCount === 0 &&
      codex.manager.accountCount === 0;
    if (cursorOnly) return cursor;

    // Multi-provider setups: fall back to the explicit family routes.
    if (codex.matchesModel(resolved)) return codex;
    if (anthropic.matchesModel(resolved)) return anthropic;
    // Unknown model + multi-provider: keep historical behaviour and
    // dispatch to anthropic so the client gets a clear "no account" error
    // for the right provider.
    return anthropic;
  };

  return {
    get: (id) => {
      const p = byId[id];
      if (!p) throw new Error(`Unknown provider: ${id}`);
      return p;
    },
    forModel: (model) => {
      const resolved = resolveModel(model);
      const signature = accountSignature();
      const cached = modelRouteCache.get(resolved);
      if (cached?.signature === signature) {
        setCachedProvider(resolved, signature, cached.provider);
        return cached.provider;
      }
      const provider = selectProvider(resolved);
      setCachedProvider(resolved, signature, provider);
      return provider;
    },
    all: () => ordered.slice(),
    withAccounts: () => ordered.filter((p) => p.manager.accountCount > 0),
  };
}
