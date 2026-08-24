import type { ReplayScript } from "./types";

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

/** 钩子剧本同样只在点击演示后加载。 */
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

export function heroReplayScenarioIds(): string[] {
  return Object.keys(HERO_SCRIPT_LOADERS);
}

export function hookReplayScenarioIds(): string[] {
  return Object.keys(HOOK_SCRIPT_LOADERS);
}

/** 大体积剧本统一按需装载；未登记场景返回 null。 */
export function loadLazyReplayScript(scenarioId: string): Promise<ReplayScript> | null {
  const loader = HERO_SCRIPT_LOADERS[scenarioId] ?? HOOK_SCRIPT_LOADERS[scenarioId];
  return loader ? loader() : null;
}
