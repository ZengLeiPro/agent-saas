/** TASK-200 fast pathless persisted ask_user reconnect regression coverage. */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WebChannel } from '../channels/web/channel.js';
import { createExecutionConfig } from '../runtime/executionConfig.js';
import type { UpsertRunInput } from '../runtime/runStore.js';
import type { RuntimeSessionRecord, SessionCatalog } from '../runtime/sessionCatalog.js';
import type { EventStore, PlatformEvent, PlatformEventInput } from '../runtime/types.js';
import { FakeWebSocket, MemoryRunStore, wsClient } from './webChannelTestHelpers.js';

const TENANT = `pathless-${randomUUID().slice(0, 8)}`;
const USER = { sub: 'pathless-user', username: 'pathless_user', role: 'user' as const, tenantId: TENANT };
const channels: WebChannel[] = [];

class PathlessMemoryEventStore implements EventStore {
  readonly events: PlatformEvent[] = [];

  async append(event: PlatformEventInput, context: { tenantId: string }): Promise<PlatformEvent> {
    const requestedId = 'id' in event ? event.id : undefined;
    const existing = requestedId ? this.events.find(candidate => candidate.id === requestedId) : undefined;
    if (existing) return existing;
    const persisted = {
      ...event,
      id: requestedId ?? `pg-${this.events.length + 1}`,
      timestamp: new Date().toISOString(),
      tenantId: context.tenantId,
    } as PlatformEvent;
    this.events.push(persisted);
    return persisted;
  }

  async list(tenantId: string, sessionId: string): Promise<PlatformEvent[]> {
    return this.events.filter(event => (
      (!('tenantId' in event) || event.tenantId === tenantId)
      && (!('sessionId' in event) || event.sessionId === sessionId)
    ));
  }
}

class PathlessSessionCatalog implements SessionCatalog {
  constructor(private readonly record: RuntimeSessionRecord) {}
  async upsert(): Promise<void> {}
  async ensure(): Promise<void> {}
  async get(sessionId: string): Promise<RuntimeSessionRecord | null> { return sessionId === this.record.sessionId ? this.record : null; }
  async markStatus(): Promise<void> {}
  async findTranscriptPath(): Promise<string | null> { return null; }
}

function sessionRecord(sessionId: string): RuntimeSessionRecord {
  const now = new Date().toISOString();
  return {
    sessionId, userId: USER.sub, username: USER.username, tenantId: TENANT, channel: 'web',
    cwd: '/pathless', transcriptPath: '', modelRef: 'm-pathless', executionTarget: 'server-local',
    workspaceId: 'ws-pathless', createdAt: now, updatedAt: now,
  };
}

async function seedAskUser(store: PathlessMemoryEventStore, sessionId: string, runId: string, interactionId: string): Promise<void> {
  await store.append({
    type: 'interaction_requested', sessionId, runId, toolCallId: `call-${interactionId}`,
    interactionId, interactionType: 'ask_user', userId: USER.sub,
    questions: [{ question: '继续吗?', header: '确认', options: [{ label: '继续', description: '' }], multiSelect: false }],
  }, { tenantId: TENANT });
}

function channelFor(input: {
  sessionId: string;
  store: PathlessMemoryEventStore;
  runStore: MemoryRunStore;
  scheduler: { enqueue: (run: UpsertRunInput) => Promise<any>; activateCreatedRun?: (runId: string) => Promise<any> };
}): WebChannel {
  const channel = new WebChannel({
    executionConfig: createExecutionConfig(),
    agentCwd: '/definitely/no/transcript',
    runtimeEventStoreSupportsPathless: true,
    runtimeEventStoreFor: () => input.store,
    enqueueRuntime: {
      enabled: true,
      runStore: input.runStore,
      sessionCatalog: new PathlessSessionCatalog(sessionRecord(input.sessionId)),
      scheduler: input.scheduler as any,
    },
  }, async function* () { yield { type: 'done' as const }; });
  channels.push(channel);
  return channel;
}

afterEach(async () => {
  await Promise.all(channels.splice(0).map(channel => channel.stop()));
});

