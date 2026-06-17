import {
  ProviderRoutingContext,
  ProviderRoutingSelection,
} from "./routing-context";

/**
 * 根据解析后的模型名选择 provider。
 *
 * 这是纯路由逻辑：不读写缓存、不触碰 IO，也不修改 provider/account 状态。
 */
export function selectProviderForModel(
  ctx: ProviderRoutingContext,
): ProviderRoutingSelection {
  const { resolvedModel, anthropic, codex, cursor } = ctx;

  // 显式 cursor 前缀优先，保留用户强制路由到 Cursor 的能力。
  if (cursor.matchesModel(resolvedModel)) {
    return { provider: cursor, reason: "cursor_model_prefix" };
  }

  // Cursor-only 模式：只有 Cursor 有账号时，所有模型名都路由到 Cursor。
  const cursorOnly =
    cursor.manager.accountCount > 0 &&
    anthropic.manager.accountCount === 0 &&
    codex.manager.accountCount === 0;
  if (cursorOnly) return { provider: cursor, reason: "cursor_exclusive" };

  // 多 provider 模式按模型家族路由。
  if (codex.matchesModel(resolvedModel)) {
    return { provider: codex, reason: "codex_model_family" };
  }
  if (anthropic.matchesModel(resolvedModel)) {
    return { provider: anthropic, reason: "anthropic_model_family" };
  }

  // 未知模型保持历史行为：落到 anthropic，让调用方得到既有错误形态。
  return { provider: anthropic, reason: "unknown_model_fallback" };
}
