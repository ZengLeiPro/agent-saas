/** Durable web interaction resume coverage, isolated from the ratcheted coverage file. */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { WebChannel, type WebChannelConfig } from '../channels/web/channel.js';
import type { OutboundEvent } from '../types/index.js';
import { createExecutionConfig } from '../runtime/executionConfig.js';
import { FileSessionCatalog } from '../runtime/sessionCatalog.js';
import { FileEventStore, getRuntimeEventLogPath } from '../runtime/fileEventStore.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { getTranscriptPath } from '../data/transcripts/index.js';
import { AGENT_LEGACY_TRANSCRIPTS_ROOT } from '../data/transcripts/projectKey.js';
import { writeSessionMeta, type SessionMeta } from '../data/transcripts/meta.js';
import { FakeWebSocket, MemoryRunStore, wsClient } from './webChannelTestHelpers.js';

const RUN_TAG = randomUUID().slice(0, 8);
const TENANT = `covpersist${RUN_TAG}`;
const USER = { sub: `cov-persist-user-${RUN_TAG}`, username: `cov_persist_${RUN_TAG}`, role: 'user' as const, tenantId: TENANT };
type TestUser = typeof USER;

async function seedRuntimeSession(
  user: TestUser,
  metaExtra: Partial<SessionMeta> = {},
): Promise<{ sessionId: string; transcriptPath: string; eventStore: FileEventStore }> {
  const sessionId = randomUUID();
  const transcriptPath = getTranscriptPath('/unused-cwd', sessionId, { tenantId: user.tenantId, userId: user.sub });
  await writeSessionMeta(transcriptPath, {
    userId: user.sub,
    username: user.username,
    tenantId: user.tenantId,
    channel: 'web',
    createdAt: new Date().toISOString(),
    ...metaExtra,
  });
  return { sessionId, transcriptPath, eventStore: new FileEventStore(getRuntimeEventLogPath(transcriptPath), user.tenantId) };
}

