import { describe, expect, it } from 'vitest';
import { RuntimeScheduler } from '../runtime/scheduler.js';
import { readTerminalEventOutbox, retryPendingTerminalEvents } from '../runtime/runTerminalCoordinator.js';
import { MemoryEventStore, MemoryRunStore } from './runtimeScheduler.testHelpers.js';

describe('RuntimeScheduler stale approval terminal delivery', () => {
  it('retries a stale approval terminal batch after the first append fails without duplicates', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    const staleUpdatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    runStore.records.set('run-stale-retry', {
      runId: 'run-stale-retry',
      sessionId: 'session-stale-retry',
      tenantId: 'wain-test',
      status: 'waiting_approval',
      requestedAt: staleUpdatedAt,
      updatedAt: staleUpdatedAt,
      metadata: {},
    });
    await eventStore.append({
      type: 'approval_requested',
      runId: 'run-stale-retry',
      sessionId: 'session-stale-retry',
      approvalId: 'approval-retry',
      toolCallId: 'call-retry',
      toolId: 'Shell',
      toolName: 'Shell',
      input: { cmd: 'date' },
    }, { tenantId: 'wain-test' });
    const originalAppend = eventStore.append.bind(eventStore);
    let failNextAppend = true;
    eventStore.append = async (event, ctx) => {
      if (failNextAppend) {
        failNextAppend = false;
        throw new Error('injected first terminal append failure');
      }
      return originalAppend(event, ctx);
    };

    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      autoWake: true,
      approvalTimeoutMs: 24 * 60 * 60 * 1000,
    });
    await scheduler.tick();
    await scheduler.stop();

    const cancelled = await runStore.get('run-stale-retry');
    expect(cancelled?.status).toBe('cancelled');
    expect(readTerminalEventOutbox(cancelled)).toMatchObject({ state: 'failed', attempts: 1 });
    expect(eventStore.events.map((event) => event.type)).toEqual(['approval_requested']);

    await expect(retryPendingTerminalEvents({
      runStore,
      eventStore,
      runId: 'run-stale-retry',
      ctx: { tenantId: 'wain-test' },
    })).resolves.toBe(true);
    await expect(retryPendingTerminalEvents({
      runStore,
      eventStore,
      runId: 'run-stale-retry',
      ctx: { tenantId: 'wain-test' },
    })).resolves.toBe(false);

    expect(eventStore.events.map((event) => event.type)).toEqual([
      'approval_requested',
      'approval_resolved',
      'run_cancel_requested',
      'run_state_changed',
    ]);
    expect(readTerminalEventOutbox(await runStore.get('run-stale-retry'))).toMatchObject({ state: 'delivered' });
  });
});
