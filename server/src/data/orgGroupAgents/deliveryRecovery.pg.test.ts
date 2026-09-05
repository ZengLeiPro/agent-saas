import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  cancelUnstartedDeliveryIntentsForInbox,
  getReplyRecoveryStateForInbox,
} from './deliveryClaims.js';

const { Pool } = pg;
const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;

describePg('DWS reply recovery PostgreSQL 状态矩阵', () => {
  const table = `reply_recovery_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let pool: InstanceType<typeof Pool>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 1 });
    await pool.query(`CREATE TABLE ${table} (
      tenant_id TEXT NOT NULL,
      inbox_id TEXT NOT NULL,
      delivery_kind TEXT NOT NULL,
      disposition TEXT NOT NULL,
      delivery_state TEXT NOT NULL,
      provider_attempt_phase TEXT NOT NULL,
      provider_started_at TIMESTAMPTZ,
      lease_owner TEXT,
      lease_expires_at TIMESTAMPTZ,
      next_attempt_at TIMESTAMPTZ,
      last_error TEXT,
      completed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE ${table}`);
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      await pool.query(`DROP TABLE IF EXISTS ${table}`);
    } finally {
      await pool.end();
    }
  });

  it.each([
    ['pending', 'before_provider', null, null, 'dead_letter', 'unstarted'],
    ['pending', 'legacy_unknown', null, null, 'unknown', 'unknown'],
    ['sending', 'legacy_unknown', null, null, 'unknown', 'unknown'],
    ['sent', 'legacy_unknown', null, null, 'sent', 'sent'],
    ['sending', 'provider_started', '2026-09-05T00:00:00.000Z', null, 'sending', 'unknown'],
    ['sending', 'before_provider', '2026-09-05T00:00:00.000Z', null, 'sending', 'unknown'],
    ['unknown', 'provider_started', '2026-09-05T00:00:00.000Z', 'receipt lost', 'unknown', 'unknown'],
    ['dead_letter', 'legacy_unknown', null, 'legacy failure', 'dead_letter', 'unknown'],
    ['dead_letter', 'provider_started', '2026-09-05T00:00:00.000Z',
      'ORG_AGENT_PROVIDER_AUTHORIZATION_REVOKED', 'dead_letter', 'unstarted'],
  ] as const)(
    '%s/%s/started=%s/error=%s 最终隔离为 %s 并分类 %s',
    async (deliveryState, phase, providerStartedAt, lastError, expectedState, expectedRecovery) => {
      await pool.query(`INSERT INTO ${table}
        (tenant_id,inbox_id,delivery_kind,disposition,delivery_state,
         provider_attempt_phase,provider_started_at,last_error)
        VALUES ('tenant-a','inbox-a','front_reply','replied',$1,$2,$3,$4)`,
      [deliveryState, phase, providerStartedAt, lastError]);

      await cancelUnstartedDeliveryIntentsForInbox(
        pool, table, 'tenant-a', 'inbox-a', 'authorization revoked',
      );

      const stored = await pool.query<{ delivery_state: string }>(
        `SELECT delivery_state FROM ${table}`,
      );
      expect(stored.rows[0]?.delivery_state).toBe(expectedState);
      await expect(getReplyRecoveryStateForInbox(
        pool, table, 'tenant-a', 'inbox-a',
      )).resolves.toBe(expectedRecovery);
    },
  );

  it('只要 legacy_unknown 与 sent 并存就优先收束为 unknown', async () => {
    await pool.query(`INSERT INTO ${table}
      (tenant_id,inbox_id,delivery_kind,disposition,delivery_state,provider_attempt_phase)
      VALUES
      ('tenant-a','inbox-a','front_reply','replied','sent','provider_started'),
      ('tenant-a','inbox-a','front_reply','replied','dead_letter','legacy_unknown')`);

    await expect(getReplyRecoveryStateForInbox(
      pool, table, 'tenant-a', 'inbox-a',
    )).resolves.toBe('unknown');
  });
});
