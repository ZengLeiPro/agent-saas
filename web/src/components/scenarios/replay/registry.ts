import { complianceGateScript } from "./complianceGateScript";
import { deadlineWatchScript } from "./deadlineWatchScript";
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
  complianceGateScript,
  meetingActionScript,
  deadlineWatchScript,
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

/**
 * 这个场景能不能「先看一遍它怎么干活」。
 *
 * 卡片 CTA 用它决定主按钮，而不是直接看 `scenario.presentation`——
 * 手写剧本同样要让卡片长出演示入口（07-26 实机走查：首屏推荐位只有
 * 「接入我的系统」，客户第一眼看到的三张卡点下去是配置页，不是演示）。
 */
export function hasReplayScript(scenario: CatalogScenarioPublic): boolean {
  return BY_SCENARIO_ID.has(scenario.id) || !!scenario.presentation;
}
