import { ProviderId } from "../auth/types";
import { ModelRouteCache } from "../cache/model-route-cache";
import { buildProviderStore } from "../registry/provider-store";
import { ProviderRouteDecision } from "../routing/routing-decision";
import { selectProviderForModel } from "../routing/provider-router";
import { resolveModel } from "../upstream/translator";
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

export interface ProviderRouteResult {
  provider: Provider;
  decision: ProviderRouteDecision;
}

export function buildRegistry(authDir: string): ProviderRegistry {
  const store = buildProviderStore(authDir);
  const { anthropic, codex, cursor } = store.byId;
  const byId: Record<ProviderId, Provider> = store.byId;
  const ordered: Provider[] = store.ordered;
  const modelRouteCache = new ModelRouteCache({
    maxEntries: MODEL_ROUTE_CACHE_MAX_ENTRIES,
    maxKeyLength: MODEL_ROUTE_CACHE_MAX_KEY_LENGTH,
  });

  const accountSignature = () =>
    `${anthropic.manager.accountCount}:${codex.manager.accountCount}:${cursor.manager.accountCount}`;

  const forModelWithDecision = (model: string): ProviderRouteResult => {
    const resolved = resolveModel(model);
    const signature = accountSignature();
    const cachedProvider = modelRouteCache.get(resolved, signature);
    if (cachedProvider) {
      return {
        provider: cachedProvider,
        decision: {
          model,
          resolvedModel: resolved,
          provider: cachedProvider.id,
          reason: "model_route_cache",
          cacheHit: true,
        },
      };
    }
    const selected = selectProviderForModel({
      resolvedModel: resolved,
      anthropic,
      codex,
      cursor,
    });
    modelRouteCache.set(resolved, signature, selected.provider);
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
