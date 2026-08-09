import type { CatalogScenarioPublic } from "@agent/shared";

export const HANDWRITTEN_REPLAY_SCENARIO_IDS = [
  "catalog-evidence-backed-communication-create",
  "catalog-compliance-evidence-gate-loop",
  "catalog-meeting-action-record-create",
  "catalog-deadline-to-receipt-watch",
] as const;

/**
 * 钩子场景剧本（08-09 批次）。与上面 4 个的区别只在装载方式：
 * 剧本含内嵌 HTML 产物、体积大，走 registry 的懒加载 loader，不进主 bundle。
 * 契约测试对两组执行同一套机检门禁。
 */
export const HOOK_REPLAY_SCENARIO_IDS = [
  "catalog-hook-promising-customers",
  "catalog-hook-boss-top-risks",
  "catalog-hook-visit-briefing",
  "catalog-hook-delivery-risk-daily",
  "catalog-hook-receivables-chase",
  "catalog-hook-material-shortage",
  "catalog-hook-open-complaints",
  "catalog-hook-meeting-todos",
  "catalog-hook-content-performance",
  "catalog-hook-attendance-anomaly",
] as const;

const HANDWRITTEN_REPLAY_SCENARIOS = new Set<string>([
  ...HANDWRITTEN_REPLAY_SCENARIO_IDS,
  ...HOOK_REPLAY_SCENARIO_IDS,
]);

export function hasReplayScript(scenario: CatalogScenarioPublic): boolean {
  return HANDWRITTEN_REPLAY_SCENARIOS.has(scenario.id) || !!scenario.presentation;
}
