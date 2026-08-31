import { expect, it } from 'vitest';
import { evaluateAgentTargetTransition } from './agentTargetRouting';

it('Mobile delegates queued Agent switches to the same Shared confirmation', () => {
  expect(evaluateAgentTargetTransition({
    currentSession: { sessionId: 's1', target: { kind: 'personal', tenantId: 't1' }, bindingVersion: 1 },
    requestedTarget: { kind: 'org-agent', tenantId: 't1', orgAgentId: 'oa1' },
    runLiveness: { state: 'terminal', recoveryActions: [], version: 1 },
    queueSnapshot: {
      version: 1, sessionId: 's1', generatedAt: '2026-09-01T00:00:00Z',
      items: [{ sessionId: 's1', clientMsgId: 'c1', runId: 'r1', sourceRunId: 'r1', deliveryMode: 'queue', status: 'queued' }],
    },
    pendingInteraction: null,
    availability: { status: 'available' },
    generation: 1,
    availabilityVersion: 1,
  })).toMatchObject({ kind: 'needs-confirmation', impacts: [{ kind: 'queued', count: 1 }] });
});
