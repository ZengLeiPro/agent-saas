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

describe('PgRunStore terminal metadata 生命周期', () => {
  it('markStatus 锁后取库时钟，并在终态合并 metadata 后原子移除 wakeMessage', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        return { rows: [{ row_json: row }] };
      },
    };
    const store = new PgRunStore({ pool: pool as never });

    await store.markStatus('run-1', 'completed', undefined, {
      wakeMessage: { content: '不得保留' },
      result: 'ok',
    });

    expect(queries[0].sql).toContain('WITH locked AS MATERIALIZED');
    expect(queries[0].sql).toContain('FOR UPDATE');
    expect(queries[0].sql).toContain('clock_timestamp() AS now FROM locked');
    expect(queries[0].sql).toContain("WHEN $2::text IN ('completed','failed','cancelled','orphaned')");
    expect(queries[0].sql).toContain("THEN ((run.metadata || $4::jsonb) - 'wakeMessage') || jsonb_build_object(");
    expect(queries[0].sql).toContain("run.metadata->>'sandboxLifecycleTerminalAt'");
    expect(queries[0].sql).toContain("WHEN run.status = 'orphaned' THEN run.updated_at::text");
    expect(queries[0].sql).toContain("WHEN run.status = $2 AND $2::text IN ('completed','failed','cancelled','orphaned') THEN run.updated_at");
    expect(queries[0].sql).toContain('ELSE transition_time.now');
    expect(queries[0].sql).toContain('ELSE run.metadata || $4::jsonb');
    expect(queries[0].params[1]).toBe('completed');
    expect(queries[0].params).toHaveLength(4);
  });

  it('markStatusIfCurrent 也使用 write-once terminalAt', async () => {
    const queries: string[] = [];
    const pool = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [{ row_json: row }] };
      },
    };
    const store = new PgRunStore({ pool: pool as never });

    await store.markStatusIfCurrent('run-1', ['running', 'completed'], 'completed', 'late');

    expect(queries[0]).toContain('WITH locked AS MATERIALIZED');
    expect(queries[0]).toContain('FOR UPDATE');
    expect(queries[0]).toContain('clock_timestamp() AS now FROM locked');
    expect(queries[0]).toContain("WHEN run.status = $3 AND $3::text IN ('completed','failed','cancelled','orphaned')");
    expect(queries[0]).toContain("run.metadata->>'sandboxLifecycleTerminalAt'");
    expect(queries[0]).toContain("WHEN run.status = 'orphaned' THEN run.updated_at::text");
  });

  it('releaseLease 保留首次终态时间，等待审批超时终态也移除 wakeMessage', async () => {
    const queries: string[] = [];
    const pool = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [{ row_json: row }] };
      },
    };
    const store = new PgRunStore({ pool: pool as never });

    await store.releaseLease('run-1', 'worker-1', 'failed', 'boom');
    await store.cancelStaleWaitingApproval('run-1', new Date(), 'timeout');

    expect(queries[0]).toContain('WITH locked AS MATERIALIZED');
    expect(queries[0]).toContain('FOR UPDATE');
    expect(queries[0]).toContain('clock_timestamp() AS now FROM locked');
    expect(queries[0]).toContain("THEN (run.metadata - 'wakeMessage') || jsonb_build_object(");
    expect(queries[0]).toContain("THEN run.metadata->>'sandboxLifecycleTerminalAt' END");
    expect(queries[0]).toContain('THEN run.updated_at ELSE transition_time.now END');
    expect(queries[1]).toContain("metadata = (metadata || $5::jsonb) - 'wakeMessage'");
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
    const store = new PgRunStore({ pool: { connect: async () => client } as never });

    await store.init();

    expect(queries).toEqual(expect.arrayContaining([
      expect.stringContaining("SET metadata = metadata - 'wakeMessage' WHERE status IN ('completed','failed','cancelled','orphaned')"),
    ]));
    expect(client.release).toHaveBeenCalledOnce();
  });
});
