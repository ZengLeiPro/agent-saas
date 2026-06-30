import { describe, expect, it, vi } from 'vitest';

import type { HandRecord, HandStore, HandStatus, RegisterHandInput } from '../runtime/handStore.js';
import type { RunRecord, RunStatus, RunStore, UpsertRunInput } from '../runtime/runStore.js';
import {
  deliverPendingToolInvocationCancels,
  deliverToolInvocationCancel,
} from '../runtime/toolInvocationCancelDelivery.js';
import { InMemoryToolInvocationStore } from '../runtime/toolInvocationStore.js';
import type { PlatformEvent } from '../runtime/types.js';

class MemoryRunStore implements RunStore {
  constructor(private readonly runs = new Map<string, RunRecord>()) {}
  async upsertPending(input: UpsertRunInput): Promise<RunRecord> {
    const now = new Date().toISOString();
    const record: RunRecord = {
      runId: input.runId,
      sessionId: input.sessionId,
      status: 'pending',
      requestedAt: now,
      updatedAt: now,
      metadata: input.metadata ?? {},
    };
    this.runs.set(record.runId, record);
    return record;
  }
  async markStatus(runId: string, status: RunStatus): Promise<RunRecord | null> {
    const record = this.runs.get(runId);
    if (!record) return null;
    const updated = { ...record, status, updatedAt: new Date().toISOString() };
    this.runs.set(runId, updated);
    return updated;
  }
  async get(runId: string): Promise<RunRecord | null> { return this.runs.get(runId) ?? null; }
  async findByIdempotencyKey(): Promise<RunRecord | null> { return null; }
  async listRecoverable(): Promise<RunRecord[]> { return []; }
  set(record: RunRecord): void { this.runs.set(record.runId, record); }
}

class MemoryHandStore implements HandStore {
  constructor(private readonly hands = new Map<string, HandRecord>()) {}
  async register(input: RegisterHandInput): Promise<HandRecord> {
    const now = new Date().toISOString();
    const record: HandRecord = {
      handId: input.handId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      type: input.type,
      status: input.status ?? 'ready',
      endpoint: input.endpoint,
      capabilities: input.capabilities ?? [],
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata ?? {},
    };
    this.hands.set(record.handId, record);
    return record;
  }
  async updateStatus(handId: string, status: HandStatus): Promise<HandRecord | null> {
    const record = this.hands.get(handId);
    if (!record) return null;
    const updated = { ...record, status, updatedAt: new Date().toISOString() };
    this.hands.set(handId, updated);
    return updated;
  }
  async get(handId: string): Promise<HandRecord | null> { return this.hands.get(handId) ?? null; }
  async listBySession(sessionId: string): Promise<HandRecord[]> {
    return [...this.hands.values()].filter((hand) => hand.sessionId === sessionId);
  }
  async listByWorkspace(workspaceId: string): Promise<HandRecord[]> {
    return [...this.hands.values()].filter((hand) => hand.workspaceId === workspaceId);
  }
}

function run(status: RunStatus, workerId?: string): RunRecord {
  const now = new Date().toISOString();
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    status,
    requestedAt: now,
    updatedAt: now,
    workerId,
    metadata: {},
  };
}

function cancelEvent(metadata?: Record<string, unknown>): Extract<PlatformEvent, { type: 'tool_invocation_cancel_requested' }> {
  return {
    id: 'event-1',
    timestamp: new Date(0).toISOString(),
    type: 'tool_invocation_cancel_requested',
    runId: 'run-1',
    sessionId: 'session-1',
    invocationId: 'inv-1',
    toolCallId: 'call-1',
    toolName: 'Shell',
    reason: 'web_abort',
    metadata,
  };
}

async function seedInvocation(metadata: Record<string, unknown> = {}) {
  const store = new InMemoryToolInvocationStore();
  await store.start({
    invocationId: 'inv-1',
    runId: 'run-1',
    sessionId: 'session-1',
    toolCallId: 'call-1',
    toolName: 'Shell',
    executionTarget: 'server-remote',
    metadata,
  });
  return store;
}

