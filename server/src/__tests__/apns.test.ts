import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';

import type { ApnsPushClient } from '../apns/client.js';
import { ApnsHttp2Client } from '../apns/client.js';
import { ApnsService, normalizeDeviceToken } from '../apns/service.js';
import type { ApnsDeviceInput, ApnsDeviceRecord, PgApnsDeviceStore } from '../apns/store.js';
import { PgApnsDeviceStore as RealPgApnsDeviceStore } from '../apns/store.js';
import type { PushOwner, PushSender } from '../push/sender.js';
import { createPushFanout } from '../push/sender.js';

vi.mock('jsonwebtoken', () => ({
  default: { sign: vi.fn(() => 'provider-jwt') },
}));

class MemoryApnsStore {
  records: ApnsDeviceRecord[] = [];
  deliveries = new Set<string>();

  async list(owner: PushOwner) {
    return this.records.filter(
      (record) => record.tenantId === owner.tenantId && record.userId === owner.userId,
    );
  }

  async save(owner: PushOwner, input: ApnsDeviceInput) {
    const existing = this.records.find((record) => record.token === input.token);
    const record: ApnsDeviceRecord = {
      id: existing?.id ?? `device-${this.records.length + 1}`,
      ...owner,
      token: input.token,
      tokenHash: `hash-${input.token}`,
      environment: input.environment,
      deviceName: input.deviceName,
      appVersion: input.appVersion ?? null,
      createdAt: existing?.createdAt ?? '2026-09-05T00:00:00.000Z',
      updatedAt: '2026-09-05T00:00:00.000Z',
    };
    this.records = this.records.filter((item) => item.token !== input.token);
    this.records.push(record);
    return record;
  }

  async delete(owner: PushOwner, deviceId: string) {
    const before = this.records.length;
    this.records = this.records.filter(
      (record) =>
        !(
          record.id === deviceId &&
          record.tenantId === owner.tenantId &&
          record.userId === owner.userId
        ),
    );
    return this.records.length < before;
  }

  async claimDelivery(owner: PushOwner, expected: ApnsDeviceRecord, eventKey: string) {
    const current = this.records.find((record) => record.id === expected.id);
    if (!current || current.tenantId !== owner.tenantId || current.userId !== owner.userId)
      return null;
    const key = `${expected.id}:${eventKey}`;
    if (this.deliveries.has(key)) return null;
    this.deliveries.add(key);
    return {
      device: current,
      finish: async () => undefined,
      invalidate: async () => {
        this.records = this.records.filter((record) => record.id !== expected.id);
      },
    };
  }
}

const owner = { tenantId: 'tenant-a', userId: 'user-a' };
/** 生成合法 hex 设备令牌；suffix 只能是 hex 字符。 */
const token = (suffix: string) => `${suffix.padEnd(8, '0')}${'ab'.repeat(28)}`;

