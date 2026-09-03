import { describe, expect, it, vi } from 'vitest';
import { RuntimeScheduler } from '../runtime/scheduler.js';
import { readTerminalEventOutbox } from '../runtime/runTerminalCoordinator.js';
import { MemoryEventStore, MemoryRunStore } from './runtimeScheduler.testHelpers.js';

describe('RuntimeScheduler terminal outbox', () => {
  it('terminalizes pre-wake lease-event failures through the durable outbox', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    await runStore.upsertPending({ runId: 'run-pre-wake-failure', sessionId: 'session-pre-wake-failure' });
    eventStore.append = vi.fn(async () => { throw new Error('event store unavailable'); });
    const wake = vi.fn(async () => undefined);
    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-pre-wake-failure',
      autoWake: true,
      wake,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(wake).not.toHaveBeenCalled();
    const terminal = await runStore.get('run-pre-wake-failure');
    expect(terminal).toMatchObject({ status: 'failed' });
    expect(readTerminalEventOutbox(terminal)).toMatchObject({ terminalStatus: 'failed' });
  });

  it('repairs a reaper orphan into the durable outbox before publishing its terminal event', async () => {
    const runStore = new MemoryRunStore(); const eventStore = new MemoryEventStore();
    const orphaned = await runStore.upsertPending({ runId: 'run-reaper-orphan', sessionId: 'session-reaper-orphan' });
    runStore.records.set(orphaned.runId, { ...orphaned, status: 'orphaned', statusReason: 'lease_expired' });
    Object.assign(runStore, {
      reapExpiredLiveness: vi.fn(async () => ({ stale: [], orphaned: [(await runStore.get(orphaned.runId))!] })),
    });
    eventStore.append = vi.fn(async () => { throw new Error('event store unavailable'); });
    const scheduler = new RuntimeScheduler({ runStore, eventStore, autoWake: false });
    await scheduler.tick(); await scheduler.stop();
    expect(readTerminalEventOutbox(await runStore.get(orphaned.runId))).toMatchObject({
      terminalStatus: 'orphaned', state: 'failed',
      events: [expect.objectContaining({ type: 'run_state_changed', status: 'orphaned' })],
    });
  });

  it('retains a durable terminal outbox when scheduler wake failure event append fails', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new MemoryEventStore();
    await runStore.upsertPending({ runId: 'run-terminal-outbox', sessionId: 'session-terminal-outbox' });
    const append = eventStore.append.bind(eventStore);
    eventStore.append = vi.fn(async (event, ctx) => {
      if (event.type === 'run_state_changed') throw new Error('event store unavailable');
      return append(event, ctx);
    });

    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-terminal-outbox',
      autoWake: true,
      wake: async () => { throw new Error('wake failed'); },
    });

    await scheduler.tick();
    await scheduler.stop();

    const terminal = await runStore.get('run-terminal-outbox'); // terminal fact wins even while delivery retries
    expect(terminal).toMatchObject({ status: 'failed', statusReason: 'wake failed' });
    const outbox = readTerminalEventOutbox(terminal);
    expect(outbox).toMatchObject({ terminalStatus: 'failed' });
    expect(outbox?.state).not.toBe('delivered');
    expect(outbox?.events).toEqual([expect.objectContaining({ type: 'run_state_changed', status: 'failed' })]);
  });

});
