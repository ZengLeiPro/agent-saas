import { describe, expect, it, vi } from 'vitest';

import { PgRunStoreQueries } from '../runtime/runStoreQueries.js';

function rawRun(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: 'run-1', session_id: 'session-1', tenant_id: 'tenant-1', status: 'running',
    requested_at: '2026-08-30T00:00:00.000Z', updated_at: '2026-08-30T00:00:01.000Z',
    worker_id: 'worker-1', lease_expires_at: '2026-08-30T00:00:02.000Z', metadata: {},
    last_heartbeat_at: '2026-08-30T00:00:01.000Z', liveness_state: 'busy',
    liveness_detected_at: '2026-08-30T00:00:01.000Z', liveness_version: '2',
    ...patch,
  };
}

describe('PgRunStore M40-02 liveness and explicit recovery SQL contract', () => {
  it.each(['stream', 'tool', 'subagent'] as const)('renews lease and heartbeat atomically for %s activity', async (source) => {
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      expect(sql).toContain("liveness_state = 'busy'");
      expect(sql).toContain('last_heartbeat_at = GREATEST');
      expect(sql).toContain("liveness_state IS DISTINCT FROM 'stale'");
      expect(params[4]).toBe(`heartbeat_${source}`);
      return { rows: [{ row_json: rawRun({ liveness_reason_code: `heartbeat_${source}` }) }] };
    });
    const queries = new PgRunStoreQueries({ query } as never, 'runtime_runs', 'runtime_message_submissions', 'runtime_steering_inputs');
    const result = await queries.renewLease('run-1', 'worker-1', 60_000, new Date('2026-08-30T00:00:10.000Z'), source);
    expect(result?.liveness).toMatchObject({ state: 'busy', reasonCode: `heartbeat_${source}`, version: 2 });
  });

  it('uses post-lock database time and records terminalAt for explicit message cancellation', async () => {
    let cancellationSql = '';
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      cancellationSql = sql;
      expect(params).toEqual(['user-1', 'client-1', 'explicit_cancel']);
      return { rows: [] };
    });
    const queries = new PgRunStoreQueries({ query } as never, 'runtime_runs', 'runtime_message_submissions', 'runtime_steering_inputs');
    await queries.cancelUserMessageByClientMsgId('user-1', 'client-1', 'explicit_cancel', new Date('2026-08-30T00:00:10.000Z'));
    expect(cancellationSql).toContain('locked AS MATERIALIZED');
    expect(cancellationSql).toContain('SELECT clock_timestamp() AS now FROM locked');
    expect(cancellationSql).toContain('updated_at = cancellation_time.now');
    expect(cancellationSql).toContain("'sandboxLifecycleTerminalAt'");
  });

  it('orders the reaper orphan pass before stale marking and uses row-level CAS fencing', async () => {
    const statements: string[] = [];
    let pass = 0;
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
        if (sql.includes("liveness_state = 'orphaned'")) {
          pass += 1;
          return { rows: pass === 1 ? [] : [{ row_json: rawRun({
            status: 'orphaned', worker_id: null, lease_expires_at: null,
            liveness_state: 'orphaned', liveness_reason_code: 'lease_expired',
            liveness_detected_at: '2026-08-30T00:00:20.000Z', liveness_version: '4',
          }) }] };
        }
        if (sql.includes("SET liveness_state = 'stale'")) return { rows: pass === 1 ? [{ row_json: rawRun({ liveness_state: 'stale', liveness_reason_code: 'lease_expired', liveness_version: '3' }) }] : [] };
        throw new Error(`unexpected SQL: ${sql}`);
      }),
      release: vi.fn(),
    };
    const queries = new PgRunStoreQueries({ connect: async () => client } as never, 'runtime_runs', 'runtime_message_submissions', 'runtime_steering_inputs');
    const first = await queries.reapExpiredLiveness(new Date('2026-08-30T00:00:10.000Z'), 5_000);
    const second = await queries.reapExpiredLiveness(new Date('2026-08-30T00:00:20.000Z'), 5_000);
    expect(first).toMatchObject({ stale: [{ runId: 'run-1' }], orphaned: [] });
    expect(second).toMatchObject({ stale: [], orphaned: [{ runId: 'run-1', status: 'orphaned' }] });
    const reaperSql = statements.filter((sql) => sql.includes('FOR UPDATE SKIP LOCKED'));
    expect(reaperSql[0]).toContain("liveness_state = 'stale'");
    expect(reaperSql[1]).toContain("liveness_state = 'busy'");
    expect(reaperSql.every((sql) => sql.includes('FOR UPDATE SKIP LOCKED'))).toBe(true);
  });

  it('terminalizes uncertain running tools without making them automatically recoverable', async () => {
    let orphanSql = '';
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
        if (sql.includes("liveness_state = 'orphaned'")) { orphanSql = sql; return { rows: [] }; }
        return { rows: [] };
      }), release: vi.fn(),
    };
    const queries = new PgRunStoreQueries({ connect: async () => client } as never, 'runtime_runs', 'runtime_message_submissions', 'runtime_steering_inputs');
    await queries.reapExpiredLiveness(new Date('2026-08-30T00:00:20.000Z'), 5_000);
    expect(orphanSql).toContain("invocation.status = 'running'");
    expect(orphanSql).toContain("'external_tool_outcome_unknown'");
    expect(orphanSql).toContain("status = 'orphaned'");
    expect(orphanSql).toContain('transition_time AS MATERIALIZED');
    expect(orphanSql).toContain('SELECT clock_timestamp() AS now FROM candidates');
    expect(orphanSql).toContain('updated_at = transition_time.now');
    expect(orphanSql).toContain("'sandboxLifecycleTerminalAt'");
  });

  it('creates one explicit retry run for the same clientMsgId while leaving the orphan terminal', async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
        if (sql.includes('JOIN runtime_message_submissions')) return { rows: [{ row_json: rawRun({ liveness_state: 'orphaned', liveness_reason_code: 'lease_expired', status: 'orphaned' }) }] };
        if (sql.includes('SELECT EXISTS')) return { rows: [{ exists: false }] };
        if (sql.includes('INSERT INTO runtime_runs')) return { rows: [{ row_json: rawRun({
          run_id: 'retry-run-1', status: 'pending', worker_id: null, lease_expires_at: null,
          status_reason: 'explicit_client_retry', liveness_state: 'active',
          liveness_reason_code: 'explicit_client_retry', liveness_version: '1',
        }) }] };
        if (sql.includes('UPDATE runtime_runs')) return { rows: [] };
        throw new Error(`unexpected SQL: ${sql}`);
      }),
      release: vi.fn(),
    };
    const queries = new PgRunStoreQueries({ connect: async () => client } as never, 'runtime_runs', 'runtime_message_submissions', 'runtime_steering_inputs');
    const retried = await queries.retryOrphanedUserMessage('user-1', 'client-1', new Date('2026-08-30T00:01:00.000Z'));
    expect(retried).toMatchObject({ runId: 'retry-run-1', status: 'pending', statusReason: 'explicit_client_retry' });
    expect(statements.join('\n')).toContain('submission.client_message_id = $2');
    expect(statements.join('\n')).toContain("WHERE run_id = $1 AND status = 'orphaned'");
    expect(statements.join('\n')).toContain("WHERE run_id = $1 AND status = 'running'");
    expect(statements.join('\n')).toContain("'pending', 'explicit_client_retry'");
  });
});
