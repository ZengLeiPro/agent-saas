import { describe, expect, it } from 'vitest';
import type { AgentTargetCatalog } from '@agent/shared';
import { resolveNewSessionAgentTarget, resolveTargetSessionAction } from './orgAgentSessionRouting';

function catalog(personal: boolean, orgIds: string[], tenantId = 'tenant-a'): AgentTargetCatalog {
  const personalTarget = { kind: 'personal' as const, tenantId };
  const orgTargets = orgIds.map(orgAgentId => ({ kind: 'org-agent' as const, tenantId, orgAgentId }));
  return {
    version: 1,
    tenantId,
    personal: {
      target: personalTarget,
      availability: personal ? { status: 'available' } : {
        status: 'unavailable',
        reason: { code: 'personal_agent_disabled', message: 'disabled', contactAdmin: true },
      },
    },
    orgAgents: orgTargets.map(target => ({ target, availability: { status: 'available' } })),
    selectableTargets: [...(personal ? [personalTarget] : []), ...orgTargets],
    ...(!personal && orgTargets.length === 0 ? {
      unavailableReason: { code: 'no_available_target' as const, message: '请联系管理员', contactAdmin: true },
    } : {}),
  };
}

describe('Web AgentTarget routing parity', () => {
  it('covers personal on/off, single and multiple assigned org targets', () => {
    expect(resolveNewSessionAgentTarget({ catalog: catalog(true, ['oa-1']) }))
      .toMatchObject({ kind: 'selected', target: { kind: 'personal' } });
    expect(resolveNewSessionAgentTarget({ catalog: catalog(false, ['oa-1']) }))
      .toEqual({ kind: 'selected', target: { kind: 'org-agent', tenantId: 'tenant-a', orgAgentId: 'oa-1' } });
    expect(resolveNewSessionAgentTarget({ catalog: catalog(false, ['oa-1', 'oa-2']) }).kind).toBe('picker');
    expect(resolveNewSessionAgentTarget({ catalog: catalog(false, []) }))
      .toMatchObject({ kind: 'unavailable', reason: { code: 'no_available_target' } });
  });

  it('switching target starts a new session and tenant scope is part of equality', () => {
    const target = { kind: 'org-agent' as const, tenantId: 'tenant-a', orgAgentId: 'oa-2' };
    expect(resolveTargetSessionAction({
      target,
      current: { sessionId: 's-personal', target: { kind: 'personal', tenantId: 'tenant-a' } },
    })).toEqual({ kind: 'new-session', target });
    expect(resolveTargetSessionAction({
      target,
      current: { sessionId: 's-other-tenant', target: { ...target, tenantId: 'tenant-b' } },
    })).toEqual({ kind: 'new-session', target });
  });
});
