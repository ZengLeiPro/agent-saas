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

describe('WebChannel queued execution projection', () => {
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
  it('keeps a durable run pending when post-accept queue projection fails', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'web-post-accept-failure-'));
    try {
      const runStore = new MemoryRunStore();
      (runStore as RunStore).listPendingUserMessagesBySession = async () => {
        throw new Error('snapshot unavailable');
      };
      const sessionCatalog = new FileSessionCatalog({ agentCwd: tmp });
      let acceptedRunId = '';
      const { channel } = createChannel({
        agentCwd: tmp,
        runtimeEventStoreFor: (transcriptPath) => new FileEventStore(getRuntimeEventLogPath(transcriptPath), PLATFORM_ADMIN_USER.tenantId),
        enqueueRuntime: {
          scheduler: {
            enqueue: async (input: UpsertRunInput) => {
              acceptedRunId = input.runId;
              const record = await runStore.upsertPending(input);
              return { ...record, metadata: { ...record.metadata, deliveryMode: 'queue', queuedBehindRunId: 'active-run' } };
            },
          } as any,
          runStore,
          sessionCatalog,
          enabled: true,
        },
      });
      const ws = new FakeWebSocket();
      await (channel as any).processChatMessage(
        { ws: ws as any, user: PLATFORM_ADMIN_USER, alive: true, lastActivityAt: Date.now() },
        chatMessage({ sessionId: 'session-post-accept', message: '不能丢', client_msg_id: 'post-accept-client' }),
      );

      expect(await runStore.get(acceptedRunId)).toMatchObject({ status: 'pending' });
      expect(ws.sent.find((message) => message.data?.type === 'chat_ack')?.data).toMatchObject({
        client_msg_id: 'post-accept-client', status: 'queued', runId: acceptedRunId,
      });
      expect(ws.sent.find((message) => message.data?.type === 'done')).toBeUndefined();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('ACKs a steering message as queued without replacing the current websocket stream', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'web-steering-enqueue-'));
    try {
      const runStore = new MemoryRunStore();
      const sessionCatalog = new FileSessionCatalog({ agentCwd: tmp });
      const enqueueCalls: Array<{ input: UpsertRunInput; options: unknown }> = [];
      const { channel } = createChannel({
        agentCwd: tmp,
        runtimeEventStoreFor: (transcriptPath) => new FileEventStore(getRuntimeEventLogPath(transcriptPath), PLATFORM_ADMIN_USER.tenantId),
        enqueueRuntime: {
          scheduler: {
            enqueue: async (input: UpsertRunInput, options: unknown) => {
              enqueueCalls.push({ input, options });
              return runStore.upsertPending({
                ...input,
                metadata: {
                  ...input.metadata,
                  deliveryMode: 'steer',
                  steeringTargetRunId: 'target-run',
                  steeringState: 'pending',
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
      const client = {
        ws: ws as any,
        user: PLATFORM_ADMIN_USER,
        alive: true,
        lastActivityAt: Date.now(),
      };
      (channel as any).wsActiveStream.set(ws as any, 'target-stream');
      (channel as any).activeStreams.set('target-stream', {
        controller: new AbortController(),
        userId: 'admin-1',
        ws: ws as any,
        sessionId: 'session-steering',
        runId: 'target-run',
        clientMsgId: 'target-client',
      });
      (channel as any).eventBufferStore.create('session-steering', 'admin-1');

      await (channel as any).processChatMessage(client, chatMessage({
        sessionId: 'session-steering',
        message: '运行中的补充条件',
        client_msg_id: 'steering-client',
        deliveryMode: 'steer',
      }));

      expect(enqueueCalls).toHaveLength(1);
      expect(enqueueCalls[0]?.options).toEqual({ deliveryMode: 'steer' });
      expect(ws.sent.find((message) => message.data?.type === 'stream_id')?.data).toMatchObject({
        queued: true,
        targetRunId: 'target-run',
        client_msg_id: 'steering-client',
      });
      expect((channel as any).wsActiveStream.get(ws as any)).toBe('target-stream');
      expect((channel as any).eventBufferStore.isActive('session-steering')).toBe(true);

      // 传输层重发必须继续携带 queued 语义，不能误切断当前目标流。
      await (channel as any).processChatMessage(client, chatMessage({
        sessionId: 'session-steering',
        message: '运行中的补充条件',
        client_msg_id: 'steering-client',
        deliveryMode: 'steer',
      }));
      const steeringAcks = ws.sent.filter((message) => (
        message.data?.type === 'stream_id' && message.data?.client_msg_id === 'steering-client'
      ));
      expect(steeringAcks).toHaveLength(2);
      expect(steeringAcks.every((message) => (
        message.data?.queued === true && message.data?.targetRunId === 'target-run'
      ))).toBe(true);
      expect((channel as any).wsActiveStream.get(ws as any)).toBe('target-stream');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('promotes a queued source stream after the target ends before absorbing it', () => {
    const { channel } = createChannel();
    const ws = new FakeWebSocket();
    const sessionId = 'session-webchannel-fallback-unique';
    const targetStreamId = 'target-stream-webchannel-fallback-unique';
    const sourceStreamId = 'source-stream-webchannel-fallback-unique';
    const targetRunId = 'target-run-webchannel-fallback-unique';
    const sourceRunId = 'source-run-webchannel-fallback-unique';
    const targetClientMsgId = 'target-client-webchannel-fallback-unique';
    const sourceClientMsgId = 'source-client-webchannel-fallback-unique';

    (channel as any).activeStreams.set(targetStreamId, {
      controller: new AbortController(),
      userId: 'admin-1',
      ws: ws as any,
      sessionId,
      runId: targetRunId,
      clientMsgId: targetClientMsgId,
    });
    (channel as any).activeStreams.set(sourceStreamId, {
      controller: new AbortController(),
      userId: 'admin-1',
      ws: ws as any,
      sessionId,
      runId: sourceRunId,
      clientMsgId: sourceClientMsgId,
    });
    (channel as any).wsActiveStream.set(ws as any, targetStreamId);
    (channel as any).wsSessionAffinity.set(ws as any, sessionId);
    (channel as any).eventBufferStore.create(sessionId, 'admin-1');

    channel.publishRuntimeOutboundEvent({
      sessionId,
      runId: targetRunId,
      streamId: targetStreamId,
      userId: 'admin-1',
      clientMsgId: targetClientMsgId,
      event: { type: 'done' },
    });
    expect((channel as any).wsActiveStream.has(ws as any)).toBe(false);

    channel.publishRuntimeOutboundEvent({
      sessionId,
      runId: sourceRunId,
      streamId: sourceStreamId,
      userId: 'admin-1',
      clientMsgId: sourceClientMsgId,
      event: { type: 'session_init', sessionId },
    });

    expect(ws.sent.find((message) => (
      message.data?.type === 'stream_id' && message.data?.runId === sourceRunId
    ))?.data).toMatchObject({
      type: 'stream_id',
      streamId: sourceStreamId,
      runId: sourceRunId,
      client_msg_id: sourceClientMsgId,
    });
    expect((channel as any).wsActiveStream.get(ws as any)).toBe(sourceStreamId);

    channel.publishRuntimeOutboundEvent({
      sessionId,
      runId: sourceRunId,
      streamId: sourceStreamId,
      userId: 'admin-1',
      clientMsgId: sourceClientMsgId,
      event: { type: 'done' },
    });
    expect(ws.sent.find((message) => (
      message.data?.type === 'done' && message.data?.client_msg_id === sourceClientMsgId
    ))).toBeDefined();
    expect((channel as any).activeStreams.has(sourceStreamId)).toBe(false);
  });

  it('promotes a queued source stream from a cross-process runtime event', () => {
    const { channel } = createChannel();
    const ws = new FakeWebSocket();

    (channel as any).activeStreams.set('source-stream-cross', {
      controller: new AbortController(),
      userId: 'admin-1',
      ws: ws as any,
      sessionId: 'session-steering-cross',
      runId: 'source-run-cross',
      clientMsgId: 'source-client-cross',
    });
    (channel as any).wsSessionAffinity.set(ws as any, 'session-steering-cross');

    channel.publishRuntimePlatformEvent({
      id: 'event-source-running',
      timestamp: new Date().toISOString(),
      type: 'run_state_changed',
      runId: 'source-run-cross',
      sessionId: 'session-steering-cross',
      status: 'running',
      previousStatus: 'pending',
    });

    expect(ws.sent.find((message) => message.data?.type === 'stream_id')?.data).toMatchObject({
      type: 'stream_id',
      streamId: 'source-stream-cross',
      sessionId: 'session-steering-cross',
      runId: 'source-run-cross',
      client_msg_id: 'source-client-cross',
    });
    expect((channel as any).wsActiveStream.get(ws as any)).toBe('source-stream-cross');
  });

  it('does not promote a queued source after the socket switches sessions', () => {
    const { channel } = createChannel();
    const ws = new FakeWebSocket();

    (channel as any).activeStreams.set('source-stream-old', {
      controller: new AbortController(),
      userId: 'admin-1',
      ws: ws as any,
      sessionId: 'session-old',
      runId: 'source-run-old',
      clientMsgId: 'source-client-old',
    });
    (channel as any).wsSessionAffinity.set(ws as any, 'session-new');

    channel.publishRuntimeOutboundEvent({
      sessionId: 'session-old',
      runId: 'source-run-old',
      streamId: 'source-stream-old',
      userId: 'admin-1',
      clientMsgId: 'source-client-old',
      event: { type: 'session_init', sessionId: 'session-old' },
    });

    expect(ws.sent.find((message) => message.data?.type === 'stream_id')).toBeUndefined();
    expect((channel as any).wsActiveStream.has(ws as any)).toBe(false);
  });

  it('does not ACK when durable enqueue fails and returns an error terminal event', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'web-enqueue-fail-'));
    try {
      const runStore = new MemoryRunStore();
      const sessionCatalog = new FileSessionCatalog({ agentCwd: tmp });
      const { channel, calls } = createChannel({
        agentCwd: tmp,
        runtimeEventStoreFor: (transcriptPath) => new FileEventStore(getRuntimeEventLogPath(transcriptPath), PLATFORM_ADMIN_USER.tenantId),
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
      expect(ws.sent.find((m) => m.data?.type === 'chat_ack')).toBeUndefined();
      expect(ws.sent.find((m) => m.data?.type === 'done')?.data?.error).toContain('queue unavailable');
      expect((channel as any).activeStreams.size).toBe(0);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('pins a new kaiyan Web session to v2 at enqueue and does not recompute continuation', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'web-memory-policy-pin-'));
    try {
      const runStore = new MemoryRunStore();
      const sessionCatalog = new FileSessionCatalog({ agentCwd: tmp });
      let resolverEnabled = true;
      const { channel } = createChannel({
        agentCwd: tmp,
        memoryWriteDelegationEnabled: () => resolverEnabled,
        runtimeEventStoreFor: transcriptPath => new FileEventStore(getRuntimeEventLogPath(transcriptPath), 'kaiyan'),
        enqueueRuntime: {
          scheduler: { enqueue: async (input: UpsertRunInput) => runStore.upsertPending(input) } as any,
          runStore, sessionCatalog, enabled: true,
        },
      });
      const ws = new FakeWebSocket();
      const client = {
        ws: ws as any,
        user: { ...PLATFORM_ADMIN_USER, tenantId: 'kaiyan' },
        alive: true,
        lastActivityAt: Date.now(),
      };
      await (channel as any).processChatMessage(client, chatMessage({ message: 'first', client_msg_id: 'policy-first' }));
      const firstAck = ws.sent.find(message => message.data?.type === 'chat_ack')?.data;
      expect(firstAck?.sessionId).toBeTruthy();
      await expect(sessionCatalog.get(firstAck.sessionId)).resolves.toMatchObject({ memoryPolicyVersion: 'v2' });
      resolverEnabled = false;
      await (channel as any).processChatMessage(client, chatMessage({
        sessionId: firstAck.sessionId, message: 'continue', client_msg_id: 'policy-continue',
      }));
      await expect(sessionCatalog.get(firstAck.sessionId)).resolves.toMatchObject({ memoryPolicyVersion: 'v2' });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

});
