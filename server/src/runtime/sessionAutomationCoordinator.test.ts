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
    publish: vi.fn(),
    tables: { outbox: 'outbox', preparedDispatchAttempts: 'prepared_dispatch_attempts' },
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
