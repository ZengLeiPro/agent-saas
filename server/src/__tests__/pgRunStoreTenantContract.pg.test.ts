import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';

import { PgRunStore } from '../runtime/runStore.js';
import { RUN_STORE_TENANT_SCHEMA_VERSION } from '../runtime/runStoreSchema.js';
import { RunCreateConflictError } from '../runtime/runStoreTypes.js';
import { describePg, testPgUrl } from './pgRunStoreSteering.pg.testHelpers.js';

const { Pool } = pg;

describePg('PgRunStore tenant contract boundary', () => {
  it('原始幂等键在 expand 跨 tenant fail-closed，contract 后按 tenant 独立', async () => {
    const prefix = `tenant_contract_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 8 });
    const store = new PgRunStore({ pool, tablePrefix: prefix });
    const enqueue = (
      tenantId: string, runId: string, sessionId: string, idempotencyKey: string,
    ) => store.enqueueUserMessage({
      tenantId, runId, sessionId, idempotencyKey,
      userId: 'owner', submitterUserId: 'submitter', channel: 'web',
    }, 'queue');

    try {
      await store.init();
      await enqueue('tenant-expand-a', 'expand-owner-run', 'expand-owner-session', 'expand-shared-key');
      for (const runId of ['expand-foreign-run-1', 'expand-foreign-run-2']) {
        const conflict = await enqueue(
          'tenant-expand-b', runId, 'expand-foreign-session', 'expand-shared-key',
        ).catch((error: unknown) => error);
        expect(conflict).toBeInstanceOf(RunCreateConflictError);
        expect(conflict).toMatchObject({
          message: expect.stringContaining('conflicts with another tenant during run-store expand phase'),
        });
        expect((conflict as { code?: string }).code).not.toBe('23505');
      }
      await expect(store.findByIdempotencyKey(
        'tenant-expand-a', 'submitter', 'expand-shared-key',
      )).resolves.toMatchObject({ runId: 'expand-owner-run' });
      await expect(store.findByIdempotencyKey(
        'tenant-expand-b', 'submitter', 'expand-shared-key',
      )).resolves.toBeNull();
      await expect(pool.query(`
        SELECT tenant_id,run_id FROM ${prefix}_message_submissions
        WHERE user_scope='submitter' AND client_message_id='expand-shared-key'
      `)).resolves.toMatchObject({
        rows: [{ tenant_id: 'tenant-expand-a', run_id: 'expand-owner-run' }],
      });

      await store.contractTenantSchema({
        expectedExpandVersion: RUN_STORE_TENANT_SCHEMA_VERSION,
        oldWritersDrained: true,
      });
      await Promise.all([
        enqueue('tenant-contract-a', 'contract-run-a', 'contract-session-a', 'contract-shared-key'),
        enqueue('tenant-contract-b', 'contract-run-b', 'contract-session-b', 'contract-shared-key'),
      ]);
      await expect(store.findByIdempotencyKey(
        'tenant-contract-a', 'submitter', 'contract-shared-key',
      )).resolves.toMatchObject({ runId: 'contract-run-a' });
      await expect(store.findByIdempotencyKey(
        'tenant-contract-b', 'submitter', 'contract-shared-key',
      )).resolves.toMatchObject({ runId: 'contract-run-b' });

      await Promise.all([
        store.upsertPending({
          tenantId: 'tenant-contract-a', runId: 'contract-stop-a', sessionId: 'contract-stop',
        }),
        store.upsertPending({
          tenantId: 'tenant-contract-b', runId: 'contract-stop-b', sessionId: 'contract-stop',
        }),
      ]);
      await Promise.all([
        store.cancelSteeringBeforeDispatchBySession(
          'contract-stop', 'stop-a', undefined, 'tenant-contract-a',
        ),
        store.cancelSteeringBeforeDispatchBySession(
          'contract-stop', 'stop-b', undefined, 'tenant-contract-b',
        ),
      ]);
      await expect(pool.query(`
        SELECT tenant_id,tenant_session_id FROM ${prefix}_steering_sessions
        WHERE tenant_session_id='contract-stop' ORDER BY tenant_id
      `)).resolves.toMatchObject({ rows: [
        { tenant_id: 'tenant-contract-a', tenant_session_id: 'contract-stop' },
        { tenant_id: 'tenant-contract-b', tenant_session_id: 'contract-stop' },
      ] });
    } finally {
      for (const suffix of [
        'steering_sessions_tenant_quarantine', 'steering_inputs_tenant_quarantine',
        'message_submissions_tenant_quarantine', 'steering_sessions', 'steering_inputs',
        'message_submissions', 'runs_schema_migrations', 'runs',
      ]) await pool.query(`DROP TABLE IF EXISTS ${prefix}_${suffix}`);
      for (const fn of [
        'message_submissions_tenant_expand_fn', 'steering_inputs_tenant_expand_fn',
        'steering_sessions_tenant_expand_fn', 'runs_tenant_aux_catchup_fn',
      ]) await pool.query(`DROP FUNCTION IF EXISTS ${prefix}_${fn}()`);
      await pool.end();
    }
  }, 30_000);
});
