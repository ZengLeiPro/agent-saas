import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { deliverPendingToolInvocationCancels } from '../runtime/toolInvocationCancelDelivery.js';
import { recoverRunningToolInvocations } from '../runtime/toolInvocationRecovery.js';
import { InMemoryToolInvocationStore } from '../runtime/toolInvocationStore.js';
import type { RunStore } from '../runtime/runStore.js';
import type { EventStore, PlatformEvent, PlatformEventInput } from '../runtime/types.js';

class MemoryEventStore implements EventStore {
  readonly events: PlatformEvent[] = [];

  async append(input: PlatformEventInput): Promise<PlatformEvent> {
    const event = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...input,
    } as PlatformEvent;
    this.events.push(event);
    return event;
  }

  async list(sessionId: string): Promise<PlatformEvent[]> {
    return this.events.filter((event) => event.sessionId === sessionId);
  }
}

function cancelledRunStore(): RunStore {
  return {
    get: vi.fn(async (runId: string) => ({
      runId,
      sessionId: 'session-1',
      status: 'cancelled',
      requestedAt: '2026-08-15T00:00:00.000Z',
      updatedAt: '2026-08-15T00:01:00.000Z',
      cancelledAt: '2026-08-15T00:01:00.000Z',
      metadata: {},
    })),
  } as unknown as RunStore;
}

async function seedInvocation(store: InMemoryToolInvocationStore): Promise<void> {
  await store.start({
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    toolCallId: 'tool-call-1',
    toolName: 'Shell',
    executionTarget: 'server-remote',
  });
}

describe('recoverRunningToolInvocations cancellation outbox', () => {
  it('keeps an already-requested external cancellation deliverable after recovery marks the invocation failed', async () => {
    const store = new InMemoryToolInvocationStore();
    const eventStore = new MemoryEventStore();
    await seedInvocation(store);
    await store.requestCancelOnce('invocation-1', 'web_abort');

    await expect(recoverRunningToolInvocations({
      toolInvocationStore: store,
      eventStore,
      runStore: cancelledRunStore(),
    })).resolves.toEqual({ scanned: 1, recovered: 1 });
    await expect(store.get('invocation-1')).resolves.toMatchObject({ status: 'failed' });
    await expect(store.listCancelRequested()).resolves.toHaveLength(1);

    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'ok', cancelled: true }), { status: 200 }));
    await expect(deliverPendingToolInvocationCancels({
      toolInvocationStore: store,
      runStore: cancelledRunStore(),
      serverRemoteBaseUrl: 'http://hand.test',
      serverRemoteAuthToken: 'token',
      fetchImpl,
    })).resolves.toMatchObject({ scanned: 1, attempted: 1, results: { delivered: 1 } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('repairs a legacy cancelled-run half-state before closing the stale invocation', async () => {
    const store = new InMemoryToolInvocationStore();
    const eventStore = new MemoryEventStore();
    await seedInvocation(store);

    await recoverRunningToolInvocations({
      toolInvocationStore: store,
      eventStore,
      runStore: cancelledRunStore(),
    });

    await expect(store.get('invocation-1')).resolves.toMatchObject({
      status: 'failed',
      cancelRequestedAt: expect.any(String),
      cancelReason: 'recovered_after_cancelled_run',
    });
    expect(eventStore.events).toEqual([
      expect.objectContaining({
        type: 'tool_invocation_cancel_requested',
        invocationId: 'invocation-1',
        reason: 'recovered_after_cancelled_run',
      }),
      expect.objectContaining({
        type: 'tool_invocation_completed',
        invocationId: 'invocation-1',
      }),
    ]);
    await expect(store.listCancelRequested()).resolves.toHaveLength(1);
  });

  it('registers a missing cancel outbox even when crash recovery finds the invocation already terminal', async () => {
    const store = new InMemoryToolInvocationStore();
    const eventStore = new MemoryEventStore();
    await seedInvocation(store);
    await store.complete('invocation-1', 'failed', 'worker restarted before cancel outbox registration');

    await expect(recoverRunningToolInvocations({
      toolInvocationStore: store,
      eventStore,
      runStore: cancelledRunStore(),
    })).resolves.toEqual({ scanned: 1, recovered: 0 });

    await expect(store.get('invocation-1')).resolves.toMatchObject({
      status: 'failed',
      cancelRequestedAt: expect.any(String),
      cancelReason: 'recovered_after_cancelled_run',
    });
    expect(eventStore.events).toEqual([
      expect.objectContaining({
        type: 'tool_invocation_cancel_requested',
        invocationId: 'invocation-1',
      }),
    ]);
    await expect(store.listCancelRequested()).resolves.toHaveLength(1);
  });

  it('keeps an in-memory terminal invocation terminal on idempotent start replay', async () => {
    const store = new InMemoryToolInvocationStore();
    await seedInvocation(store);
    await store.complete('invocation-1', 'completed');

    await seedInvocation(store);

    await expect(store.get('invocation-1')).resolves.toMatchObject({ status: 'completed' });
  });

  it('does not infer an external cancellation for a terminal legacy record without completedAt', async () => {
    const store = new InMemoryToolInvocationStore();
    const eventStore = new MemoryEventStore();
    await seedInvocation(store);
    await store.complete('invocation-1', 'failed', 'legacy half-state');
    delete (await store.get('invocation-1') as { completedAt?: string }).completedAt;

    await expect(recoverRunningToolInvocations({
      toolInvocationStore: store,
      eventStore,
      runStore: cancelledRunStore(),
    })).resolves.toEqual({ scanned: 1, recovered: 0 });

    expect((await store.get('invocation-1'))?.cancelRequestedAt).toBeUndefined();
    expect(eventStore.events).toHaveLength(0);
  });

  it('does not cancel an invocation that completed before the run was cancelled', async () => {
    const store = new InMemoryToolInvocationStore();
    const eventStore = new MemoryEventStore();
    await seedInvocation(store);
    await store.complete('invocation-1', 'completed');
    const completed = await store.get('invocation-1');
    const cancelledAt = new Date(Date.parse(completed!.completedAt!) + 60_000).toISOString();
    const runStore = {
      get: vi.fn(async (runId: string) => ({
        runId,
        sessionId: 'session-1',
        status: 'cancelled',
        requestedAt: completed!.startedAt,
        updatedAt: cancelledAt,
        cancelledAt,
        metadata: {},
      })),
    } as unknown as RunStore;

    await expect(recoverRunningToolInvocations({
      toolInvocationStore: store,
      eventStore,
      runStore,
    })).resolves.toEqual({ scanned: 1, recovered: 0 });

    const recovered = await store.get('invocation-1');
    expect(recovered?.status).toBe('completed');
    expect(recovered?.cancelRequestedAt).toBeUndefined();
    expect(eventStore.events).toHaveLength(0);
  });
});
