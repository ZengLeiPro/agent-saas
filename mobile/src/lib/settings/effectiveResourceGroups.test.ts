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
    primaryResult: { code: 'ready', label: '可用' },
    decisiveFactor: { code: 'assignment', label: '组织分配' },
  } as unknown as EffectiveResourceView;
}

describe('groupEffectiveResources', () => {
  it('按 Web 的 domain 固定顺序分组，空组不返回', () => {
    const groups = groupEffectiveResources([
      view({ domain: 'file', id: 'f1' }),
      view({ domain: 'agent', id: 'a1' }),
      view({ domain: 'connector', id: 'c1' }),
      view({ domain: 'agent', id: 'a2' }),
    ]);
    expect(groups.map((g) => g.domain)).toEqual(['agent', 'connector', 'file']);
    expect(groups[0].rows.map((r) => r.displayName)).toEqual(['a1', 'a2']);
    expect(groups[1].label).toBe(GOVERNANCE_DOMAIN_LABELS.connector);
  });

  it('空清单返回空数组', () => {
    expect(groupEffectiveResources([])).toEqual([]);
  });

  it('未知 domain 不被吞掉：排到末尾且标签退化为原值', () => {
    const groups = groupEffectiveResources([
      view({ domain: 'brand-new-domain', id: 'x1' }),
      view({ domain: 'agent', id: 'a1' }),
    ]);
    expect(groups.map((g) => g.domain)).toEqual(['agent', 'brand-new-domain']);
    expect(groups[1].label).toBe('brand-new-domain');
  });

  it('domain 顺序与标签覆盖 Web 的全部八个 domain', () => {
    expect(GOVERNANCE_DOMAIN_ORDER).toHaveLength(8);
    for (const domain of GOVERNANCE_DOMAIN_ORDER) {
      expect(GOVERNANCE_DOMAIN_LABELS[domain]?.length).toBeGreaterThan(0);
    }
  });
});

describe('toEffectiveResourceRow', () => {
  it('key 为 type:id，明细行覆盖决定因素/访问判定/执行就绪', () => {
    const row = toEffectiveResourceRow(
      view({ domain: 'agent', id: 'a1', displayName: '销售助理' }),
    );
    expect(row.key).toBe('agent:a1');
    expect(row.displayName).toBe('销售助理');
    expect(row.resultLabel).toBe('可用');
    expect(row.detailLines).toEqual([
      '决定因素：组织分配',
      '访问判定：a1 可用',
      '执行就绪：已就绪',
    ]);
  });

  it('未就绪时展示首条 blocker，缺 blocker 时给出兜底文案', () => {
    expect(
      toEffectiveResourceRow(
        view({ domain: 'agent', id: 'a1', ready: false, blocker: '缺少连接器授权' }),
      ).detailLines[2],
    ).toBe('执行就绪：缺少连接器授权');
    expect(
      toEffectiveResourceRow(view({ domain: 'agent', id: 'a1', ready: false })).detailLines[2],
    ).toBe('执行就绪：不可执行');
  });

  it('权威未返回 readiness 时明确标注不可用，不本地推导', () => {
    expect(
      toEffectiveResourceRow(view({ domain: 'agent', id: 'a1', withReadiness: false }))
        .detailLines[2],
    ).toBe('执行就绪：权威数据不可用');
  });
});
