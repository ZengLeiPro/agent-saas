import { describe, expect, it, vi } from 'vitest';
import { SessionAutomationCoordinator } from './sessionAutomationCoordinator.js';

function storeStub(overrides: Record<string, unknown> = {}) {
  return {
    recoverLeases: vi.fn(async () => undefined),
    listRecoverablePreparedDispatches: vi.fn(async () => []),
    transitionPreparedDispatch: vi.fn(async () => true),
    claimCancellations: vi.fn(async () => []),
    completeCancellation: vi.fn(async () => undefined),
    failCancellation: vi.fn(async () => undefined),
    claimDue: vi.fn(async () => 0),
    claimDispatch: vi.fn(async () => []),
    get: vi.fn(async () => undefined),
    supersedeDispatch: vi.fn(async () => undefined),
    failDispatch: vi.fn(async () => undefined),
    markDispatched: vi.fn(async () => undefined),
    prepareDispatch: vi.fn(async () => undefined),
    publish: vi.fn(),
    tables: { outbox: 'outbox', preparedDispatchAttempts: 'prepared_dispatch_attempts', executions: 'executions', automations: 'automations' },
    runsTable: 'runs',
    pool: { query: vi.fn(async () => ({ rows: [] })) },
    ...overrides,
  };
}

describe('SessionAutomationCoordinator drain/cancel fences', () => {
  it('does not acknowledge a cancellation until the durable cancel adapter succeeds', async () => {
    const item = {
      cancellationId: 'cancel-1', tenantId: 'tenant-1', sessionId: 'session-1',
      automationId: 'automation-1', runId: 'run-1', reason: 'replace',
      leaseToken: 'lease-1', requestedGeneration: 1,
    };
    const store = storeStub({ claimCancellations: vi.fn(async () => [item]) });
    const cancelRun = vi.fn()
      .mockRejectedValueOnce(new Error('crash-before-durable-terminal'))
      .mockResolvedValueOnce(undefined);
    const coordinator = new SessionAutomationCoordinator(store as never, {
      stage: vi.fn(), activate: vi.fn(),
    }, { executionEnabled: () => true, cancelRun });

    await coordinator.tick();
    expect(store.failCancellation).toHaveBeenCalledWith(item, expect.any(Error));
    expect(store.completeCancellation).not.toHaveBeenCalled();

    await coordinator.tick();
    expect(cancelRun).toHaveBeenCalledTimes(2);
    expect(store.completeCancellation).toHaveBeenCalledWith(item);
  });

  it('supersedes a claimed dispatch when an active run appears before staging', async () => {
    const item = {
      outboxId: 'outbox-1', wakeupId: 'wakeup-1', automationId: 'automation-1',
      tenantId: 'tenant-1', sessionId: 'session-1', targetRunId: 'run-new',
      triggerKey: 'trigger-1', payload: {}, leaseToken: 'lease-1', generation: 2,
      specVersion: 1, incarnationId: 'incarnation-1',
    };
    const store = storeStub({
      claimDispatch: vi.fn(async () => [item]),
      get: vi.fn(async () => ({
        status: 'active', activeRunId: 'run-old', generation: 2,
        incarnationId: 'incarnation-1',
      })),
    });
    const dispatcher = { stage: vi.fn(), activate: vi.fn() };
    const coordinator = new SessionAutomationCoordinator(
      store as never, dispatcher, { executionEnabled: () => true },
    );

    await coordinator.tick();

    expect(dispatcher.stage).not.toHaveBeenCalled();
    expect(store.supersedeDispatch).toHaveBeenCalledWith(item);
  });
});

