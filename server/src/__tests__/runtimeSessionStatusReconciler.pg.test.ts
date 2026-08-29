import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgSessionLock } from '../runtime/pgSessionLock.js';
import { PgRunStore } from '../runtime/runStore.js';
import {
  PgRuntimeSessionStatusReconciliationStore,
  RuntimeSessionStatusReconciler,
} from '../runtime/runtimeSessionStatusReconciler.js';
import { PgSessionProjectionStore } from '../runtime/sessionProjectionStore.js';

const { Pool } = pg;
const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;

describePg('runtime session status reconciliation PostgreSQL contract', () => {
  const prefix = `session_reconcile_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let pool: InstanceType<typeof Pool>;
  let runStore: PgRunStore;
  let projectionStore: PgSessionProjectionStore;
  let sessionLock: PgSessionLock;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: connectionString!,
      connectionTimeoutMillis: 5_000,
      max: 6,
    });
    runStore = new PgRunStore({ pool, tablePrefix: prefix });
    projectionStore = new PgSessionProjectionStore({ pool, tablePrefix: prefix });
    sessionLock = new PgSessionLock({ pool, tablePrefix: prefix, mode: 'lease' });
    await runStore.init();
    await projectionStore.init();
    await sessionLock.init();
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    try {
      await sessionLock?.close();
      await pool.query(`DROP TABLE IF EXISTS
        ${prefix}_session_leases, ${prefix}_sessions, ${prefix}_steering_inputs,
        ${prefix}_steering_sessions, ${prefix}_message_submissions, ${prefix}_runs CASCADE`);
    } finally {
      await pool.end();
    }
  }, 30_000);

  it('repairs both projection fields and excludes sessions with an active run', async () => {
    const staleSessionId = randomUUID();
    const activeSessionId = randomUUID();
    await runStore.upsertPending({
      runId: 'run-stale',
      sessionId: staleSessionId,
      tenantId: 'kaiyan',
      userId: 'user-1',
    });
    await runStore.markStatus('run-stale', 'orphaned', 'subagent_run_not_recoverable');
    await runStore.upsertPending({
      runId: 'run-active',
      sessionId: activeSessionId,
      tenantId: 'kaiyan',
      userId: 'user-1',
    });
    for (const [sessionId, kind] of [
      [staleSessionId, 'subagent'],
      [activeSessionId, 'user'],
    ] as const) {
      await pool.query(
        `
        INSERT INTO ${prefix}_sessions
          (session_id, tenant_id, user_id, username, kind, runtime_status, updated_at, meta_json)
        VALUES ($1, 'kaiyan', 'user-1', 'alice', $2, 'running', NOW(), $3::jsonb)
      `,
        [
          sessionId,
          kind,
          JSON.stringify({
            userId: 'user-1',
            username: 'alice',
            tenantId: 'kaiyan',
            channel: 'web',
            createdAt: '2026-08-30T00:00:00.000Z',
            updatedAt: '2026-08-30T00:00:00.000Z',
            runtimeStatus: 'running',
            ...(kind === 'subagent' ? { kind } : {}),
          }),
        ],
      );
    }
    const store = new PgRuntimeSessionStatusReconciliationStore({
      pool,
      sessionsTable: projectionStore.sessionsTable,
      runsTable: runStore.runsTable,
    });
    const metaWrites: Array<{ sessionId: string; status: string }> = [];
    const reconciler = new RuntimeSessionStatusReconciler({
      store,
      sessionLock,
      updateMetaStatus: async (sessionId, status) => {
        metaWrites.push({ sessionId, status });
        return true;
      },
    });

    const plan = await reconciler.runOnce({ execute: false });
    expect(plan.outcomes.map((outcome) => outcome.sessionId)).toEqual([staleSessionId]);

    const summary = await reconciler.runOnce();
    expect(summary).toMatchObject({ scanned: 1, repaired: 1, failed: 0 });
    expect(metaWrites).toEqual([{ sessionId: staleSessionId, status: 'error' }]);
    const repaired = await pool.query(
      `
      SELECT runtime_status, meta_json->>'runtimeStatus' AS meta_status, updated_at
      FROM ${prefix}_sessions WHERE session_id = $1
    `,
      [staleSessionId],
    );
    expect(repaired.rows[0]).toMatchObject({ runtime_status: 'error', meta_status: 'error' });
    const active = await pool.query(
      `
      SELECT runtime_status, meta_json->>'runtimeStatus' AS meta_status
      FROM ${prefix}_sessions WHERE session_id = $1
    `,
      [activeSessionId],
    );
    expect(active.rows[0]).toMatchObject({ runtime_status: 'running', meta_status: 'running' });
    expect((await reconciler.runOnce()).scanned).toBe(0);
  });
});