describe('tool invocation cancel delivery', () => {
  it('falls back to server-remote endpoint/auth token and marks delivery terminal', async () => {
    const store = await seedInvocation();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'ok', cancelled: true }), { status: 200 }));

    const result = await deliverToolInvocationCancel({
      event: cancelEvent(),
      toolInvocationStore: store,
      serverRemoteBaseUrl: 'http://hand.test',
      serverRemoteAuthToken: 'token-1',
      fetchImpl,
    });

    expect(result.status).toBe('delivered');
    expect(fetchImpl).toHaveBeenCalledWith('http://hand.test/invocations/inv-1', expect.objectContaining({
      method: 'DELETE',
      headers: { authorization: 'Bearer token-1' },
    }));
    await expect(store.get('inv-1')).resolves.toMatchObject({
      cancelDeliveredAt: expect.any(String),
      metadata: expect.objectContaining({ cancelDelivery: 'delivered', cancelDeliveryTerminal: true }),
    });
  });

  it('treats hand-server unknown invocation as terminal after restart', async () => {
    const store = await seedInvocation();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'ok', cancelled: false, alreadyFinishedOrUnknown: true }), { status: 200 }));

    const result = await deliverToolInvocationCancel({
      event: cancelEvent(),
      toolInvocationStore: store,
      serverRemoteBaseUrl: 'http://hand.test',
      serverRemoteAuthToken: 'token-1',
      fetchImpl,
    });

    expect(result.status).toBe('not_found_assumed_terminal');
    await expect(store.get('inv-1')).resolves.toMatchObject({
      cancelDeliveredAt: expect.any(String),
      metadata: expect.objectContaining({ cancelDelivery: 'not_found_assumed_terminal' }),
    });
  });

  it('schedules retry and scanner respects nextAttemptAt', async () => {
    const store = await seedInvocation();
    const firstFetch = vi.fn(async () => {
      throw new Error('network down');
    });
    const now = new Date('2026-06-18T00:00:00.000Z');

    const result = await deliverToolInvocationCancel({
      event: cancelEvent(),
      toolInvocationStore: store,
      serverRemoteBaseUrl: 'http://hand.test',
      serverRemoteAuthToken: 'token-1',
      retryBaseMs: 1000,
      now,
      fetchImpl: firstFetch,
    });

    expect(result.status).toBe('retry_scheduled');
    const afterFailure = await store.get('inv-1');
    expect(afterFailure?.cancelDeliveredAt).toBeUndefined();
    expect(afterFailure?.metadata).toMatchObject({
      cancelDelivery: 'retry_scheduled',
      cancelDeliveryAttempts: 1,
      cancelDeliveryNextAttemptAt: '2026-06-18T00:00:01.000Z',
    });

    const skipped = await deliverPendingToolInvocationCancels({
      toolInvocationStore: store,
      serverRemoteBaseUrl: 'http://hand.test',
      serverRemoteAuthToken: 'token-1',
      now: new Date('2026-06-18T00:00:00.500Z'),
      fetchImpl: vi.fn(),
    });
    expect(skipped).toMatchObject({ scanned: 1, attempted: 0 });

    const secondFetch = vi.fn(async () => new Response(JSON.stringify({ status: 'ok', cancelled: true }), { status: 200 }));
    const retried = await deliverPendingToolInvocationCancels({
      toolInvocationStore: store,
      serverRemoteBaseUrl: 'http://hand.test',
      serverRemoteAuthToken: 'token-1',
      now: new Date('2026-06-18T00:00:01.000Z'),
      fetchImpl: secondFetch,
    });
    expect(retried).toMatchObject({ scanned: 1, attempted: 1, results: { delivered: 1 } });
    expect(secondFetch).toHaveBeenCalledTimes(1);
  });

  it('dead-letters after max attempts', async () => {
    const store = await seedInvocation({ cancelDeliveryAttempts: 1 });
    await store.requestCancel('inv-1', 'web_abort');
    const result = await deliverPendingToolInvocationCancels({
      toolInvocationStore: store,
      serverRemoteBaseUrl: 'http://hand.test',
      serverRemoteAuthToken: 'token-1',
      maxAttempts: 2,
      fetchImpl: vi.fn(async () => new Response('oops', { status: 503 })),
      now: new Date('2026-06-18T00:00:00.000Z'),
    });

    expect(result.results).toEqual({ dead_letter: 1 });
    await expect(store.get('inv-1')).resolves.toMatchObject({
      cancelDeliveredAt: expect.any(String),
      metadata: expect.objectContaining({
        cancelDelivery: 'dead_letter',
        cancelDeliveryDeadLetterAt: '2026-06-18T00:00:00.000Z',
      }),
    });
  });

  it('defers delivery when invocation worker ownership no longer matches active run owner', async () => {
    const store = await seedInvocation({ workerId: 'worker-a' });
    const runStore = new MemoryRunStore();
    runStore.set(run('running', 'worker-b'));
    const fetchImpl = vi.fn();

    const result = await deliverToolInvocationCancel({
      event: cancelEvent(),
      toolInvocationStore: store,
      runStore,
      serverRemoteBaseUrl: 'http://hand.test',
      serverRemoteAuthToken: 'token-1',
      now: new Date('2026-06-18T00:00:00.000Z'),
      fetchImpl,
    });

    expect(result.status).toBe('ownership_mismatch');
    expect(fetchImpl).not.toHaveBeenCalled();
    const record = await store.get('inv-1');
    expect(record?.cancelDeliveredAt).toBeUndefined();
    expect(record?.metadata).toEqual(expect.objectContaining({
      cancelDelivery: 'retry_scheduled',
      cancelDeliveryLastReason: 'worker_ownership_mismatch',
      cancelDeliveryOwnerWorkerId: 'worker-a',
      cancelDeliveryCurrentWorkerId: 'worker-b',
    }));
  });

  it('uses per-hand auth token before global token', async () => {
    const store = await seedInvocation({ handId: 'hand-1' });
    const hands = new MemoryHandStore();
    await hands.register({
      handId: 'hand-1',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      type: 'server-remote',
      endpoint: 'http://hand-specific.test',
      metadata: { authToken: 'hand-token' },
    });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'ok', cancelled: true }), { status: 200 }));

    await deliverToolInvocationCancel({
      event: cancelEvent(),
      toolInvocationStore: store,
      handStore: hands,
      serverRemoteAuthToken: 'global-token',
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith('http://hand-specific.test/invocations/inv-1', expect.objectContaining({
      headers: { authorization: 'Bearer hand-token' },
    }));
  });
});