describe('SessionAutomationCoordinator execution gating and staged recovery', () => {
  it('continues cancellation, lifecycle, and staged reconciliation while execution is disabled', async () => {
    const item = {
      cancellationId: 'cancel-1', tenantId: 'tenant-1', sessionId: 'session-1',
      automationId: 'automation-1', runId: 'run-1', reason: 'clear',
      leaseToken: 'lease-1', requestedGeneration: 2,
    };
    const store = storeStub({
      claimCancellations: vi.fn(async () => [item]),
      processLifecycleWork: vi.fn(async () => 1),
      listRecoverablePreparedDispatches: vi.fn(async () => [{
        outboxId: 'outbox-1', tenantId: 'tenant-1', sessionId: 'session-1',
        runId: 'run-staged', state: 'dispatched', requestPayload: {},
      }]),
      pool: { query: vi.fn(async () => ({ rows: [{ status: 'pending', admitted: true, metadata: { automationFence: { executionId: 'outbox-1' } } }] })) },
    });
    const dispatcher = { stage: vi.fn(), activate: vi.fn(async () => undefined) };
    const cancelRun = vi.fn(async () => undefined);
    const coordinator = new SessionAutomationCoordinator(store as never, dispatcher, {
      executionEnabled: () => false, cancelRun, lifecycleAdapters: {} as never,
    });

    await coordinator.tick();

    expect(cancelRun).toHaveBeenCalledWith('run-1', 'clear');
    expect((store as typeof store & { processLifecycleWork: ReturnType<typeof vi.fn> }).processLifecycleWork).toHaveBeenCalled();
    expect(store.listRecoverablePreparedDispatches).toHaveBeenCalledOnce();
    expect(store.pool.query).toHaveBeenCalledOnce();
    expect(dispatcher.activate).not.toHaveBeenCalled();
    expect(store.claimDue).not.toHaveBeenCalled();
    expect(store.claimDispatch).not.toHaveBeenCalled();
  });


  it('continues result-unknown reconciliation while execution is disabled', async () => {
    const store = storeStub({
      listRecoverablePreparedDispatches: vi.fn(async () => [{
        outboxId: 'outbox-1', tenantId: 'tenant-1', sessionId: 'session-1',
        runId: 'run-staged', state: 'result_unknown', requestPayload: {},
      }]),
      pool: { query: vi.fn(async () => ({ rows: [{
        status: 'pending', admitted: false,
        metadata: { automationFence: { executionId: 'outbox-1' } },
      }] })) },
    });
    const dispatcher = { stage: vi.fn(), activate: vi.fn() };
    const coordinator = new SessionAutomationCoordinator(store as never, dispatcher, {
      executionEnabled: () => false,
    });

    await coordinator.tick();

    expect(store.transitionPreparedDispatch).toHaveBeenNthCalledWith(1, 'outbox-1', 'result_unknown', 'reconcile');
    expect(store.transitionPreparedDispatch).toHaveBeenNthCalledWith(2, 'outbox-1', 'reconcile', 'dispatched');
    expect(dispatcher.stage).not.toHaveBeenCalled();
    expect(dispatcher.activate).not.toHaveBeenCalled();
  });

  it('rechecks the kill switch after claiming due wakeups', async () => {
    let enabled = true;
    const store = storeStub({ claimDue: vi.fn(async () => { enabled = false; return 1; }) });
    const coordinator = new SessionAutomationCoordinator(store as never, {
      stage: vi.fn(), activate: vi.fn(),
    }, { executionEnabled: () => enabled });

    await coordinator.tick();

    expect(store.claimDue).toHaveBeenCalledOnce();
    expect(store.claimDispatch).not.toHaveBeenCalled();
  });

  it('does not stage after the kill switch changes during dispatch recovery checks', async () => {
    const item = {
      outboxId: 'outbox-1', wakeupId: 'wakeup-1', automationId: 'automation-1',
      tenantId: 'tenant-1', sessionId: 'session-1', targetRunId: 'run-new',
      triggerKey: 'trigger-1', payload: {}, leaseToken: 'lease-1', generation: 2,
      specVersion: 1, incarnationId: 'incarnation-1',
    };
    let checks = 0;
    const store = storeStub({
      claimDispatch: vi.fn(async () => [item]),
      get: vi.fn(async () => ({
        status: 'active', activeRunId: null, generation: 2, incarnationId: 'incarnation-1',
        spec: { kind: 'loop', prompt: 'continue' }, specVersion: 1,
      })),
    });
    const dispatcher = { stage: vi.fn(), activate: vi.fn() };
    const coordinator = new SessionAutomationCoordinator(store as never, dispatcher, {
      executionEnabled: () => ++checks < 5,
    });

    await coordinator.tick();

    expect(dispatcher.stage).not.toHaveBeenCalled();
    expect(store.markDispatched).not.toHaveBeenCalled();
  });

  it('does not activate a staged run before durable dispatch admission', async () => {
    const store = storeStub({
      listRecoverablePreparedDispatches: vi.fn(async () => [{
        outboxId: 'outbox-1', tenantId: 'tenant-1', sessionId: 'session-1',
        runId: 'run-staged', state: 'dispatched', requestPayload: {},
      }]),
      pool: { query: vi.fn(async () => ({ rows: [{
        status: 'pending', admitted: false,
        metadata: { automationFence: { executionId: 'outbox-1' } },
      }] })) },
    });
    const dispatcher = { stage: vi.fn(), activate: vi.fn() };
    const coordinator = new SessionAutomationCoordinator(store as never, dispatcher, {
      executionEnabled: () => true,
    });

    await coordinator.tick();

    expect(dispatcher.activate).not.toHaveBeenCalled();
    expect(store.transitionPreparedDispatch).not.toHaveBeenCalled();
  });


  it('completes recovered admission without reactivation after the run already started', async () => {
    const store = storeStub({
      listRecoverablePreparedDispatches: vi.fn(async () => [{
        outboxId: 'outbox-1', tenantId: 'tenant-1', sessionId: 'session-1',
        runId: 'run-started', state: 'dispatched', requestPayload: {},
      }]),
      pool: { query: vi.fn(async () => ({ rows: [{
        status: 'running', admitted: true,
        metadata: { automationFence: { executionId: 'outbox-1' } },
      }] })) },
    });
    const dispatcher = { stage: vi.fn(), activate: vi.fn() };
    const coordinator = new SessionAutomationCoordinator(store as never, dispatcher, {
      executionEnabled: () => true,
    });

    await coordinator.tick();

    expect(dispatcher.activate).not.toHaveBeenCalled();
    expect(store.transitionPreparedDispatch).toHaveBeenCalledWith('outbox-1', 'dispatched', 'completed');
  });

  it('does not activate a newly staged run when execution is disabled before activation', async () => {
    const item = {
      outboxId: 'outbox-1', wakeupId: 'wakeup-1', automationId: 'automation-1',
      tenantId: 'tenant-1', sessionId: 'session-1', targetRunId: 'run-new',
      triggerKey: 'trigger-1', payload: {}, leaseToken: 'lease-1', generation: 2,
      specVersion: 1, incarnationId: 'incarnation-1',
    };
    let enabled = true;
    const store = storeStub({
      claimDispatch: vi.fn(async () => [item]),
      get: vi.fn(async () => ({
        status: 'active', activeRunId: null, generation: 2, incarnationId: 'incarnation-1',
        spec: { kind: 'loop', prompt: 'continue' }, specVersion: 1,
      })),
      markDispatched: vi.fn(async () => { enabled = false; }),
    });
    const dispatcher = { stage: vi.fn(async () => undefined), activate: vi.fn() };
    const coordinator = new SessionAutomationCoordinator(store as never, dispatcher, {
      executionEnabled: () => enabled,
    });

    await coordinator.tick();

    expect(dispatcher.stage).toHaveBeenCalledOnce();
    expect(store.markDispatched).toHaveBeenCalledWith(item);
    expect(dispatcher.activate).not.toHaveBeenCalled();
    expect(store.transitionPreparedDispatch).not.toHaveBeenCalledWith('outbox-1', 'dispatched', 'completed');
  });

  it('leaves the committed outbox and active slot recoverable when first activation fails', async () => {
    const item = {
      outboxId: 'outbox-1', wakeupId: 'wakeup-1', automationId: 'automation-1',
      tenantId: 'tenant-1', sessionId: 'session-1', targetRunId: 'run-new',
      triggerKey: 'trigger-1', payload: {}, leaseToken: 'lease-1', generation: 2,
      specVersion: 1, incarnationId: 'incarnation-1',
    };
    let recovery = false;
    const store = storeStub({
      claimDispatch: vi.fn(async () => recovery ? [] : [item]),
      get: vi.fn(async () => ({
        status: 'active', activeRunId: null, generation: 2, incarnationId: 'incarnation-1',
        spec: { kind: 'loop', prompt: 'continue' }, specVersion: 1,
      })),
      prepareDispatch: vi.fn(async () => undefined),
      listRecoverablePreparedDispatches: vi.fn(async () => recovery ? [{
        outboxId: 'outbox-1', tenantId: 'tenant-1', sessionId: 'session-1',
        runId: 'run-new', state: 'dispatched', requestPayload: {},
      }] : []),
      pool: { query: vi.fn(async () => recovery
        ? ({ rows: [{ status: 'pending', admitted: true, metadata: { automationFence: { executionId: 'outbox-1' } } }] })
        : ({ rows: [] })) },
    });
    const dispatcher = {
      stage: vi.fn(async () => undefined),
      activate: vi.fn().mockRejectedValueOnce(new Error('activate unavailable')).mockResolvedValueOnce(undefined),
    };
    const coordinator = new SessionAutomationCoordinator(store as never, dispatcher, { executionEnabled: () => true });

    await coordinator.tick();
    expect(store.markDispatched).toHaveBeenCalledWith(item);
    expect(store.failDispatch).not.toHaveBeenCalled();
    expect(store.supersedeDispatch).not.toHaveBeenCalled();

    recovery = true;
    await coordinator.tick();
    expect(dispatcher.activate).toHaveBeenCalledTimes(2);
    expect(store.transitionPreparedDispatch).toHaveBeenLastCalledWith('outbox-1', 'dispatched', 'completed');
  });
});
