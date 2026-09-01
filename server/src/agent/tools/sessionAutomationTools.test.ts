import { describe, expect, it, vi } from 'vitest';
import type { AuthorizedToolCall, ToolCallContext } from '../toolRuntime.js';
import type { SessionAutomationExecutionFlagSource } from '../../runtime/sessionAutomationFlags.js';
import { SessionAutomationToolProvider, SessionAutomationTools } from './sessionAutomationTools.js';

const snapshot = {
  tenantId: 'tenant-1', sessionId: 'session-1', automationId: 'automation-1',
  incarnationId: 'incarnation-1', generation: 3, specVersion: 2, activeRunId: 'run-1',
  spec: { kind: 'loop', mode: 'adaptive' },
};

function liveSource(initial: boolean) {
  let enabled = initial;
  const source: SessionAutomationExecutionFlagSource = {
    read: () => ({
      controlEnabled: true, executionEnabled: enabled, fixedLoopEnabled: true,
      adaptiveLoopEnabled: true, goalEnabled: true, evaluatorEnforced: true,
    }),
    executionEnabled: () => enabled,
  };
  return { source, set: (value: boolean) => { enabled = value; } };
}

function toolCall<T>(toolId: string, input: T): AuthorizedToolCall<T> {
  return { toolId, input, authorization: { approved: true, source: 'policy_auto' } };
}

function toolContext(): ToolCallContext {
  return {
    channelContext: { channel: 'web', user: { tenantId: snapshot.tenantId } },
    workspace: { id: 'workspace-1', root: '.', executionTarget: 'server-local' },
    sessionId: snapshot.sessionId,
    runId: snapshot.activeRunId,
    automationFence: {
      automationId: snapshot.automationId, incarnationId: snapshot.incarnationId,
      generation: snapshot.generation, specVersion: snapshot.specVersion,
      executionId: 'execution-1', runId: snapshot.activeRunId,
    },
  } as ToolCallContext;
}

