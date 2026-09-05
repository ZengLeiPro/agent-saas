/**
 * 工作流目录筛选与排序 —— 对齐 Web `scenarios/workflowUi.ts` 的
 * `filterWorkflowScenarios` / `sortWorkflowScenarios` / `isHookScenario`
 * 与 `friendlyMappings.ts` 的行业文案。
 *
 * 移动端只做「行业 + 垂直行业 + 岗位」三层（小屏放不下 Web 的六层筛选），
 * 但筛选语义逐条与 Web 相同：
 * - industryTags 命中制；
 * - industryVerticals 为空表示该场景不限垂直行业（不参与垂直筛选时命中）；
 * - Hero 优先、featuredOrder 次之、其余保持服务端声明顺序。
 *
 * 纯函数，无 RN 依赖。
 */
import type { CatalogScenarioPublic, IndustryType } from '@agent/shared';

export const FILTER_ALL = 'all' as const;
export type FilterAll = typeof FILTER_ALL;

/** Web `INDUSTRY_ORDER` + `friendlyIndustry` 的顺序与文案。 */
export const INDUSTRY_OPTIONS: ReadonlyArray<{ value: IndustryType; label: string }> = [
  { value: 'manufacturing', label: '制造' },
  { value: 'trade', label: '贸易' },
  { value: 'retail', label: '零售' },
  { value: 'service', label: '服务' },
  { value: 'export', label: '出口' },
  { value: 'ecommerce', label: '电商' },
];

export const PRIMARY_TYPE_LABEL: Record<CatalogScenarioPublic['primaryType'], string> = {
  CREATE: '产出成果',
  WATCH: '持续巡检',
  ACT: '会动系统',
  LOOP: '持续闭环',
};

export const READINESS_LABEL: Record<CatalogScenarioPublic['readiness'], string> = {
  D0_CURRENT: '当前即用',
  D1_CONNECTOR: '标准接入',
  D2_PROJECT: '项目集成',
};

export interface WorkflowFilterState {
  industry: IndustryType | FilterAll;
  vertical: string | FilterAll;
  role: string | FilterAll;
}

export const EMPTY_WORKFLOW_FILTERS: WorkflowFilterState = {
  industry: FILTER_ALL,
  vertical: FILTER_ALL,
  role: FILTER_ALL,
};

/**
 * 钩子场景只出现在空会话推荐位，不进目录（Web `isHookScenario`）。
 */
export function isHookScenario(scenario: Pick<CatalogScenarioPublic, 'id'>): boolean {
  return scenario.id.startsWith('catalog-hook-');
}

/** Hero 优先 → featuredOrder → 服务端声明顺序（Web `sortWorkflowScenarios`）。 */
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
        const delta =
          (left.scenario.featuredOrder ?? Number.MAX_SAFE_INTEGER) -
          (right.scenario.featuredOrder ?? Number.MAX_SAFE_INTEGER);
        if (delta !== 0) return delta;
      }
      return left.index - right.index;
    })
    .map(({ scenario }) => scenario);
}

export function filterWorkflowScenarios(
  scenarios: readonly CatalogScenarioPublic[],
  filters: WorkflowFilterState,
): CatalogScenarioPublic[] {
  const seen = new Set<string>();
  const filtered = scenarios.filter((scenario) => {
    if (seen.has(scenario.id)) return false;
    seen.add(scenario.id);
    if (filters.industry !== FILTER_ALL && !scenario.industryTags.includes(filters.industry)) {
      return false;
    }
    if (filters.vertical !== FILTER_ALL && !scenario.industryVerticals.includes(filters.vertical)) {
      return false;
    }
    if (filters.role !== FILTER_ALL && !scenario.roleIds.includes(filters.role)) return false;
    return true;
  });
  return sortWorkflowScenarios(filtered);
}

/**
 * 当前行业下可选的垂直行业。行业切换后旧的垂直选项可能不再存在，
 * 调用方据此重置为 `all`，避免出现「选了筛选却零结果」的死态。
 */
export function verticalOptionsFor(
  scenarios: readonly CatalogScenarioPublic[],
  industry: IndustryType | FilterAll,
): string[] {
  const pool = scenarios.filter(
    (scenario) => industry === FILTER_ALL || scenario.industryTags.includes(industry),
  );
  return [...new Set(pool.flatMap((scenario) => scenario.industryVerticals))].sort((a, b) =>
    a.localeCompare(b, 'zh-CN'),
  );
}
