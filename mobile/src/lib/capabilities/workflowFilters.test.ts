import { describe, expect, it } from 'vitest';
import type { CatalogScenarioPublic } from '@agent/shared';
import {
  EMPTY_WORKFLOW_FILTERS,
  INDUSTRY_OPTIONS,
  filterWorkflowScenarios,
  isHookScenario,
  sortWorkflowScenarios,
  verticalOptionsFor,
} from './workflowFilters';

function make(overrides: Partial<CatalogScenarioPublic>): CatalogScenarioPublic {
  return {
    id: 'catalog-a',
    industryTags: ['manufacturing'],
    industryVerticals: [],
    roleIds: ['role-sales'],
    featured: false,
    ...overrides,
  } as CatalogScenarioPublic;
}

describe('工作流目录筛选', () => {
  it('行业顺序与文案对齐 Web friendlyIndustry', () => {
    expect(INDUSTRY_OPTIONS.map((item) => item.value)).toEqual([
      'manufacturing',
      'trade',
      'retail',
      'service',
      'export',
      'ecommerce',
    ]);
    expect(INDUSTRY_OPTIONS[0].label).toBe('制造');
  });

  it('钩子场景不进目录', () => {
    expect(isHookScenario({ id: 'catalog-hook-boss-top-risks' })).toBe(true);
    expect(isHookScenario({ id: 'catalog-deadline-to-receipt-watch' })).toBe(false);
  });

  it('行业 / 垂直行业 / 岗位三层命中制，且同 id 去重', () => {
    const scenarios = [
      make({ id: 'a', industryTags: ['manufacturing'], industryVerticals: ['注塑'] }),
      make({ id: 'b', industryTags: ['trade'], industryVerticals: ['五金'] }),
      make({ id: 'a', industryTags: ['manufacturing'] }),
      make({ id: 'c', industryTags: ['manufacturing'], roleIds: ['role-finance'] }),
    ];
    expect(filterWorkflowScenarios(scenarios, EMPTY_WORKFLOW_FILTERS).map((s) => s.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(
      filterWorkflowScenarios(scenarios, {
        ...EMPTY_WORKFLOW_FILTERS,
        industry: 'manufacturing',
      }).map((s) => s.id),
    ).toEqual(['a', 'c']);
    expect(
      filterWorkflowScenarios(scenarios, { ...EMPTY_WORKFLOW_FILTERS, vertical: '注塑' }).map(
        (s) => s.id,
      ),
    ).toEqual(['a']);
    expect(
      filterWorkflowScenarios(scenarios, { ...EMPTY_WORKFLOW_FILTERS, role: 'role-finance' }).map(
        (s) => s.id,
      ),
    ).toEqual(['c']);
  });

  it('Hero 优先，featuredOrder 次之，其余保持服务端顺序', () => {
    const sorted = sortWorkflowScenarios([
      make({ id: 'plain-1' }),
      make({ id: 'hero-2', featured: true, featuredOrder: 2 }),
      make({ id: 'plain-2' }),
      make({ id: 'hero-1', featured: true, featuredOrder: 1 }),
    ]);
    expect(sorted.map((s) => s.id)).toEqual(['hero-1', 'hero-2', 'plain-1', 'plain-2']);
  });

  it('垂直行业选项跟随当前行业收敛', () => {
    const scenarios = [
      make({ id: 'a', industryTags: ['manufacturing'], industryVerticals: ['注塑', '五金'] }),
      make({ id: 'b', industryTags: ['trade'], industryVerticals: ['大宗'] }),
    ];
    expect(verticalOptionsFor(scenarios, 'all')).toEqual(
      ['大宗', '五金', '注塑'].sort((a, b) => a.localeCompare(b, 'zh-CN')),
    );
    expect(verticalOptionsFor(scenarios, 'manufacturing')).toEqual(
      ['五金', '注塑'].sort((a, b) => a.localeCompare(b, 'zh-CN')),
    );
    expect(verticalOptionsFor(scenarios, 'retail')).toEqual([]);
  });
});