describe('ApnsService', () => {
  let store: MemoryApnsStore;
  let client: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  let service: ApnsService;

  beforeEach(() => {
    store = new MemoryApnsStore();
    client = { send: vi.fn(async () => ({ ok: true as const })), close: vi.fn() };
    service = new ApnsService(store as unknown as PgApnsDeviceStore, {
      defaultEnvironment: 'production',
      clientFor: () => client as unknown as ApnsPushClient,
    });
  });

  it('按租户和用户隔离，同一事件每台设备只投递一次，payload 不带身份', async () => {
    await service.register(owner, { token: token('e1').toUpperCase(), deviceName: 'iPhone 15' });
    await service.register(owner, {
      token: token('e2'),
      deviceName: 'iPad',
      environment: 'sandbox',
    });
    await service.register(
      { tenantId: 'tenant-b', userId: 'user-b' },
      { token: token('e3'), deviceName: 'x' },
    );

    const listed = await service.list(owner);
    expect(listed).toHaveLength(2);
    expect(listed.map((device) => device.environment).sort()).toEqual(['production', 'sandbox']);
    expect(listed[0]).not.toHaveProperty('token');

    const message = {
      ...owner,
      eventKey: 'cron:job-1:run-1:ok',
      taskName: '日报汇总',
      status: '执行成功',
      url: '/chat/session-1',
    };
    await expect(service.send(message)).resolves.toEqual({
      sent: 2,
      failed: 0,
      skipped: 0,
      deferred: 0,
    });
    await expect(service.send(message)).resolves.toEqual({
      sent: 0,
      failed: 0,
      skipped: 2,
      deferred: 0,
    });
    expect(client.send).toHaveBeenCalledTimes(2);
    expect(client.send.mock.calls[0]![0]).toEqual({
      deviceToken: token('e1'),
      title: '日报汇总',
      body: '执行成功',
      collapseId: 'cron:job-1:run-1:ok',
      url: '/chat/session-1',
    });
  });

  it('410 / BadDeviceToken 自动解绑，其它失败保留设备且不抛给任务', async () => {
    await service.register(owner, { token: token('d0'), deviceName: 'old' });
    await service.register(owner, { token: token('b5'), deviceName: 'flaky' });
    client.send
      .mockResolvedValueOnce({ ok: false, status: 400, reason: 'BadDeviceToken' })
      .mockResolvedValueOnce({ ok: false, status: 500, reason: 'InternalServerError' });

    await expect(
      service.send({
        ...owner,
        eventKey: 'background:bg-1:failed',
        taskName: '后台分析',
        status: '执行失败',
        url: '/chat/s',
      }),
    ).resolves.toEqual({ sent: 0, failed: 2, skipped: 0, deferred: 0 });
    expect((await service.list(owner)).map((device) => device.deviceName)).toEqual(['flaky']);
  });

  it('设备令牌必须是 hex，并统一小写', () => {
    expect(normalizeDeviceToken(` ${token('AB').toUpperCase()} `)).toBe(token('AB').toLowerCase());
    expect(() => normalizeDeviceToken('not-a-token')).toThrow('无效');
    expect(() => normalizeDeviceToken('abc')).toThrow('无效');
  });
});

describe('ApnsHttp2Client', () => {
  function fakeSession(responses: Array<{ status: number; body?: string }>) {
    const requests: Array<{ headers: Record<string, unknown>; payload: string }> = [];
    const session = Object.assign(new EventEmitter(), {
      closed: false,
      destroyed: false,
      close: vi.fn(),
      request: vi.fn((headers: Record<string, unknown>) => {
        const stream = Object.assign(new EventEmitter(), {
          close: vi.fn(),
          end: vi.fn((payload: string) => {
            requests.push({ headers, payload });
            const response = responses.shift() ?? { status: 200 };
            queueMicrotask(() => {
              stream.emit('response', { ':status': response.status });
              if (response.body) stream.emit('data', Buffer.from(response.body));
              stream.emit('end');
            });
          }),
        });
        return stream;
      }),
    });
    return { session, requests };
  }

  it('按 Apple 规范发 HTTP/2 请求：topic / push-type / collapse-id 截断 / bearer', async () => {
    const { session, requests } = fakeSession([{ status: 200 }]);
    const client = new ApnsHttp2Client({
      teamId: 'TEAM',
      keyId: 'KEY',
      privateKey: 'pem',
      bundleId: 'com.agentsaas.mobile',
      environment: 'production',
      connect: vi.fn(() => session) as never,
      now: () => 1_700_000_000_000,
    });

    await expect(
      client.send({
        deviceToken: token('de'),
        title: '任务',
        body: '等待你的确认',
        collapseId: 'x'.repeat(100),
        url: '/chat/s-1',
      }),
    ).resolves.toEqual({ ok: true });
    expect(client.host).toBe('https://api.push.apple.com');
    const [request] = requests;
    expect(request!.headers).toEqual(
      expect.objectContaining({
        ':method': 'POST',
        ':path': `/3/device/${token('de')}`,
        authorization: 'bearer provider-jwt',
        'apns-topic': 'com.agentsaas.mobile',
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-collapse-id': 'x'.repeat(64),
        'apns-expiration': String(1_700_000_000 + 3600),
      }),
    );
    expect(JSON.parse(request!.payload)).toEqual({
      aps: { alert: { title: '任务', body: '等待你的确认' }, sound: 'default' },
      url: '/chat/s-1',
    });
    expect(jwt.sign).toHaveBeenCalledWith({ iss: 'TEAM', iat: 1_700_000_000 }, 'pem', {
      algorithm: 'ES256',
      keyid: 'KEY',
    });
  });

  it('provider token 过期时刷新一次重试；provider token 在 50 分钟内复用', async () => {
    vi.mocked(jwt.sign).mockClear();
    const { session, requests } = fakeSession([
      { status: 403, body: JSON.stringify({ reason: 'ExpiredProviderToken' }) },
      { status: 200 },
      { status: 410, body: JSON.stringify({ reason: 'Unregistered' }) },
    ]);
    let now = 1_700_000_000_000;
    const client = new ApnsHttp2Client({
      teamId: 'TEAM',
      keyId: 'KEY',
      privateKey: 'pem',
      bundleId: 'b',
      environment: 'sandbox',
      connect: vi.fn(() => session) as never,
      now: () => now,
    });
    const request = { deviceToken: token('de'), title: 't', body: 'b', collapseId: 'c', url: '/' };

    await expect(client.send(request)).resolves.toEqual({ ok: true });
    expect(requests).toHaveLength(2);
    expect(jwt.sign).toHaveBeenCalledTimes(2);

    now += 10 * 60 * 1000;
    await expect(client.send(request)).resolves.toEqual({
      ok: false,
      status: 410,
      reason: 'Unregistered',
    });
    expect(jwt.sign).toHaveBeenCalledTimes(2);
    expect(client.host).toBe('https://api.sandbox.push.apple.com');
  });
});

