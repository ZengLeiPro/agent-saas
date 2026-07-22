import type { CatalogScenarioPublic, WorkflowLibraryPublicV3 } from "@agent/shared";
import type { IndustryFilterValue } from "./useIndustryFilter";

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

export type WorkflowPrimaryAction = "chat" | "replay" | "isolated-demo" | "connector" | "diagnosis" | "presentation" | "detail";

export interface WorkflowCta {
  action: WorkflowPrimaryAction;
  label: string;
  secondaryLabel?: string;
  secondaryAction?: WorkflowPrimaryAction;
}

/**
 * 服务端给出启动方式，Web 只做保守分发。尤其 replay 缺 sharePath 时只查看详情，
 * 绝不把 planned/design-only Demo 显示成已运行。
 */
export function workflowCta(scenario: CatalogScenarioPublic): WorkflowCta {
  const operational = workflowOperationalCta(scenario);
  if (scenario.presentation) {
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
  if (scenario.demo.evidenceLevel === "workflow_replay" && scenario.demo.sharePath) {
    return { action: "replay", label: "用示例数据体验", secondaryLabel: "查看工作流" };
  }
  return { action: "detail", label: "查看工作流" };
}

export function workflowById(
  library: WorkflowLibraryPublicV3,
  scenario: CatalogScenarioPublic,
) {
  return library.workflows.find((workflow) => workflow.id === scenario.workflowId) ?? null;
}

export function workflowIsolatedDemoFor(
  _library: WorkflowLibraryPublicV3,
  scenario: CatalogScenarioPublic,
) {
  if (scenario.readiness === "D0_CURRENT") return null;
  return scenario.launch.isolatedDemoAvailable ? true : null;
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
