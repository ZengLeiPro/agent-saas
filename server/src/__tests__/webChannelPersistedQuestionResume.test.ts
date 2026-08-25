import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { WebChannel } from '../channels/web/channel.js';
import { getTranscriptPath } from '../data/transcripts/index.js';
import { writeSessionMeta } from '../data/transcripts/meta.js';
import { AGENT_LEGACY_TRANSCRIPTS_ROOT } from '../data/transcripts/projectKey.js';
import { createExecutionConfig } from '../runtime/executionConfig.js';
import { FileEventStore, getRuntimeEventLogPath } from '../runtime/fileEventStore.js';
import { wakeRuntimeSession } from '../runtime/rawRuntimeRunDispatch.js';
import type { UpsertRunInput } from '../runtime/runStore.js';
import { FileSessionCatalog } from '../runtime/sessionCatalog.js';
import { InMemoryToolInvocationStore } from '../runtime/toolInvocationStore.js';
import type { ModelAdapter, ModelEvent, ModelRequest, RunContext } from '../runtime/types.js';
import { FakeWebSocket, MemoryRunStore, wsClient } from './webChannelTestHelpers.js';

const TAG = randomUUID().slice(0, 8);
const TENANT = `question-resume-${TAG}`;
const USER = { sub: `user-${TAG}`, username: `user_${TAG}`, role: 'user' as const, tenantId: TENANT };
const SHARED_DIR = resolve(process.cwd(), '../workspace-shared');

class WaitThenTextAdapter implements ModelAdapter {
  calls = 0;

  async *stream(_request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    this.calls += 1;
    if (this.calls === 1) {
      yield {
        type: 'completed',
        content: '',
        toolCalls: [{
          id: 'call-wait-after-resume',
          name: 'WaitForWorkspaceReady',
          arguments: JSON.stringify({ timeoutMs: 0 }),
        }],
      };
      return;
    }
    yield { type: 'text_delta', content: '恢复完成' };
    yield { type: 'completed', content: '恢复完成', toolCalls: [] };
  }
}

async function seedQuestion(cwd: string) {
  const sessionId = randomUUID();
  const transcriptPath = getTranscriptPath('/unused-cwd', sessionId, { tenantId: TENANT, userId: USER.sub });
  await writeSessionMeta(transcriptPath, {
    userId: USER.sub,
    username: USER.username,
    tenantId: TENANT,
    channel: 'web',
    createdAt: new Date().toISOString(),
    cwd,
    transcriptPath,
    model: 'm-ask',
    executionTarget: 'server-local',
    workspaceId: 'ws-ask',
  });
  const eventStore = new FileEventStore(getRuntimeEventLogPath(transcriptPath), TENANT);
  await eventStore.append({
    type: 'assistant_tool_calls',
    sessionId,
    runId: 'run-ask-terminal',
    content: '',
    toolCalls: [{
      id: 'call-ask-terminal',
      name: 'AskUserQuestion',
      arguments: JSON.stringify({
        questions: [{
          question: '继续吗?',
          header: '确认',
          options: [{ label: '继续', description: '' }],
          multiSelect: false,
        }],
      }),
    }],
  }, { tenantId: TENANT });
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
    const { sessionId, eventStore } = await seedQuestion(tmp);
    const sessionCatalog = new FileSessionCatalog({ agentCwd: tmp });
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
        sessionCatalog,
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

    const replacementRunId = enqueued[0]!.runId;
    const adapter = new WaitThenTextAdapter();
    const toolInvocationStore = new InMemoryToolInvocationStore();
    const outbound: unknown[] = [];
    const wakeConfig = {
      agentCwd: tmp,
      sharedDir: SHARED_DIR,
      memory: { enabled: false },
      sessionCatalog,
      eventStoreFactory: () => eventStore,
      runStore,
      toolInvocationStore,
      resolveUserAutoApproveTools: () => true,
      modelResolver: () => ({
        model: 'gpt-5.5',
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      }),
      modelAdapterFactory: () => adapter,
    };
    const wake = async () => {
      const run = await runStore.get(replacementRunId);
      expect(run).not.toBeNull();
      await wakeRuntimeSession(wakeConfig, run!, {
        lease: {
          runId: replacementRunId,
          workerId: 'worker-question-resume',
          renew: async () => {},
          release: async (status, reason) => {
            if (status) await runStore.markStatus(replacementRunId, status, reason);
          },
        },
        onOutboundEvent: (event) => { outbound.push(event); },
      });
    };

    await wake();
    await expect(toolInvocationStore.get(`${replacementRunId}:call-wait-after-resume`))
      .resolves.toMatchObject({ runId: replacementRunId, status: 'running' });
    await wake();
    const resumedInvocation = await toolInvocationStore.get(`${replacementRunId}:call-wait-after-resume`);
    expect(resumedInvocation).toMatchObject({ runId: replacementRunId });
    expect(resumedInvocation?.status).not.toBe('failed');
    expect(adapter.calls).toBe(2);
    expect(outbound).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'error', error: expect.stringContaining('run_terminal') }),
    ]));
    expect((await runStore.get(replacementRunId))?.status).toBe('completed');
    expect((await runStore.get('run-ask-terminal'))?.status).toBe('completed');
    const events = await eventStore.list(TENANT, sessionId);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'assistant_tool_calls', runId: replacementRunId,
        toolCalls: [expect.objectContaining({ id: 'call-wait-after-resume' })],
      }),
      expect.objectContaining({ type: 'run_finished', runId: replacementRunId, subtype: 'success' }),
    ]));
    expect(events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'run_finished', runId: 'run-ask-terminal' }),
    ]));
  });
});
