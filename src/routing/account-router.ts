import { ApiKeyTier, RoutingLevel } from "../auth/types";
import { isRoutingLevelAllowedForTier } from "../registry/tier-index";

/** 账号路由层的 tier 权限判断。 */
export function isAccountAllowedForTier(
  accountLevel: RoutingLevel | undefined,
  apiKeyTier: ApiKeyTier | undefined,
): boolean {
  return isRoutingLevelAllowedForTier(accountLevel, apiKeyTier);
}
