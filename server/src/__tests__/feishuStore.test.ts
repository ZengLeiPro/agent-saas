import { describe, expect, it, vi } from 'vitest';

import { PgFeishuConnectionStore } from '../feishu/store.js';

const IDENTITY = { tenantId: 'tenant-a', userId: 'user-a', username: 'alice' };

describe('PgFeishuConnectionStore broker lifecycle', () => {
  it('用 PostgreSQL advisory transaction lock 串行化 refresh', async () => {
    const query = vi.fn(async (..._args: unknown[]) => ({ rows: [], rowCount: 1 }));
    const release = vi.fn();
    const pool = { connect: vi.fn(async () => ({ query, release })) } as any;
    const store = new PgFeishuConnectionStore({ pool, tablePrefix: 'test' });
    const run = vi.fn(async () => 'fresh-token');

    await expect(store.withBrokerRefreshLock(IDENTITY, 'kaiyan-agent', run)).resolves.toBe('fresh-token');
    expect(query.mock.calls.map(call => String(call[0]))).toEqual([
      'BEGIN',
      "SET LOCAL statement_timeout = '30000ms'",
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      'COMMIT',
    ]);
    expect(query.mock.calls[2]?.[1]).toEqual(['feishu-refresh:tenant-a:user-a:kaiyan-agent']);
    expect(run).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it('refresh 回调失败时回滚并释放 advisory lock', async () => {
    const query = vi.fn(async (..._args: unknown[]) => ({ rows: [], rowCount: 1 }));
    const release = vi.fn();
    const store = new PgFeishuConnectionStore({
      pool: { connect: vi.fn(async () => ({ query, release })) } as any,
      tablePrefix: 'test',
    });

    await expect(store.withBrokerRefreshLock(IDENTITY, 'kaiyan-agent', async () => {
      throw new Error('refresh failed');
    })).rejects.toThrow('refresh failed');
    expect(query.mock.calls.map(call => String(call[0]))).toContain('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
  });

  it('provider 与 Vault 撤销状态分别持久化', async () => {
    const query = vi.fn(async (..._args: unknown[]) => ({ rows: [], rowCount: 1 }));
    const store = new PgFeishuConnectionStore({ pool: { query } as any, tablePrefix: 'test' });

    await store.markBrokerProviderRevoked(IDENTITY, 'kaiyan-agent');
    await store.markBrokerRevoked(IDENTITY, 'kaiyan-agent');

    expect(query.mock.calls[0]?.[1]).toEqual(['tenant-a', 'user-a', 'kaiyan-agent', 'provider_revoked']);
    expect(query.mock.calls[1]?.[1]).toEqual(['tenant-a', 'user-a', 'kaiyan-agent', 'revoked']);
  });

  it('只删除仍无 Broker refs 的旧 CLI profile', async () => {
    const query = vi.fn(async (..._args: unknown[]) => ({ rows: [], rowCount: 1 }));
    const store = new PgFeishuConnectionStore({ pool: { query } as any, tablePrefix: 'test' });

    await expect(store.removeLegacyProfile(IDENTITY, 'kaiyan-agent')).resolves.toBe(1);
    expect(String(query.mock.calls[0]?.[0])).toContain('token_secret_ref IS NULL AND broker_secret_id IS NULL');
  });
});
