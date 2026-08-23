import { knowledgeQaScript } from "./knowledgeQaScript";
import { meetingActionScript } from "./meetingActionScript";
import { presentationToReplayScript } from "./presentationReplayScript";
import type { CatalogScenarioPublic } from "@agent/shared";
import type { ReplayScript } from "./types";

/**
 * 场景演示剧本注册表。
 *
 * 单独成文件（不与回放视图同模块导出），让场景卡片查询剧本时不会把
 * MessageList 整棵组件树拉进 bundle。
 *
 * 未登记的场景维持原有分章演示对话框，不受影响。首批只登记 1 个——
 * 目的是把底层建起来，不是铺覆盖率。
 */
const SCRIPTS: ReplayScript[] = [
  knowledgeQaScript,
  meetingActionScript,
];

const BY_SCENARIO_ID = new Map(SCRIPTS.map((script) => [script.scenarioId, script]));

export function getReplayScript(
  scenarioId: string,
  scenario?: CatalogScenarioPublic,
): ReplayScript | null {
  return BY_SCENARIO_ID.get(scenarioId)
    ?? (scenario ? presentationToReplayScript(scenario) : null);
}

export function allReplayScripts(): ReplayScript[] {
  return SCRIPTS;
}
