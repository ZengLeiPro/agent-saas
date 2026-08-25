/** TASK-200 staged interaction lifecycle regression coverage. */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WebChannel, type WebChannelConfig } from '../channels/web/channel.js';
import { createExecutionConfig } from '../runtime/executionConfig.js';
import { FileEventStore, getRuntimeEventLogPath } from '../runtime/fileEventStore.js';
import { FileSessionCatalog } from '../runtime/sessionCatalog.js';
import { RuntimeScheduler } from '../runtime/scheduler.js';
import { getTranscriptPath } from '../data/transcripts/index.js';
import { writeSessionMeta } from '../data/transcripts/meta.js';
import { FakeWebSocket, MemoryRunStore, wsClient } from './webChannelTestHelpers.js';

const TENANT = `staged-${randomUUID().slice(0, 8)}`;
const USER = { sub: 'staged-user', username: 'staged_user', role: 'user' as const, tenantId: TENANT };
const dirs: string[] = [];

async function seed(): Promise<{ sessionId: string; tmp: string; store: FileEventStore }> {
  const tmp = await mkdtemp(join(tmpdir(), 'task-200-staged-'));
  dirs.push(tmp);
  const sessionId = randomUUID();
  const transcriptPath = getTranscriptPath('/unused-cwd', sessionId, { tenantId: TENANT, userId: USER.sub });
  await writeSessionMeta(transcriptPath, {
    userId: USER.sub, username: USER.username, tenantId: TENANT, channel: 'web', createdAt: new Date().toISOString(),
  });
  const store = new FileEventStore(getRuntimeEventLogPath(transcriptPath), TENANT);
  await store.append({
    type: 'interaction_requested', sessionId, runId: 'run-staged', toolCallId: 'call-staged',
    interactionId: 'interaction-staged', interactionType: 'ask_user', userId: USER.sub,
    questions: [{ question: 'continue?', header: 'continue', options: [], multiSelect: false }],
  }, { tenantId: TENANT });
  return { sessionId, tmp, store };
}

