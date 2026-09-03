import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WebChannel } from '../channels/web/channel.js';
import { interactionStore } from '../channels/web/interactionStore.js';
import { UserEventLog } from '../channels/web/userEventLog.js';
import { createExecutionConfig } from '../runtime/executionConfig.js';
import {
  FakeWebSocket,
  flushMicrotasks,
  wsClient,
} from './webChannelTestHelpers.js';

// openai：自动命名（titleGenerator）上游，返回固定标题并记录调用
vi.mock('openai', () => {
  class MockOpenAI {
    constructor(_opts: unknown) {}
    chat = {
      completions: {
        create: async () => ({
          id: 'mock-title',
          choices: [{ message: { content: 'TASK-63 测试标题' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      },
    };
  }
  return { default: MockOpenAI };
});

const USER = { sub: 'task63-user', username: 'task63_user', role: 'user' as const, tenantId: 'task63-tenant' };

interface Rig {
  channel: WebChannel;
  ws: FakeWebSocket;
  userEvents: any[];
  sessionEvents: any[];
}

/**
 * TASK-63：跨进程/后台 run 的 ask_user 实时投递与恢复。
 *
 * 根因：后台 run 的 ask_user 只写 EventBuffer（emitSession 在无 activeEntry 时用
 * dummy ws，不直推），且 web 进程 interactionStore 无该交互条目（interaction 在
 * run 执行进程创建）。前端在 stream_started 触发的 resume 无游标（lastEventId=0
 * 且无 durable cursor）时，回放边界为 buffer 末尾，已入 buffer 的 ask_user 会被
 * 跳过 → 停留在会话页的用户看不到提问表单，必须刷新或切换会话才恢复。修复：
 * pushPendingInteractions 从 EventBuffer 扫描未决的 ask_user/permission_request
 * 作为 interactionStore 的补充恢复来源。
 */
describe('跨进程/后台 run 的 ask_user 实时投递与恢复（TASK-63）', () => {
  const channels: WebChannel[] = [];

  afterEach(async () => {
    for (const channel of channels) await channel.stop();
    channels.length = 0;
  });

  function makeRig(): Rig {
    const channel = new WebChannel(
      { executionConfig: createExecutionConfig() },
      async function* () { yield { type: 'done' as const }; },
    );
    channels.push(channel);
    const ws = new FakeWebSocket();
    const userEvents: any[] = [];
    const sessionEvents: any[] = [];
    (channel as any).eventBus = {
      emitReply: (target: any, data: any) => { target?.send?.(JSON.stringify({ data })); },
      emitSession: (ctx: any, data: any) => { sessionEvents.push(data); ctx?.ws?.send?.(JSON.stringify({ data })); },
      emitUser: (_uid: string, data: any) => { userEvents.push(data); },
      emitDual: (_uid: string, _sid: string, data: any) => { userEvents.push(data); },
    };
    return { channel, ws, userEvents, sessionEvents };
  }

  /** 模拟跨进程 outbound 事件：emitSession 只写 EventBuffer，不直推（无 activeEntry → dummy ws） */
  function installCrossProcessEventBus(rig: Rig): void {
    (rig.channel as any).eventBus = {
      emitSession: (ctx: any, data: any) => {
        rig.sessionEvents.push(data);
        (rig.channel as any).eventBufferStore.create(ctx.sessionId, ctx.userId ?? USER.sub);
        (rig.channel as any).eventBufferStore.push(ctx.sessionId, JSON.stringify(data));
      },
      emitUser: (_uid: string, data: any) => { rig.userEvents.push(data); },
      emitDual: (_uid: string, _sid: string, data: any) => { rig.userEvents.push(data); },
      emitReply: (_ws: any, data: any) => { rig.ws.sent.push({ data }); },
    };
  }

  it('用户在会话页面但 resume 前 ask_user 已入 buffer：resume 应通过 pending_interactions 恢复该提问（TASK-63 复现）', async () => {
    const rig = makeRig();
    const sessionId = randomUUID();
    installCrossProcessEventBus(rig);

    // 后台 run 的 ask_user（跨进程路径：只写 EventBuffer，不直推）
    (rig.channel as any).publishRuntimeOutboundEvent({
      sessionId,
      runId: 'run-ask-live-1',
      userId: USER.sub,
      event: {
        type: 'ask_user',
        interactionId: 'ask-live-1',
        questions: [{
          question: '是否继续?', header: '确认',
          options: [{ label: '继续', description: '继续执行' }],
          multiSelect: false,
        }],
      },
    });

    // 用户 resume（stream_started 触发：lastEventId=0 且无 durable cursor）
    await (rig.channel as any).handleResumeAsync(wsClient(rig.ws, USER), {
      action: 'resume', sessionId, lastEventId: 0, skipReplay: false,
    });
    await flushMicrotasks();

    // 期望：resume 后把已入 buffer 的 ask_user 恢复给前端
    const pending = rig.ws.sent.find((m) => m.data?.type === 'pending_interactions');
    expect(pending).toBeDefined();
    expect(pending!.data.interactions).toContainEqual(expect.objectContaining({
      type: 'ask_user', interactionId: 'ask-live-1',
    }));
  });

  it('durable 扫描期间新建的本地 interaction 会进入最终替换快照', async () => {
    const sessionId = randomUUID();
    let finishScan!: (events: any[]) => void;
    let markScanStarted!: () => void;
    const scanStarted = new Promise<void>((resolve) => { markScanStarted = resolve; });
    const eventStore = {
      list: () => new Promise<any[]>((resolve) => {
        finishScan = resolve;
        markScanStarted();
      }),
    } as any;
    const channel = new WebChannel(
      {
        executionConfig: createExecutionConfig(),
        runtimeEventStoreFor: () => eventStore,
      },
      async function* () { yield { type: 'done' as const }; },
    );
    channels.push(channel);
    const ws = new FakeWebSocket();

    const snapshot = (channel as any).pushPendingInteractions(wsClient(ws, USER), sessionId, USER.tenantId);
    await scanStarted;
    const interactionId = `ask-during-scan-${randomUUID()}`;
    const response = interactionStore.create(interactionId, 'ask_user', {
      sessionId,
      userId: USER.sub,
      questions: [],
    });
    finishScan([]);
    await snapshot;

    expect(ws.sent.find((message) => message.data?.type === 'pending_interactions')?.data.interactions)
      .toContainEqual(expect.objectContaining({ interactionId, type: 'ask_user' }));
    interactionStore.resolve(interactionId, { answers: {} });
    await response;
  });

  it('sync overflow 在 async 返回边界后才终采样 interaction 并同步发送', async () => {
    const sessionId = randomUUID();
    let finishScan!: (events: any[]) => void;
    let markScanStarted!: () => void;
    const scanStarted = new Promise<void>((resolve) => { markScanStarted = resolve; });
    const eventStore = {
      list: () => new Promise<any[]>((resolve) => {
        finishScan = resolve;
        markScanStarted();
      }),
    } as any;
    const channel = new WebChannel(
      {
        executionConfig: createExecutionConfig(),
        runtimeEventStoreFor: () => eventStore,
      },
      async function* () { yield { type: 'done' as const }; },
    );
    channels.push(channel);
    const ws = new FakeWebSocket();
    const log = new UserEventLog('sync-final-sample');
    (channel as any).wsServer = {
      userEventLog: log,
      hasUserEventEpochMismatch: () => true,
      destroy: () => {},
    };

    const sync = (channel as any).runtimeRecovery.handleSync(wsClient(ws, USER), {
      action: 'sync', lastSeq: 0, epoch: 'stale', sessionId,
    });
    await scanStarted;
    finishScan([]);
    let pendingResponse!: Promise<unknown>;
    const interactionId = `ask-after-prepare-${randomUUID()}`;
    queueMicrotask(() => {
      pendingResponse = interactionStore.create(interactionId, 'ask_user', {
        sessionId,
        userId: USER.sub,
        questions: [],
      });
    });
    await sync;

    expect(ws.sent.at(-1)?.data).toMatchObject({
      type: 'sync_overflow',
      recovery: { session: { pendingInteractions: [expect.objectContaining({ interactionId })] } },
    });
    interactionStore.resolve(interactionId, { answers: {} });
    await pendingResponse;
    log.stop();
  });

  it('已 resume 订阅 buffer 的用户：后续写入的 ask_user 通过订阅推送实时到达', async () => {
    const rig = makeRig();
    const sessionId = randomUUID();
    installCrossProcessEventBus(rig);

    // 后台 run 的 session_init 已创建 buffer 并写入首条会话事件（真实时序）
    (rig.channel as any).eventBufferStore.create(sessionId, USER.sub);
    (rig.channel as any).eventBufferStore.push(sessionId, JSON.stringify({ type: 'session', sessionId }));

    // 用户 resume（订阅 buffer，建立 subscribeFrom）
    await (rig.channel as any).handleResumeAsync(wsClient(rig.ws, USER), {
      action: 'resume', sessionId, lastEventId: 0, skipReplay: false,
    });
    await flushMicrotasks();
    const before = rig.ws.sent.length;

    // 后台 run 的 ask_user 之后写入 buffer
    (rig.channel as any).publishRuntimeOutboundEvent({
      sessionId,
      runId: 'run-ask-live-2',
      userId: USER.sub,
      event: {
        type: 'ask_user',
        interactionId: 'ask-live-2',
        questions: [{
          question: '是否提交?', header: '提交',
          options: [{ label: '是', description: '' }, { label: '否', description: '' }],
          multiSelect: false,
        }],
      },
    });

    // 订阅回调同步推送（subscribeFrom 是同步的）
    const after = rig.ws.sent.slice(before);
    expect(after.some((m) => m.data?.type === 'ask_user' && m.data.interactionId === 'ask-live-2')).toBe(true);
  });

  it('web 进程 interactionStore 无跨进程 ask_user 条目时，buffer 扫描为唯一恢复来源', async () => {
    const rig = makeRig();
    const sessionId = randomUUID();
    (rig.channel as any).eventBufferStore.create(sessionId, USER.sub);
    (rig.channel as any).eventBufferStore.push(sessionId, JSON.stringify({
      type: 'ask_user', interactionId: 'ask-buf-only', questions: [],
    }));
    await (rig.channel as any).pushPendingInteractions(wsClient(rig.ws, USER), sessionId);
    const pending = rig.ws.sent.find((m) => m.data?.type === 'pending_interactions');
    expect(pending).toBeDefined();
    expect(pending!.data.interactions).toContainEqual(expect.objectContaining({
      type: 'ask_user', interactionId: 'ask-buf-only',
    }));
  });

  it('durable 已解决的 ask_user 不会从残留 buffer 再次恢复', async () => {
    const sessionId = randomUUID();
    const eventStore = {
      list: async () => [{
        id: 'resolved-1',
        timestamp: '2026-08-19T00:00:00.000Z',
        type: 'interaction_resolved' as const,
        sessionId,
        interactionId: 'ask-resolved',
        interactionType: 'ask_user' as const,
      }],
    } as any;
    const channel = new WebChannel(
      {
        executionConfig: createExecutionConfig(),
        runtimeEventStoreFor: () => eventStore,
      },
      async function* () { yield { type: 'done' as const }; },
    );
    channels.push(channel);
    const ws = new FakeWebSocket();
    (channel as any).eventBufferStore.create(sessionId, USER.sub);
    (channel as any).eventBufferStore.push(sessionId, JSON.stringify({
      type: 'ask_user', interactionId: 'ask-resolved', questions: [],
    }));

    await (channel as any).pushPendingInteractions(wsClient(ws, USER), sessionId);

    expect(ws.sent.some((message) => message.data?.type === 'pending_interactions')).toBe(false);
  });

  it('非本人用户 resume 已完成 buffer：不推送他人 ask_user（安全回归，review CHANGES_REQUESTED）', async () => {
    const rig = makeRig();
    const sessionId = randomUUID();
    const attacker = { sub: 'task63-attacker', username: 'attacker', role: 'user' as const, tenantId: 'task63-tenant' };
    // 他人（USER）已完成 buffer 中残留 ask_user
    (rig.channel as any).eventBufferStore.create(sessionId, USER.sub);
    (rig.channel as any).eventBufferStore.push(sessionId, JSON.stringify({
      type: 'ask_user', interactionId: 'ask-other-user', questions: [{
        question: '机密问题', header: '机密',
        options: [{ label: '选项A', description: '机密选项' }], multiSelect: false,
      }],
    }));
    (rig.channel as any).eventBufferStore.complete(sessionId);

    // 攻击者 resume 该 sessionId
    await (rig.channel as any).handleResumeAsync(wsClient(rig.ws, attacker), {
      action: 'resume', sessionId, lastEventId: 0, skipReplay: false,
    });
    await flushMicrotasks();

    const pending = rig.ws.sent.find((m) => m.data?.type === 'pending_interactions');
    expect(pending).toBeUndefined();
    expect(rig.ws.sent.some((m) => m.data?.type === 'ask_user' && m.data.interactionId === 'ask-other-user')).toBe(false);
  });

  it('admin resume 他人已完成 buffer：仍能推送 pending 交互（归属校验放行 admin）', async () => {
    const rig = makeRig();
    const sessionId = randomUUID();
    const admin = { sub: 'task63-admin', username: 'admin', role: 'admin' as const, tenantId: 'task63-tenant' };
    (rig.channel as any).eventBufferStore.create(sessionId, USER.sub);
    (rig.channel as any).eventBufferStore.push(sessionId, JSON.stringify({
      type: 'ask_user', interactionId: 'ask-admin-visible', questions: [],
    }));
    (rig.channel as any).eventBufferStore.complete(sessionId);

    await (rig.channel as any).handleResumeAsync(wsClient(rig.ws, admin), {
      action: 'resume', sessionId, lastEventId: 0, skipReplay: false,
    });
    await flushMicrotasks();

    const pending = rig.ws.sent.find((m) => m.data?.type === 'pending_interactions');
    expect(pending).toBeDefined();
    expect(pending!.data.interactions).toContainEqual(expect.objectContaining({
      type: 'ask_user', interactionId: 'ask-admin-visible',
    }));
  });
});
