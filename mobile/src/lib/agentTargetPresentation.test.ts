import { describe, expect, it } from 'vitest';
import type { AgentTargetCatalog, OrgAgentSummary } from '@agent/shared';
import {
  agentTargetActionId,
  agentTargetTestID,
  listAgentTargetChoices,
  resolveAgentTargetByActionId,
} from './agentTargetPresentation';

const expert = (id: string, name: string): OrgAgentSummary => ({
  id,
  name,
  description: '',
  starterPrompts: [],
  skillCount: 0,
});

const catalog: AgentTargetCatalog<OrgAgentSummary> = {
  version: 1,
  tenantId: 't-1',
  personal: {
    target: { kind: 'personal', tenantId: 't-1' },
    availability: { status: 'available' },
  },
  orgAgents: [
    {
      target: { kind: 'org-agent', tenantId: 't-1', orgAgentId: 'org-e2e' },
      availability: { status: 'available' },
      presentation: expert('org-e2e', '企业 E2E Agent'),
    },
    {
      target: { kind: 'org-agent', tenantId: 't-1', orgAgentId: 'gone' },
      availability: {
        status: 'unavailable',
        reason: { code: 'org_agent_disabled', message: '已停用', contactAdmin: true },
      },
      presentation: expert('gone', '已停用专家'),
    },
  ],
  selectableTargets: [],
};

describe('agentTargetPresentation', () => {
  it('动作 id 与 Maestro 已固化的 testID 保持不变', () => {
    expect(agentTargetActionId({ kind: 'personal', tenantId: 't-1' })).toBe('_agent:personal');
    expect(agentTargetTestID({ kind: 'org-agent', tenantId: 't-1', orgAgentId: 'org-e2e' })).toBe(
      'dropdown-action-agent-org-e2e',
    );
    expect(agentTargetTestID({ kind: 'personal', tenantId: 't-1' })).toBe(
      'dropdown-action-agent-personal',
    );
  });

  it('只列可用目标，并带展示名与描述', () => {
    const choices = listAgentTargetChoices(catalog);
    expect(choices.map((choice) => choice.label)).toEqual(['个人 Agent', '企业 E2E Agent']);
    expect(choices[0].description).toBe('你的个人通用 Agent');
    expect(choices[1].description).toBe('由组织统一配置的企业专家');
    expect(listAgentTargetChoices(null)).toEqual([]);
  });

  it('按动作 id 反查目标，不可用目标查不到', () => {
    expect(resolveAgentTargetByActionId(catalog, '_agent:org-e2e')).toEqual({
      kind: 'org-agent',
      tenantId: 't-1',
      orgAgentId: 'org-e2e',
    });
    expect(resolveAgentTargetByActionId(catalog, '_agent:gone')).toBeNull();
    expect(resolveAgentTargetByActionId(catalog, '_agent:personal')?.kind).toBe('personal');
  });
});
