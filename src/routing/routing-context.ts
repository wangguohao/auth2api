import { Provider } from "../providers/types";

/** provider 路由纯函数所需的上下文。 */
export interface ProviderRoutingContext {
  resolvedModel: string;
  anthropic: Provider;
  codex: Provider;
  cursor: Provider;
}

/** provider 路由纯函数输出。 */
export interface ProviderRoutingSelection {
  provider: Provider;
  reason:
    | "cursor_model_prefix"
    | "cursor_exclusive"
    | "codex_model_family"
    | "anthropic_model_family"
    | "unknown_model_fallback";
}
