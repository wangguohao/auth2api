import { RoutingLevel, TokenData } from "../auth/types";

/** Codex 路由窗口元数据，来源于账号状态快照。 */
export interface CodexRoutingMetadata {
  resetAt: string | null;
  resetPeriodMs: number | null;
}

/** Codex 候选账号打分所需的最小输入。 */
export interface CodexRoutingCandidate {
  failureCount: number;
  routing: CodexRoutingMetadata;
  routingPlan: RoutingPlan;
}

/** 预计算后的账号路由计划，避免请求路径反复解析 token routing 配置。 */
export interface RoutingPlan {
  level: RoutingLevel;
  baseScore: number;
}

/** 根据套餐类型推断 quota 重置周期。 */
export function inferResetPeriodMs(planType: string | undefined): number | null {
  switch ((planType || "").toLowerCase()) {
    case "plus":
    case "pro":
      return 5 * 60 * 60 * 1000;
    case "team":
      return 30 * 24 * 60 * 60 * 1000;
    default:
      return null;
  }
}

/** 根据套餐类型推断管理接口中展示的窗口类型。 */
export function inferWindowType(planType: string | undefined): string | null {
  switch ((planType || "").toLowerCase()) {
    case "plus":
      return "plus_5h";
    case "pro":
      return "pro_5h";
    case "team":
      return "team_monthly";
    default:
      return null;
  }
}

/** 套餐基础偏置，保留既有 free 优先、plus/pro 小幅加权的策略。 */
function planTypeBias(planType: string | undefined): number {
  switch ((planType || "").toLowerCase()) {
    case "plus":
      return 0.08;
    case "pro":
      return 0.05;
    case "team":
      return 0.03;
    case "free":
      return 1;
    default:
      return 0;
  }
}

/** 从 token 中预计算账号路由计划，保留 routing.bias 与 routing.level 功能。 */
export function buildRoutingPlan(token: TokenData): RoutingPlan {
  return {
    level: (token.routing?.level || "lite").toLowerCase() as RoutingLevel,
    baseScore: planTypeBias(token.planType) + (token.routing?.bias ?? 0),
  };
}

/** 计算距离重置窗口越近越高的紧迫度，范围约为 0~1。 */
export function computeResetUrgency(
  routing: CodexRoutingMetadata,
  now: number,
): number {
  const { resetAt, resetPeriodMs } = routing;
  if (!resetAt || !resetPeriodMs || resetPeriodMs <= 0) return 0;
  const remainingMs = new Date(resetAt).getTime() - now;
  const clamped = Math.max(0, Math.min(remainingMs, resetPeriodMs));
  return 1 - clamped / resetPeriodMs;
}

/** Codex smart routing 的纯打分函数。 */
export function scoreCodexCandidate(
  candidate: CodexRoutingCandidate,
  now: number,
): number {
  const resetUrgency = computeResetUrgency(candidate.routing, now);
  const healthPenalty = Math.min(candidate.failureCount * 0.15, 0.6);
  return resetUrgency * 0.75 + candidate.routingPlan.baseScore - healthPenalty;
}
