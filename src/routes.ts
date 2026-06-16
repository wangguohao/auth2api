export const ROUTES = {
  health: { method: "GET", path: "/health" },
  v1ChatCompletions: { method: "POST", path: "/v1/chat/completions" },
  v1Responses: { method: "POST", path: "/v1/responses" },
  v1Messages: { method: "POST", path: "/v1/messages" },
  v1CountTokens: { method: "POST", path: "/v1/messages/count_tokens" },
  v1Models: { method: "GET", path: "/v1/models" },
  adminAccounts: { method: "GET", path: "/admin/accounts" },
  adminStats: { method: "GET", path: "/admin/stats" },
  adminApiKeys: { method: "GET", path: "/admin/api-keys" },
  adminApiKeysCreate: { method: "POST", path: "/admin/api-keys" },
  adminApiKeysEnable: { method: "POST", path: "/admin/api-keys/:id/enable" },
  adminApiKeysDisable: { method: "POST", path: "/admin/api-keys/:id/disable" },
  adminReload: { method: "POST", path: "/admin/reload" },
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
  ROUTES.adminAccounts,
  ROUTES.adminStats,
  ROUTES.health,
];

export function getRouteLines(includeStats: boolean): string[] {
  return PRINT_ORDER.filter((route) => includeStats || route !== ROUTES.adminStats).map(
    (route) => `  ${route.method.padEnd(4)} ${route.path}`,
  );
}