describe('推送扇出', () => {
  const counters = (sent: number) => ({ sent, failed: 0, skipped: 0, deferred: 0 });

  it('汇总各通道计数；单通道抛错不阻断其它通道，全部完成后再抛出', async () => {
    const order: string[] = [];
    const web: PushSender = {
      send: vi.fn(async () => {
        order.push('web');
        return counters(1);
      }),
    };
    const apns: PushSender = {
      send: vi.fn(async () => {
        order.push('apns');
        throw new Error('apns down');
      }),
    };
    const message = { ...owner, eventKey: 'e', taskName: 't', status: 's', url: '/' };

    await expect(createPushFanout([web])!.send(message)).resolves.toEqual(counters(1));
    await expect(
      createPushFanout([
        web,
        { send: async () => ({ sent: 0, failed: 1, skipped: 2, deferred: 3 }) },
      ])!.send(message),
    ).resolves.toEqual({ sent: 1, failed: 1, skipped: 2, deferred: 3 });
    await expect(createPushFanout([apns, web])!.send(message)).rejects.toThrow(
      '1 条推送通道投递失败',
    );
    expect(order.slice(-2).sort()).toEqual(['apns', 'web']);
    expect(createPushFanout([])).toBeUndefined();
  });
});

describe('PgApnsDeviceStore 隔离条件', () => {
  it('查询始终同时携带 tenantId 与 userId，删除在事务内清理投递记录', async () => {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.startsWith('DELETE FROM agent_saas_apns_devices')) return { rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const release = vi.fn();
    const store = new RealPgApnsDeviceStore({
      pool: { query, connect: vi.fn().mockResolvedValue({ query, release }) } as never,
      tablePrefix: 'agent_saas',
    });

    await store.list(owner);
    expect(query.mock.calls[0]![0]).toContain('WHERE tenant_id=$1 AND user_id=$2');
    expect(query.mock.calls[0]![1]).toEqual(['tenant-a', 'user-a']);

    await expect(store.delete(owner, 'device-1')).resolves.toBe(true);
    const statements = query.mock.calls.slice(1).map((call) => String(call[0]));
    expect(statements[0]).toBe('BEGIN');
    expect(statements[1]).toContain('id=$1 AND tenant_id=$2 AND user_id=$3');
    expect(statements[2]).toContain('DELETE FROM agent_saas_apns_deliveries WHERE device_id=$1');
    expect(statements[3]).toBe('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });
});
