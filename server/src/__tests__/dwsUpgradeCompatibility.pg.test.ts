import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgAgentDwsAccountStore } from '../data/agentDwsAccounts/store.js';
import { PgAgentDwsMessageStore } from '../data/agentDwsMessages/store.js';
import { PgGovernanceMigrationRunner } from '../data/governance-schema/migrations.js';
import { governanceV34Statements } from '../data/governance-schema/v34Migration.js';
import { PgDwsAuthSessionStore } from '../dws/authStore.js';

const { Pool } = pg;
const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;

describePg('DWS V34 PostgreSQL 跨版本兼容', () => {
  const prefix = `dwsv34_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let pool: InstanceType<typeof Pool>;
  let authStore: PgDwsAuthSessionStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 4 });
    await new PgGovernanceMigrationRunner(pool, prefix).run();
    authStore = new PgDwsAuthSessionStore({ pool, tablePrefix: prefix, connectorId: 'agent_dws' });
    await authStore.init();
  }, 60_000);

  afterAll(async () => {
    if (!pool) return;
    try {
      const tables = await pool.query<{ tablename: string }>(`
        SELECT tablename FROM pg_tables
        WHERE schemaname=current_schema() AND LEFT(tablename,LENGTH($1))=$1
      `, [prefix]);
      for (const row of tables.rows) await pool.query(`DROP TABLE IF EXISTS "${row.tablename}" CASCADE`);
      const functions = await pool.query<{ proname: string; args: string }>(`
        SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS args
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname=current_schema() AND LEFT(p.proname,LENGTH($1))=$1
      `, [prefix]);
      for (const row of functions.rows) {
        await pool.query(`DROP FUNCTION IF EXISTS "${row.proname}"(${row.args}) CASCADE`);
      }
    } finally {
      await pool.end();
    }
  }, 30_000);

  async function rerunV34(): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const statement of governanceV34Statements(prefix)) await client.query(statement);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  it('终结升级中断的 authorizing 账号与授权 session，并允许重新授权', async () => {
    await pool.query(`INSERT INTO ${prefix}_managed_agents
      (agent_id,tenant_id,kind,owner_user_id,status,revision,created_by,updated_by)
      VALUES
        ('agent-auth-exact','tenant-a','org_agent','admin','enabled',1,'admin','admin'),
        ('agent-auth-empty','tenant-a','org_agent','admin','enabled',1,'admin','admin')`);
    await pool.query(`INSERT INTO ${prefix}_agent_dws_accounts
      (account_id,tenant_id,agent_id,display_name,login_id,corp_id,dingtalk_user_id,profile_id,
       status,runtime_status,event_policy_json,runtime_lease_owner,runtime_lease_expires_at,last_error,
       revision,created_by,updated_at,updated_by)
      VALUES
        ('auth-exact','tenant-a','agent-auth-exact','授权中精确账号','auth-exact-login',
         'corp-auth','user-auth','corp-auth:user-auth','authorizing','ready','{"kinds":["at_me"]}'::jsonb,
         'old-worker',NOW()+INTERVAL '5 minutes','old-error',7,'admin','2000-01-01T00:00:00Z','legacy'),
        ('auth-empty','tenant-a','agent-auth-empty','授权中空账号','auth-empty-login',
         NULL,NULL,NULL,'authorizing','starting','{"kinds":["at_me"]}'::jsonb,
         'old-worker',NOW()+INTERVAL '5 minutes','old-error',11,'admin','2000-01-01T00:00:00Z','legacy')`);
    for (const userId of ['auth-exact', 'auth-empty']) {
      const { record } = await authStore.createOrReuse({ tenantId: 'tenant-a', userId, username: userId });
      await authStore.markAwaitingUser(
        record.sessionId,
        { tenantId: 'tenant-a', userId, username: userId },
        `CODE-${userId}`,
        `https://example.invalid/${userId}`,
      );
    }

    await rerunV34();

    const accounts = await pool.query<{
      account_id: string; status: string; runtime_status: string; runtime_lease_owner: string | null;
      last_error: string | null; revision: string; updated_by: string; profile_id: string | null;
    }>(`SELECT account_id,status,runtime_status,runtime_lease_owner,last_error,revision,updated_by,profile_id
      FROM ${prefix}_agent_dws_accounts WHERE account_id IN ('auth-exact','auth-empty') ORDER BY account_id`);
    expect(accounts.rows).toEqual([
      expect.objectContaining({
        account_id: 'auth-empty', status: 'error', runtime_status: 'error', runtime_lease_owner: null,
        last_error: 'authorization_interrupted_by_upgrade', revision: '12',
        updated_by: 'system:dws-authorizing-v34', profile_id: null,
      }),
      expect.objectContaining({
        account_id: 'auth-exact', status: 'error', runtime_status: 'error', runtime_lease_owner: null,
        last_error: 'authorization_interrupted_by_upgrade', revision: '8',
        updated_by: 'system:dws-authorizing-v34', profile_id: 'corp-auth:user-auth',
      }),
    ]);
    for (const userId of ['auth-exact', 'auth-empty']) {
      const session = await authStore.getLatestForUser('tenant-a', userId);
      expect(session).toMatchObject({
        status: 'failed', errorCode: 'authorization_interrupted_by_upgrade',
      });
      expect(session?.authorizationUrl).toBeUndefined();
      expect(session?.userCode).toBeUndefined();
    }

    const accountStore = new PgAgentDwsAccountStore(pool, prefix);
    await expect(accountStore.markAuthorizing('tenant-a', 'auth-empty', 12, 'admin:retry'))
      .resolves.toMatchObject({ status: 'authorizing', revision: 13 });
    await expect(accountStore.markAuthorizing('tenant-a', 'auth-exact', 8, 'admin:retry'))
      .resolves.toMatchObject({ status: 'authorizing', revision: 9, profileId: 'corp-auth:user-auth' });
    await expect(authStore.createOrReuse({ tenantId: 'tenant-a', userId: 'auth-exact', username: '重试' }))
      .resolves.toMatchObject({ created: true, record: { status: 'starting' } });

    await pool.query(`DELETE FROM ${prefix}_agent_dws_auth_sessions WHERE user_id IN ('auth-exact','auth-empty')`);
    await pool.query(`DELETE FROM ${prefix}_agent_dws_accounts WHERE account_id IN ('auth-exact','auth-empty')`);
    await pool.query(`DELETE FROM ${prefix}_managed_agents WHERE agent_id IN ('agent-auth-exact','agent-auth-empty')`);
  });

  it('旧 v1 inbox 在真实 PostgreSQL 中按入队身份补 pin 或一次性终结', async () => {
    await pool.query(`INSERT INTO ${prefix}_managed_agents
      (agent_id,tenant_id,kind,owner_user_id,status,revision,created_by,updated_by)
      VALUES ('agent-inbox-v1','tenant-a','org_agent','admin','enabled',1,'admin','admin')`);
    await pool.query(`INSERT INTO ${prefix}_agent_dws_accounts
      (account_id,tenant_id,agent_id,display_name,login_id,corp_id,dingtalk_user_id,profile_id,
       status,event_policy_json,revision,created_by,updated_at,updated_by)
      VALUES ('inbox-v1','tenant-a','agent-inbox-v1','旧 inbox 账号','inbox-v1-login',
        'corp-v1','user-v1','corp-v1:user-v1','active','{"kinds":["at_me"]}'::jsonb,
        1,'admin','2000-01-01T00:00:00Z','admin')`);
    const inboxTable = `${prefix}_agent_dws_event_inbox`;
    await pool.query(`INSERT INTO ${inboxTable}
      (inbox_id,tenant_id,account_id,event_id,event_type,conversation_id,content,payload_json,state,
       session_id,run_id,response_text,attempt,lease_expires_at,next_attempt_at,created_at,updated_at)
      VALUES
        ('legacy-pending','tenant-a','inbox-v1','event-pending','chatbot_message','conv-pending','pending',
          '{"schemaVersion":1,"source":"dws_personal_stream"}'::jsonb,'pending',NULL,NULL,NULL,0,NULL,NULL,
          '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
        ('legacy-retry','tenant-a','inbox-v1','event-retry','chatbot_message','conv-retry','retry',
          '{"schemaVersion":1,"source":"dws_personal_stream"}'::jsonb,'retry_wait',NULL,NULL,NULL,2,NULL,
          '2025-01-01T00:00:00Z','2026-01-01T00:00:01Z','2026-01-01T00:00:01Z'),
        ('legacy-reply','tenant-a','inbox-v1','event-reply','chatbot_message','conv-reply','reply',
          '{"schemaVersion":1,"source":"dws_personal_stream"}'::jsonb,'reply_pending','session-v1','run-v1',
          '旧版本回复',2,'2025-01-01T00:00:00Z',NULL,'2026-01-01T00:00:02Z','2026-01-01T00:00:02Z')`);

    const store = new PgAgentDwsMessageStore(pool, prefix);
    const identity = {
      revision: 1, profileId: 'corp-v1:user-v1', corpId: 'corp-v1', dingtalkUserId: 'user-v1',
    };
    for (const expected of [
      ['legacy-pending', 'processing'], ['legacy-retry', 'processing'], ['legacy-reply', 'reply_pending'],
    ] as const) {
      const claimed = await store.claimNext('worker-v1', 60_000);
      expect(claimed).toMatchObject({ inboxId: expected[0], state: expected[1] });
      await expect(store.pinLegacyIdentityOrTerminate(
        claimed!.inboxId, 'worker-v1', claimed!.leaseFence, identity,
      )).resolves.toMatchObject({
        state: expected[1],
        payload: { accountIdentity: { profileId: 'corp-v1:user-v1', corpId: 'corp-v1', dingtalkUserId: 'user-v1' } },
      });
    }

    await pool.query(`UPDATE ${prefix}_agent_dws_accounts SET updated_at=NOW() WHERE account_id='inbox-v1'`);
    await pool.query(`INSERT INTO ${inboxTable}
      (inbox_id,tenant_id,account_id,event_id,event_type,conversation_id,content,payload_json,state,
       attempt,created_at,updated_at)
      VALUES ('legacy-unprovable','tenant-a','inbox-v1','event-unprovable','chatbot_message','conv-unprovable',
        'unprovable','{"schemaVersion":1,"source":"dws_personal_stream"}'::jsonb,'pending',0,
        '2026-01-01T00:00:03Z','2026-01-01T00:00:03Z')`);
    const unprovable = await store.claimNext('worker-v1', 60_000);
    const terminal = await store.pinLegacyIdentityOrTerminate(
      unprovable!.inboxId, 'worker-v1', unprovable!.leaseFence, identity,
    );
    expect(terminal).toMatchObject({
      state: 'dead_letter', lastError: 'DWS_INBOX_V1_IDENTITY_UNPROVABLE',
    });
    expect(terminal.leaseOwner).toBeUndefined();
    expect(terminal.nextAttemptAt).toBeUndefined();
    await expect(store.claimNext('worker-v1', 60_000)).resolves.toBeNull();

    await pool.query(`DELETE FROM ${prefix}_agent_dws_accounts WHERE account_id='inbox-v1'`);
    await pool.query(`DELETE FROM ${prefix}_managed_agents WHERE agent_id='agent-inbox-v1'`);
  });
});
