import { beforeEach, describe, expect, it, vi } from 'vitest';
import webPush from 'web-push';

import { createWebPushNotifyChannel } from '../cron/notifyChannels/webPushNotifyChannel.js';
import type { PgSessionProjectionStore } from '../runtime/sessionProjectionStore.js';
import type { PlatformEvent } from '../runtime/types.js';
import { notifyWebPushForRuntimeEvent } from '../webPush/runtimeEventNotifier.js';
import { WebPushService, assertSafePushEndpoint } from '../webPush/service.js';
import { PgWebPushStore, type WebPushOwner, type WebPushSubscriptionInput, type WebPushSubscriptionRecord } from '../webPush/store.js';

vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(),
  },
}));

class MemoryPushStore {
  records: WebPushSubscriptionRecord[] = [];
  deliveries = new Set<string>();

  async list(owner: WebPushOwner) {
    return this.records.filter((record) => record.tenantId === owner.tenantId && record.userId === owner.userId);
  }

  async save(owner: WebPushOwner, input: WebPushSubscriptionInput) {
    const existing = this.records.find((record) => record.endpoint === input.endpoint);
    const record: WebPushSubscriptionRecord = {
      id: existing?.id ?? `subscription-${this.records.length + 1}`,
      ...owner,
      endpoint: input.endpoint,
      endpointHash: `hash-${input.endpoint}`,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      deviceName: input.deviceName,
      createdAt: existing?.createdAt ?? '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z',
    };
    this.records = this.records.filter((item) => item.endpoint !== input.endpoint);
    this.records.push(record);
    return record;
  }

  async delete(owner: WebPushOwner, subscriptionId: string) {
    const before = this.records.length;
    this.records = this.records.filter((record) => !(
      record.id === subscriptionId && record.tenantId === owner.tenantId && record.userId === owner.userId
    ));
    return this.records.length < before;
  }

  async deleteInvalid(subscriptionId: string) {
    this.records = this.records.filter((record) => record.id !== subscriptionId);
  }

  async claimDelivery(owner: WebPushOwner, expected: WebPushSubscriptionRecord, eventKey: string) {
    const current = this.records.find((record) => record.id === expected.id);
    if (!current || current.tenantId !== owner.tenantId || current.userId !== owner.userId) return null;
    const key = `${expected.id}:${eventKey}`;
    if (this.deliveries.has(key)) return null;
    this.deliveries.add(key);
    return {
      subscription: current,
      finish: async () => undefined,
      invalidate: async () => { await this.deleteInvalid(expected.id); },
    };
  }
}

