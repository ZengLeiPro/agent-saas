import type { CatalogScenarioPublic, WorkflowLibraryPublicV3 } from "@agent/shared";
import type { IndustryFilterValue } from "./useIndustryFilter";
import { hasReplayScript } from "./replay/availability";

export const OUTCOME_ALL = "all" as const;
export const ROLE_ALL = "all" as const;
export const VERTICAL_ALL = "all" as const;
export const BUSINESS_MODEL_ALL = "all" as const;
export const MATURITY_ALL = "all" as const;

export const OUTCOME_OPTIONS = [
  "找客户",
  "推进成交",
  "追回款",
  "保交付",
  "控库存",
  "降客诉",
  "提人效",
  "控风险",
] as const;

export type OutcomeFilterValue = typeof OUTCOME_ALL | (typeof OUTCOME_OPTIONS)[number];
export type RoleFilterValue = typeof ROLE_ALL | string;
export type VerticalFilterValue = typeof VERTICAL_ALL | string;
export type BusinessModelFilterValue = typeof BUSINESS_MODEL_ALL | string;
export type MaturityFilterValue = typeof MATURITY_ALL | string;

export interface WorkflowFilters {
  outcome: OutcomeFilterValue;
  role: RoleFilterValue;
  industry: IndustryFilterValue;
  vertical?: VerticalFilterValue;
  businessModel?: BusinessModelFilterValue;
  maturity?: MaturityFilterValue;
}

export function filterWorkflowScenarios(
  scenarios: readonly CatalogScenarioPublic[],
  filters: WorkflowFilters,
): CatalogScenarioPublic[] {
  const seen = new Set<string>();
  const filtered = scenarios.filter((scenario) => {
    if (seen.has(scenario.id)) return false;
    seen.add(scenario.id);
    if (filters.outcome !== OUTCOME_ALL && !scenario.goalTags.includes(filters.outcome)) return false;
    if (filters.role !== ROLE_ALL && !scenario.roleIds.includes(filters.role)) return false;
    if (filters.industry !== "all" && !scenario.industryTags.includes(filters.industry)) return false;
    if (filters.vertical && filters.vertical !== VERTICAL_ALL
      && !scenario.industryVerticals.includes(filters.vertical)) return false;
    if (filters.businessModel && filters.businessModel !== BUSINESS_MODEL_ALL
      && !scenario.businessModels.includes(filters.businessModel)) return false;
    if (filters.maturity && filters.maturity !== MATURITY_ALL
      && !scenario.maturityLevels.includes(filters.maturity)) return false;
    return true;
  });
  return sortWorkflowScenarios(filtered);
}

/**
 * 钩子场景：空白对话框里那句一句话入口对应的目录条目（08-09 批次）。
 * 约定用 id 前缀识别；若未来需要更强语义，应提升为 schema 字段而不是扩散此判断。
 */
export function isHookScenario(scenario: Pick<CatalogScenarioPublic, "id">): boolean {
  return scenario.id.startsWith("catalog-hook-");
}

/** Hero 仅决定目录优先级；客户面不消费设计评分或内部评审状态。 */
export function sortWorkflowScenarios(
  scenarios: readonly CatalogScenarioPublic[],
): CatalogScenarioPublic[] {
  return scenarios
    .map((scenario, index) => ({ scenario, index }))
    .sort((left, right) => {
      if (left.scenario.featured !== right.scenario.featured) {
        return left.scenario.featured ? -1 : 1;
      }
      if (left.scenario.featured && right.scenario.featured) {
        const orderDelta = (left.scenario.featuredOrder ?? Number.MAX_SAFE_INTEGER)
          - (right.scenario.featuredOrder ?? Number.MAX_SAFE_INTEGER);
        if (orderDelta !== 0) return orderDelta;
      }
      return left.index - right.index;
    })
    .map(({ scenario }) => scenario);
}

