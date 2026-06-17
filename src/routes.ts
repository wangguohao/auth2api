export const ROUTES = {
  /** 存活探针接口，无需鉴权。 */
  health: { method: "GET", path: "/health" },
  /** OpenAI 兼容的 Chat Completions 接口。 */
  v1ChatCompletions: { method: "POST", path: "/v1/chat/completions" },
  /** OpenAI 兼容的 Responses 接口。 */
  v1Responses: { method: "POST", path: "/v1/responses" },
  /** Anthropic 原生 Messages 接口。 */
  v1Messages: { method: "POST", path: "/v1/messages" },
  /** Anthropic 原生 token 计数接口。 */
  v1CountTokens: { method: "POST", path: "/v1/messages/count_tokens" },
  /** 返回当前已加载 provider 的模型列表。 */
  v1Models: { method: "GET", path: "/v1/models" },
  /** 查看 provider 账号快照和路由缓存状态。 */
  adminAccounts: { method: "GET", path: "/admin/accounts" },
  /** 管理员手动触发账号用量刷新。 */
  adminAccountsUsageRefresh: {
    method: "POST",
    path: "/admin/accounts/usage/refresh",
  },
  /** 管理员查看账号选择决策和详细原因。 */
  adminAccountsDecision: {
    method: "GET",
    path: "/admin/accounts/decision",
  },
  /** 查看聚合后的请求统计快照。 */
  adminStats: { method: "GET", path: "/admin/stats" },
  /** 查看 API key 列表。 */
  adminApiKeys: { method: "GET", path: "/admin/api-keys" },
  /** 创建新的 API key。 */
  adminApiKeysCreate: { method: "POST", path: "/admin/api-keys" },
  /** 启用指定 API key。 */
  adminApiKeysEnable: { method: "POST", path: "/admin/api-keys/:id/enable" },
  /** 禁用指定 API key。 */
  adminApiKeysDisable: { method: "POST", path: "/admin/api-keys/:id/disable" },
  /** 热重载磁盘上的 token 和 API key。 */
  adminReload: { method: "POST", path: "/admin/reload" },
  /** 生成日报，并可选发送邮件。 */
  adminDailyReport: { method: "POST", path: "/admin/reports/daily" },
} as const;

type RouteDescriptor = (typeof ROUTES)[keyof typeof ROUTES];

const PRINT_ORDER: RouteDescriptor[] = [
  ROUTES.v1ChatCompletions,
  ROUTES.v1Responses,
  ROUTES.v1Messages,
  ROUTES.v1CountTokens,
  ROUTES.v1Models,
  ROUTES.adminApiKeys,
  ROUTES.adminApiKeysCreate,
  ROUTES.adminApiKeysEnable,
  ROUTES.adminApiKeysDisable,
  ROUTES.adminReload,
  ROUTES.adminDailyReport,
  ROUTES.adminAccounts,
  ROUTES.adminAccountsUsageRefresh,
  ROUTES.adminAccountsDecision,
  ROUTES.adminStats,
  ROUTES.health,
];

export function getRouteLines(includeStats: boolean): string[] {
  return PRINT_ORDER.filter(
    (route) => includeStats || route !== ROUTES.adminStats,
  ).map((route) => `  ${route.method.padEnd(4)} ${route.path}`);
}
