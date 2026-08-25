import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { WebChannel } from '../channels/web/channel.js';
import { getTranscriptPath } from '../data/transcripts/index.js';
import { writeSessionMeta } from '../data/transcripts/meta.js';
import { AGENT_LEGACY_TRANSCRIPTS_ROOT } from '../data/transcripts/projectKey.js';
import { createExecutionConfig } from '../runtime/executionConfig.js';
import { FileEventStore, getRuntimeEventLogPath } from '../runtime/fileEventStore.js';
import type { UpsertRunInput } from '../runtime/runStore.js';
import { FileSessionCatalog } from '../runtime/sessionCatalog.js';
import { FakeWebSocket, MemoryRunStore, wsClient } from './webChannelTestHelpers.js';

const TAG = randomUUID().slice(0, 8);
const TENANT = `question-resume-${TAG}`;
const USER = { sub: `user-${TAG}`, username: `user_${TAG}`, role: 'user' as const, tenantId: TENANT };

async function seedQuestion() {
  const sessionId = randomUUID();
  const transcriptPath = getTranscriptPath('/unused-cwd', sessionId, { tenantId: TENANT, userId: USER.sub });
  await writeSessionMeta(transcriptPath, {
    userId: USER.sub,
    username: USER.username,
    tenantId: TENANT,
    channel: 'web',
    createdAt: new Date().toISOString(),
    model: 'm-ask',
    executionTarget: 'server-local',
    workspaceId: 'ws-ask',
  });
  const eventStore = new FileEventStore(getRuntimeEventLogPath(transcriptPath), TENANT);
  await eventStore.append({
    type: 'interaction_requested',
    sessionId,
    runId: 'run-ask-terminal',
    toolCallId: 'call-ask-terminal',
    interactionId: 'ask-terminal',
    interactionType: 'ask_user',
    userId: USER.sub,
    questions: [{
      question: '继续吗?',
      header: '确认',
      options: [{ label: '继续', description: '' }],
      multiSelect: false,
    }],
  }, { tenantId: TENANT });
  return { sessionId, transcriptPath, eventStore };
}

describe('WebChannel 持久化提问恢复', () => {
  const channels: WebChannel[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(channels.splice(0).map((channel) => channel.stop()));
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  afterAll(async () => {
    await rm(join(AGENT_LEGACY_TRANSCRIPTS_ROOT, TENANT), { recursive: true, force: true });
  });

  it('源 run 已终态时新建恢复 run，不再返回 Run unavailable', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'question-resume-terminal-'));
    dirs.push(tmp);
    const { sessionId } = await seedQuestion();
    const runStore = new MemoryRunStore();
    await runStore.upsertPending({
      runId: 'run-ask-terminal',
      sessionId,
      userId: USER.sub,
      tenantId: TENANT,
      model: 'm-ask',
      channel: 'web',
      executionTarget: 'server-local',
      workspaceId: 'ws-ask',
      metadata: { approvalPolicy: { autoApproveTools: true } },
    });
    await runStore.markStatus('run-ask-terminal', 'completed');
    const enqueued: UpsertRunInput[] = [];
    const channel = new WebChannel({
      executionConfig: createExecutionConfig(),
      agentCwd: tmp,
      runtimeEventStoreFor: (path) => new FileEventStore(getRuntimeEventLogPath(path), TENANT),
      enqueueRuntime: {
        scheduler: {
          enqueue: async (input: UpsertRunInput) => {
            enqueued.push(input);
            return runStore.upsertPending(input);
          },
        } as any,
        runStore,
        sessionCatalog: new FileSessionCatalog({ agentCwd: tmp }),
        enabled: true,
      },
    }, async function* () { yield { type: 'done' as const }; });
    channels.push(channel);
    const ws = new FakeWebSocket();
    const userEvents: any[] = [];
    (channel as any).eventBus = {
      emitUser: (_userId: string, data: any) => userEvents.push(data),
    };

    await (channel as any).resolveInteraction(
      wsClient(ws, USER), 'ask-terminal', { answers: { confirm: '继续' } }, sessionId,
    );

    expect(ws.sent.at(-1)?.data).toEqual({ type: 'respond_ok', interactionId: 'ask-terminal' });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      runId: expect.not.stringMatching(/^run-ask-terminal$/),
      sessionId,
      userId: USER.sub,
      tenantId: TENANT,
      model: 'm-ask',
      executionTarget: 'server-local',
      workspaceId: 'ws-ask',
      metadata: {
        approvalPolicy: { autoApproveTools: true },
        resumeInteraction: {
          interactionId: 'ask-terminal',
          response: { answers: { confirm: '继续' } },
        },
      },
    });
    expect((await runStore.get('run-ask-terminal'))?.status).toBe('completed');
    expect(userEvents).toContainEqual({
      type: 'session_status', sessionId, status: 'queued', runId: enqueued[0]!.runId,
    });
  });
});
