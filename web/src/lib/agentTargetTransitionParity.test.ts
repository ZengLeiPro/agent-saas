import { expect, it } from 'vitest';
import { evaluateAgentTargetTransition } from './orgAgentSessionRouting';

it('Web delegates running Agent switches to Shared confirmation', () => {
  expect(evaluateAgentTargetTransition({
    currentSession: { sessionId: 's1', target: { kind: 'personal', tenantId: 't1' }, bindingVersion: 1 },
    requestedTarget: { kind: 'org-agent', tenantId: 't1', orgAgentId: 'oa1' },
    runLiveness: { state: 'active', recoveryActions: ['cancel'], version: 1 },
    queueSnapshot: null,
    pendingInteraction: null,
    availability: { status: 'available' },
    generation: 1,
    availabilityVersion: 1,
  })).toMatchObject({ kind: 'needs-confirmation', choices: ['keep-old-open', 'cancel-active'] });
});
