import { describe, expect, it } from 'vitest';
import type { AgentTargetCatalog, OrgAgentSummary } from '@agent/shared';
import { resolveActiveExpertPresentation } from './activeExpertPresentation';

const expert: OrgAgentSummary = {
  id: 'oa-1',
  name: '合同专家',
  description: '',
  starterPrompts: ['审一份合同'],
  skillCount: 2,
};

const catalog: AgentTargetCatalog<OrgAgentSummary> = {
  version: 1,
  tenantId: 't-1',
  personal: {
    target: { kind: 'personal', tenantId: 't-1' },
    availability: { status: 'available' },
  },
  orgAgents: [
    {
      target: { kind: 'org-agent', tenantId: 't-1', orgAgentId: 'oa-1' },
      availability: { status: 'available' },
      presentation: expert,
    },
  ],
  selectableTargets: [],
};

describe('resolveActiveExpertPresentation', () => {
  it('按 orgAgentId 精确命中目录里的专家', () => {
    expect(
      resolveActiveExpertPresentation(catalog, {
        kind: 'org-agent',
        tenantId: 't-1',
        orgAgentId: 'oa-1',
      }),
    ).toBe(expert);
  });

  it('个人目标与未命中的专家都返回 null', () => {
    expect(
      resolveActiveExpertPresentation(catalog, { kind: 'personal', tenantId: 't-1' }),
    ).toBeNull();
    expect(
      resolveActiveExpertPresentation(catalog, {
        kind: 'org-agent',
        tenantId: 't-1',
        orgAgentId: 'oa-missing',
      }),
    ).toBeNull();
  });

  it('目录缺失或目标为空时返回 null，不做本地推断', () => {
    expect(
      resolveActiveExpertPresentation(null, {
        kind: 'org-agent',
        tenantId: 't-1',
        orgAgentId: 'oa-1',
      }),
    ).toBeNull();
    expect(resolveActiveExpertPresentation(catalog, null)).toBeNull();
  });
});
