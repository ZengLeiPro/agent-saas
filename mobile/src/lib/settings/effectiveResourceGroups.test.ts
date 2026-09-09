/** P3-3d：「我的权限」有效资源分组的纯函数测试（与 Web EffectiveResourceList 同序）。 */
import { describe, expect, it } from 'vitest';
import type { EffectiveResourceView } from '@agent/shared/types/governance';
import {
  GOVERNANCE_DOMAIN_LABELS,
  GOVERNANCE_DOMAIN_ORDER,
  groupEffectiveResources,
  toEffectiveResourceRow,
} from './effectiveResourceGroups';

function view(overrides: {
  domain: string;
  id: string;
  displayName?: string;
  available?: boolean;
  ready?: boolean;
  blocker?: string;
  withReadiness?: boolean;
}): EffectiveResourceView {
  return {
    resource: {
      type: 'agent',
      id: overrides.id,
      displayName: overrides.displayName ?? overrides.id,
      domain: overrides.domain,
    },
    lifecycle: { state: 'active', blocksNewUse: false },
    access: { reason: `${overrides.id} 可用`, nextActions: [] },
    ...(overrides.withReadiness === false
      ? {}
      : {
          readiness:
            overrides.ready === false
              ? {
                  ready: false,
                  blockers: overrides.blocker ? [{ message: overrides.blocker }] : [],
                }
              : { ready: true, blockers: [] },
        }),
    primaryResult: {
      code: overrides.available === false ? 'unavailable' : 'available',
      label: overrides.available === false ? '不可用' : '可用',
    },
    decisiveFactor: { code: 'assignment', label: '组织分配' },
  } as unknown as EffectiveResourceView;
}

describe('groupEffectiveResources', () => {
  it('只按 Web 的四个业务 domain 固定顺序展示可用资源', () => {
    const groups = groupEffectiveResources([
      view({ domain: 'environment', id: 'e1' }),
      view({ domain: 'agent', id: 'a1' }),
      view({ domain: 'connector', id: 'c1' }),
      view({ domain: 'agent', id: 'a2' }),
      view({ domain: 'skill', id: 'internal-denied', available: false }),
      view({ domain: 'file', id: 'internal-file' }),
    ]);
    expect(groups.map((g) => g.domain)).toEqual(['agent', 'connector', 'environment']);
    expect(groups[0].rows.map((r) => r.displayName)).toEqual(['a1', 'a2']);
    expect(groups[1].label).toBe(GOVERNANCE_DOMAIN_LABELS.connector);
    expect(JSON.stringify(groups)).not.toContain('internal-denied');
    expect(JSON.stringify(groups)).not.toContain('internal-file');
  });

  it('空清单返回空数组', () => {
    expect(groupEffectiveResources([])).toEqual([]);
  });

  it('未知或内部 domain 不向普通用户展示', () => {
    const groups = groupEffectiveResources([
      view({ domain: 'brand-new-domain', id: 'x1' }),
      view({ domain: 'agent', id: 'a1' }),
    ]);
    expect(groups.map((g) => g.domain)).toEqual(['agent']);
  });

  it('domain 顺序与标签覆盖 Web 的四个业务 domain', () => {
    expect(GOVERNANCE_DOMAIN_ORDER).toEqual(['agent', 'skill', 'connector', 'environment']);
    for (const domain of GOVERNANCE_DOMAIN_ORDER) {
      expect(GOVERNANCE_DOMAIN_LABELS[domain]?.length).toBeGreaterThan(0);
    }
  });
});

describe('toEffectiveResourceRow', () => {
  it('只投影渲染所需的业务名称，不携带诊断明细', () => {
    const row = toEffectiveResourceRow(
      view({ domain: 'agent', id: 'a1', displayName: '销售助理' }),
    );
    expect(row.key).toBe('agent:a1');
    expect(row.displayName).toBe('销售助理');
    expect(row).toEqual({ key: 'agent:a1', displayName: '销售助理' });
  });
});
