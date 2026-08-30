import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebChannel, type WebChannelConfig } from '../channels/web/channel.js';
import type { AgentRunDispatch, AgentRunOptions } from '../agent/types.js';
import { createExecutionConfig } from '../runtime/executionConfig.js';
import { FileSessionCatalog } from '../runtime/sessionCatalog.js';
import { FileEventStore, getRuntimeEventLogPath } from '../runtime/fileEventStore.js';
import type { RunRecord, RunStatus, RunStore, UpsertRunInput } from '../runtime/runStore.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { chatMessage, FakeWebSocket } from './webChannelTestHelpers.js';

// Queue/steering projection scenarios live in webChannelExecutionQueueProjection.test.ts.
const PLATFORM_ADMIN_USER = {
  sub: 'admin-1',
  username: 'admin',
  role: 'admin' as const,
  tenantId: DEFAULT_TENANT_ID,
};

interface CapturedCall {
  options?: AgentRunOptions;
}

function createSpyDispatch(): { dispatch: AgentRunDispatch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const dispatch: AgentRunDispatch = async function* (_msg, _ctx, options) {
    calls.push({ options });
    yield { type: 'done' };
  };
  return { dispatch, calls };
}

async function flushMicrotasks(): Promise<void> {
  // processChatMessage 内部有多个 await（idempotency / mkdir 等）
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

class MemoryRunStore implements RunStore {
  records = new Map<string, RunRecord>();

  async upsertPending(input: UpsertRunInput): Promise<RunRecord> {
    const now = new Date().toISOString();
    const record: RunRecord = {
      runId: input.runId,
      sessionId: input.sessionId,
      userId: input.userId,
      tenantId: input.tenantId,
      status: 'pending',
      model: input.model,
      channel: input.channel,
      requestedAt: now,
      updatedAt: now,
      idempotencyKey: input.idempotencyKey,
      executionTarget: input.executionTarget,
      workspaceId: input.workspaceId,
      metadata: input.metadata ?? {},
    };
    this.records.set(input.runId, record);
    return record;
  }

  async markStatus(
    runId: string,
    status: RunStatus,
    reason?: string,
    metadataPatch: Record<string, unknown> = {},
  ): Promise<RunRecord | null> {
    const record = this.records.get(runId);
    if (!record) return null;
    const updated = {
      ...record,
      status,
      statusReason: reason,
      updatedAt: new Date().toISOString(),
      metadata: { ...record.metadata, ...metadataPatch },
    };
    this.records.set(runId, updated);
    return updated;
  }

  async get(runId: string): Promise<RunRecord | null> {
    return this.records.get(runId) ?? null;
  }

  async findByIdempotencyKey(tenantId: string, userId: string | undefined, idempotencyKey: string): Promise<RunRecord | null> {
    return [...this.records.values()].find((record) =>
      record.idempotencyKey === idempotencyKey && (record.tenantId ?? DEFAULT_TENANT_ID) === tenantId && record.userId === userId,
    ) ?? null;
  }

  async listRecoverable(): Promise<RunRecord[]> {
    return [...this.records.values()].filter((record) => record.status === 'pending');
  }

  async getActiveBySession(tenantId: string, sessionId: string): Promise<RunRecord | null> {
    // active = pending / running / waiting_*；与 RunStore.getActiveBySession 语义对齐
    return [...this.records.values()].find((r) =>
      (r.tenantId ?? DEFAULT_TENANT_ID) === tenantId
      && r.sessionId === sessionId
        && (r.status === 'pending' || r.status === 'running'
          || r.status === 'waiting_approval' || r.status === 'waiting_user'
          || r.status === 'waiting_hand'),
    ) ?? null;
  }
}

describe('WebChannel executionTarget gating', () => {
  const channels: WebChannel[] = [];

  afterEach(async () => {
    for (const channel of channels) {
      await channel.stop();
    }
    channels.length = 0;
  });

  function createChannel(extra: Partial<WebChannelConfig> = {}, dispatch?: AgentRunDispatch): {
    channel: WebChannel;
    calls: CapturedCall[];
  } {
    const { dispatch: spyDispatch, calls } = createSpyDispatch();
    const channel = new WebChannel(
      {
        agentCwd: '/tmp/workspace-exec-target-test',
        executionConfig: createExecutionConfig(),
        ...extra,
      },
      dispatch ?? spyDispatch,
    );
    channels.push(channel);
    // 注入最小 eventBus stub：sendChatRejected / sendChatAck / done 推送都走 emitReply，
    // 把 emitReply 路由回 FakeWebSocket.sent，与原生 wsSend 路径行为一致，方便断言。
    (channel as any).eventBus = {
      emitReply: (ws: any, data: any) => {
        if (ws && typeof ws.send === 'function') {
          ws.send(JSON.stringify({ data }));
        }
      },
      emitUser: () => {},
      emitDual: () => {},
      emitSession: (context: any, data: any) => {
        if (context?.ws && typeof context.ws.send === 'function') {
          context.ws.send(JSON.stringify({ data }));
        }
      },
      emit: () => {},
      subscribe: () => () => {},
      register: () => {},
    };
    return { channel, calls };
  }

  it('rejects non-admin users that explicitly select an executionTarget', async () => {
    const { channel } = createChannel();
    const ws = new FakeWebSocket();
    const client = {
      ws: ws as any,
      user: { sub: 'user-1', username: 'alice', role: 'user' as const, tenantId: 'wain-test' },
      alive: true,
      lastActivityAt: Date.now(),
    };

    await (channel as any).processChatMessage(client, chatMessage({ executionTarget: 'server-container' }));

    const rejected = ws.sent.find((m) => m.data?.type === 'chat_rejected');
    expect(rejected?.data).toMatchObject({
      type: 'chat_rejected',
      reason_code: 'access_denied',
      reason: '无权选择 executionTarget',
    });
    // 不应发任何 chat_ack（在策略校验失败前不能 ack）
    expect(ws.sent.find((m) => m.data?.type === 'chat_ack')).toBeUndefined();
  });

  it('rejects unknown executionTarget values before any further processing', async () => {
    const { channel } = createChannel();
    const ws = new FakeWebSocket();
    const client = {
      ws: ws as any,
      user: PLATFORM_ADMIN_USER,
      alive: true,
      lastActivityAt: Date.now(),
    };

    await (channel as any).processChatMessage(client, chatMessage({ executionTarget: 'remote-ecs' }));

    const rejected = ws.sent.find((m) => m.data?.type === 'chat_rejected');
    expect(rejected?.data).toMatchObject({
      type: 'chat_rejected',
      reason_code: 'access_denied',
    });
    expect(rejected?.data?.reason).toContain('remote-ecs');
  });

  it('rejects the unsupported "client" execution target even for admin', async () => {
    const { channel } = createChannel();
    const ws = new FakeWebSocket();
    const client = {
      ws: ws as any,
      user: PLATFORM_ADMIN_USER,
      alive: true,
      lastActivityAt: Date.now(),
    };

    await (channel as any).processChatMessage(client, chatMessage({ executionTarget: 'client' }));

    const rejected = ws.sent.find((m) => m.data?.type === 'chat_rejected');
    expect(rejected?.data).toMatchObject({
      type: 'chat_rejected',
      reason_code: 'access_denied',
    });
    expect(rejected?.data?.reason).toContain('client');
  });

  it('rejects admin override when executionConfig.allowAdminOverride is disabled', async () => {
    const { channel } = createChannel({
      executionConfig: createExecutionConfig({ allowAdminOverride: false }),
    });
    const ws = new FakeWebSocket();
    const client = {
      ws: ws as any,
      user: PLATFORM_ADMIN_USER,
      alive: true,
      lastActivityAt: Date.now(),
    };

    await (channel as any).processChatMessage(client, chatMessage({ executionTarget: 'server-container' }));

    const rejected = ws.sent.find((m) => m.data?.type === 'chat_rejected');
    expect(rejected?.data).toMatchObject({
      type: 'chat_rejected',
      reason_code: 'access_denied',
      reason: '无权选择 executionTarget',
    });
  });

  it('passes platform admin default executionTarget down to the dispatcher (default = server-container)', async () => {
    const { channel, calls } = createChannel();
    const ws = new FakeWebSocket();
    const client = {
      ws: ws as any,
      user: PLATFORM_ADMIN_USER,
      alive: true,
      lastActivityAt: Date.now(),
    };

    await (channel as any).processChatMessage(client, chatMessage({}));
    await flushMicrotasks();

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.options?.executionTarget).toBe('server-container');
  });

  it('defaults non-platform users to server-container without explicit override', async () => {
    const { channel, calls } = createChannel();
    const ws = new FakeWebSocket();
    const client = {
      ws: ws as any,
      user: { sub: 'user-1', username: 'alice', role: 'user' as const, tenantId: 'wain-test' },
      alive: true,
      lastActivityAt: Date.now(),
    };

    await (channel as any).processChatMessage(client, chatMessage({}));
    await flushMicrotasks();

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.options?.executionTarget).toBe('server-container');
  });

  it('enqueues non-platform web chat with server-container as the durable executionTarget', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'web-enqueue-tenant-container-'));
    try {
      const runStore = new MemoryRunStore();
      const enqueued: UpsertRunInput[] = [];
      const sessionCatalog = new FileSessionCatalog({ agentCwd: tmp });
      const { channel } = createChannel({
        agentCwd: tmp,
        runtimeEventStoreFor: (transcriptPath) => new FileEventStore(getRuntimeEventLogPath(transcriptPath), 'wain-test'),
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
      });
      const ws = new FakeWebSocket();
      const client = {
        ws: ws as any,
        user: { sub: 'user-1', username: 'alice', role: 'user' as const, tenantId: 'wain-test' },
        alive: true,
        lastActivityAt: Date.now(),
      };

      await (channel as any).processChatMessage(client, chatMessage({}));
      await flushMicrotasks();

      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]?.executionTarget).toBe('server-container');
      expect(enqueued[0]?.tenantId).toBe('wain-test');
      expect(enqueued[0]?.workspaceId).toBe('ws_wain-test__user-1');
      const sessionId = enqueued[0]?.sessionId;
      expect(sessionId).toBeTruthy();
      const session = sessionId ? await sessionCatalog.get(sessionId) : null;
      expect(session?.executionTarget).toBe('server-container');
      expect(session?.tenantId).toBe('wain-test');
      expect(session?.workspaceId).toBe('ws_wain-test__user-1');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  // 2026-08-04 P2 回归：enqueue 路径对已有会话的每条消息只允许写一条
  // user_message_submitted（带 runId 的权威条）。修复前 processChatMessage 会在
  // enqueue 前再写一条无 runId 的，形成双份 submitted（实证 fc3bf95a seq 75/76 等四对）。
  it('writes exactly one user_message_submitted per message on existing sessions', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'web-enqueue-submitted-'));
    try {
      const runStore = new MemoryRunStore();
      const enqueued: UpsertRunInput[] = [];
      const sessionCatalog = new FileSessionCatalog({ agentCwd: tmp });
      const { channel } = createChannel({
        agentCwd: tmp,
        runtimeEventStoreFor: (transcriptPath) => new FileEventStore(getRuntimeEventLogPath(transcriptPath), 'wain-test'),
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
      });
      const client = {
        ws: new FakeWebSocket() as any,
        user: { sub: 'user-1', username: 'alice', role: 'user' as const, tenantId: 'wain-test' },
        alive: true,
        lastActivityAt: Date.now(),
      };

      await (channel as any).processChatMessage(client, chatMessage({}));
      await flushMicrotasks();
      const sessionId = enqueued[0]?.sessionId as string;
      expect(sessionId).toBeTruthy();

      await (channel as any).processChatMessage(client, chatMessage({ sessionId, message: 'second message' }));
      // appendDurableWebCommand 是 fire-and-forget 且含真实 fs 扫描，等宏任务
      await new Promise((resolve) => setTimeout(resolve, 80));

      const transcriptPath = (enqueued[1]?.metadata as any)?.transcriptPath as string;
      expect(transcriptPath).toBeTruthy();
      const store = new FileEventStore(getRuntimeEventLogPath(transcriptPath), 'wain-test');
      const events = await store.list('wain-test', sessionId);
      const submitted = events.filter((event: any) => (
        event.type === 'user_message_submitted' && event.content === 'second message'
      ));
      expect(submitted).toHaveLength(1);
      expect((submitted[0] as any).runId).toBeTruthy();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('passes admin-selected server-container down to the dispatcher', async () => {
    const { channel, calls } = createChannel();
    const ws = new FakeWebSocket();
    const client = {
      ws: ws as any,
      user: PLATFORM_ADMIN_USER,
      alive: true,
      lastActivityAt: Date.now(),
    };

    await (channel as any).processChatMessage(client, chatMessage({ executionTarget: 'server-container' }));
    await flushMicrotasks();

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.options?.executionTarget).toBe('server-container');
  });

  it('projects durable approval requests to the active socket even for in-process scheduler runs', () => {
    const { channel } = createChannel();
    const ws = new FakeWebSocket();
    const streamId = 'run-approval-1';

    (channel as any).activeStreams.set(streamId, {
      controller: new AbortController(),
      userId: 'admin-1',
      ws: ws as any,
      sessionId: 'session-approval-1',
      runId: 'run-approval-1',
    });
    (channel as any).wsActiveStream.set(ws as any, streamId);
    (channel as any).inProcessOutboundRuns.add('run-approval-1');

    channel.publishRuntimePlatformEvent({
      id: 'event-approval-1',
      timestamp: new Date().toISOString(),
      type: 'approval_requested',
      runId: 'run-approval-1',
      sessionId: 'session-approval-1',
      approvalId: 'approval-1',
      toolCallId: 'call-shell-1',
      toolId: 'Shell',
      toolName: 'Shell',
      displayName: 'Run Shell',
      executionTarget: 'server-local',
      input: { command: 'pwd', timeoutMs: 1000 },
    });

    const request = ws.sent.find((m) => m.data?.type === 'permission_request');
    expect(request?.data).toMatchObject({
      type: 'permission_request',
      interactionId: 'approval-1',
      toolId: 'Shell',
      toolName: 'Shell',
      displayName: 'Run Shell',
      toolInput: { command: 'pwd', timeoutMs: 1000 },
    });
  });

  it('projects durable failed run as done error, clears active stream, and broadcasts failed status', async () => {
    const { channel } = createChannel();
    const ws = new FakeWebSocket();
    const userEvents: any[] = [];
    (channel as any).eventBus.emitUser = (_userId: string, data: any) => {
      userEvents.push(data);
    };

    (channel as any).activeStreams.set('stream-failed-1', {
      controller: new AbortController(),
      userId: 'admin-1',
      ws: ws as any,
      sessionId: 'session-failed-1',
      runId: 'run-failed-1',
      clientMsgId: 'client-msg-1',
    });
    (channel as any).wsActiveStream.set(ws as any, 'stream-failed-1');
    (channel as any).eventBufferStore.create('session-failed-1', 'admin-1');

    channel.publishRuntimePlatformEvent({
      id: 'event-failed-1',
      timestamp: new Date().toISOString(),
      type: 'run_state_changed',
      runId: 'run-failed-1',
      sessionId: 'session-failed-1',
      status: 'failed',
      previousStatus: 'running',
      reason: 'model returned empty turn',
    });

    expect(ws.sent.find((m) => m.data?.type === 'done')?.data).toMatchObject({
      type: 'done',
      client_msg_id: 'client-msg-1',
      error: 'model returned empty turn',
    });
    expect(userEvents.find((e) => e.type === 'session_status')).toMatchObject({
      type: 'session_status',
      sessionId: 'session-failed-1',
      status: 'failed',
      streamId: 'stream-failed-1',
      runId: 'run-failed-1',
      reason: 'model returned empty turn',
    });
    expect((channel as any).activeStreams.has('stream-failed-1')).toBe(false);
    expect(await channel.getStreamStatus(DEFAULT_TENANT_ID, 'session-failed-1')).toEqual({ active: false });
  });

  it('getStreamStatus prefers runStore over EventBuffer (buffer-gone but durable run still active)', async () => {
    const runStore = new MemoryRunStore();
    const { channel } = createChannel({
      enqueueRuntime: {
        scheduler: { wake: async () => null } as any,
        runStore,
        sessionCatalog: new FileSessionCatalog({
          agentCwd: await mkdtemp(join(tmpdir(), 'web-stream-status-buffer-gone-')),
        }),
        enabled: true,
      },
    });

    // 关键场景：EventBuffer 没有这个会话的记录（进程重启 / evict / 从未 create）,
    // 但 PG runStore 里仍有 active run。原实现只看 buffer.isActive 会误报 inactive,
    // 导致前端切回会话时连锁忽略 active_stream 兜底。
    await runStore.upsertPending({
      runId: 'run-buffer-gone-1',
      sessionId: 'session-buffer-gone-1',
      userId: 'admin-1',
      model: 'noop',
      channel: 'web',
      executionTarget: 'server-local',
    });
    await runStore.markStatus('run-buffer-gone-1', 'waiting_user');

    expect((channel as any).eventBufferStore.isActive('session-buffer-gone-1')).toBe(false);

    const status = await channel.getStreamStatus(DEFAULT_TENANT_ID, 'session-buffer-gone-1');
    expect(status).toMatchObject({ active: true, runId: 'run-buffer-gone-1', status: 'waiting_user' });
  });

  it('getStreamStatus reports inactive when runStore says no active run (overrides stale buffer)', async () => {
    const runStore = new MemoryRunStore();
    const { channel } = createChannel({
      enqueueRuntime: {
        scheduler: { wake: async () => null } as any,
        runStore,
        sessionCatalog: new FileSessionCatalog({
          agentCwd: await mkdtemp(join(tmpdir(), 'web-stream-status-stale-buffer-')),
        }),
        enabled: true,
      },
    });

    // 反向场景：buffer 还 active（chat 流尚未 complete）但 runStore 里 run 已 completed。
    // runStore 是 source of truth,active 应判 false（避免前端误显示停止按钮 / loading）。
    (channel as any).eventBufferStore.create('session-stale-buffer-1', 'admin-1');
    await runStore.upsertPending({
      runId: 'run-stale-buffer-1',
      sessionId: 'session-stale-buffer-1',
      userId: 'admin-1',
      model: 'noop',
      channel: 'web',
      executionTarget: 'server-local',
    });
    await runStore.markStatus('run-stale-buffer-1', 'completed');

    expect((channel as any).eventBufferStore.isActive('session-stale-buffer-1')).toBe(true);
    expect(await channel.getStreamStatus(DEFAULT_TENANT_ID, 'session-stale-buffer-1')).toEqual({ active: false });
  });

  it('enqueues web chat into durable runtime instead of directly dispatching when enqueueRuntime is configured', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'web-enqueue-only-'));
    try {
      const runStore = new MemoryRunStore();
      const enqueued: UpsertRunInput[] = [];
      const sessionCatalog = new FileSessionCatalog({ agentCwd: tmp });
      const { channel, calls } = createChannel({
        agentCwd: tmp,
        runtimeEventStoreFor: (transcriptPath) => new FileEventStore(getRuntimeEventLogPath(transcriptPath), PLATFORM_ADMIN_USER.tenantId),
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
      });
      const ws = new FakeWebSocket();
      const client = {
        ws: ws as any,
        user: PLATFORM_ADMIN_USER,
        alive: true,
        lastActivityAt: Date.now(),
      };

      await (channel as any).processChatMessage(client, chatMessage({
        message: 'enqueue me',
        clientCapabilities: ['replaceable_drafts'],
        approvalPolicy: { autoApproveTools: true },
      }));

      expect(calls).toHaveLength(0);
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]).toMatchObject({
        channel: 'web',
        userId: 'admin-1',
        tenantId: DEFAULT_TENANT_ID,
        executionTarget: 'server-container',
      });
      expect(enqueued[0]?.metadata?.wakeMessage).toMatchObject({ content: 'enqueue me' });
      expect(enqueued[0]?.metadata?.approvalPolicy).toEqual({ autoApproveTools: true });
      expect(enqueued[0]?.metadata?.outputTransactionMode).toBe('replaceable_draft');
      expect(enqueued[0]?.metadata?.replaceableDrafts).toBeUndefined();
      expect(ws.sent.find((m) => m.data?.type === 'stream_id')?.data).toMatchObject({
        runId: enqueued[0]?.runId,
      });
      expect(ws.sent.some((m) => m.data?.type === 'session')).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('concurrent duplicate new-session submissions share one session, run, and active stream', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'web-concurrent-new-session-'));
    try {
      const runStore = new MemoryRunStore();
      let lookupCalls = 0;
      let releaseLookups!: () => void;
      const lookupsReady = new Promise<void>((resolve) => { releaseLookups = resolve; });
      runStore.findByIdempotencyKey = async () => {
        lookupCalls += 1;
        if (lookupCalls === 2) releaseLookups();
        await lookupsReady;
        return null;
      };
      const upsertedSessionIds: string[] = [];
      const sessionCatalog = {
        upsert: async (record: { sessionId: string }) => { upsertedSessionIds.push(record.sessionId); },
        ensure: async (record: { sessionId: string }) => { upsertedSessionIds.push(record.sessionId); },
        get: async () => null,
        markStatus: async () => undefined,
        findTranscriptPath: async () => null,
      };
      let acceptedRun: RunRecord | null = null;
      let schedulerCalls = 0;
      const { channel } = createChannel({
        agentCwd: tmp,
        runtimeEventStoreFor: (transcriptPath) => new FileEventStore(getRuntimeEventLogPath(transcriptPath), PLATFORM_ADMIN_USER.tenantId),
        enqueueRuntime: {
          scheduler: {
            enqueue: async (input: UpsertRunInput) => {
              schedulerCalls += 1;
              if (acceptedRun) return acceptedRun;
              const now = new Date().toISOString();
              acceptedRun = {
                runId: input.runId,
                sessionId: input.sessionId,
                userId: input.userId,
                tenantId: input.tenantId,
                status: 'pending',
                requestedAt: now,
                updatedAt: now,
                idempotencyKey: input.idempotencyKey,
                metadata: { ...input.metadata, deliveryMode: 'queue' },
              };
              runStore.records.set(acceptedRun.runId, acceptedRun);
              return acceptedRun;
            },
          } as any,
          runStore,
          sessionCatalog: sessionCatalog as any,
          enabled: true,
        },
      });
      const wsA = new FakeWebSocket();
      const wsB = new FakeWebSocket();
      const message = chatMessage({ message: '只执行一次', client_msg_id: 'same-new-session-client' });

      await Promise.all([
        (channel as any).processChatMessage(
          { ws: wsA as any, user: PLATFORM_ADMIN_USER, alive: true, lastActivityAt: Date.now() },
          message,
        ),
        (channel as any).processChatMessage(
          { ws: wsB as any, user: PLATFORM_ADMIN_USER, alive: true, lastActivityAt: Date.now() },
          message,
        ),
      ]);

      expect(schedulerCalls).toBe(2);
      expect(runStore.records.size).toBe(1);
      expect(new Set(upsertedSessionIds).size).toBe(1);
      expect(acceptedRun).not.toBeNull();
      expect(upsertedSessionIds[0]).toBe(acceptedRun!.sessionId);
      expect((channel as any).activeStreams.size).toBe(1);
      expect([wsA, wsB].flatMap((ws) => ws.sent).filter((event) => event.data?.type === 'chat_ack')).toHaveLength(2);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('defaults a running-session send to durable queue and ACKs only after enqueue commits', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'web-ordinary-queue-'));
    try {
      const runStore = new MemoryRunStore();
      const sessionCatalog = new FileSessionCatalog({ agentCwd: tmp });
      const enqueueCalls: Array<{ input: UpsertRunInput; options: unknown }> = [];
      const ws = new FakeWebSocket();
      const { channel } = createChannel({
        agentCwd: tmp,
        runtimeEventStoreFor: (transcriptPath) => new FileEventStore(getRuntimeEventLogPath(transcriptPath), PLATFORM_ADMIN_USER.tenantId),
        enqueueRuntime: {
          scheduler: {
            enqueue: async (input: UpsertRunInput, options: unknown) => {
              enqueueCalls.push({ input, options });
              expect(ws.sent.some((message) => message.data?.type === 'chat_ack')).toBe(false);
              const now = new Date().toISOString();
              return {
                runId: input.runId,
                sessionId: input.sessionId,
                userId: input.userId,
                tenantId: input.tenantId,
                status: 'pending',
                requestedAt: now,
                updatedAt: now,
                metadata: { ...input.metadata, deliveryMode: 'queue', queuedBehindRunId: 'active-run' },
              } as RunRecord;
            },
          } as any,
          runStore,
          sessionCatalog,
          enabled: true,
        },
      });
      const client = { ws: ws as any, user: PLATFORM_ADMIN_USER, alive: true, lastActivityAt: Date.now() };
      (channel as any).wsActiveStream.set(ws as any, 'active-stream');

      await (channel as any).processChatMessage(client, chatMessage({
        sessionId: 'session-ordinary-queue',
        message: '下一项普通任务',
        client_msg_id: 'ordinary-client',
      }));
      expect(enqueueCalls).toHaveLength(1);

      expect(enqueueCalls[0]?.options).toEqual({ deliveryMode: 'queue' });
      expect(ws.sent.find((message) => message.data?.type === 'chat_ack')?.data).toMatchObject({
        client_msg_id: 'ordinary-client', status: 'queued', deliveryMode: 'queue',
      });
      expect(ws.sent.find((message) => message.data?.type === 'stream_id')?.data).toMatchObject({
        queued: true, deliveryMode: 'queue', targetRunId: 'active-run',
      });
      expect((channel as any).wsActiveStream.get(ws as any)).toBe('active-stream');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('duplicate ACK follows queued run current status and does not regress running to queued', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'web-duplicate-authority-'));
    try {
      const runStore = new MemoryRunStore();
      await runStore.upsertPending({
        runId: 'active-run',
        sessionId: 'session-duplicate-authority',
        userId: PLATFORM_ADMIN_USER.sub,
        model: 'anthropic/claude-sonnet-4',
        channel: 'web',
      });
      await runStore.markStatus('active-run', 'running');
      const sessionCatalog = new FileSessionCatalog({ agentCwd: tmp });
      let enqueueCalls = 0;
      const { channel } = createChannel({
        agentCwd: tmp,
        runtimeEventStoreFor: (transcriptPath) => new FileEventStore(getRuntimeEventLogPath(transcriptPath), PLATFORM_ADMIN_USER.tenantId),
        enqueueRuntime: {
          scheduler: {
            enqueue: async (input: UpsertRunInput, options: { deliveryMode: 'queue' | 'steer' }) => {
              enqueueCalls += 1;
              return runStore.upsertPending({
                ...input,
                metadata: {
                  ...input.metadata,
                  deliveryMode: options.deliveryMode,
                  queuedBehindRunId: 'active-run',
                },
              });
            },
          } as any,
          runStore,
          sessionCatalog,
          enabled: true,
        },
      });
      const ws = new FakeWebSocket();
      const client = { ws: ws as any, user: PLATFORM_ADMIN_USER, alive: true, lastActivityAt: Date.now() };
      const message = chatMessage({
        sessionId: 'session-duplicate-authority',
        message: '只执行一次',
        client_msg_id: 'duplicate-authority-client',
      });

      await (channel as any).processChatMessage(client, message);
      const firstAck = ws.sent.find((event) => event.data?.type === 'chat_ack')?.data;
      expect(firstAck).toMatchObject({ status: 'queued' });
      const queuedRunId = firstAck?.runId as string;
      const activeStreamCount = (channel as any).activeStreams.size;
      await runStore.markStatus('active-run', 'completed');
      await runStore.markStatus(queuedRunId, 'running');

      ws.sent.length = 0;
      await (channel as any).processChatMessage(client, message);

      expect(enqueueCalls).toBe(1);
      expect((channel as any).activeStreams.size).toBe(activeStreamCount);
      expect(ws.sent.find((event) => event.data?.type === 'chat_ack')?.data).toMatchObject({
        runId: queuedRunId,
        status: 'running',
      });
      expect(ws.sent.find((event) => event.data?.type === 'stream_id')?.data).not.toHaveProperty('queued');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

});
