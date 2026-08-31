import { describe, expect, it, vi } from 'vitest';
import { SessionAutomationTools } from './sessionAutomationTools.js';

const snapshot = {
  tenantId: 'tenant-1', sessionId: 'session-1', automationId: 'automation-1',
  incarnationId: 'incarnation-1', generation: 3, specVersion: 2, activeRunId: 'run-1',
  spec: { kind: 'loop', mode: 'adaptive' },
};

describe('SessionAutomationTools terminal drain', () => {
  it('routes adaptive stop through the typed lifecycle drain', async () => {
    const client = { query: vi.fn() };
    const store = {
      tx: vi.fn(async (fn: (c: typeof client) => unknown) => fn(client)),
      getLocked: vi.fn(async () => snapshot),
      beginTerminalDrainLocked: vi.fn(async () => snapshot),
    };
    const tools = new SessionAutomationTools(store as never);

    await expect(tools.scheduleWakeup({
      tenantId: snapshot.tenantId, sessionId: snapshot.sessionId, automationId: snapshot.automationId,
      incarnationId: snapshot.incarnationId, generation: snapshot.generation, specVersion: snapshot.specVersion,
      runId: snapshot.activeRunId, action: 'stop', reason: 'done',
    })).resolves.toEqual({ accepted: true });
    expect(store.beginTerminalDrainLocked).toHaveBeenCalledWith(client, snapshot, 'completed', 'done');
    expect(client.query).not.toHaveBeenCalled();
  });

  it('keeps blocked goal work in drain instead of clearing the active slot', async () => {
    const goal = { ...snapshot, spec: { kind: 'goal', mode: 'goal' } };
    const client = { query: vi.fn() };
    const store = {
      get: vi.fn(async () => goal),
      tx: vi.fn(async (fn: (c: typeof client) => unknown) => fn(client)),
      getLocked: vi.fn(async () => goal),
      beginTerminalDrainLocked: vi.fn(async () => goal),
    };
    const tools = new SessionAutomationTools(store as never);

    await expect(tools.updateGoal({
      tenantId: goal.tenantId, sessionId: goal.sessionId, automationId: goal.automationId,
      incarnationId: goal.incarnationId, generation: goal.generation, specVersion: goal.specVersion,
      executionId: 'execution-1', runId: goal.activeRunId, action: 'blocked', summary: 'waiting on authority',
    })).resolves.toEqual({ accepted: true });
    expect(store.beginTerminalDrainLocked).toHaveBeenCalledWith(client, goal, 'blocked', 'waiting on authority');
    expect(client.query).not.toHaveBeenCalled();
  });
});
