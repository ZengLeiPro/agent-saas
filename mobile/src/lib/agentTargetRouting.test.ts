import { describe, expect, it } from 'vitest';
import {
  adaptAgentTargetCatalogResponse,
  resolveNewSessionAgentTarget,
  resolveTargetSessionAction,
  type AgentTargetCatalog,
} from '@agent/shared';

const catalog: AgentTargetCatalog<{ name: string }> = {
  version: 1,
  tenantId: 'tenant-a',
  personal: {
    target: { kind: 'personal', tenantId: 'tenant-a' },
    availability: {
      status: 'unavailable',
      reason: { code: 'personal_agent_disabled', message: 'disabled', contactAdmin: true },
    },
  },
  orgAgents: ['oa-1', 'oa-2'].map(orgAgentId => ({
    target: { kind: 'org-agent' as const, tenantId: 'tenant-a', orgAgentId },
    availability: { status: 'available' as const },
    presentation: { name: orgAgentId },
  })),
  selectableTargets: [
    { kind: 'org-agent', tenantId: 'tenant-a', orgAgentId: 'oa-1' },
    { kind: 'org-agent', tenantId: 'tenant-a', orgAgentId: 'oa-2' },
  ],
};

describe('Mobile AgentTarget routing parity', () => {
  it('opens the org picker when personal is off and multiple assigned targets exist', () => {
    expect(resolveNewSessionAgentTarget({ catalog })).toMatchObject({ kind: 'picker', options: catalog.selectableTargets });
  });

  it('never reuses a differently bound session when switching Agent', () => {
    expect(resolveTargetSessionAction({
      target: catalog.selectableTargets[1]!,
      current: { sessionId: 's-1', target: catalog.selectableTargets[0] },
    })).toEqual({ kind: 'new-session', target: catalog.selectableTargets[1] });
  });

  it('keeps N-1 arrays and tenant mismatch fail-closed instead of guessing personal', () => {
    expect(adaptAgentTargetCatalogResponse([{ id: 'oa-1' }], 'tenant-a'))
      .toMatchObject({ kind: 'legacy-unproven', reason: { code: 'legacy_binding_unproven' } });
    expect(adaptAgentTargetCatalogResponse({ ...catalog, tenantId: 'tenant-b' }, 'tenant-a'))
      .toMatchObject({ kind: 'invalid', reason: { code: 'tenant_mismatch' } });
  });
});
