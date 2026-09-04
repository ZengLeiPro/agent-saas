import { describe, expect, it, vi } from 'vitest';

import { DurableBackgroundTaskService } from '../runtime/background/backgroundTaskService.js';
import type { RawRuntimeRunDispatchConfig } from '../runtime/rawRuntimeRunDispatch.js';
import { RuntimeScheduler } from '../runtime/scheduler.js';
import type { RunRecord, RunStatus } from '../runtime/runStore.js';
import { deferred, MemoryEventStore, MemoryRunStore } from './runtimeScheduler.testHelpers.js';

function terminalRuntimeConfig(runStore: MemoryRunStore, eventStore: MemoryEventStore): RawRuntimeRunDispatchConfig {
  return {
    agentCwd: '/tmp',
    sharedDir: '/tmp',
    runStore,
    sessionCatalog: {
      async upsert() {},
      async ensure() {},
      async get(sessionId: string) {
        const run = [...runStore.records.values()].find(candidate => candidate.sessionId === sessionId);
        if (!run) return null;
        const now = new Date().toISOString();
        return {
          sessionId,
          userId: run.userId ?? 'background-user',
          username: 'background-user',
          tenantId: run.tenantId,
          channel: run.channel ?? 'web',
          cwd: '/tmp/workspace',
          transcriptPath: `/tmp/${sessionId}.jsonl`,
          createdAt: now,
          updatedAt: now,
        };
      },
      async markStatus() {},
      async findTranscriptPath(sessionId: string) { return `/tmp/${sessionId}.jsonl`; },
    },
    eventStoreFactory: () => eventStore,
  } as RawRuntimeRunDispatchConfig;
}

function automationAgentMetadata(runId: string): Record<string, unknown> {
  return {
    backgroundTask: true,
    backgroundTaskType: 'agent',
    backgroundTaskReady: true,
    parentRunId: 'automation-root-run',
    parentSessionId: 'automation-root-session',
    parentToolCallId: 'tool-call-1',
    description: 'durable automation child',
    prompt: 'continue',
    agentType: 'general',
    modelRef: 'group/model',
    includeCompanyInfo: false,
    cwd: '/tmp/workspace',
    workspaceId: 'automation-root-session',
    parentChannel: 'web',
    outputTransactionMode: 'terminal_buffered',
    parentOutputTransactionMode: 'replaceable_draft',
    wakeState: 'none',
    executionChildSessionId: 'sub-fixed-child',
    executionChildRunId: 'fixed-child-run',
    automationFence: {
      automationId: 'automation-1',
      incarnationId: 'incarnation-1',
      generation: 1,
      specVersion: 1,
      executionId: 'execution-1',
      runId,
      rootSessionId: 'automation-root-session',
      rootRunId: 'automation-root-run',
    },
  };
}

