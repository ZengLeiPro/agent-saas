import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PgSessionLock } from '../runtime/pgSessionLock.js';

interface LeaseState {
  ownerToken: string;
  expiresAt: number;
}

class FakePool {
  readonly leases = new Map<string, LeaseState>();
  connectCalls = 0;
  clientReleaseCalls = 0;
  advisoryUnlockCalls = 0;
  clientQueries: string[] = [];
  failRenewFor = new Set<string>();

  async connect(): Promise<pg.PoolClient> {
    this.connectCalls += 1;
    const client = {
      query: async <T>(sql: string) => {
        this.clientQueries.push(sql);
        if (sql.includes('pg_try_advisory_lock')) {
          return { rows: [{ acquired: true }] as T[] };
        }
        if (sql.includes('pg_advisory_unlock')) {
          this.advisoryUnlockCalls += 1;
        }
        return { rows: [] as T[] };
      },
      release: () => {
        this.clientReleaseCalls += 1;
      },
    };
    return client as unknown as pg.PoolClient;
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    if (sql.includes('INSERT INTO') && sql.includes('_session_leases')) {
      const [tenantId, sessionId, ownerToken, leaseMs] = params as [string, string, string, number];
      const key = `${tenantId}\0${sessionId}`;
      const now = Date.now();
      const current = this.leases.get(key);
      if (current && current.expiresAt > now) return { rows: [] };
      const expiresAt = now + leaseMs;
      this.leases.set(key, { ownerToken, expiresAt });
      return { rows: [{ tenant_id: tenantId, lease_expires_at: new Date(expiresAt) }] as T[] };
    }

    if (sql.includes('UPDATE') && sql.includes('_session_leases')) {
      const [tenantId, sessionId, ownerToken, leaseMs] = params as [string, string, string, number];
      const key = `${tenantId}\0${sessionId}`;
      const current = this.leases.get(key);
      if (
        this.failRenewFor.has(key)
        || !current
        || current.ownerToken !== ownerToken
        || current.expiresAt <= Date.now()
      ) {
        return { rows: [] };
      }
      const expiresAt = Date.now() + leaseMs;
      this.leases.set(key, { ownerToken, expiresAt });
      return { rows: [{ tenant_id: tenantId, lease_expires_at: new Date(expiresAt) }] as T[] };
    }

    if (sql.includes('DELETE FROM') && sql.includes('_session_leases')) {
      const [tenantId, sessionId, ownerToken] = params as [string, string, string];
      const key = `${tenantId}\0${sessionId}`;
      const current = this.leases.get(key);
      if (current?.ownerToken === ownerToken) this.leases.delete(key);
    }
    return { rows: [] };
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('PgSessionLock', () => {
  it('初始化受 tablePrefix 约束的 durable lease 表且保留 rolling dual 索引', async () => {
    const pool = new FakePool();
    const lock = new PgSessionLock({
      pool: pool as unknown as pg.Pool,
      tablePrefix: 'tenant_runtime',
      mode: 'lease',
    });

    await lock.init();

    expect(pool.clientQueries.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS tenant_runtime_session_leases'))).toBe(true);
    expect(pool.clientQueries.some((sql) => sql.includes('PRIMARY KEY (tenant_id, session_id)'))).toBe(true);
    expect(pool.clientQueries.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS tenant_runtime_tenant_session_leases'))).toBe(true);
    expect(pool.clientQueries.some((sql) => sql.includes('DROP INDEX'))).toBe(false);
    expect(pool.clientQueries.some((sql) => sql.includes("SET LOCAL statement_timeout = '15000ms'"))).toBe(true);
    expect(pool.clientQueries.some((sql) => sql.includes("SET LOCAL lock_timeout = '5000ms'"))).toBe(true);
    expect(pool.clientQueries.some((sql) => sql.includes('pg_advisory_xact_lock(hashtext'))).toBe(true);
    expect(pool.advisoryUnlockCalls).toBe(0);
    expect(pool.clientReleaseCalls).toBe(1);
  });

  it('拒绝会让派生表名超过 PostgreSQL 63 字节上限的 tablePrefix', () => {
    const pool = new FakePool();
    expect(() => new PgSessionLock({
      pool: pool as unknown as pg.Pool,
      tablePrefix: `prefix_${'x'.repeat(35)}`,
    })).toThrow('PG tablePrefix 不能超过 41 字节');
  });

  it('lease 模式下并发会话只做短查询，不占用 pool client', async () => {
    const pool = new FakePool();
    const lock = new PgSessionLock({
      pool: pool as unknown as pg.Pool,
      mode: 'lease',
    });

    const handles = await Promise.all(
      Array.from({ length: 20 }, (_, index) => lock.tryAcquire('tenant-a', `session-${index}`)),
    );

    expect(handles.every(Boolean)).toBe(true);
    expect(pool.connectCalls).toBe(0);
    expect(pool.leases.size).toBe(20);

    await Promise.all(handles.map((handle) => handle?.release()));
    expect(pool.leases.size).toBe(0);
    expect(pool.connectCalls).toBe(0);
  });

  it('同一 session 在租约释放前只有一个 owner', async () => {
    const pool = new FakePool();
    const lock = new PgSessionLock({
      pool: pool as unknown as pg.Pool,
      mode: 'lease',
    });

    const first = await lock.tryAcquire('tenant-a', 'session-one');
    const blocked = await lock.tryAcquire('tenant-a', 'session-one');

    expect(first).not.toBeNull();
    expect(blocked).toBeNull();

    await first?.release();
    const next = await lock.tryAcquire('tenant-a', 'session-one');
    expect(next).not.toBeNull();
    await next?.release();
  });

  it('相同 session 在不同 tenant 可并行持有 lease', async () => {
    const pool = new FakePool();
    const lock = new PgSessionLock({ pool: pool as unknown as pg.Pool, mode: 'lease' });

    const [tenantA, tenantB] = await Promise.all([
      lock.tryAcquire('tenant-a', 'shared-session'),
      lock.tryAcquire('tenant-b', 'shared-session'),
    ]);

    expect(tenantA).not.toBeNull();
    expect(tenantB).not.toBeNull();
    expect(pool.leases.size).toBe(2);
    await Promise.all([tenantA?.release(), tenantB?.release()]);
  });

  it('续约确认 owner 丢失时通知 dispatch abort', async () => {
    vi.useFakeTimers();
    const pool = new FakePool();
    const onLost = vi.fn();
    const lock = new PgSessionLock({
      pool: pool as unknown as pg.Pool,
      mode: 'lease',
      leaseMs: 10_000,
      renewIntervalMs: 1_000,
    });
    const handle = await lock.tryAcquire('tenant-a', 'session-lost', { onLost });
    pool.failRenewFor.add('tenant-a\0session-lost');

    await vi.advanceTimersByTimeAsync(1_000);

    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onLost.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    await handle?.release();
  });

  it('dual 模式同时持旧 advisory lock 和 tenant-native 租约，供两阶段蓝绿迁移', async () => {
    const pool = new FakePool();
    const lock = new PgSessionLock({
      pool: pool as unknown as pg.Pool,
      mode: 'dual',
    });

    const handle = await lock.tryAcquire('tenant-a', 'session-dual');

    expect(handle).not.toBeNull();
    expect(pool.connectCalls).toBe(1);
    expect(pool.leases.has('tenant-a\0session-dual')).toBe(true);

    await handle?.release();
    expect(pool.advisoryUnlockCalls).toBe(1);
    expect(pool.clientReleaseCalls).toBe(1);
    expect(pool.leases.has('tenant-a\0session-dual')).toBe(false);
  });
});