describe('SessionAutomationTools execution gate', () => {
  it('routes adaptive stop through the typed lifecycle drain', async () => {
    const flags = liveSource(true);
    const client = { query: vi.fn() };
    const store = {
      tx: vi.fn(async (fn: (c: typeof client) => unknown) => fn(client)),
      getLocked: vi.fn(async () => snapshot),
      beginTerminalDrainLocked: vi.fn(async () => snapshot),
    };
    const tools = new SessionAutomationTools(store as never, flags.source);

    await expect(tools.scheduleWakeup({
      tenantId: snapshot.tenantId, sessionId: snapshot.sessionId, automationId: snapshot.automationId,
      incarnationId: snapshot.incarnationId, generation: snapshot.generation, specVersion: snapshot.specVersion,
      runId: snapshot.activeRunId, action: 'stop', reason: 'done',
    })).resolves.toEqual({ accepted: true });
    expect(store.beginTerminalDrainLocked).toHaveBeenCalledWith(client, snapshot, 'completed', 'done');
    expect(client.query).not.toHaveBeenCalled();
  });

  it('fails closed before a direct tool DB side effect and recovers false-to-true', async () => {
    const flags = liveSource(false);
    const client = { query: vi.fn() };
    const store = {
      tx: vi.fn(async (fn: (c: typeof client) => unknown) => fn(client)),
      getLocked: vi.fn(async () => snapshot),
      beginTerminalDrainLocked: vi.fn(async () => snapshot),
    };
    const tools = new SessionAutomationTools(store as never, flags.source);
    const input = {
      tenantId: snapshot.tenantId, sessionId: snapshot.sessionId, automationId: snapshot.automationId,
      incarnationId: snapshot.incarnationId, generation: snapshot.generation, specVersion: snapshot.specVersion,
      runId: snapshot.activeRunId, action: 'stop' as const, reason: 'done',
    };

    await expect(tools.scheduleWakeup(input)).resolves.toEqual({ accepted: false, reason: 'execution_disabled' });
    expect(store.tx).not.toHaveBeenCalled();
    flags.set(true);
    await expect(tools.scheduleWakeup(input)).resolves.toEqual({ accepted: true });
    expect(store.beginTerminalDrainLocked).toHaveBeenCalledOnce();
  });

  it('blocks direct goal tool access before DB or evaluator work', async () => {
    const flags = liveSource(false);
    const store = { get: vi.fn(), tx: vi.fn() };
    const evaluator = { nominate: vi.fn() };
    const tools = new SessionAutomationTools(store as never, flags.source, evaluator as never);

    await expect(tools.updateGoal({
      tenantId: snapshot.tenantId, sessionId: snapshot.sessionId, automationId: snapshot.automationId,
      incarnationId: snapshot.incarnationId, generation: snapshot.generation, specVersion: snapshot.specVersion,
      executionId: 'execution-1', runId: snapshot.activeRunId,
      action: 'complete_candidate', summary: 'done', evidenceRefs: [],
    })).resolves.toEqual({ accepted: false, reason: 'execution_disabled' });
    expect(store.get).not.toHaveBeenCalled();
    expect(store.tx).not.toHaveBeenCalled();
    expect(evaluator.nominate).not.toHaveBeenCalled();
  });

  it('rechecks the live flag immediately before the terminal side effect', async () => {
    const flags = liveSource(true);
    const client = { query: vi.fn() };
    const store = {
      tx: vi.fn(async (fn: (c: typeof client) => unknown) => fn(client)),
      getLocked: vi.fn(async () => { flags.set(false); return snapshot; }),
      beginTerminalDrainLocked: vi.fn(),
    };
    const tools = new SessionAutomationTools(store as never, flags.source);

    await expect(tools.scheduleWakeup({
      tenantId: snapshot.tenantId, sessionId: snapshot.sessionId, automationId: snapshot.automationId,
      incarnationId: snapshot.incarnationId, generation: snapshot.generation, specVersion: snapshot.specVersion,
      runId: snapshot.activeRunId, action: 'stop',
    })).resolves.toEqual({ accepted: false, reason: 'execution_disabled' });
    expect(store.beginTerminalDrainLocked).not.toHaveBeenCalled();
  });

  it('keeps blocked goal work in drain instead of clearing the active slot', async () => {
    const flags = liveSource(true);
    const goal = { ...snapshot, spec: { kind: 'goal', mode: 'goal' } };
    const client = { query: vi.fn() };
    const store = {
      get: vi.fn(async () => goal),
      tx: vi.fn(async (fn: (c: typeof client) => unknown) => fn(client)),
      getLocked: vi.fn(async () => goal),
      beginTerminalDrainLocked: vi.fn(async () => goal),
    };
    const tools = new SessionAutomationTools(store as never, flags.source);

    await expect(tools.updateGoal({
      tenantId: goal.tenantId, sessionId: goal.sessionId, automationId: goal.automationId,
      incarnationId: goal.incarnationId, generation: goal.generation, specVersion: goal.specVersion,
      executionId: 'execution-1', runId: goal.activeRunId, action: 'blocked', summary: 'waiting on authority',
    })).resolves.toEqual({ accepted: true });
    expect(store.beginTerminalDrainLocked).toHaveBeenCalledWith(client, goal, 'blocked', 'waiting on authority');
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe('SessionAutomationToolProvider execution gate', () => {
  it('uses the same live source, blocks direct provider invoke, and recovers false-to-true', async () => {
    const flags = liveSource(false);
    const scheduleWakeup = vi.fn(async () => ({ accepted: true }));
    const tools = { scheduleWakeup, updateGoal: vi.fn() } as unknown as SessionAutomationTools;
    const provider = new SessionAutomationToolProvider(tools, flags.source);
    const call = toolCall('ScheduleWakeup', { action: 'stop' });

    expect(provider.flagSource).toBe(flags.source);
    expect(provider.list(toolContext()).map(tool => tool.id)).toEqual(['ScheduleWakeup', 'UpdateGoal']);
    await expect(provider.invoke(call, toolContext())).resolves.toEqual({
      content: JSON.stringify({ accepted: false, reason: 'execution_disabled' }),
    });
    await expect(provider.invoke(toolCall('UpdateGoal', {
      action: 'complete_candidate', summary: 'done', evidenceRefs: [],
    }), toolContext())).resolves.toEqual({
      content: JSON.stringify({ accepted: false, reason: 'execution_disabled' }),
    });
    expect(scheduleWakeup).not.toHaveBeenCalled();
    expect(tools.updateGoal).not.toHaveBeenCalled();

    flags.set(true);
    await expect(provider.invoke(call, toolContext())).resolves.toEqual({ content: JSON.stringify({ accepted: true }) });
    expect(scheduleWakeup).toHaveBeenCalledOnce();
  });
});
