import { ApiKeyTier, RoutingLevel } from "../auth/types";

/** API key tier 到账号路由等级的预计算权限表。 */
const TIER_ALLOWED_LEVELS: Record<ApiKeyTier, ReadonlySet<RoutingLevel>> = {
  lite: new Set(["lite"]),
  pro: new Set(["lite", "pro"]),
  admin: new Set(["lite", "pro"]),
};

/**
 * 判断指定 API key tier 是否允许使用某个账号路由等级。
 *
 * 这是请求路径上的 O(1) 查表逻辑，替代散落的 switch 判断。
 */
export function isRoutingLevelAllowedForTier(
  accountLevel: RoutingLevel | undefined,
  apiKeyTier: ApiKeyTier | undefined,
): boolean {
  if (!apiKeyTier) return true;
  const level = accountLevel || "lite";
  return TIER_ALLOWED_LEVELS[apiKeyTier]?.has(level) ?? false;
}

/** 返回某个 API key tier 可访问的账号路由等级列表。 */
export function allowedRoutingLevelsForTier(
  apiKeyTier: ApiKeyTier,
): RoutingLevel[] {
  return Array.from(TIER_ALLOWED_LEVELS[apiKeyTier] ?? []);
}
