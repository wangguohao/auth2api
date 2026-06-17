import { ProviderId } from "../auth/types";

/** provider 路由决策结果，供 handler 写入 trace 与 stats。 */
export interface ProviderRouteDecision {
  model: string;
  resolvedModel: string;
  provider: ProviderId;
  reason: string;
  cacheHit: boolean;
}

/** provider 路由选择原因，保持现有 trace 字段稳定。 */
export type ProviderRouteReason =
  | "model_route_cache"
  | "cursor_model_prefix"
  | "cursor_exclusive"
  | "codex_model_family"
  | "anthropic_model_family"
  | "unknown_model_fallback";
