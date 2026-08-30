import { describe, expect, it, vi } from 'vitest';

import { PgDwsConnectionStore } from './store.js';

function mockPool(existingRows: Record<string, unknown>[] = []) {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => ({
    rows: sql.includes('SELECT * FROM test_dws_connections') ? existingRows : [],
    rowCount: 0,
  }));
  const client = { query, release: vi.fn() };
  return {
    query,
    client,
    pool: { connect: vi.fn(async () => client), query } as never,
  };
}

describe('PgDwsConnectionStore profile identity', () => {
  it('init 幂等增加 corp_id，并把可验证的历史组织 selector 升级为账号 selector', async () => {
    const { pool, query } = mockPool();
    const store = new PgDwsConnectionStore({ pool, tablePrefix: 'test' });

    await store.init();

    const sql = query.mock.calls.map(call => call[0]).join('\n');
    expect(sql).toContain('corp_id TEXT NOT NULL');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS corp_id TEXT');
    expect(sql).toContain("SET profile_id = legacy.corp_id || ':' || BTRIM(legacy.dingtalk_user_id)");
    expect(sql).toContain('ALTER COLUMN corp_id SET NOT NULL');
  });

  it('组织级 selector 即使 auth status 有效也保持断开，禁止 Broker 使用漂移账号', async () => {
    const { pool, query } = mockPool();
    const store = new PgDwsConnectionStore({ pool, tablePrefix: 'test' });

    await store.completeCheck({
      tenantId: 'tenant-a', userId: 'user-a', username: 'alice',
      profileId: 'corp-a', corpId: 'corp-a', connectionStatus: 'pending',
      nextCheckAt: '2026-08-30T00:00:00.000Z', consecutiveFailures: 0,
      createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z',
    }, 'worker-a', {
      authenticated: true, tokenValid: true, refreshTokenValid: true, refreshed: false,
      dingtalkUserId: 'staff-a',
    }, new Date('2026-08-30T01:00:00.000Z'));

    const params = query.mock.calls[0]![1] as unknown[];
    expect(params[4]).toBe('disconnected');
    expect(params[15]).toBe('dws_profile_identity_reauthorization_required');
  });

  it('syncProfiles 不折叠同组织双账号，分别写入精确 selector 与 corpId', async () => {
    const { pool, query } = mockPool();
    const store = new PgDwsConnectionStore({ pool, tablePrefix: 'test' });

    await store.syncProfiles({ tenantId: 'tenant-a', userId: 'user-a', username: 'alice' }, [
      {
        profileId: 'corp-a:staff-a', corpId: 'corp-a', dingtalkUserId: 'staff-a', profileStatus: 'active',
      },
      {
        profileId: 'corp-a:staff-b', corpId: 'corp-a', dingtalkUserId: 'staff-b', profileStatus: 'active',
      },
    ], new Date('2026-08-30T00:00:00.000Z'));

    const inserts = query.mock.calls.filter(call => String(call[0]).includes('INSERT INTO test_dws_connections'));
    expect(inserts).toHaveLength(2);
    expect(inserts.map(call => (call[1] as unknown[]).slice(3, 5))).toEqual([
      ['corp-a:staff-a', 'corp-a'],
      ['corp-a:staff-b', 'corp-a'],
    ]);
  });
});
