import type { CatalogScenarioPublic } from "@agent/shared";

export const HANDWRITTEN_REPLAY_SCENARIO_IDS = [
  "catalog-evidence-backed-communication-create",
  "catalog-meeting-action-record-create",
] as const;

/** 七类跨行业业务闭环主 Demo。剧本体积较大，点击时按需装载。 */
export const HERO_REPLAY_SCENARIO_IDS = [
  "catalog-contract-sow-to-approved-baseline-loop",
  "catalog-compliance-evidence-gate-loop",
  "catalog-order-delivery-defender-loop",
  "catalog-customer-issue-resolution-loop",
  "catalog-settlement-reconciliation-to-cash-loop",
  "catalog-employee-lifecycle-transition-loop",
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
  ...HERO_REPLAY_SCENARIO_IDS,
  ...HOOK_REPLAY_SCENARIO_IDS,
]);

const HERO_REPLAY_SCENARIOS = new Set<string>(HERO_REPLAY_SCENARIO_IDS);

export function isHeroReplayScenario(scenarioId: string): boolean {
  return HERO_REPLAY_SCENARIOS.has(scenarioId);
}

export function hasReplayScript(scenario: CatalogScenarioPublic): boolean {
  return HANDWRITTEN_REPLAY_SCENARIOS.has(scenario.id) || !!scenario.presentation;
}
