import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { governanceV47DwsDurableReceiverStatements } from '../governance-schema/v47DwsDurableReceiverMigration.js';
import { PgDwsDeliveryStore } from './durableDeliveryStore.js';
import type { AgentDwsAccountRecord } from './types.js';
import type { DwsReceiverSource, DwsSpoolFrame } from '../../runtime/dwsReceiverProtocol.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl && !new URL(databaseUrl).pathname.toLowerCase().includes('test')) {
  throw new Error('DWS PG fixtures require an explicitly named test database');
}

const prefix = `drx_test_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const identity = '2026-09-10T00:00:00.000Z';
const account = { accountId: 'fixture-account', tenantId: 'fixture-tenant', revision: 3 } as AgentDwsAccountRecord;
const source: DwsReceiverSource = { accountId: account.accountId, receiverId: 'drx-fixture', profileId: 'corp:user',
  identityUpdatedAt: identity, eventKinds: ['at_me'] };
const workspace = { id: 'fixture-ws', sessionId: 'fixture-session', sandboxScopeId: 'fixture-scope', mountSubPath: 'fixtures/dws' };

function frame(sequence: number, value: unknown = {
  event_id: `event-${sequence}`, type: 'user_im_message_receive_at', conversation_id: 'conversation-one', content: 'hello',
}): DwsSpoolFrame {
  const payload = Buffer.from(JSON.stringify(value));
  return { sequence, payloadBase64: payload.toString('base64'),
    sha256: createHash('sha256').update(payload).digest('hex'), receivedAtMs: Date.now() };
}

describe.skipIf(!databaseUrl)('PgDwsDeliveryStore real database contracts', () => {
  let pool: pg.Pool;
  let store: PgDwsDeliveryStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
    store = new PgDwsDeliveryStore(pool, prefix);
    // Create only this test's account fixture and execute the actual additive DDL.
    await pool.query(`CREATE TABLE ${prefix}_agent_dws_accounts (
      account_id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,revision BIGINT NOT NULL,
      status TEXT NOT NULL,profile_id TEXT,identity_updated_at TIMESTAMPTZ,event_policy_json JSONB,
      runtime_status TEXT NOT NULL DEFAULT 'stopped',runtime_lease_owner TEXT,
      runtime_lease_expires_at TIMESTAMPTZ,updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`);
    for (const sql of governanceV47DwsDurableReceiverStatements(prefix)) await pool.query(sql);
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE ${store.accountsTable} CASCADE`);
    await pool.query(`INSERT INTO ${store.accountsTable}
      (account_id,tenant_id,revision,status,profile_id,identity_updated_at,event_policy_json)
      VALUES ($1,$2,3,'active','corp:user',$3,'{"deliveryProtocol":"durable-v1"}')`,
    [account.accountId, account.tenantId, identity]);
    await pool.query(`INSERT INTO ${store.ownersTable}
      (account_id,tenant_id,receiver_id,source_json,workspace_json,account_revision,bridge_evidence_json)
      VALUES ($1,$2,'drx-fixture',$3,$4,3,'{"fixtureOnly":true}')`,
    [account.accountId, account.tenantId, source, workspace]);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP TABLE IF EXISTS ${store.migrationsTable},${store.inboxTable},${store.ownersTable},${store.accountsTable} CASCADE`);
    await pool.end();
  });

  it('only one concurrent consumer claims an account and reacquisition advances its epoch', async () => {
    const results = await Promise.all([store.claim(account, 'worker-a'), store.claim(account, 'worker-b')]);
    const claimed = results.filter(value => value !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.owner.epoch).toBe('1');
    await store.release(claimed[0]!.owner);
    expect((await store.claim(account, 'worker-c'))!.owner.epoch).toBe('2');
  });

  it('keeps legacy active until handoff and activates only through the fenced migration transaction', async () => {
    await pool.query(`TRUNCATE ${store.accountsTable} CASCADE`);
    await pool.query(`INSERT INTO ${store.accountsTable}
      (account_id,tenant_id,revision,status,profile_id,identity_updated_at,event_policy_json)
      VALUES ($1,$2,3,'active','corp:user',$3,'{}')`, [account.accountId, account.tenantId, identity]);
    const planned = await store.prepareMigration({ account, receiverId: 'drx-fixture', source, workspace,
      actor: 'platform-admin', evidence: { legacyInvocationId: 'legacy-one' } });
    expect(planned.state).toBe('planned');
    let persisted = await pool.query(`SELECT revision,event_policy_json FROM ${store.accountsTable}`);
    expect(persisted.rows[0]).toMatchObject({ revision: '3', event_policy_json: {} });

    expect((await store.beginMigration(planned.migrationId)).state).toBe('handoff_pending');
    persisted = await pool.query(`SELECT revision,event_policy_json FROM ${store.accountsTable}`);
    expect(persisted.rows[0]).toMatchObject({ revision: '4', event_policy_json: { deliveryProtocol: 'handoff_pending' } });
    await expect(store.abortPlannedMigration(planned.migrationId, 'platform-admin')).rejects.toThrow('migration_abort_unsafe');

    expect((await store.activateMigration(planned.migrationId, { legacyStopProof: { provenance: 'journal' } })).state)
      .toBe('activated');
    persisted = await pool.query(`SELECT a.revision,a.event_policy_json,r.account_revision,r.bridge_evidence_json
      FROM ${store.accountsTable} a JOIN ${store.ownersTable} r USING(account_id)`);
    expect(persisted.rows[0]).toMatchObject({ revision: '5', account_revision: '5',
      event_policy_json: { deliveryProtocol: 'durable-v1' },
      bridge_evidence_json: { legacyInvocationId: 'legacy-one', legacyStopProof: { provenance: 'journal' } } });
  });

  it('aborts only a pre-handoff plan without changing the legacy account', async () => {
    await pool.query(`TRUNCATE ${store.accountsTable} CASCADE`);
    await pool.query(`INSERT INTO ${store.accountsTable}
      (account_id,tenant_id,revision,status,profile_id,identity_updated_at,event_policy_json)
      VALUES ($1,$2,3,'active','corp:user',$3,'{}')`, [account.accountId, account.tenantId, identity]);
    const planned = await store.prepareMigration({ account, receiverId: 'drx-fixture', source, workspace,
      actor: 'platform-admin', evidence: {} });
    expect((await store.abortPlannedMigration(planned.migrationId, 'platform-admin')).state).toBe('aborted');
    expect((await pool.query(`SELECT COUNT(*)::int AS count FROM ${store.ownersTable}`)).rows[0].count).toBe(0);
    expect((await pool.query(`SELECT revision,event_policy_json FROM ${store.accountsTable}`)).rows[0])
      .toMatchObject({ revision: '3', event_policy_json: {} });
  });

  it('an expired owner cannot renew or persist after a successor claim', async () => {
    const old = (await store.claim(account, 'old'))!.owner;
    await pool.query(`UPDATE ${store.ownersTable} SET lease_expires_at=clock_timestamp()-INTERVAL '1 second'`);
    await expect(store.renew(old)).rejects.toThrow('stale_consumer_owner');
    const next = (await store.claim(account, 'new'))!.owner;
    expect(next.epoch).toBe('2');
    await expect(store.accept(old, [frame(1)])).rejects.toThrow('stale_consumer_owner');
    expect(await store.accept(next, [frame(1)])).toBe(1);
  });

  it('durable intake precedes remote ACK and an ambiguous COMMIT replays by the exact frame hash', async () => {
    const owner = (await store.claim(account, 'consumer'))!.owner;
    const first = frame(1);
    expect(await store.accept(owner, [first])).toBe(1);
    expect(await store.pending(owner)).toHaveLength(1);
    expect(await store.ackableCursor(owner)).toBe(0);
    await expect(store.acknowledged(owner, 1)).rejects.toThrow('uncommitted_ack_cursor');
    expect(await store.accept(owner, [first])).toBe(1);
    const count = await pool.query(`SELECT COUNT(*)::int AS count FROM ${store.inboxTable}`);
    expect(count.rows[0].count).toBe(1);
    await store.forwarded(owner, 1);
    expect(await store.ackableCursor(owner)).toBe(1);
    await store.acknowledged(owner, 1);
    expect(await store.pending(owner)).toEqual([]);
  });

  it('a sequence gap or changed replay payload rolls back the entire intake transaction', async () => {
    const owner = (await store.claim(account, 'consumer'))!.owner;
    await expect(store.accept(owner, [frame(1), frame(3)])).rejects.toThrow('intake_cursor_gap');
    expect((await store.diagnostics(account.tenantId, account.accountId))!.received_cursor).toBe('0');
    const original = frame(1);
    await store.accept(owner, [original]);
    await expect(store.accept(owner, [frame(1, { changed: true })])).rejects.toThrow('intake_replay_identity_conflict');
  });

  it('unsupported events are retained as durable dead letters before ACK is allowed', async () => {
    const owner = (await store.claim(account, 'consumer'))!.owner;
    await store.accept(owner, [frame(1, { event_id: 'future', type: 'unknown_event_type' })]);
    await store.acknowledged(owner, 1);
    const stored = await pool.query(`SELECT state,reason_code,payload FROM ${store.inboxTable}`);
    expect(stored.rows[0].state).toBe('dead_letter');
    expect(stored.rows[0].reason_code).toBe('unsupported_event_type');
    expect(stored.rows[0].payload.length).toBeGreaterThan(0);
  });

  it('account revision changes serialize with intake and prevent stale identity persistence', async () => {
    const owner = (await store.claim(account, 'consumer'))!.owner;
    const editor = await pool.connect();
    try {
      await editor.query('BEGIN');
      await editor.query(`SELECT account_id FROM ${store.accountsTable} WHERE account_id=$1 FOR UPDATE`, [account.accountId]);
      const pending = store.accept(owner, [frame(1)]);
      // Attach the rejection observer before releasing the account-row lock.
      const assertion = expect(pending).rejects.toThrow('stale_consumer_owner');
      await editor.query(`UPDATE ${store.accountsTable} SET revision=revision+1 WHERE account_id=$1`, [account.accountId]);
      await editor.query('COMMIT');
      await assertion;
      expect((await pool.query(`SELECT COUNT(*)::int AS count FROM ${store.inboxTable}`)).rows[0].count).toBe(0);
    } finally {
      await editor.query('ROLLBACK').catch(() => undefined);
      editor.release();
    }
  });

  it('explicit stop advances the epoch and fences the preceding consumer ACK', async () => {
    const old = (await store.claim(account, 'consumer'))!.owner;
    await store.accept(old, [frame(1)]);
    const stop = (await store.claim(account, 'stop-controller', 'stop'))!;
    expect(stop.owner.epoch).toBe('2');
    await expect(store.acknowledged(old, 1)).rejects.toThrow();
    expect((await store.diagnostics(account.tenantId, account.accountId))!.acknowledged_cursor).toBe('0');
  });

  it('owner epochs retain PostgreSQL bigint precision above the JavaScript integer limit', async () => {
    await pool.query(`UPDATE ${store.ownersTable} SET owner_epoch=9007199254740993`);
    expect((await store.claim(account, 'consumer'))!.owner.epoch).toBe('9007199254740994');
  });

  it('the physical durable inbox quota refuses new frames without deleting old dead letters', async () => {
    const owner = (await store.claim(account, 'consumer'))!.owner;
    await pool.query(`INSERT INTO ${store.inboxTable}
      (account_id,receiver_id,sequence,tenant_id,account_revision,account_identity_json,payload,
       payload_sha256,received_at_ms,state,reason_code)
      SELECT $1,'drx-retained',n,$2,3,'{}','x'::bytea,repeat('a',64),1,'dead_letter','fixture'
      FROM generate_series(1,10000) AS n`, [account.accountId, account.tenantId]);
    await expect(store.accept(owner, [frame(1)])).rejects.toThrow('durable_inbox_quota_exhausted');
    expect((await pool.query(`SELECT COUNT(*)::int AS count FROM ${store.inboxTable}`)).rows[0].count).toBe(10000);
  }, 30_000);
});
