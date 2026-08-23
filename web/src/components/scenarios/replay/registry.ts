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

/** 七类 Hero 闭环按需装载，避免完整企业系统面板和演示数据进入主 bundle。 */
const HERO_SCRIPT_LOADERS: Record<string, () => Promise<ReplayScript>> = {
  "catalog-contract-sow-to-approved-baseline-loop": () =>
    import("./contractBaselineScript").then((module) => module.contractBaselineScript),
  "catalog-compliance-evidence-gate-loop": () =>
    import("./complianceGateScript").then((module) => module.complianceGateScript),
  "catalog-order-delivery-defender-loop": () =>
    import("./deliveryRecoveryScript").then((module) => module.deliveryRecoveryScript),
  "catalog-customer-issue-resolution-loop": () =>
    import("./qualityRemedyScript").then((module) => module.qualityRemedyScript),
  "catalog-settlement-reconciliation-to-cash-loop": () =>
    import("./settlementClosureScript").then((module) => module.settlementClosureScript),
  "catalog-employee-lifecycle-transition-loop": () =>
    import("./employeeLifecycleScript").then((module) => module.employeeLifecycleScript),
  "catalog-deadline-to-receipt-watch": () =>
    import("./deadlineWatchScript").then((module) => module.deadlineWatchScript),
};

/**
 * 钩子剧本懒加载表（08-09 批次）。每条剧本内嵌 HTML 产物、体积大，
 * 静态 import 会把全部数据灌进能力中心主 bundle，故按需装载；
 * 卡片层只查 availability 的 ID 索引，不触发这里。
 */
const HOOK_SCRIPT_LOADERS: Record<string, () => Promise<ReplayScript>> = {
  "catalog-hook-promising-customers": () =>
    import("./promisingCustomersScript").then((module) => module.promisingCustomersScript),
  "catalog-hook-boss-top-risks": () =>
    import("./bossTopRisksScript").then((module) => module.bossTopRisksScript),
  "catalog-hook-visit-briefing": () =>
    import("./visitBriefingScript").then((module) => module.visitBriefingScript),
  "catalog-hook-delivery-risk-daily": () =>
    import("./deliveryRiskDailyScript").then((module) => module.deliveryRiskDailyScript),
  "catalog-hook-receivables-chase": () =>
    import("./receivablesChaseScript").then((module) => module.receivablesChaseScript),
  "catalog-hook-material-shortage": () =>
    import("./materialShortageScript").then((module) => module.materialShortageScript),
  "catalog-hook-open-complaints": () =>
    import("./openComplaintsScript").then((module) => module.openComplaintsScript),
  "catalog-hook-meeting-todos": () =>
    import("./meetingTodosScript").then((module) => module.meetingTodosScript),
  "catalog-hook-content-performance": () =>
    import("./contentPerformanceScript").then((module) => module.contentPerformanceScript),
  "catalog-hook-attendance-anomaly": () =>
    import("./attendanceAnomalyScript").then((module) => module.attendanceAnomalyScript),
};

export function getReplayScript(
  scenarioId: string,
  scenario?: CatalogScenarioPublic,
): ReplayScript | null {
  return BY_SCENARIO_ID.get(scenarioId)
    ?? (scenario ? presentationToReplayScript(scenario) : null);
}

/** 七类主闭环剧本按需装载；其他场景返回 null。 */
export function loadHeroReplayScript(scenarioId: string): Promise<ReplayScript> | null {
  const loader = HERO_SCRIPT_LOADERS[scenarioId];
  return loader ? loader() : null;
}

export function heroReplayScenarioIds(): string[] {
  return Object.keys(HERO_SCRIPT_LOADERS);
}

/** 钩子剧本按需装载；非钩子场景返回 null（调用方回落到 getReplayScript）。 */
export function loadHookReplayScript(scenarioId: string): Promise<ReplayScript> | null {
  const loader = HOOK_SCRIPT_LOADERS[scenarioId];
  return loader ? loader() : null;
}

export function hookReplayScenarioIds(): string[] {
  return Object.keys(HOOK_SCRIPT_LOADERS);
}

export function allReplayScripts(): ReplayScript[] {
  return SCRIPTS;
}