export function workflowSkinFor(
  library: WorkflowLibraryPublicV3,
  scenario: CatalogScenarioPublic,
  skinId?: string | null,
  selection?: {
    vertical: VerticalFilterValue;
    businessModel: BusinessModelFilterValue;
    maturity: MaturityFilterValue;
  },
) {
  const candidates = library.skins.filter((skin) => skin.workflowId === scenario.workflowId);
  if (skinId) {
    const exact = candidates.find((skin) => skin.id === skinId);
    if (exact) return exact;
  }
  if (scenario.skinId) {
    const catalogDefault = candidates.find((skin) => skin.id === scenario.skinId);
    if (catalogDefault) return catalogDefault;
  }
  if (!selection
    || selection.vertical === VERTICAL_ALL
    || selection.businessModel === BUSINESS_MODEL_ALL
    || selection.maturity === MATURITY_ALL) return null;
  return candidates
    .filter((skin) => (
      skin.industryVerticals.includes(selection.vertical)
      && skin.businessModels.includes(selection.businessModel)
      && skin.maturityProfiles.some((profile) => profile.level === selection.maturity)
    ))
    .sort((left, right) => {
      const specificity = (left.industryVerticals.length + left.businessModels.length)
        - (right.industryVerticals.length + right.businessModels.length);
      return specificity || left.id.localeCompare(right.id, "zh-CN");
    })[0] ?? null;
}

export function workflowRoleViewFor(
  library: WorkflowLibraryPublicV3,
  scenario: CatalogScenarioPublic,
  roleViewId?: string | null,
  roleId?: string | null,
) {
  const candidates = library.roleViews.filter((view) => (
    view.workflowId === scenario.workflowId && scenario.roleViewIds.includes(view.id)
  ));
  if (roleViewId) {
    const exact = candidates.find((view) => view.id === roleViewId);
    if (exact) return exact;
  }
  if (roleId && roleId !== ROLE_ALL) {
    const matched = candidates.find((view) => view.roleId === roleId);
    if (matched) return matched;
  }
  return null;
}

export const primaryTypeLabel: Record<CatalogScenarioPublic["primaryType"], string> = {
  CREATE: "产出成果",
  WATCH: "持续巡检",
  ACT: "会动系统",
  LOOP: "持续闭环",
};

export const readinessLabel: Record<CatalogScenarioPublic["readiness"], string> = {
  D0_CURRENT: "当前即用",
  D1_CONNECTOR: "标准接入",
  D2_PROJECT: "项目集成",
};

export type WorkflowPrimaryAction = "chat" | "connector" | "diagnosis" | "presentation" | "detail";

export interface WorkflowCta {
  action: WorkflowPrimaryAction;
  label: string;
  secondaryLabel?: string;
  secondaryAction?: WorkflowPrimaryAction;
}

/**
 * 有预定义剧本时优先展示纯回放；没有剧本时按服务端成熟度进入真实接入路径。
 * 展示能力与执行能力只共享 UI 契约，不共享 Runtime。
 */
export function workflowCta(scenario: CatalogScenarioPublic): WorkflowCta {
  const operational = workflowOperationalCta(scenario);
  // 手写剧本与 Workflow V3 presentation 同权：能看演示的场景，主按钮就是看演示
  if (hasReplayScript(scenario)) {
    return {
      action: "presentation",
      label: "看它如何完成",
      secondaryLabel: operational.label,
      secondaryAction: operational.action,
    };
  }
  return operational;
}

export function workflowOperationalCta(scenario: CatalogScenarioPublic): WorkflowCta {
  if (scenario.launch.startMode === "chat") {
    return { action: "chat", label: scenario.cta.primary };
  }
  if (scenario.launch.startMode === "connector") {
    return { action: "connector", label: "接入我的系统", secondaryLabel: "查看工作流" };
  }
  if (scenario.launch.startMode === "diagnosis") {
    return { action: "diagnosis", label: "预约落地诊断", secondaryLabel: "查看行业演示" };
  }
  return { action: "detail", label: "查看工作流" };
}

export function workflowById(
  library: WorkflowLibraryPublicV3,
  scenario: CatalogScenarioPublic,
) {
  return library.workflows.find((workflow) => workflow.id === scenario.workflowId) ?? null;
}

export const INTERNAL_UI_FIELD_NAMES = [
  "promptTemplate",
  "toolCalls",
  "toolResults",
  "operationRef",
  "idempotencyKey",
  "runId",
  "sessionId",
  "shareToken",
  "secret",
] as const;