describe('WebChannel pathless ask_user resume (memory event store)', () => {
  it('断线重连后 non-terminal staged resume 只激活一次并按 attempt ACK canonical response', async () => {
    const sessionId = randomUUID();
    const interactionId = 'ask-pathless-staged';
    const runId = 'run-pathless-staged';
    const store = new PathlessMemoryEventStore();
    await seedAskUser(store, sessionId, runId, interactionId);
    const runStore = new MemoryRunStore();
    await runStore.upsertPending({
      runId, sessionId, userId: USER.sub, tenantId: TENANT, model: 'm-pathless', channel: 'web',
      executionTarget: 'server-local', workspaceId: 'ws-pathless',
    });
    await runStore.markStatus(runId, 'waiting_user');
    const activateCreatedRun = vi.fn(async (targetRunId: string, claim: Record<string, unknown>, patch?: Record<string, unknown>) => (
      runStore.activatePersistedInteractionResume(targetRunId, claim, patch)
    ));
    const channel = channelFor({ sessionId, store, runStore, scheduler: { enqueue: vi.fn(), activateCreatedRun } as any });
    const first = new FakeWebSocket();

    await (channel as any).resolveInteraction(wsClient(first, USER), interactionId, { answers: { confirm: '继续' } }, sessionId, 'attempt-first');
    expect(first.sent.at(-1)?.data).toEqual({
      type: 'respond_ok', interactionId, clientAttemptId: 'attempt-first', response: { answers: { confirm: '继续' } },
    });

    const reconnect = new FakeWebSocket();
    await (channel as any).resolveInteraction(wsClient(reconnect, USER), interactionId, { answers: { confirm: '停止' } }, sessionId, 'attempt-reconnect');
    expect(reconnect.sent.at(-1)?.data).toEqual({
      type: 'respond_ok', interactionId, clientAttemptId: 'attempt-reconnect', response: { answers: { confirm: '继续' } },
    });
    expect(activateCreatedRun).toHaveBeenCalledTimes(1);
    expect(store.events.filter(event => event.type === 'interaction_resolved')).toHaveLength(1);
  });

  it('终态 synthetic resume 在 enqueue/activation 失败后重连恢复，重复提交保持 canonical ACK', async () => {
    const sessionId = randomUUID();
    const interactionId = 'ask-pathless-terminal';
    const runId = 'run-pathless-terminal';
    const store = new PathlessMemoryEventStore();
    await seedAskUser(store, sessionId, runId, interactionId);
    const runStore = new MemoryRunStore();
    await runStore.upsertPending({
      runId, sessionId, userId: USER.sub, tenantId: TENANT, model: 'm-pathless', channel: 'web',
      executionTarget: 'server-local', workspaceId: 'ws-pathless',
    });
    await runStore.markStatus(runId, 'completed');
    const enqueue = vi.fn(async (input: UpsertRunInput) => {
      const staged = await runStore.upsertPending(input);
      if (enqueue.mock.calls.length === 1) throw new Error('enqueue transport failed');
      return staged;
    });
    const activateCreatedRun = vi.fn(async (targetRunId: string) => {
      if (activateCreatedRun.mock.calls.length === 1) return null;
      return runStore.markStatus(targetRunId, 'pending', undefined, { schedulerState: 'ready' });
    });
    const channel = channelFor({ sessionId, store, runStore, scheduler: { enqueue, activateCreatedRun } });
    const attempts = [
      ['attempt-enqueue-failed', '继续'],
      ['attempt-activation-failed', '停止'],
      ['attempt-reconnect', '再次停止'],
      ['attempt-duplicate', '重复停止'],
    ] as const;
    const replies: unknown[] = [];
    for (const [clientAttemptId, answer] of attempts) {
      const ws = new FakeWebSocket();
      await (channel as any).resolveInteraction(wsClient(ws, USER), interactionId, { answers: { confirm: answer } }, sessionId, clientAttemptId);
      replies.push(ws.sent.at(-1)?.data);
    }

    expect(replies).toEqual([
      { type: 'respond_error', interactionId, clientAttemptId: 'attempt-enqueue-failed', error: 'Interaction response was persisted but resume enqueue failed; please retry' },
      { type: 'respond_error', interactionId, clientAttemptId: 'attempt-activation-failed', error: 'Interaction response is awaiting resume activation; please retry' },
      { type: 'respond_ok', interactionId, clientAttemptId: 'attempt-reconnect', response: { answers: { confirm: '继续' } } },
      { type: 'respond_ok', interactionId, clientAttemptId: 'attempt-duplicate', response: { answers: { confirm: '继续' } } },
    ]);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(activateCreatedRun).toHaveBeenCalledTimes(2);
    expect(store.events.filter(event => event.type === 'interaction_resolved')).toHaveLength(1);
  });
});
