/** TASK-200 real-PG/pathless persisted ask_user reconnect regression coverage. */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { WebChannel } from '../channels/web/channel.js';
import { createExecutionConfig } from '../runtime/executionConfig.js';
import { PgEventStore } from '../runtime/pgEventStore.js';
import type { UpsertRunInput } from '../runtime/runStore.js';
import type { RuntimeSessionRecord, SessionCatalog } from '../runtime/sessionCatalog.js';
import { FakeWebSocket, MemoryRunStore, wsClient } from './webChannelTestHelpers.js';

const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;
const prefix = `web_pathless_${randomUUID().replaceAll('-', '_').slice(0, 12)}`;
const store = connectionString ? new PgEventStore({ connectionString, tablePrefix: prefix }) : null;
const TENANT = `pathless-pg-${randomUUID().slice(0, 8)}`;
const USER = { sub: 'pathless-pg-user', username: 'pathless_pg_user', role: 'user' as const, tenantId: TENANT };
const channels: WebChannel[] = [];

class PathlessSessionCatalog implements SessionCatalog {
  constructor(private readonly record: RuntimeSessionRecord) {}
  async upsert(): Promise<void> {}
  async ensure(): Promise<void> {}
  async get(sessionId: string): Promise<RuntimeSessionRecord | null> {
    return sessionId === this.record.sessionId ? this.record : null;
  }
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

async function seedAskUser(sessionId: string, runId: string, interactionId: string): Promise<void> {
  await store!.append({
    type: 'interaction_requested', sessionId, runId, toolCallId: `call-${interactionId}`,
    interactionId, interactionType: 'ask_user', userId: USER.sub,
    questions: [{ question: '继续吗?', header: '确认', options: [{ label: '继续', description: '' }], multiSelect: false }],
  }, { tenantId: TENANT });
}

function channelFor(input: {
  sessionId: string;
  runStore: MemoryRunStore;
  scheduler: { enqueue: (run: UpsertRunInput) => Promise<unknown>; activateCreatedRun?: (...args: any[]) => Promise<unknown> };
}): WebChannel {
  const channel = new WebChannel({
    executionConfig: createExecutionConfig(),
    agentCwd: '/definitely/no/transcript',
    runtimeEventStoreSupportsPathless: true,
    runtimeEventStoreFor: () => store!,
    enqueueRuntime: {
      enabled: true,
      runStore: input.runStore,
      sessionCatalog: new PathlessSessionCatalog(sessionRecord(input.sessionId)),
      scheduler: input.scheduler as never,
    },
  }, async function* () { yield { type: 'done' as const }; });
  channels.push(channel);
  return channel;
}

async function createRun(runStore: MemoryRunStore, runId: string, sessionId: string): Promise<void> {
  await runStore.upsertPending({
    runId, sessionId, userId: USER.sub, tenantId: TENANT, model: 'm-pathless', channel: 'web',
    executionTarget: 'server-local', workspaceId: 'ws-pathless',
  });
}

describePg('WebChannel pathless ask_user resume with PgEventStore', () => {
  beforeAll(async () => store!.init());

  afterEach(async () => {
    await Promise.all(channels.splice(0).map(channel => channel.stop()));
  });

  afterAll(async () => {
    if (!store) return;
    await Promise.all(channels.splice(0).map(channel => channel.stop()));
    await store.pool.query(`DROP TABLE IF EXISTS ${prefix}_events`);
    await store.pool.query(`DROP TABLE IF EXISTS ${prefix}_event_cursors`);
    await store.close();
  });

  it('无 transcript 时断线重连/重复提交返回 canonical ACK，且只持久化一次 resolved event', async () => {
    const sessionId = randomUUID();
    const interactionId = 'ask-pathless-pg-staged';
    const runId = 'run-pathless-pg-staged';
    await seedAskUser(sessionId, runId, interactionId);
    const runStore = new MemoryRunStore();
    await createRun(runStore, runId, sessionId);
    await runStore.markStatus(runId, 'waiting_user');
    const activateCreatedRun = vi.fn(async (targetRunId: string, claim: Record<string, unknown>, patch?: Record<string, unknown>) => (
      runStore.activatePersistedInteractionResume(targetRunId, claim, patch)
    ));
    const channel = channelFor({ runStore, sessionId, scheduler: { enqueue: vi.fn(), activateCreatedRun } });

    const first = new FakeWebSocket();
    await (channel as any).resolveInteraction(wsClient(first, USER), interactionId, { answers: { confirm: '继续' } }, sessionId, 'attempt-first');
    const reconnect = new FakeWebSocket();
    await (channel as any).resolveInteraction(wsClient(reconnect, USER), interactionId, { answers: { confirm: '停止' } }, sessionId, 'attempt-reconnect');

    expect(first.sent.at(-1)?.data).toEqual({
      type: 'respond_ok', interactionId, clientAttemptId: 'attempt-first', response: { answers: { confirm: '继续' } },
    });
    expect(reconnect.sent.at(-1)?.data).toEqual({
      type: 'respond_ok', interactionId, clientAttemptId: 'attempt-reconnect', response: { answers: { confirm: '继续' } },
    });
    expect(activateCreatedRun).toHaveBeenCalledTimes(1);
    const events = await store!.list(TENANT, sessionId);
    expect(events.filter(event => event.type === 'interaction_resolved')).toHaveLength(1);
  });

  it('终态 synthetic resume 首次 enqueue/activation 失败后可重连恢复并保持 canonical ACK', async () => {
    const sessionId = randomUUID();
    const interactionId = 'ask-pathless-pg-terminal';
    const runId = 'run-pathless-pg-terminal';
    await seedAskUser(sessionId, runId, interactionId);
    const runStore = new MemoryRunStore();
    await createRun(runStore, runId, sessionId);
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
    const channel = channelFor({ runStore, sessionId, scheduler: { enqueue, activateCreatedRun } });
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
    const events = await store!.list(TENANT, sessionId);
    expect(events.filter(event => event.type === 'interaction_resolved')).toHaveLength(1);
  });
});
