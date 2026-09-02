import { describe, expect, it } from 'vitest';
import {
  adaptAgentTargetCatalogResponse,
  parseAgentTarget,
  resolveNewSessionAgentTarget,
  resolveTargetSessionAction,
  sameAgentTarget,
  type AgentTargetCatalog,
} from './agentTarget';

function catalog(input: { tenantId?: string; personal?: boolean; orgIds?: string[] } = {}): AgentTargetCatalog {
  const tenantId = input.tenantId ?? 'tenant-a';
  const personal = input.personal ?? true;
  const orgIds = input.orgIds ?? [];
  const personalTarget = { kind: 'personal' as const, tenantId };
  const orgTargets = orgIds.map(orgAgentId => ({ kind: 'org-agent' as const, tenantId, orgAgentId }));
  return {
    version: 1,
    tenantId,
    personal: {
      target: personalTarget,
      availability: personal
        ? { status: 'available' }
        : { status: 'unavailable', reason: { code: 'personal_agent_disabled', message: 'disabled', contactAdmin: true } },
    },
    orgAgents: orgTargets.map(target => ({ target, availability: { status: 'available' } })),
    selectableTargets: [...(personal ? [personalTarget] : []), ...orgTargets],
    ...(!personal && orgTargets.length === 0
      ? { unavailableReason: { code: 'no_available_target' as const, message: 'none', contactAdmin: true } }
      : {}),
  };
}

describe('AgentTarget canonical contract', () => {
  it('parses only tenant-scoped personal/org targets and compares the complete boundary', () => {
    expect(parseAgentTarget({ kind: 'personal', tenantId: 'tenant-a' })).toEqual({ kind: 'personal', tenantId: 'tenant-a' });
    expect(parseAgentTarget({ kind: 'org-agent', tenantId: 'tenant-a', orgAgentId: 'oa-1' }))
      .toEqual({ kind: 'org-agent', tenantId: 'tenant-a', orgAgentId: 'oa-1' });
    expect(parseAgentTarget({ kind: 'org-agent', tenantId: 'tenant-a' })).toBeUndefined();
    expect(sameAgentTarget(
      { kind: 'org-agent', tenantId: 'tenant-a', orgAgentId: 'oa-1' },
      { kind: 'org-agent', tenantId: 'tenant-b', orgAgentId: 'oa-1' },
    )).toBe(false);
  });

  it('covers personal on/off, assigned choices and explicit unavailable state', () => {
    expect(resolveNewSessionAgentTarget({ catalog: catalog({ personal: true, orgIds: ['oa-1'] }) }))
      .toEqual({ kind: 'selected', target: { kind: 'personal', tenantId: 'tenant-a' } });
    expect(resolveNewSessionAgentTarget({ catalog: catalog({ personal: false, orgIds: ['oa-1'] }) }))
      .toEqual({ kind: 'selected', target: { kind: 'org-agent', tenantId: 'tenant-a', orgAgentId: 'oa-1' } });
    expect(resolveNewSessionAgentTarget({ catalog: catalog({ personal: false, orgIds: ['oa-1', 'oa-2'] }) }).kind)
      .toBe('picker');
    expect(resolveNewSessionAgentTarget({ catalog: catalog({ personal: false, orgIds: [] }) }))
      .toEqual({ kind: 'unavailable', reason: { code: 'no_available_target', message: 'none', contactAdmin: true } });
  });

  it('adapts the versioned catalog but keeps legacy arrays and tenant mismatches fail-closed', () => {
    expect(adaptAgentTargetCatalogResponse(catalog({ personal: false, orgIds: ['oa-1'] }), 'tenant-a'))
      .toMatchObject({ kind: 'catalog', catalog: { tenantId: 'tenant-a' } });
    expect(adaptAgentTargetCatalogResponse([{ id: 'oa-1' }], 'tenant-a'))
      .toMatchObject({ kind: 'legacy-unproven', presentations: [{ id: 'oa-1' }], reason: { code: 'legacy_binding_unproven' } });
    expect(adaptAgentTargetCatalogResponse(catalog({ tenantId: 'tenant-b' }), 'tenant-a'))
      .toMatchObject({ kind: 'invalid', reason: { code: 'tenant_mismatch' } });
  });

  it('keeps an available active target but never silently reuses a session bound to another target', () => {
    const orgTarget = { kind: 'org-agent' as const, tenantId: 'tenant-a', orgAgentId: 'oa-2' };
    expect(resolveNewSessionAgentTarget({
      catalog: catalog({ personal: true, orgIds: ['oa-1', 'oa-2'] }),
      activeTarget: orgTarget,
    })).toEqual({ kind: 'selected', target: orgTarget });

    expect(resolveTargetSessionAction({
      target: orgTarget,
      current: { sessionId: 'personal-session', target: { kind: 'personal', tenantId: 'tenant-a' } },
    })).toEqual({ kind: 'new-session', target: orgTarget });
    expect(resolveTargetSessionAction({
      target: orgTarget,
      explicitMatchingSession: { sessionId: 'org-session', target: orgTarget },
    })).toEqual({ kind: 'reuse', sessionId: 'org-session' });
  });
});
