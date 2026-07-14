import { describe, expect, it, vi } from 'vitest';
import { CronLeadership, type LeadershipPgClient } from '../runtime/cronLeadership.js';

/**
 * Cron leadership 选主单测（2026-07-15 零停机部署批次）。
 * 用假 PG client 覆盖：单实例假设 / 竞选成功 / 落选轮询接管 /
 * 连接断开丢失 leadership / 自愿 stop 不触发 onLost。
 */

function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface FakeClientController {
  client: LeadershipPgClient;
  setLockAvailable(available: boolean): void;
  emitError(err: Error): void;
  queries: string[];
}

function createFakeClient(initialLockAvailable: boolean): FakeClientController {
  let lockAvailable = initialLockAvailable;
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const queries: string[] = [];
  const client: LeadershipPgClient = {
    connect: async () => {},
    query: async (text: string) => {
      queries.push(text);
      if (text.includes('pg_try_advisory_lock')) {
        return { rows: [{ acquired: lockAvailable }] };
      }
      return { rows: [] };
    },
    end: async () => {},
    on: (event: string, listener: (...args: unknown[]) => void) => {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return client;
    },
  };
  return {
    client,
    setLockAvailable: (available: boolean) => { lockAvailable = available; },
    emitError: (err: Error) => {
      for (const listener of listeners.get('error') ?? []) listener(err);
    },
    queries,
  };
}

describe('CronLeadership', () => {
  it('assumes leadership immediately without a connection string (single-instance dev)', async () => {
    const onAcquired = vi.fn();
    const leadership = new CronLeadership({
      lockName: 'test:cron-leader',
      onAcquired,
      onLost: vi.fn(),
    });
    leadership.start();
    await tick();

    expect(leadership.isLeader()).toBe(true);
    expect(onAcquired).toHaveBeenCalledTimes(1);
    await leadership.stop();
  });

  it('acquires leadership when the advisory lock is free', async () => {
    const fake = createFakeClient(true);
    const onAcquired = vi.fn();
    const leadership = new CronLeadership({
      connectionString: 'postgres://fake',
      lockName: 'test:cron-leader',
      onAcquired,
      onLost: vi.fn(),
      createClient: () => fake.client,
    });
    leadership.start();
    await tick(10);

    expect(leadership.isLeader()).toBe(true);
    expect(onAcquired).toHaveBeenCalledTimes(1);
    expect(fake.queries.some((q) => q.includes('pg_try_advisory_lock'))).toBe(true);
    await leadership.stop();
  });

  it('retries while the lock is held elsewhere and takes over once released', async () => {
    const fake = createFakeClient(false);
    const onAcquired = vi.fn();
    const leadership = new CronLeadership({
      connectionString: 'postgres://fake',
      lockName: 'test:cron-leader',
      onAcquired,
      onLost: vi.fn(),
      retryMs: 20,
      createClient: () => fake.client,
    });
    leadership.start();
    await tick(10);
    expect(leadership.isLeader()).toBe(false);
    expect(onAcquired).not.toHaveBeenCalled();

    // 旧 leader 释放锁（drain 退出）→ 下一个重试周期接管
    fake.setLockAvailable(true);
    await tick(40);

    expect(leadership.isLeader()).toBe(true);
    expect(onAcquired).toHaveBeenCalledTimes(1);
    await leadership.stop();
  });

  it('loses leadership on connection error and calls onLost', async () => {
    const fake = createFakeClient(true);
    const onLost = vi.fn();
    // 重连后的新 client 拿不到锁（模拟其他实例已接管）
    const reconnectFake = createFakeClient(false);
    let created = 0;
    const leadership = new CronLeadership({
      connectionString: 'postgres://fake',
      lockName: 'test:cron-leader',
      onAcquired: vi.fn(),
      onLost,
      retryMs: 20,
      createClient: () => (created++ === 0 ? fake.client : reconnectFake.client),
    });
    leadership.start();
    await tick(10);
    expect(leadership.isLeader()).toBe(true);

    fake.emitError(new Error('connection reset'));
    await tick(10);

    expect(leadership.isLeader()).toBe(false);
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onLost).toHaveBeenCalledWith('connection reset');

    // 重连后继续竞选（此处锁被别人持有 → 保持 follower）
    await tick(40);
    expect(created).toBeGreaterThanOrEqual(2);
    expect(leadership.isLeader()).toBe(false);
    await leadership.stop();
  });

  it('does not call onLost on voluntary stop and releases the lock', async () => {
    const fake = createFakeClient(true);
    const onLost = vi.fn();
    const leadership = new CronLeadership({
      connectionString: 'postgres://fake',
      lockName: 'test:cron-leader',
      onAcquired: vi.fn(),
      onLost,
      createClient: () => fake.client,
    });
    leadership.start();
    await tick(10);
    expect(leadership.isLeader()).toBe(true);

    await leadership.stop();

    expect(leadership.isLeader()).toBe(false);
    expect(onLost).not.toHaveBeenCalled();
    expect(fake.queries.some((q) => q.includes('pg_advisory_unlock'))).toBe(true);
  });
});
