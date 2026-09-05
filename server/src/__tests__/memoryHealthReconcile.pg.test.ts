import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgMemoryConsolidationStore } from '../memory/consolidation/store.js';

const connectionString = process.env.MEMORY_CONSOLIDATION_TEST_PG_URL;
const prefix = `mh_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const pool = connectionString ? new Pool({ connectionString }) : null;
const store = connectionString
  ? new PgMemoryConsolidationStore({ connectionString, tablePrefix: prefix })
  : null;
const now = '2026-09-06T00:00:00Z';
const claim = () =>
  store!.claimDue({
    workerId: 'worker',
    now,
    limit: 100,
    leaseSeconds: 60,
    reconcile: { debounceMinutes: 30 },
  });

describe.skipIf(!connectionString)('记忆调度真实 PG 对账', () => {
  beforeAll(async () => {
    await store!.init();
    await pool!.query(`CREATE TABLE ${prefix}_runs (
      run_id TEXT PRIMARY KEY, tenant_id TEXT, session_id TEXT, user_id TEXT,
      status TEXT, updated_at TIMESTAMPTZ, lease_expires_at TIMESTAMPTZ,
      liveness_reason_code TEXT, metadata JSONB DEFAULT '{}')`);
    await pool!.query(`CREATE TABLE ${prefix}_tool_invocations (
      tenant_id TEXT, run_id TEXT, status TEXT)`);
    await pool!.query(`CREATE TABLE ${prefix}_events (
      tenant_id TEXT, session_id TEXT, run_id TEXT, session_sequence BIGINT)`);
  });
  afterAll(async () => {
    await store?.close();
    await pool?.end();
  });

  async function seed(
    id: string,
    status: string,
    extra: { lease?: string; tool?: boolean; reason?: string; tenant?: string } = {},
  ) {
    await pool!.query(
      `INSERT INTO ${prefix}_memory_consolidation_state
      (tenant_id,user_id,workspace_id,session_id,target_session_sequence,active_run_ids,status,first_pending_at,due_at)
      VALUES ('t','u','w',$1,10,$2::jsonb,'pending','2026-09-01','2026-09-01')`,
      [id, JSON.stringify([id])],
    );
    await pool!.query(
      `INSERT INTO ${prefix}_runs
      (run_id,tenant_id,user_id,session_id,status,updated_at,lease_expires_at,liveness_reason_code)
      VALUES ($1,$2,'u',$1,$3,'2026-09-01',$4,$5)`,
      [id, extra.tenant ?? 't', status, extra.lease ?? null, extra.reason ?? null],
    );
    if (extra.tool)
      await pool!.query(`INSERT INTO ${prefix}_tool_invocations VALUES ('t',$1,'running')`, [id]);
  }

  it('无 run_finished 的终态恢复领取；活跃、未知结果和跨租户引用保持阻断', async () => {
    for (const status of ['completed', 'failed', 'cancelled', 'orphaned'])
      await seed(status, status);
    await seed('live', 'running');
    await seed('lease', 'cancelled', { lease: '2026-09-07' });
    await seed('tool', 'orphaned', { tool: true });
    await seed('unknown', 'orphaned', { reason: 'external_tool_outcome_unknown' });
    await seed('other-tenant', 'cancelled', { tenant: 'other' });
    await pool!.query(`INSERT INTO ${prefix}_events VALUES ('t','cancelled','cancelled',25)`);
    const claimed = await claim();
    expect(claimed.map((s) => s.sessionId).sort()).toEqual([
      'cancelled',
      'completed',
      'failed',
      'orphaned',
    ]);
    expect(claimed.find((s) => s.sessionId === 'cancelled')?.targetSessionSequence).toBe(25);
    for (const id of ['live', 'lease', 'tool', 'unknown', 'other-tenant']) {
      expect((await store!.getState('t', id))?.activeRunIds).toEqual([id]);
    }
    expect(await claim()).toEqual([]);
  });

  it('混合 active IDs 只移除已终止成员，不能绕过仍在运行的成员', async () => {
    await seed('mixed', 'failed');
    await pool!.query(
      `INSERT INTO ${prefix}_runs VALUES ('mixed-live','t','mixed','u','running','2026-09-01',NULL,NULL,'{}')`,
    );
    await pool!.query(
      `UPDATE ${prefix}_memory_consolidation_state SET active_run_ids='["mixed","mixed-live"]' WHERE session_id='mixed'`,
    );
    expect(await claim()).toEqual([]);
    expect((await store!.getState('t', 'mixed'))?.activeRunIds).toEqual(['mixed-live']);
  });

  it('已领取的 generation 不被对账修改', async () => {
    await seed('owned', 'cancelled');
    await pool!.query(
      `UPDATE ${prefix}_memory_consolidation_state SET status='running',lease_owner='other',lease_expires_at='2026-09-07' WHERE session_id='owned'`,
    );
    await claim();
    expect((await store!.getState('t', 'owned'))?.activeRunIds).toEqual(['owned']);
  });

  it('关闭被水位覆盖的 started，但保留 prepared 和恢复 journal', async () => {
    await seed('ledger', 'completed');
    await pool!.query(
      `UPDATE ${prefix}_memory_consolidation_state SET processed_session_sequence=10,status='idle' WHERE session_id='ledger'`,
    );
    for (const [key, status, usage] of [
      ['old', 'started', null],
      ['prepared', 'prepared', null],
      ['journal', 'started', { commitJournal: { version: 1, entries: [] } }],
    ] as const) {
      await pool!.query(
        `INSERT INTO ${prefix}_memory_consolidation_runs
        (id,idempotency_key,tenant_id,user_id,workspace_id,session_id,from_session_sequence,to_session_sequence,status,prompt_version,usage_json)
        VALUES ($1,$2,'t','u','w','ledger',0,10,$3,1,$4)`,
        [randomUUID(), key, status, JSON.stringify(usage)],
      );
    }
    await claim();
    const rows = (
      await pool!.query(
        `SELECT idempotency_key,status,error_code FROM ${prefix}_memory_consolidation_runs ORDER BY idempotency_key`,
      )
    ).rows;
    expect(rows).toEqual([
      { idempotency_key: 'journal', status: 'started', error_code: null },
      {
        idempotency_key: 'old',
        status: 'permanent_failed',
        error_code: 'superseded_by_processed_watermark',
      },
      { idempotency_key: 'prepared', status: 'prepared', error_code: null },
    ]);
  });
});
