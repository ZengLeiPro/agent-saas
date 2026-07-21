import { EventEmitter } from 'node:events';
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

const PLATFORM_ADMIN_USER = { sub: 'admin-1', username: 'admin', role: 'admin' as const, tenantId: DEFAULT_TENANT_ID };

class FakeWebSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent: Array<{ data: any; eventId?: number }> = [];

  send(raw: string): void {
    this.sent.push(JSON.parse(raw));
  }
}

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

function chatMessage(overrides: Record<string, unknown>) {
  return {
    action: 'chat' as const,
    client_msg_id: `msg-${Math.random().toString(16).slice(2)}`,
    message: 'hi',
    ...overrides,
  } as any;
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

  async markStatus(runId: string, status: RunStatus, reason?: string, metadataPatch: Record<string, unknown> = {}): Promise<RunRecord | null> {
    const record = this.records.get(runId);
    if (!record) return null;
    const updated = { ...record, status, statusReason: reason, updatedAt: new Date().toISOString(), metadata: { ...record.metadata, ...metadataPatch } };
    this.records.set(runId, updated);
    return updated;
  }

  async get(runId: string): Promise<RunRecord | null> {
    return this.records.get(runId) ?? null;
  }

  async findByIdempotencyKey(userId: string | undefined, idempotencyKey: string): Promise<RunRecord | null> {
    return [...this.records.values()].find((record) =>
      record.idempotencyKey === idempotencyKey && record.userId === userId,
    ) ?? null;
  }

  async listRecoverable(): Promise<RunRecord[]> {
    return [...this.records.values()].filter((record) => record.status === 'pending');
  }

  async getActiveBySession(sessionId: string): Promise<RunRecord | null> {
    // active = pending / running / waiting_*；与 RunStore.getActiveBySession 语义对齐
    return [...this.records.values()].find((r) =>
      r.sessionId === sessionId
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
        runtimeEventStoreFor: (transcriptPath) => new FileEventStore(getRuntimeEventLogPath(transcriptPath)),
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
    expect(await channel.getStreamStatus('session-failed-1')).toEqual({ active: false });
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
    await runStore.markStatus('run-buffer-gone-1', 'running');

    expect((channel as any).eventBufferStore.isActive('session-buffer-gone-1')).toBe(false);

    const status = await channel.getStreamStatus('session-buffer-gone-1');
    expect(status).toMatchObject({ active: true, runId: 'run-buffer-gone-1' });
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
    expect(await channel.getStreamStatus('session-stale-buffer-1')).toEqual({ active: false });
  });

  it('enqueues web chat into durable runtime instead of directly dispatching when enqueueRuntime is configured', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'web-enqueue-only-'));
    try {
      const runStore = new MemoryRunStore();
      const enqueued: UpsertRunInput[] = [];
      const sessionCatalog = new FileSessionCatalog({ agentCwd: tmp });
      const { channel, calls } = createChannel({
        agentCwd: tmp,
        runtimeEventStoreFor: (transcriptPath) => new FileEventStore(getRuntimeEventLogPath(transcriptPath)),
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
        approvalPolicy: { autoApproveTools: true },
        workflowDemo: {
          runId: '11111111-1111-4111-8111-111111111111',
          eventId: 'event-01',
        },
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
      expect(enqueued[0]?.metadata?.wakeMessage).toMatchObject({
        metadata: {
          workflowDemo: {
            runId: '11111111-1111-4111-8111-111111111111',
            eventId: 'event-01',
          },
        },
      });
      expect(enqueued[0]?.metadata?.approvalPolicy).toEqual({ autoApproveTools: true });
      expect(ws.sent.find((m) => m.data?.type === 'stream_id')?.data).toMatchObject({
        runId: enqueued[0]?.runId,
      });
      expect(ws.sent.some((m) => m.data?.type === 'session')).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('returns an error terminal event when enqueueRuntime fails after ACK', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'web-enqueue-fail-'));
    try {
      const runStore = new MemoryRunStore();
      const sessionCatalog = new FileSessionCatalog({ agentCwd: tmp });
      const { channel, calls } = createChannel({
        agentCwd: tmp,
        runtimeEventStoreFor: (transcriptPath) => new FileEventStore(getRuntimeEventLogPath(transcriptPath)),
        enqueueRuntime: {
          scheduler: {
            enqueue: async () => {
              throw new Error('queue unavailable');
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

      await (channel as any).processChatMessage(client, chatMessage({ message: 'enqueue fail' }));

      expect(calls).toHaveLength(0);
      expect(ws.sent.find((m) => m.data?.type === 'chat_ack')).toBeDefined();
      expect(ws.sent.find((m) => m.data?.type === 'done')?.data?.error).toContain('queue unavailable');
      expect((channel as any).activeStreams.size).toBe(0);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
