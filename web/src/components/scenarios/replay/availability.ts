import type { CatalogScenarioPublic } from "@agent/shared";

export const HANDWRITTEN_REPLAY_SCENARIO_IDS = [
  "catalog-evidence-backed-communication-create",
  "catalog-compliance-evidence-gate-loop",
  "catalog-meeting-action-record-create",
  "catalog-deadline-to-receipt-watch",
] as const;

const HANDWRITTEN_REPLAY_SCENARIOS = new Set<string>(HANDWRITTEN_REPLAY_SCENARIO_IDS);

export function hasReplayScript(scenario: CatalogScenarioPublic): boolean {
  return HANDWRITTEN_REPLAY_SCENARIOS.has(scenario.id) || !!scenario.presentation;
}
