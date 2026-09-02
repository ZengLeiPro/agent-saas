import { describe, expect, it } from 'vitest';
import type { RunLiveness } from './runLiveness';
import type { AgentTargetTransitionInput } from './agentTargetTransition';
import { createAgentTargetTransition, evaluateAgentTargetTransition, reduceAgentTargetTransition } from './agentTargetTransition';

const personal = { kind: 'personal', tenantId: 'tenant-a' } as const;
const expert = { kind: 'org-agent', tenantId: 'tenant-a', orgAgentId: 'oa-1' } as const;
const terminal: RunLiveness = { state: 'terminal', recoveryActions: [], version: 1 };
const active: RunLiveness = { state: 'active', recoveryActions: ['cancel'], version: 1 };

function input(overrides: Partial<AgentTargetTransitionInput> = {}): AgentTargetTransitionInput {
  return {
    currentSession: { sessionId: 's-old', target: personal, bindingVersion: 1 },
    requestedTarget: expert,
    runLiveness: terminal,
    queueSnapshot: null,
    pendingInteraction: null,
    availability: { status: 'available', version: 3 },
    generation: 7,
    availabilityVersion: 3,
    ...overrides,
  };
}

describe('M30-03 canonical Agent target transition', () => {
  it('reuses only the same persisted target and otherwise creates a new session', () => {
    expect(evaluateAgentTargetTransition(input({ requestedTarget: personal }))).toMatchObject({ kind: 'reuse', sessionId: 's-old' });
    expect(evaluateAgentTargetTransition(input())).toMatchObject({ kind: 'new-session', previousSessionId: 's-old', target: expert });
  });

  it('requires confirmation for running, queued, and pending interaction impacts', () => {
    const decision = evaluateAgentTargetTransition(input({
      runLiveness: active,
      queueSnapshot: {
        version: 1, sessionId: 's-old', generatedAt: '2026-09-01T00:00:00Z',
        items: [{ sessionId: 's-old', clientMsgId: 'c1', runId: 'r2', sourceRunId: 'r2', deliveryMode: 'queue', status: 'queued' }],
      },
      pendingInteraction: { interactionId: 'i1', type: 'ask_user', version: 9 },
    }));
    expect(decision).toMatchObject({ kind: 'needs-confirmation', choices: ['keep-old-open', 'cancel-active'] });
    if (decision.kind === 'needs-confirmation') expect(decision.impacts.map(item => item.kind)).toEqual(['running', 'queued', 'pending-interaction']);
  });

  it('keep-old-open can commit without mutating the old session', () => {
    const state = reduceAgentTargetTransition(createAgentTargetTransition(input({ runLiveness: active })), { type: 'choose', choice: 'keep-old-open' });
    expect(state).toMatchObject({ phase: 'ready', decision: { kind: 'new-session', previousSessionId: 's-old' } });
  });

  it('cancel-active waits for a canonical terminal snapshot and fences old generations', () => {
    let state = reduceAgentTargetTransition(createAgentTargetTransition(input({ runLiveness: active })), { type: 'choose', choice: 'cancel-active' });
    expect(state.phase).toBe('awaiting-canonical-terminal');
    state = reduceAgentTargetTransition(state, {
      type: 'canonical-snapshot', generation: 6, availabilityVersion: 99,
      runLiveness: terminal, queueSnapshot: null, pendingInteraction: null, availability: { status: 'available' },
    });
    expect(state.phase).toBe('awaiting-canonical-terminal');
    state = reduceAgentTargetTransition(state, {
      type: 'canonical-snapshot', generation: 7, availabilityVersion: 4,
      runLiveness: terminal, queueSnapshot: null, pendingInteraction: null, availability: { status: 'available' },
    });
    expect(state.phase).toBe('ready');
  });

  it('surfaces cancel failure and fail-closes revoked/disabled/deleted targets', () => {
    let state = reduceAgentTargetTransition(createAgentTargetTransition(input({ runLiveness: active })), { type: 'choose', choice: 'cancel-active' });
    state = reduceAgentTargetTransition(state, { type: 'cancel-failed', generation: 7, reason: 'canonical cancel rejected' });
    expect(state).toMatchObject({ phase: 'cancel-failed', reason: 'canonical cancel rejected' });
    for (const code of ['org_agent_unassigned', 'org_agent_disabled', 'org_agent_deleted'] as const) {
      expect(evaluateAgentTargetTransition(input({ availability: { status: 'unavailable', reason: { code, message: code, contactAdmin: true } } }))).toMatchObject({ kind: 'blocked', reason: { code } });
    }
  });

  it('does not reopen a completed same-target session after revocation', () => {
    expect(evaluateAgentTargetTransition(input({
      requestedTarget: personal,
      availability: { status: 'unavailable', reason: { code: 'personal_agent_disabled', message: 'disabled', contactAdmin: true } },
    }))).toMatchObject({ kind: 'blocked' });
  });
});
