import type { CatalogScenarioPublic } from "../../types";

export const HANDWRITTEN_REPLAY_SCENARIO_IDS = [
  "catalog-evidence-backed-communication-create",
  "catalog-meeting-action-record-create",
] as const;

/** 七类跨行业业务闭环主 Demo。只保留轻量 ID 判定，剧本映射在点击后装载。 */
const HERO_REPLAY_SCENARIO_ID = /^catalog-(?:(?:contract-sow-to-approved-baseline|compliance-evidence-gate|order-delivery-defender|customer-issue-resolution|settlement-reconciliation-to-cash|employee-lifecycle-transition)-loop|deadline-to-receipt-watch)$/;

const HANDWRITTEN_REPLAY_SCENARIOS = new Set<string>(HANDWRITTEN_REPLAY_SCENARIO_IDS);

export function hasLazyReplayScript(scenarioId: string): boolean {
  return HERO_REPLAY_SCENARIO_ID.test(scenarioId)
    || scenarioId.startsWith("catalog-hook-");
}

export function hasReplayScript(scenario: CatalogScenarioPublic): boolean {
  return HANDWRITTEN_REPLAY_SCENARIOS.has(scenario.id)
    || hasLazyReplayScript(scenario.id)
    || !!scenario.presentation;
}