describe('RuntimeScheduler background task recovery', () => {
  it('requeues an interrupted automation agent and executes it with the fixed child identity', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    const record = await runStore.upsertPending({
      runId: 'bg-automation-crashed',
      sessionId: 'sub-bg-automation-crashed',
      metadata: automationAgentMetadata('bg-automation-crashed'),
    });
    runStore.records.set(record.runId, {
      ...record,
      status: 'running',
      workerId: 'dead-worker',
      leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const recoverInterruptedBackgroundChild = vi.fn(async () => {
      await runStore.markStatusIfCurrent(record.runId, ['running'], 'pending',
        'background_task_interrupted_replay_ready', { backgroundTaskReady: true, wakeState: 'none' });
      return 'requeued' as const;
    });
    const service = new DurableBackgroundTaskService({
      agentCwd: '/tmp', sharedDir: '/tmp', runStore,
      sessionAutomationRuntimeGuard: { recoverInterruptedBackgroundChild } as never,
    } as RawRuntimeRunDispatchConfig);
    const wake = vi.fn(async (candidate: RunRecord, lease: { release(status?: RunStatus): Promise<void> }) => {
      expect(candidate.metadata).toMatchObject({
        executionChildSessionId: 'sub-fixed-child',
        executionChildRunId: 'fixed-child-run',
        automationFence: {
          runId: 'bg-automation-crashed',
          rootSessionId: 'automation-root-session',
          rootRunId: 'automation-root-run',
        },
      });
      await lease.release('completed');
    });
    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-new',
      autoWake: true,
      wake,
      failInterruptedBackgroundTask: candidate => service.failInterrupted(candidate),
    });

    await scheduler.tick();
    await expect(runStore.get(record.runId)).resolves.toMatchObject({
      status: 'pending',
      statusReason: 'background_task_interrupted_replay_ready',
    });
    await scheduler.tick();
    await scheduler.stop();

    await expect(runStore.get(record.runId)).resolves.toMatchObject({
      status: 'completed',
      metadata: {
        backgroundTaskReady: true,
        executionChildSessionId: 'sub-fixed-child',
        executionChildRunId: 'fixed-child-run',
      },
    });
    expect(wake).toHaveBeenCalledOnce();
  });

  it('does not freeze an interrupted Agent when the old worker renewed after the recovery snapshot', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    const record = await runStore.upsertPending({
      runId: 'bg-agent-renewed', sessionId: 'sub-bg-agent-renewed',
      metadata: automationAgentMetadata('bg-agent-renewed'),
    });
    runStore.records.set(record.runId, {
      ...record, status: 'running', workerId: 'old-worker',
      leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    vi.spyOn(runStore, 'acquireLease').mockResolvedValueOnce(null);
    const failInterruptedBackgroundTask = vi.fn();
    const scheduler = new RuntimeScheduler({
      runStore, eventStore, workerId: 'worker-new', autoWake: true, wake: vi.fn(),
      failInterruptedBackgroundTask,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(failInterruptedBackgroundTask).not.toHaveBeenCalled();
    await expect(runStore.get(record.runId)).resolves.toMatchObject({ status: 'running', workerId: 'old-worker' });
  });

  it('freezes a running parent when the interrupted child terminal is already preserved', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    const interrupted = await runStore.upsertPending({
      runId: 'bg-automation-child-cancelled',
      sessionId: 'sub-bg-automation-child-cancelled',
      metadata: automationAgentMetadata('bg-automation-child-cancelled'),
    });
    runStore.records.set(interrupted.runId, { ...interrupted, status: 'running' });
    const service = new DurableBackgroundTaskService({
      ...terminalRuntimeConfig(runStore, eventStore),
      sessionAutomationRuntimeGuard: {
        recoverInterruptedBackgroundChild: vi.fn(async () => 'terminal_preserved' as const),
      } as never,
    });

    await service.failInterrupted(runStore.records.get(interrupted.runId)!);

    await expect(runStore.get(interrupted.runId)).resolves.toMatchObject({
      status: 'failed',
      statusReason: 'background_task_interrupted_child_terminal',
      metadata: { wakeState: 'pending' },
    });
  });

  it('preserves concurrent cancellation and never falls back to the automation root run', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    await runStore.upsertPending({ runId: 'automation-root-run', sessionId: 'automation-root-session' });
    const interrupted = await runStore.upsertPending({
      runId: 'bg-automation-cancelled',
      sessionId: 'sub-bg-automation-cancelled',
      metadata: automationAgentMetadata('bg-automation-cancelled'),
    });
    runStore.records.set(interrupted.runId, { ...interrupted, status: 'running' });
    const staleInterrupted = runStore.records.get(interrupted.runId)!;
    await runStore.markStatus(interrupted.runId, 'cancelled', 'user_cancelled');
    const service = new DurableBackgroundTaskService({
      ...terminalRuntimeConfig(runStore, eventStore),
      sessionAutomationRuntimeGuard: {
        recoverInterruptedBackgroundChild: vi.fn(async () => 'terminal_preserved' as const),
      } as never,
    });

    await service.failInterrupted(staleInterrupted);

    await expect(runStore.get(interrupted.runId)).resolves.toMatchObject({
      status: 'cancelled', statusReason: 'user_cancelled',
    });
    await expect(runStore.get('automation-root-run')).resolves.toMatchObject({ status: 'pending' });
  });

  it('freezes a legacy expired agent without durable intent and never calls wake to replay it', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    const metadata = automationAgentMetadata('bg-crashed');
    delete metadata.executionChildSessionId;
    delete metadata.executionChildRunId;
    const record = await runStore.upsertPending({
      runId: 'bg-crashed',
      sessionId: 'sub-bg-crashed',
      metadata,
    });
    runStore.records.set(record.runId, {
      ...record,
      status: 'running',
      workerId: 'dead-worker',
      leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const wake = vi.fn();
    const service = new DurableBackgroundTaskService(terminalRuntimeConfig(runStore, eventStore));
    const failInterrupted = vi.fn((candidate: RunRecord) => service.failInterrupted(candidate));
    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-new',
      autoWake: true,
      wake,
      failInterruptedBackgroundTask: failInterrupted,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(failInterrupted).toHaveBeenCalledOnce();
    expect(wake).not.toHaveBeenCalled();
    await expect(runStore.get('bg-crashed')).resolves.toMatchObject({
      status: 'failed',
      statusReason: 'background_task_interrupted_no_replay',
      metadata: { wakeState: 'pending' },
    });
  });

  it('re-acquires an expired background command monitor without replaying the command', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    const record = await runStore.upsertPending({
      runId: 'shell-bg-recover',
      sessionId: 'sub-shell-recover',
      metadata: {
        backgroundTask: true,
        backgroundTaskType: 'command',
        backgroundTaskReady: true,
      },
    });
    runStore.records.set(record.runId, {
      ...record,
      status: 'running',
      workerId: 'dead-monitor',
      leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const failInterrupted = vi.fn();
    const wake = vi.fn(async (_candidate: RunRecord, lease: { release(status?: RunStatus): Promise<void> }) => {
      await lease.release('completed');
    });
    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-new',
      autoWake: true,
      wake,
      failInterruptedBackgroundTask: failInterrupted,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(failInterrupted).not.toHaveBeenCalled();
    expect(wake).toHaveBeenCalledWith(expect.objectContaining({ runId: 'shell-bg-recover' }), expect.anything());
    await expect(runStore.get('shell-bg-recover')).resolves.toMatchObject({ status: 'completed' });
  });

  it('does not lease a reserved background command until ACS start is acknowledged', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    await runStore.upsertPending({
      runId: 'shell-bg-starting',
      sessionId: 'sub-shell-starting',
      metadata: {
        backgroundTask: true,
        backgroundTaskType: 'command',
        backgroundTaskReady: false,
      },
    });
    const wake = vi.fn();
    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-1',
      autoWake: true,
      wake,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(wake).not.toHaveBeenCalled();
    await expect(runStore.get('shell-bg-starting')).resolves.toMatchObject({ status: 'pending' });
  });

  it('fails stale unactivated command and Agent background reservations', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    const record = await runStore.upsertPending({
      runId: 'shell-bg-stale-start',
      sessionId: 'sub-shell-stale-start',
      metadata: {
        backgroundTask: true,
        backgroundTaskType: 'command',
        backgroundTaskReady: false,
      },
    });
    runStore.records.set(record.runId, {
      ...record,
      requestedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    });
    const agent = await runStore.upsertPending({
      runId: 'bg-agent-stale-start', sessionId: 'sub-agent-stale-start',
      metadata: { backgroundTask: true, backgroundTaskType: 'agent', backgroundTaskReady: false },
    });
    runStore.records.set(agent.runId, { ...agent, requestedAt: new Date(Date.now() - 3 * 60_000).toISOString() });
    const failBackgroundTask = vi.fn(async (candidate: RunRecord, message: string) => {
      await runStore.markStatus(candidate.runId, 'failed', 'background_command_start_timeout', {
        wakeState: 'pending',
        error: message,
      });
    });
    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-1',
      autoWake: true,
      wake: vi.fn(),
      failBackgroundTask,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(failBackgroundTask).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'shell-bg-stale-start' }),
      expect.stringContaining('启动确认超时'),
    );
    expect(failBackgroundTask).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'bg-agent-stale-start' }),
      expect.stringContaining('启动确认超时'),
    );
    await expect(runStore.get('shell-bg-stale-start')).resolves.toMatchObject({
      status: 'failed',
      metadata: { wakeState: 'pending' },
    });
  });

  it('hands off an in-flight background command monitor during scheduler drain', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    await runStore.upsertPending({
      runId: 'shell-bg-drain',
      sessionId: 'sub-shell-drain',
      metadata: {
        backgroundTask: true,
        backgroundTaskType: 'command',
        backgroundTaskReady: true,
      },
    });
    const wakeEntered = deferred();
    const handedOff = deferred();
    const handoffBackgroundCommand = vi.fn(() => handedOff.resolve());
    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-1',
      autoWake: true,
      wake: async (_record, lease) => {
        wakeEntered.resolve();
        await handedOff.promise;
        await lease.handoff('background_command_monitor_handoff');
      },
      handoffBackgroundCommand,
    });

    await scheduler.tick();
    await wakeEntered.promise;
    await scheduler.stop();

    expect(handoffBackgroundCommand).toHaveBeenCalledWith(expect.objectContaining({ runId: 'shell-bg-drain' }));
    await expect(runStore.get('shell-bg-drain')).resolves.toMatchObject({
      status: 'running',
      workerId: undefined,
      leaseExpiresAt: undefined,
      liveness: { state: 'unknown' },
    });
  });

  it('freezes a pending background task when a pre-wake tenant/billing gate rejects it', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    await runStore.upsertPending({
      runId: 'bg-blocked',
      sessionId: 'sub-bg-blocked',
      metadata: { backgroundTask: true, backgroundTaskReady: true, wakeState: 'none' },
    });
    const failBackground = vi.fn(async (candidate: RunRecord, message: string) => {
      await runStore.markStatus(candidate.runId, 'failed', 'background_task_start_failed', {
        wakeState: 'pending',
        backgroundResult: { status: 'failed', text: '', errorMessage: message },
      });
    });
    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-1',
      autoWake: true,
      wake: async () => { throw new Error('组织积分余额不足'); },
      failBackgroundTask: failBackground,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(failBackground).toHaveBeenCalledWith(expect.objectContaining({ runId: 'bg-blocked' }), '组织积分余额不足');
    await expect(runStore.get('bg-blocked')).resolves.toMatchObject({
      status: 'failed',
      metadata: { wakeState: 'pending' },
    });
  });

});
