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
});
