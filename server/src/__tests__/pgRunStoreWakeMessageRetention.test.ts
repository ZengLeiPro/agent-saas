import { describe, expect, it, vi } from 'vitest';

import { PgRunStore } from '../runtime/runStore.js';

const row = {
  run_id: 'run-1',
  session_id: 'session-1',
  tenant_id: 'tenant-1',
  status: 'completed',
  requested_at: '2026-08-08T00:00:00.000Z',
  updated_at: '2026-08-08T00:00:00.000Z',
  metadata: {},
};

describe('PgRunStore wakeMessage 生命周期', () => {
  it('markStatus 仅在终态合并 metadata 后原子移除 wakeMessage', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        return { rows: [{ row_json: row }] };
      },
    };
    const store = new PgRunStore({
      pool: pool as never,
      writerCapability: { capability: 'tenant-native-v1', allowPrivilegedRoleForTests: true },
    });

    await store.markStatus('run-1', 'completed', undefined, {
      wakeMessage: { content: '不得保留' },
      result: 'ok',
    });

    expect(queries[0].sql).toContain("WHEN $2::text IN ('completed','failed','cancelled','orphaned')");
    expect(queries[0].sql).toContain("THEN (metadata || $5::jsonb) - 'wakeMessage'");
    expect(queries[0].sql).toContain('ELSE metadata || $5::jsonb');
    expect(queries[0].params[1]).toBe('completed');
  });

  it('releaseLease 和等待审批超时终态也移除 wakeMessage', async () => {
    const queries: string[] = [];
    const pool = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [{ row_json: row }] };
      },
    };
    const store = new PgRunStore({
      pool: pool as never,
      writerCapability: { capability: 'tenant-native-v1', allowPrivilegedRoleForTests: true },
    });

    await store.releaseLease('run-1', 'worker-1', 'failed', 'boom');
    await store.cancelStaleWaitingApproval('run-1', new Date(), 'timeout');

    expect(queries[0]).toContain("THEN metadata - 'wakeMessage'");
    expect(queries[1]).toContain("metadata = (metadata || $5::jsonb) - 'wakeMessage'");
  });

  it('init 在 fake pool 查询不到 pg_roles identity 且无测试声明时仍 fail-closed', async () => {
    const client = { query: async () => ({ rows: [] }), release: vi.fn() };
    const store = new PgRunStore({ pool: { connect: async () => client } as never });

    await expect(store.init()).rejects.toThrow('run-store writer session_user must be a LOGIN role');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('init 会幂等清理历史终态 Run 的 wakeMessage', async () => {
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      },
      release: vi.fn(),
    };
    const store = new PgRunStore({
      pool: { connect: async () => client } as never,
      writerCapability: { capability: 'tenant-native-v1', allowPrivilegedRoleForTests: true },
    });

    await store.init();

    expect(queries).toEqual(expect.arrayContaining([
      expect.stringContaining("SET metadata = metadata - 'wakeMessage' WHERE status IN ('completed','failed','cancelled','orphaned')"),
    ]));
    expect(client.release).toHaveBeenCalledOnce();
  });
});