function channelRig(
  tmp: string,
  runStore: MemoryRunStore,
  eventStore: { list: FileEventStore['list']; append: FileEventStore['append'] },
  activations: string[],
): { channel: WebChannel; ws: FakeWebSocket } {
  const channel = new WebChannel({
    agentCwd: tmp,
    executionConfig: createExecutionConfig(),
    runtimeEventStoreFor: () => eventStore as any,
    enqueueRuntime: {
      enabled: true,
      runStore,
      sessionCatalog: new FileSessionCatalog({ agentCwd: tmp }),
      scheduler: {
        activateCreatedRun: async (runId: string, claim: Record<string, unknown>) => {
          const activated = await runStore.activatePersistedInteractionResume(runId, claim);
          if (activated) activations.push(runId);
          return activated;
        },
        enqueue: vi.fn(),
      } as any,
    },
  } as WebChannelConfig, async function* () { yield { type: 'done' as const }; });
  return { channel, ws: new FakeWebSocket() };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('TASK-200 staged interaction lifecycle', () => {
  it('scheduler tick between staged CAS and append cannot lease or fail the run', async () => {
    const store = new MemoryRunStore();
    await store.upsertPending({ runId: 'run-tick', sessionId: 'session-tick', userId: USER.sub });
    await store.markStatus('run-tick', 'waiting_user');
    await store.claimPersistedInteractionResume('run-tick', ['waiting_user'], 'claim', {
      persistedInteractionResumeClaim: { sessionId: 'session-tick', interactionId: 'i-tick', interactionType: 'ask_user', claimId: 'claim-tick' },
    });
    const wake = vi.fn();
    const scheduler = new RuntimeScheduler({ runStore: store, eventStore: {} as any, wake, autoWake: false });
    await scheduler.tick();
    expect(await store.listRecoverable()).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
    expect(await store.get('run-tick')).toMatchObject({ status: 'pending', metadata: { schedulerState: 'staged' } });
  });

  it('append exception does not ACK, rolls back, and a retry completes once', async () => {
    const { sessionId, tmp, store } = await seed();
    const runs = new MemoryRunStore();
    await runs.upsertPending({ runId: 'run-staged', sessionId, userId: USER.sub });
    await runs.markStatus('run-staged', 'waiting_user');
    let failAppend = true;
    const eventStore = {
      list: store.list.bind(store),
      append: vi.fn(async (...args: Parameters<FileEventStore['append']>) => {
        if (failAppend) throw new Error('append exploded');
        return store.append(...args);
      }),
    };
    const activations: string[] = [];
    const { channel, ws } = channelRig(tmp, runs, eventStore, activations);

    await (channel as any).resolveInteraction(wsClient(ws, USER), 'interaction-staged', { answers: { q: 'yes' } }, sessionId, 'try-1');
    expect(ws.sent.at(-1)?.data).toMatchObject({ type: 'respond_error' });
    expect(await runs.get('run-staged')).toMatchObject({ status: 'waiting_user', metadata: {} });

    failAppend = false;
    await (channel as any).resolveInteraction(wsClient(ws, USER), 'interaction-staged', { answers: { q: 'yes' } }, sessionId, 'try-2');
    expect(ws.sent.at(-1)?.data).toEqual({ type: 'respond_ok', interactionId: 'interaction-staged', clientAttemptId: 'try-2' });
    expect(activations).toEqual(['run-staged']);
    expect((await store.list(TENANT, sessionId)).filter((event) => event.type === 'interaction_resolved')).toHaveLength(1);
  });

  it('a live staged claim rejects a truly concurrent retry without a second append or activation', async () => {
    const { sessionId, tmp, store } = await seed();
    const runs = new MemoryRunStore();
    await runs.upsertPending({ runId: 'run-staged', sessionId, userId: USER.sub });
    await runs.markStatus('run-staged', 'waiting_user');
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => { releaseAppend = resolve; });
    let appendStarted!: () => void;
    const appendStartedGate = new Promise<void>((resolve) => { appendStarted = resolve; });
    const append = vi.fn(async (...args: Parameters<FileEventStore['append']>) => {
      appendStarted();
      await appendGate;
      return store.append(...args);
    });
    const activations: string[] = [];
    const { channel, ws } = channelRig(tmp, runs, { list: store.list.bind(store), append }, activations);

    const attempts = Promise.all([
      (channel as any).resolveInteraction(wsClient(ws, USER), 'interaction-staged', { answers: { q: 'yes' } }, sessionId, 'concurrent-1'),
      (channel as any).resolveInteraction(wsClient(ws, USER), 'interaction-staged', { answers: { q: 'yes' } }, sessionId, 'concurrent-2'),
    ]);
    await appendStartedGate;
    releaseAppend();
    await attempts;

    const replies = ws.sent.map((message) => message.data);
    // 同连接可能串行化，使第二次在 durable event 已落盘后收到幂等 ACK；无论顺序如何，都不得重复副作用。
    expect(replies).toHaveLength(2);
    expect(replies.every((reply) => reply.type === 'respond_ok' || reply.type === 'respond_error')).toBe(true);
    expect(activations).toEqual(['run-staged']);
    expect((await store.list(TENANT, sessionId)).filter((event) => event.type === 'interaction_resolved')).toHaveLength(1);
  });

  it('a post-durable append error still activates and ACKs exactly once', async () => {
    const { sessionId, tmp, store } = await seed();
    const runs = new MemoryRunStore();
    await runs.upsertPending({ runId: 'run-staged', sessionId, userId: USER.sub });
    await runs.markStatus('run-staged', 'waiting_user');
    const eventStore = {
      list: store.list.bind(store),
      append: vi.fn(async (...args: Parameters<FileEventStore['append']>) => {
        await store.append(...args);
        throw new Error('commit outcome unknown');
      }),
    };
    const activations: string[] = [];
    const { channel, ws } = channelRig(tmp, runs, eventStore, activations);

    await (channel as any).resolveInteraction(wsClient(ws, USER), 'interaction-staged', { answers: { q: 'yes' } }, sessionId, 'uncertain-commit');
    expect(ws.sent.at(-1)?.data).toEqual({ type: 'respond_ok', interactionId: 'interaction-staged', clientAttemptId: 'uncertain-commit' });
    expect(activations).toEqual(['run-staged']);
    expect((await store.list(TENANT, sessionId)).filter((event) => event.type === 'interaction_resolved')).toHaveLength(1);
  });

  it('an expired claimant cannot append a second resolution after a new lease activates', async () => {
    const { sessionId, tmp, store } = await seed();
    const runs = new MemoryRunStore();
    await runs.upsertPending({ runId: 'run-staged', sessionId, userId: USER.sub });
    await runs.markStatus('run-staged', 'waiting_user');
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => { releaseAppend = resolve; });
    let appendStarted!: () => void;
    const appendStartedGate = new Promise<void>((resolve) => { appendStarted = resolve; });
    const oldActivations: string[] = [];
    const old = channelRig(tmp, runs, {
      list: store.list.bind(store),
      append: async (...args: Parameters<FileEventStore['append']>) => {
        appendStarted();
        await appendGate;
        return store.append(...args);
      },
    }, oldActivations);
    const newActivations: string[] = [];
    const replacement = channelRig(tmp, runs, { list: store.list.bind(store), append: store.append.bind(store) }, newActivations);
    vi.useFakeTimers();
    try {
      const oldAttempt = (old.channel as any).resolveInteraction(wsClient(old.ws, USER), 'interaction-staged', { answers: { q: 'old' } }, sessionId, 'old-attempt');
      await appendStartedGate;
      vi.setSystemTime(new Date(Date.now() + 31_000));
      await (replacement.channel as any).resolveInteraction(wsClient(replacement.ws, USER), 'interaction-staged', { answers: { q: 'new' } }, sessionId, 'new-attempt');
      releaseAppend();
      await oldAttempt;
    } finally {
      vi.useRealTimers();
    }
    const resolved = (await store.list(TENANT, sessionId)).filter((event) => event.type === 'interaction_resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ response: { answers: { q: 'new' } } });
    expect(newActivations).toEqual(['run-staged']);
    expect(oldActivations).toEqual([]);
    expect(old.ws.sent.at(-1)?.data).toMatchObject({ type: 'respond_error' });
  });

  it('a staged claim crash before append rolls back, reclaims, and completes', async () => {
    const { sessionId, tmp, store } = await seed();
    const runs = new MemoryRunStore();
    await runs.upsertPending({ runId: 'run-staged', sessionId, userId: USER.sub, metadata: {
      schedulerState: 'staged',
      persistedInteractionResumeClaim: { sessionId, interactionId: 'interaction-staged', interactionType: 'ask_user', claimId: 'lost-claim', claimedAt: new Date(Date.now() - 31_000).toISOString() },
      resumeInteraction: { interactionId: 'interaction-staged', response: { answers: { q: 'lost' } } },
    } });
    const activations: string[] = [];
    const { channel, ws } = channelRig(tmp, runs, { list: store.list.bind(store), append: store.append.bind(store) }, activations);

    await (channel as any).resolveInteraction(wsClient(ws, USER), 'interaction-staged', { answers: { q: 'retry' } }, sessionId);
    expect(ws.sent.at(-1)?.data).toEqual({ type: 'respond_ok', interactionId: 'interaction-staged' });
    expect(activations).toEqual(['run-staged']);
    expect((await store.list(TENANT, sessionId)).filter((event) => event.type === 'interaction_resolved')).toHaveLength(1);
    expect(await runs.get('run-staged')).toMatchObject({ status: 'pending', metadata: { schedulerState: 'ready' } });
  });

  it('a staged claim crash with durable resolution activates without a second append', async () => {
    const { sessionId, tmp, store } = await seed();
    await store.append({
      type: 'interaction_resolved', sessionId, runId: 'run-staged', toolCallId: 'call-staged',
      interactionId: 'interaction-staged', interactionType: 'ask_user', userId: USER.sub, response: { answers: { q: 'yes' } },
    }, { tenantId: TENANT });
    const runs = new MemoryRunStore();
    await runs.upsertPending({ runId: 'run-staged', sessionId, userId: USER.sub, metadata: {
      schedulerState: 'staged',
      persistedInteractionResumeClaim: { sessionId, interactionId: 'interaction-staged', interactionType: 'ask_user', claimId: 'crashed-claim', claimedAt: new Date(Date.now() - 31_000).toISOString() },
    } });
    const activations: string[] = [];
    const { channel, ws } = channelRig(tmp, runs, { list: store.list.bind(store), append: store.append.bind(store) }, activations);

    await (channel as any).resolveInteraction(wsClient(ws, USER), 'interaction-staged', { answers: { q: 'new' } }, sessionId);
    expect(ws.sent.at(-1)?.data).toEqual({ type: 'respond_ok', interactionId: 'interaction-staged' });
    expect(activations).toEqual(['run-staged']);
    expect((await store.list(TENANT, sessionId)).filter((event) => event.type === 'interaction_resolved')).toHaveLength(1);
  });
});