const owner = { tenantId: 'tenant-a', userId: 'user-a' };
const subscription = (suffix: string) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}`,
  keys: { p256dh: `p256dh-${suffix}`, auth: `auth-${suffix}` },
  deviceName: `Chrome · Windows ${suffix}`,
});

let store: MemoryPushStore;
let service: WebPushService;

beforeEach(() => {
  store = new MemoryPushStore();
  service = new WebPushService(store as unknown as PgWebPushStore, {
    publicKey: 'public-key',
    privateKey: 'private-key',
    subject: 'mailto:test@example.com',
  });
  vi.mocked(webPush.sendNotification).mockReset().mockResolvedValue({});
});

describe('WebPushService', () => {
  it('按租户和用户隔离，并对同一事件在每台设备只发送一次', async () => {
    await service.subscribe(owner, subscription('one'));
    await service.subscribe(owner, subscription('two'));
    await service.subscribe({ tenantId: 'tenant-b', userId: 'user-b' }, subscription('three'));

    expect(await service.list(owner)).toHaveLength(2);
    expect(await service.list({ tenantId: 'tenant-a', userId: 'user-b' })).toEqual([]);

    const message = {
      ...owner,
      eventKey: 'cron:job-1:run-1:ok',
      taskName: '日报汇总',
      status: '执行成功',
      url: '/chat/session-1',
    };
    await expect(service.send(message)).resolves.toEqual({ sent: 2, failed: 0, skipped: 0, deferred: 0 });
    await expect(service.send(message)).resolves.toEqual({ sent: 0, failed: 0, skipped: 2, deferred: 0 });
    expect(webPush.sendNotification).toHaveBeenCalledTimes(2);
    const payload = JSON.parse(vi.mocked(webPush.sendNotification).mock.calls[0]![1] as string);
    expect(payload).toEqual(expect.objectContaining({ title: '日报汇总', body: '执行成功', url: '/chat/session-1' }));
    expect(payload).not.toHaveProperty('tenantId');
    expect(payload).not.toHaveProperty('userId');
  });

  it('410 失效订阅自动清理，且失败不抛给任务', async () => {
    await service.subscribe(owner, subscription('gone'));
    vi.mocked(webPush.sendNotification).mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }));

    await expect(service.send({
      ...owner,
      eventKey: 'background:bg-1:failed',
      taskName: '后台分析',
      status: '执行失败',
      url: '/chat/session-1',
    })).resolves.toEqual({ sent: 0, failed: 1, skipped: 0, deferred: 0 });
    expect(await service.list(owner)).toEqual([]);
  });

  it('只接受主流浏览器推送服务的 HTTPS endpoint', () => {
    expect(assertSafePushEndpoint('https://web.push.apple.com/Q/test').hostname).toBe('web.push.apple.com');
    expect(assertSafePushEndpoint('https://jmt17.google.com/fcm/send/test').hostname).toBe('jmt17.google.com');
    expect(() => assertSafePushEndpoint('http://fcm.googleapis.com/x')).toThrow('HTTPS');
    expect(() => assertSafePushEndpoint('https://accounts.google.com/push')).toThrow('不是受支持');
    expect(() => assertSafePushEndpoint('https://127.0.0.1/push')).toThrow('不是受支持');
  });
});

describe('PgWebPushStore 隔离条件', () => {
  it('近期 failed delivery 返回 deferred，而不是与已投递记录一起记为 skipped', async () => {
    const current: WebPushSubscriptionRecord = {
      id: 'sub-1', ...owner, endpoint: subscription('deferred').endpoint, endpointHash: 'hash',
      p256dh: 'p', auth: 'a', deviceName: 'Chrome',
      createdAt: '2026-08-13T00:00:00.000Z', updatedAt: '2026-08-13T00:00:00.000Z',
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM agent_saas_web_push_subscriptions')) return { rows: [{
        id: current.id, tenant_id: current.tenantId, user_id: current.userId, endpoint: current.endpoint,
        endpoint_hash: current.endpointHash, p256dh: current.p256dh, auth: current.auth,
        device_name: current.deviceName, created_at: current.createdAt, updated_at: current.updatedAt,
      }] };
      if (sql.includes('INSERT INTO agent_saas_web_push_deliveries')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT status FROM agent_saas_web_push_deliveries')) return { rows: [{ status: 'failed' }] };
      return { rows: [] };
    });
    const release = vi.fn();
    const pgStore = new PgWebPushStore({
      pool: { connect: vi.fn().mockResolvedValue({ query, release }) } as never,
      tablePrefix: 'agent_saas',
    });

    await expect(pgStore.claimDelivery(owner, current, 'event-1')).resolves.toEqual({ deferred: true });
    expect(release).toHaveBeenCalledOnce();
    // updated_at 必须按毫秒比较：PG 微秒 vs JS 毫秒直接等值永远不等（生产 Web Push 曾因此全部 skipped）。
    expect(String(query.mock.calls[1]![0])).toContain("date_trunc('milliseconds', updated_at)=date_trunc('milliseconds', $5::timestamptz)");
  });

  it('查询和删除始终同时携带 tenantId 与 userId', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 0 });
    const pgStore = new PgWebPushStore({
      pool: { query } as never,
      tablePrefix: 'agent_saas',
    });

    await pgStore.list(owner);
    await pgStore.delete(owner, 'sub-1');

    expect(query.mock.calls[0]![0]).toContain('WHERE tenant_id=$1 AND user_id=$2');
    expect(query.mock.calls[0]![1]).toEqual(['tenant-a', 'user-a']);
    expect(query.mock.calls[1]![0]).toContain('id=$1 AND tenant_id=$2 AND user_id=$3');
    expect(query.mock.calls[1]![1]).toEqual(['sub-1', 'tenant-a', 'user-a']);
  });
});

describe('Web Push 触发链路', () => {
  it('Cron 使用任务 owner 和结果会话，且不携带结果正文', async () => {
    const send = vi.spyOn(service, 'send').mockResolvedValue({ sent: 1, failed: 0, skipped: 0, deferred: 0 });
    const channel = createWebPushNotifyChannel({
      service,
      userStore: { findById: vi.fn().mockReturnValue({ id: 'user-a', tenantId: 'tenant-a' }) } as never,
    });

    await expect(channel.send('敏感结果正文', {
      jobId: 'job-1', jobName: '每日报表', jobOwner: 'user-a', runId: 'run-1', runStatus: 'ok', sessionId: 'session-1',
    })).resolves.toEqual({ ok: true });
    expect(send).toHaveBeenCalledWith({
      tenantId: 'tenant-a', userId: 'user-a', eventKey: 'cron:job-1:run-1:ok',
      taskName: '每日报表', status: '执行成功', url: '/chat/session-1',
    });
  });

  it('后台 Agent 成功/失败按父会话归属发送，后台命令与取消不通知', async () => {
    const send = vi.spyOn(service, 'send').mockResolvedValue({ sent: 1, failed: 0, skipped: 0, deferred: 0 });
    const sessionStore = {
      get: vi.fn().mockResolvedValue({
        sessionId: 'session-1', tenantId: 'tenant-a', userId: 'user-a', title: '父会话', metaJson: {},
      }),
    } as unknown as PgSessionProjectionStore;
    const event = (id: string, agentType: string, status: 'completed' | 'failed' | 'cancelled') => ({
      id, timestamp: '2026-08-13T00:00:00.000Z', type: 'background_task_finished',
      sessionId: 'session-1', runId: 'run-1', taskId: 'bg-1', taskSessionId: 'sub-1',
      toolCallId: 'call-1', agentType, description: '后台调研', status, totalTokens: 1, durationMs: 10,
    }) as PlatformEvent;

    await notifyWebPushForRuntimeEvent(event('event-ok', 'general', 'completed'), { service, sessionStore });
    await notifyWebPushForRuntimeEvent(event('event-failed', 'explore', 'failed'), { service, sessionStore });
    await notifyWebPushForRuntimeEvent(event('event-command', 'command', 'completed'), { service, sessionStore });
    await notifyWebPushForRuntimeEvent(event('event-cancelled', 'general', 'cancelled'), { service, sessionStore });

    expect(send).toHaveBeenNthCalledWith(1, expect.objectContaining({
      eventKey: 'background:bg-1:completed', taskName: '后台调研', status: '执行成功', url: '/chat/session-1',
    }));
    expect(send).toHaveBeenNthCalledWith(2, expect.objectContaining({
      eventKey: 'background:bg-1:failed', taskName: '后台调研', status: '执行失败', url: '/chat/session-1',
    }));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('审批只按 approval_requested 通知一次，忽略同一审批派生的 permission_request', async () => {
    const send = vi.spyOn(service, 'send').mockResolvedValue({ sent: 1, failed: 0, skipped: 0, deferred: 0 });
    const sessionStore = {
      get: vi.fn().mockResolvedValue({
        sessionId: 'session-1', tenantId: 'tenant-a', userId: 'user-a', title: '合同审核', metaJson: {},
      }),
    } as unknown as PgSessionProjectionStore;
    await notifyWebPushForRuntimeEvent({
      id: 'event-approval', timestamp: '2026-08-13T00:00:00.000Z', type: 'approval_requested',
      sessionId: 'session-1', runId: 'run-1', approvalId: 'approval-1', toolCallId: 'call-1',
      toolId: 'Write', toolName: 'Write', input: {},
    }, { service, sessionStore });
    await notifyWebPushForRuntimeEvent({
      id: 'event-permission', timestamp: '2026-08-13T00:00:00.000Z', type: 'interaction_requested',
      sessionId: 'session-1', runId: 'run-1', interactionId: 'permission-1', interactionType: 'permission_request',
      userId: 'user-a',
    }, { service, sessionStore });

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ status: '等待你的确认' }));
  });

  it('审批完成后发送可区分结果的完成态通知并跳回对应会话', async () => {
    const send = vi.spyOn(service, 'send').mockResolvedValue({ sent: 1, failed: 0, skipped: 0, deferred: 0 });
    const sessionStore = {
      get: vi.fn().mockResolvedValue({
        sessionId: 'session-1', tenantId: 'tenant-a', userId: 'user-a', title: '合同审核', metaJson: {},
      }),
    } as unknown as PgSessionProjectionStore;

    await notifyWebPushForRuntimeEvent({
      id: 'event-approved', timestamp: '2026-09-07T04:00:00.000Z', type: 'approval_resolved',
      sessionId: 'session-1', runId: 'run-1', approvalId: 'approval-1', decision: 'approved',
    }, { service, sessionStore });
    await notifyWebPushForRuntimeEvent({
      id: 'event-rejected', timestamp: '2026-09-07T04:01:00.000Z', type: 'approval_resolved',
      sessionId: 'session-1', runId: 'run-1', approvalId: 'approval-2', decision: 'rejected',
    }, { service, sessionStore });

    expect(send).toHaveBeenNthCalledWith(1, expect.objectContaining({
      eventKey: 'runtime:event-approved', status: '确认完成', url: '/chat/session-1',
    }));
    expect(send).toHaveBeenNthCalledWith(2, expect.objectContaining({
      eventKey: 'runtime:event-rejected', status: '确认已拒绝', url: '/chat/session-1',
    }));
  });

  it('等待补充信息按会话投影归属发送，事件用户不一致时拒绝串发', async () => {
    const send = vi.spyOn(service, 'send').mockResolvedValue({ sent: 1, failed: 0, skipped: 0, deferred: 0 });
    const sessionStore = {
      get: vi.fn().mockResolvedValue({
        sessionId: 'session-1', tenantId: 'tenant-a', userId: 'user-a', title: '采购核对', metaJson: {},
      }),
    } as unknown as PgSessionProjectionStore;
    const baseEvent: Extract<PlatformEvent, { type: 'interaction_requested' }> = {
      id: 'event-1', timestamp: '2026-08-13T00:00:00.000Z', type: 'interaction_requested',
      sessionId: 'session-1', runId: 'run-1', interactionId: 'ask-1', interactionType: 'ask_user',
    };

    await notifyWebPushForRuntimeEvent(baseEvent, { service, sessionStore });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a', userId: 'user-a', taskName: 'Agent 任务', status: '等待你补充信息',
    }));

    send.mockClear();
    await notifyWebPushForRuntimeEvent({ ...baseEvent, id: 'event-2', userId: 'other-user' }, { service, sessionStore });
    expect(send).not.toHaveBeenCalled();
  });
});