describe('WebChannel persistent interaction recovery', () => {
  const channels: WebChannel[] = [];
  const dirs: string[] = [];

  interface Rig {
    channel: WebChannel;
    ws: FakeWebSocket;
    userEvents: any[];
  }

  function makeRig(extra: Partial<WebChannelConfig> = {}): Rig {
    const channel = new WebChannel({ executionConfig: createExecutionConfig(), ...extra }, async function* () { yield { type: 'done' as const }; });
    channels.push(channel);
    const ws = new FakeWebSocket();
    const userEvents: any[] = [];
    (channel as any).eventBus = {
      emitReply: (target: any, data: any) => { target?.send?.(JSON.stringify({ data })); },
      emitSession: (ctx: any, data: any) => { ctx?.ws?.send?.(JSON.stringify({ data })); },
      emitUser: (_uid: string, data: any) => { userEvents.push(data); },
      emitDual: (_uid: string, _sid: string, data: any) => { userEvents.push(data); },
    };
    return { channel, ws, userEvents };
  }

  async function makeTmp(prefix: string): Promise<string> {
    const tmp = await mkdtemp(join(tmpdir(), prefix));
    dirs.push(tmp);
    return tmp;
  }

  afterEach(async () => {
    try {
      for (const channel of channels) await channel.stop();
    } finally {
      channels.length = 0;
    }
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  afterAll(async () => {
    await rm(join(AGENT_LEGACY_TRANSCRIPTS_ROOT, TENANT), { recursive: true, force: true });
  });
  describe('持久化交互恢复', () => {
    function resumeRig(runStore: MemoryRunStore, tmp: string, activations: string[], eventStore?: { list: FileEventStore['list']; append: FileEventStore['append'] }): Rig {
      return makeRig({
        agentCwd: tmp,
        runtimeEventStoreFor: (tp) => (eventStore as any) ?? new FileEventStore(getRuntimeEventLogPath(tp), TENANT),
        enqueueRuntime: {
          scheduler: {
            activateCreatedRun: async (runId: string, claim: Record<string, unknown>, metadataPatch?: Record<string, unknown>) => {
              const activated = await runStore.activatePersistedInteractionResume(runId, claim, metadataPatch);
              if (activated) activations.push(runId);
              return activated;
            },
          } as any,
          runStore,
          sessionCatalog: new FileSessionCatalog({ agentCwd: tmp }),
          enabled: true,
        },
      });
    }

    it('ask_user 并发恢复：CAS 只允许一次 event append/enqueue，live claim 拒绝竞争重试', async () => {
      const tmp = await makeTmp('cov-askresume-');
      const { sessionId, eventStore } = await seedRuntimeSession(USER, {
        model: 'm-ask', executionTarget: 'server-local', workspaceId: 'ws-ask',
      });
      await eventStore.append({
        type: 'interaction_requested', sessionId, runId: 'run-ask-1', toolCallId: 'call-ask-1',
        interactionId: 'ask-int-1', interactionType: 'ask_user', userId: USER.sub,
        questions: [{ question: '选哪个颜色?', header: '颜色', options: [{ label: '红', description: '' }], multiSelect: false }],
      }, { tenantId: TENANT });
      const runStore = new MemoryRunStore();
      await runStore.upsertPending({ runId: 'run-ask-1', sessionId, userId: USER.sub, model: 'm-ask', channel: 'web' });
      await runStore.markStatus('run-ask-1', 'waiting_user');
      const claimSpy = vi.spyOn(runStore, 'claimPersistedInteractionResume');
      const activations: string[] = [];
      const rig = resumeRig(runStore, tmp, activations);

      await Promise.all([
        (rig.channel as any).resolveInteraction(wsClient(rig.ws, USER), 'ask-int-1', { answers: { q1: '红色' } }, sessionId, 'attempt-persisted-1'),
        (rig.channel as any).resolveInteraction(wsClient(rig.ws, USER), 'ask-int-1', { answers: { q1: '红色' } }, sessionId, 'attempt-persisted-2'),
      ]);

      const askReplies = rig.ws.sent.map((message) => message.data);
      // 同连接的处理可串行化，第二次在 event 已落盘后收到幂等 ACK；不可重复的是 durable 副作用。
      expect(askReplies).toHaveLength(2);
      expect(askReplies.every((reply) => reply.type === 'respond_ok' || reply.type === 'respond_error')).toBe(true);
      expect(activations).toEqual(['run-ask-1']);
      // durable 日志追加 interaction_resolved（归一化应答）
      const events = await eventStore.list(TENANT, sessionId);
      expect(events.at(-1)).toMatchObject({
        type: 'interaction_resolved', interactionId: 'ask-int-1', interactionType: 'ask_user',
        runId: 'run-ask-1', toolCallId: 'call-ask-1', userId: USER.sub,
        response: { answers: { q1: '红色' } },
      });
      expect(events.filter((event) => event.type === 'interaction_resolved' && event.interactionId === 'ask-int-1')).toHaveLength(1);
      // waiting_user → pending + staged is the durable cross-process claim.
      expect(claimSpy).toHaveBeenCalledWith('run-ask-1', ['waiting_user'], 'ask_user_resolved_enqueue_resume', expect.objectContaining({
        persistedInteractionResumeClaim: expect.objectContaining({
          sessionId, interactionId: 'ask-int-1', interactionType: 'ask_user', claimId: expect.any(String), claimedAt: expect.any(String),
        }),
        resumeInteraction: { interactionId: 'ask-int-1', response: { answers: { q1: '红色' } } },
      }));
      expect((await runStore.get('run-ask-1'))?.metadata?.resumeInteraction).toEqual({
        interactionId: 'ask-int-1', response: { answers: { q1: '红色' } },
      });
      expect(rig.userEvents).toContainEqual({ type: 'interaction_resolved', sessionId, interactionId: 'ask-int-1', response: { answers: { q1: '红色' } } });
      expect(rig.userEvents).toContainEqual({ type: 'session_status', sessionId, status: 'queued', runId: 'run-ask-1' });
    });

    it('approval 并发恢复：CAS 只允许一次 event append/enqueue，live claim 拒绝竞争重试', async () => {
      const tmp = await makeTmp('cov-apprresume-');
      const { sessionId, eventStore } = await seedRuntimeSession(USER, {
        model: 'm-appr', executionTarget: 'server-local', workspaceId: 'ws-appr',
      });
      await eventStore.append({
        type: 'assistant_tool_calls', sessionId, runId: 'run-appr-1', content: '',
        toolCalls: [{ id: 'call-appr-1', name: 'Shell', arguments: '{"command":"ls"}' }],
      } as any, { tenantId: TENANT });
      await eventStore.append({
        type: 'approval_requested', sessionId, runId: 'run-appr-1', approvalId: 'appr-1',
        toolCallId: 'call-appr-1', toolId: 'Shell', toolName: 'Shell',
        executionTarget: 'server-local', input: { command: 'ls' },
      } as any, { tenantId: TENANT });
      const runStore = new MemoryRunStore();
      await runStore.upsertPending({ runId: 'run-appr-1', sessionId, userId: USER.sub, model: 'm-appr', channel: 'web' });
      await runStore.markStatus('run-appr-1', 'waiting_approval');
      const activations: string[] = [];
      const rig = resumeRig(runStore, tmp, activations);

      await Promise.all([
        (rig.channel as any).resolveInteraction(wsClient(rig.ws, USER), 'appr-1', { allow: true, message: '可以执行' }, sessionId, 'approval-attempt-1'),
        (rig.channel as any).resolveInteraction(wsClient(rig.ws, USER), 'appr-1', { allow: true, message: '可以执行' }, sessionId, 'approval-attempt-2'),
      ]);
      const approvalReplies = rig.ws.sent.map((message) => message.data);
      // 串行化时第二次可观察到已落盘事件并收到幂等 ACK；核心约束是副作用恰好一次。
      expect(approvalReplies).toHaveLength(2);
      expect(approvalReplies.every((reply) => reply.type === 'respond_ok' || reply.type === 'respond_error')).toBe(true);
      expect(activations).toEqual(['run-appr-1']);
      const events = await eventStore.list(TENANT, sessionId);
      expect(events.at(-1)).toMatchObject({
        type: 'interaction_resolved', interactionId: 'appr-1', interactionType: 'approval',
        response: { allow: true, message: '可以执行' },
      });
      expect(events.filter((event) => event.type === 'interaction_resolved' && event.interactionId === 'appr-1')).toHaveLength(1);

      // 第二次 respond：日志里已有 interaction_resolved → 直接 respond_ok，不再入队
      rig.ws.sent.length = 0;
      await (rig.channel as any).resolveInteraction(wsClient(rig.ws, USER), 'appr-1', { allow: true }, sessionId);
      expect(rig.ws.sent.map((m) => m.data.type)).toEqual(['respond_ok']);
      expect(activations).toEqual(['run-appr-1']);
    });

    it('approval 写后抛错时读取 durable resolution、activate 并 ACK', async () => {
      const tmp = await makeTmp('cov-appruncertain-');
      const { sessionId, eventStore } = await seedRuntimeSession(USER, {
        model: 'm-appr', executionTarget: 'server-local', workspaceId: 'ws-appr',
      });
      await eventStore.append({
        type: 'assistant_tool_calls', sessionId, runId: 'run-appr-uncertain', content: '',
        toolCalls: [{ id: 'call-appr-uncertain', name: 'Shell', arguments: '{"command":"ls"}' }],
      } as any, { tenantId: TENANT });
      await eventStore.append({
        type: 'approval_requested', sessionId, runId: 'run-appr-uncertain', approvalId: 'appr-uncertain',
        toolCallId: 'call-appr-uncertain', toolId: 'Shell', toolName: 'Shell', input: { command: 'ls' },
      } as any, { tenantId: TENANT });
      const runStore = new MemoryRunStore();
      await runStore.upsertPending({ runId: 'run-appr-uncertain', sessionId, userId: USER.sub, model: 'm-appr', channel: 'web' });
      await runStore.markStatus('run-appr-uncertain', 'waiting_approval');
      const uncertainStore = {
        list: eventStore.list.bind(eventStore),
        append: vi.fn(async (...args: Parameters<FileEventStore['append']>) => {
          const [event, context] = args;
          await eventStore.append({ ...event, response: { allow: false } } as any, context);
          throw new Error('commit outcome unknown');
        }),
      };
      const activations: string[] = [];
      const rig = resumeRig(runStore, tmp, activations, uncertainStore);

      await (rig.channel as any).resolveInteraction(wsClient(rig.ws, USER), 'appr-uncertain', { allow: true }, sessionId, 'approval-uncertain');
      expect(rig.ws.sent.at(-1)?.data).toEqual({ type: 'respond_ok', interactionId: 'appr-uncertain', clientAttemptId: 'approval-uncertain', response: { allow: false } });
      expect(activations).toEqual(['run-appr-uncertain']);
      const resolved = (await eventStore.list(TENANT, sessionId)).filter((event) => event.type === 'interaction_resolved' && event.interactionId === 'appr-uncertain');
      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({ response: { allow: false } });
      expect(await runStore.get('run-appr-uncertain')).toMatchObject({ status: 'pending', metadata: { schedulerState: 'ready', resumeApproval: { approvalId: 'appr-uncertain', response: { allow: false } } } });
    });

    it('approval 指向终态 run → 拒绝遗留审批并 respond_ok，不恢复旧 run', async () => {
      const tmp = await makeTmp('cov-apprterm-');
      const { sessionId, eventStore } = await seedRuntimeSession(USER, { executionTarget: 'server-local' });
      await eventStore.append({
        type: 'assistant_tool_calls', sessionId, runId: 'run-appr-t', content: '',
        toolCalls: [{ id: 'call-t-1', name: 'Shell', arguments: '{}' }],
      } as any, { tenantId: TENANT });
      await eventStore.append({
        type: 'approval_requested', sessionId, runId: 'run-appr-t', approvalId: 'appr-t-1',
        toolCallId: 'call-t-1', toolId: 'Shell', toolName: 'Shell', input: {},
      } as any, { tenantId: TENANT });
      const runStore = new MemoryRunStore();
      await runStore.upsertPending({ runId: 'run-appr-t', sessionId, userId: USER.sub, model: 'm', channel: 'web' });
      await runStore.markStatus('run-appr-t', 'completed');
      const activations: string[] = [];
      const rig = resumeRig(runStore, tmp, activations);

      await (rig.channel as any).resolveInteraction(wsClient(rig.ws, USER), 'appr-t-1', { allow: true }, sessionId, 'terminal-attempt-1');
      expect(rig.ws.sent.at(-1)?.data).toEqual({
        type: 'respond_ok', interactionId: 'appr-t-1', clientAttemptId: 'terminal-attempt-1', response: { allow: false, message: '源 run 不可恢复（completed），拒绝遗留审批' },
      });
      // Simulate a dropped ACK / disconnected client: recovery must replay the stable deny, not expire.
      rig.ws.sent.length = 0;
      await (rig.channel as any).resolveInteraction(wsClient(rig.ws, USER), 'appr-t-1', { allow: true }, sessionId, 'terminal-attempt-2');
      expect(rig.ws.sent).toHaveLength(1);
      expect(rig.ws.sent[0]?.data).toEqual({
        type: 'respond_ok', interactionId: 'appr-t-1', clientAttemptId: 'terminal-attempt-2', response: { allow: false, message: '源 run 不可恢复（completed），拒绝遗留审批' },
      });
      expect(activations).toHaveLength(0);
      const events = await eventStore.list(TENANT, sessionId);
      const canonical = events.filter((event) => event.type === 'interaction_resolved' && event.interactionId === 'appr-t-1');
      const approvals = events.filter((event) => event.type === 'approval_resolved' && event.approvalId === 'appr-t-1');
      expect(canonical).toEqual([expect.objectContaining({
        id: `interaction_resolved:${sessionId}:appr-t-1`, sessionId, runId: 'run-appr-t', interactionType: 'approval',
        response: { allow: false, message: '源 run 不可恢复（completed），拒绝遗留审批' },
      })]);
      expect(canonical[0]).not.toHaveProperty('clientAttemptId');
      expect(approvals).toEqual([expect.objectContaining({
        sessionId, runId: 'run-appr-t', decision: 'rejected', message: expect.stringContaining('源 run 不可恢复（completed）'),
      })]);
    });

    it('无 enqueueRuntime 时 fail-closed 拒绝持久审批，不调用 legacy resumeApprovalDispatch', async () => {
      const tmp = await makeTmp('cov-apprlegacy-');
      const { sessionId, eventStore } = await seedRuntimeSession(USER, { model: 'm-legacy' });
      await eventStore.append({
        type: 'assistant_tool_calls', sessionId, runId: 'run-appr-l', content: '',
        toolCalls: [{ id: 'call-l-1', name: 'Shell', arguments: '{}' }],
      } as any, { tenantId: TENANT });
      await eventStore.append({
        type: 'approval_requested', sessionId, runId: 'run-appr-l', approvalId: 'appr-l-1',
        toolCallId: 'call-l-1', toolId: 'Shell', toolName: 'Shell', input: {},
      } as any, { tenantId: TENANT });
      const resumeCalls: any[] = [];
      const rig = makeRig({
        agentCwd: tmp,
        runtimeEventStoreFor: (tp) => new FileEventStore(getRuntimeEventLogPath(tp), TENANT),
        resumeApprovalDispatch: ((request: any) => {
          resumeCalls.push(request);
          return (async function* (): AsyncGenerator<OutboundEvent> { yield { type: 'done' }; })();
        }) as any,
      });

      await (rig.channel as any).resolveInteraction(
        wsClient(rig.ws, USER), 'appr-l-1', { allow: false, message: '不允许' }, sessionId, 'no-scheduler-attempt-1',
      );
      expect(rig.ws.sent.at(-1)?.data).toEqual({
        type: 'respond_ok', interactionId: 'appr-l-1', clientAttemptId: 'no-scheduler-attempt-1',
        response: { allow: false, message: '持久审批恢复需要 Runtime Scheduler；已安全拒绝，未恢复旧 Run' },
      });
      // The original ACK is lost; a reconnect uses a new clientAttemptId but receives the canonical deny.
      rig.ws.sent.length = 0;
      await (rig.channel as any).resolveInteraction(
        wsClient(rig.ws, USER), 'appr-l-1', { allow: true }, sessionId, 'no-scheduler-attempt-2',
      );
      expect(rig.ws.sent).toHaveLength(1);
      expect(rig.ws.sent[0]?.data).toEqual({
        type: 'respond_ok', interactionId: 'appr-l-1', clientAttemptId: 'no-scheduler-attempt-2',
        response: { allow: false, message: '持久审批恢复需要 Runtime Scheduler；已安全拒绝，未恢复旧 Run' },
      });
      expect(resumeCalls).toHaveLength(0);
      const events = await eventStore.list(TENANT, sessionId);
      const canonical = events.filter((event) => event.type === 'interaction_resolved' && event.interactionId === 'appr-l-1');
      const approvals = events.filter((event) => event.type === 'approval_resolved' && event.approvalId === 'appr-l-1');
      expect(canonical).toEqual([expect.objectContaining({
        id: `interaction_resolved:${sessionId}:appr-l-1`, sessionId, runId: 'run-appr-l', interactionType: 'approval',
        response: { allow: false, message: '持久审批恢复需要 Runtime Scheduler；已安全拒绝，未恢复旧 Run' },
      })]);
      expect(canonical[0]).not.toHaveProperty('clientAttemptId');
      expect(approvals).toEqual([expect.objectContaining({
        sessionId, runId: 'run-appr-l', decision: 'rejected', message: expect.stringContaining('未恢复旧 Run'),
      })]);
      expect(rig.userEvents).not.toContainEqual(expect.objectContaining({ type: 'session_status', status: 'busy' }));
      expect((rig.channel as any).findActiveStreamIdBySession(sessionId)).toBeUndefined();
    });
  });
});
