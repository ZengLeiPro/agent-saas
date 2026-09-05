import { describe, expect, it } from 'vitest';
import {
  RECOMMENDATION_COUNT,
  matchRoleIdByPosition,
  pickRecommendedScenarios,
  pickRoleTopScenarios,
  resolveScenarioActionMeta,
} from './scenarioRecommendation';
import type { ScenarioItem } from '../types/scenario';

function scenario(partial: Partial<ScenarioItem> & { id: string }): ScenarioItem {
  return {
    title: partial.id,
    role: 'boss',
    industries: [],
    mode: 'oneshot',
    pitch: '',
    story: '',
    promptTemplate: '',
    slots: [],
    requires: [],
    recommendCron: false,
    ...partial,
  };
}

describe('matchRoleIdByPosition', () => {
  const roles = [
    { id: 'boss', name: '老板/总经理' },
    { id: 'sales', name: '销售' },
  ];

  it('岗位包含角色别名时命中', () => {
    expect(matchRoleIdByPosition(roles, '公司总经理')).toBe('boss');
    expect(matchRoleIdByPosition(roles, '销售总监')).toBe('sales');
  });

  it('岗位为角色别名子串时也命中（长度 >= 2）', () => {
    expect(matchRoleIdByPosition(roles, '老板')).toBe('boss');
    expect(matchRoleIdByPosition(roles, '老')).toBeNull();
  });

  it('空岗位或无匹配返回 null', () => {
    expect(matchRoleIdByPosition(roles, '  ')).toBeNull();
    expect(matchRoleIdByPosition(roles, '仓库管理员')).toBeNull();
    expect(matchRoleIdByPosition(roles)).toBeNull();
  });
});

describe('pickRoleTopScenarios', () => {
  const pool = [
    scenario({ id: 'a', role: 'sales', firstAhaMode: 'voice_then_result' }),
    scenario({ id: 'b', role: 'boss', firstAhaMode: 'paste_then_result' }),
    scenario({ id: 'c', role: 'boss', firstAhaMode: 'zero_input_example' }),
    scenario({ id: 'd', role: 'sales', firstAhaMode: 'zero_input_example' }),
  ];

  it('无角色时按 aha 成本排序', () => {
    expect(pickRoleTopScenarios(pool, null).map((s) => s.id)).toEqual(['c', 'd', 'b']);
  });

  it('命中角色的场景整体前置', () => {
    expect(pickRoleTopScenarios(pool, 'boss').map((s) => s.id)).toEqual(['c', 'b', 'd']);
  });

  it('同 aha 档位下 recurring 优先，其次零数据依赖，再按 id', () => {
    const tie = [
      scenario({ id: 'z', mode: 'oneshot', dataDependencyLevel: 'upload' }),
      scenario({ id: 'y', mode: 'oneshot', dataDependencyLevel: 'zero' }),
      scenario({ id: 'x', mode: 'recurring' }),
    ];
    expect(pickRoleTopScenarios(tie, null, 3).map((s) => s.id)).toEqual(['x', 'y', 'z']);
    expect(RECOMMENDATION_COUNT).toBe(3);
  });
});

describe('pickRecommendedScenarios', () => {
  it('岗位命中最多 2 条，再按精选 id 补齐', () => {
    const pool = [
      scenario({ id: 'sales-1', role: 'sales' }),
      scenario({ id: 'sales-2', role: 'sales' }),
      scenario({ id: 'sales-3', role: 'sales' }),
      scenario({ id: 'boss-competitor-daily', role: 'boss' }),
    ];
    expect(pickRecommendedScenarios(pool, 3, 'sales').map((s) => s.id)).toEqual([
      'sales-1',
      'sales-2',
      'boss-competitor-daily',
    ]);
  });

  it('无岗位时按精选 id + 角色去重补齐，并截断到 count', () => {
    const pool = [
      scenario({ id: 'hr-meeting-minutes', role: 'hr' }),
      scenario({ id: 'zz-other', role: 'ops' }),
      scenario({ id: 'aa-other', role: 'ops' }),
    ];
    expect(pickRecommendedScenarios(pool, 2).map((s) => s.id)).toEqual([
      'hr-meeting-minutes',
      'aa-other',
    ]);
  });

  it('场景不足时不会补出重复项', () => {
    const pool = [scenario({ id: 'only', role: 'boss' })];
    expect(pickRecommendedScenarios(pool, 3).map((s) => s.id)).toEqual(['only']);
  });
});

describe('resolveScenarioActionMeta', () => {
  it('零数据依赖可直接试', () => {
    expect(resolveScenarioActionMeta({ dataDependencyLevel: 'zero' })).toEqual({
      label: '直接试',
      tone: 'success',
    });
    expect(resolveScenarioActionMeta({})).toEqual({ label: '直接试', tone: 'success' });
  });

  it('需要外部数据时只预填任务', () => {
    expect(resolveScenarioActionMeta({ dataDependencyLevel: 'upload' })).toEqual({
      label: '预填任务',
      tone: 'muted',
    });
  });
});
