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

  it('V34 原子补 pin 存量路由，运行态更新不冒充身份变化，重授权仍 fail closed', async () => {
    const accountsTable = `${prefix}_agent_dws_accounts`;
    const inboxTable = `${prefix}_agent_dws_event_inbox`;
    const runsTable = `${prefix}_runs`;
    await pool.query(`CREATE TABLE ${runsTable} (
      run_id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,channel TEXT,requested_at TIMESTAMPTZ NOT NULL,
      metadata JSONB NOT NULL
    )`);
    await pool.query(`INSERT INTO ${prefix}_managed_agents
      (agent_id,tenant_id,kind,owner_user_id,status,revision,created_by,updated_by)
      VALUES
        ('agent-inbox-v1','tenant-a','org_agent','admin','enabled',1,'admin','admin'),
        ('agent-inbox-reauthed','tenant-a','org_agent','admin','enabled',1,'admin','admin')`);
    await pool.query(`ALTER TABLE ${accountsTable} DROP CONSTRAINT ${prefix}_adws_active_identity_ck`);
    await pool.query(`ALTER TABLE ${accountsTable} ALTER COLUMN identity_updated_at DROP NOT NULL`);
    await pool.query(`INSERT INTO ${accountsTable}
      (account_id,tenant_id,agent_id,display_name,login_id,corp_id,dingtalk_user_id,profile_id,
       status,event_policy_json,revision,created_at,created_by,identity_updated_at,updated_at,updated_by)
      VALUES ('inbox-v1','tenant-a','agent-inbox-v1','旧 inbox 账号','inbox-v1-login',
        'corp-v1','user-v1','corp-v1:user-v1','active','{"kinds":["at_me"]}'::jsonb,
        3,'2025-01-01T00:00:00Z','admin',NULL,'2025-01-01T00:00:00Z','system:agent-dws-auth'),
        ('inbox-reauthed','tenant-a','agent-inbox-reauthed','已重授权账号','inbox-reauthed-login',
        'corp-current','user-current','corp-current:user-current','active','{"kinds":["at_me"]}'::jsonb,
        5,'2025-01-01T00:00:00Z','admin',NULL,'2026-03-01T00:00:00Z','system:agent-dws-auth')`);
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
    await pool.query(`INSERT INTO ${inboxTable}
      (inbox_id,tenant_id,account_id,event_id,event_type,conversation_id,content,payload_json,state,
       attempt,lease_owner,lease_expires_at,created_at,updated_at)
      VALUES ('legacy-processing','tenant-a','inbox-v1','event-processing','chatbot_message','conv-processing',
        'processing','{"schemaVersion":1,"source":"dws_personal_stream"}'::jsonb,'processing',1,
        'old-worker','2099-01-01T00:00:00Z','2026-01-01T00:00:03Z','2026-01-01T00:00:03Z')`);
    await pool.query(`INSERT INTO ${inboxTable}
      (inbox_id,tenant_id,account_id,event_id,event_type,conversation_id,content,payload_json,state,
       attempt,created_at,updated_at)
      VALUES ('legacy-pre-reauth','tenant-a','inbox-reauthed','event-pre-reauth',
        'chatbot_message','conv-pre-reauth','pre-reauth',
        '{"schemaVersion":1,"source":"dws_personal_stream"}'::jsonb,'pending',0,
        '2026-02-01T00:00:00Z','2026-02-01T00:00:00Z')`);
    await pool.query(`INSERT INTO ${runsTable} (run_id,tenant_id,channel,requested_at,metadata) VALUES
      ('parent-legacy','tenant-a','dingtalk','2026-01-01T00:00:00Z','{}'::jsonb),
      ('legacy-completion','tenant-a','background_task','2026-01-02T00:00:00Z',
       '{"backgroundTask":true,"parentRunId":"parent-legacy","parentChannel":"dingtalk","dwsCompletionRoute":{
         "accountId":"inbox-v1","conversationId":"conv-run","eventType":"user_im_message_receive_o2o_all"
       }}'::jsonb),
      ('partial-corp','tenant-a','background_task','2026-01-02T00:00:00Z',
       '{"backgroundTask":true,"parentRunId":"parent-legacy","parentChannel":"dingtalk","dwsCompletionRoute":{
         "accountId":"inbox-v1","corpId":"corp-conflict","conversationId":"conv-partial-corp",
         "eventType":"user_im_message_receive_o2o_all"
       }}'::jsonb),
      ('partial-user','tenant-a','background_task','2026-01-02T00:00:00Z',
       '{"backgroundTask":true,"parentRunId":"parent-legacy","parentChannel":"dingtalk","dwsCompletionRoute":{
         "accountId":"inbox-v1","dingtalkUserId":"user-conflict","conversationId":"conv-partial-user",
         "eventType":"user_im_message_receive_o2o_all"
       }}'::jsonb),
      ('partial-missing','tenant-a','background_task','2026-01-02T00:00:00Z',
       '{"backgroundTask":true,"parentRunId":"parent-legacy","parentChannel":"dingtalk","dwsCompletionRoute":{
         "accountId":"inbox-v1","corpId":"corp-v1","conversationId":"conv-partial-missing",
         "eventType":"user_im_message_receive_o2o_all"
       }}'::jsonb),
      ('parent-pre-reauth','tenant-a','dingtalk','2026-02-01T00:00:00Z','{}'::jsonb),
      ('legacy-completion-pre-reauth','tenant-a','background_task','2026-04-01T00:00:00Z',
       '{"backgroundTask":true,"parentRunId":"parent-pre-reauth","parentChannel":"dingtalk","dwsCompletionRoute":{
         "accountId":"inbox-reauthed","conversationId":"conv-old","eventType":"user_im_message_receive_o2o_all"
       }}'::jsonb)`);

    const accountStore = new PgAgentDwsAccountStore(pool, prefix);
    await accountStore.updateRuntimeStatus('inbox-v1', 'starting', undefined, undefined, 3);
    await expect(accountStore.claimRuntimeLease('inbox-v1', 'legacy-runtime', 60_000, 3))
      .resolves.toBe(true);
    await expect(accountStore.markEvent(
      'inbox-v1', 'legacy-runtime', new Date('2026-05-01T00:00:00Z'), 3,
    )).resolves.toBe(true);
    await accountStore.releaseRuntimeLease('inbox-v1', 'legacy-runtime');
    const runtimeUpdated = await pool.query<{ updated_at: Date }>(
      `SELECT updated_at FROM ${accountsTable} WHERE account_id='inbox-v1'`,
    );
    expect(runtimeUpdated.rows[0]!.updated_at.getTime()).toBeGreaterThan(
      new Date('2026-01-02T00:00:00Z').getTime(),
    );

    await rerunV34();
    const account = await accountStore.getForTenant('tenant-a', 'inbox-v1');
    expect(account).toMatchObject({
      profileId: 'corp-v1:user-v1', corpId: 'corp-v1', dingtalkUserId: 'user-v1', revision: 3,
      identityUpdatedAt: '2025-01-01T00:00:00.000Z',
    });
    const pinnedRun = await pool.query(`SELECT metadata FROM ${runsTable} WHERE run_id='legacy-completion'`);
    expect(pinnedRun.rows[0]?.metadata.dwsCompletionRoute).toMatchObject({
      accountId: 'inbox-v1', profileId: 'corp-v1:user-v1', corpId: 'corp-v1', dingtalkUserId: 'user-v1',
    });
    const partialRuns = await pool.query(`SELECT run_id,metadata->'dwsCompletionRoute' AS route
      FROM ${runsTable} WHERE run_id IN ('partial-corp','partial-user','partial-missing')`);
    const partialRoutes = Object.fromEntries(partialRuns.rows.map(row => [row.run_id, row.route]));
    expect(partialRoutes['partial-corp']).toMatchObject({ corpId: 'corp-conflict' });
    expect(partialRoutes['partial-corp']).not.toHaveProperty('profileId');
    expect(partialRoutes['partial-corp']).not.toHaveProperty('dingtalkUserId');
    expect(partialRoutes['partial-user']).toMatchObject({ dingtalkUserId: 'user-conflict' });
    expect(partialRoutes['partial-user']).not.toHaveProperty('profileId');
    expect(partialRoutes['partial-user']).not.toHaveProperty('corpId');
    expect(partialRoutes['partial-missing']).toMatchObject({ corpId: 'corp-v1' });
    expect(partialRoutes['partial-missing']).not.toHaveProperty('profileId');
    expect(partialRoutes['partial-missing']).not.toHaveProperty('dingtalkUserId');
    const pinnedProcessing = await pool.query(`SELECT payload_json FROM ${inboxTable}
      WHERE inbox_id='legacy-processing'`);
    expect(pinnedProcessing.rows[0]?.payload_json.accountIdentity).toEqual({
      profileId: 'corp-v1:user-v1', corpId: 'corp-v1', dingtalkUserId: 'user-v1',
    });
    const unprovenInbox = await pool.query(`SELECT payload_json FROM ${inboxTable}
      WHERE inbox_id='legacy-pre-reauth'`);
    expect(unprovenInbox.rows[0]?.payload_json).not.toHaveProperty('accountIdentity');
    const unprovenRun = await pool.query(`SELECT metadata FROM ${runsTable}
      WHERE run_id='legacy-completion-pre-reauth'`);
    expect(unprovenRun.rows[0]?.metadata.dwsCompletionRoute).not.toHaveProperty('profileId');

    const store = new PgAgentDwsMessageStore(pool, prefix);
    for (const expected of [
      ['legacy-pending', 'processing'], ['legacy-retry', 'processing'], ['legacy-reply', 'reply_pending'],
    ] as const) {
      const claimed = await store.claimNext('worker-v1', 60_000);
      expect(claimed).toMatchObject({
        inboxId: expected[0], state: expected[1],
        payload: { accountIdentity: {
          profileId: 'corp-v1:user-v1', corpId: 'corp-v1', dingtalkUserId: 'user-v1',
        } },
      });
    }

    const preReauth = await store.claimNext('worker-pre-reauth', 60_000);
    expect(preReauth?.inboxId).toBe('legacy-pre-reauth');
    await expect(store.pinLegacyIdentityOrTerminate(
      preReauth!.inboxId, 'worker-pre-reauth', preReauth!.leaseFence, {
        profileId: 'corp-current:user-current',
        corpId: 'corp-current', dingtalkUserId: 'user-current',
      },
    )).resolves.toMatchObject({
      state: 'dead_letter', lastError: 'DWS_INBOX_V1_IDENTITY_UNPROVABLE',
    });

    const identityBeforeSameAuth = (await accountStore.getForTenant('tenant-a', 'inbox-v1'))!.identityUpdatedAt;
    await pool.query(`INSERT INTO ${inboxTable}
      (inbox_id,tenant_id,account_id,event_id,event_type,conversation_id,content,payload_json,state,
       attempt,created_at,updated_at)
      VALUES ('legacy-same-auth','tenant-a','inbox-v1','event-same-auth','chatbot_message','conv-same-auth',
        'same-auth','{"schemaVersion":1,"source":"dws_personal_stream"}'::jsonb,'pending',0,NOW(),NOW())`);
    await pool.query(`INSERT INTO ${runsTable} (run_id,tenant_id,channel,requested_at,metadata) VALUES
      ('parent-same-auth','tenant-a','dingtalk','2090-01-01T00:00:00Z','{}'::jsonb),
      ('legacy-completion-same-auth','tenant-a','background_task','2090-01-02T00:00:00Z',
       '{"backgroundTask":true,"parentRunId":"parent-same-auth","parentChannel":"dingtalk","dwsCompletionRoute":{
         "accountId":"inbox-v1","conversationId":"conv-same-run","eventType":"user_im_message_receive_o2o_all"
       }}'::jsonb)`);
    await accountStore.markAuthorizing('tenant-a', 'inbox-v1', 3, 'admin:same-reauthorize');
    const sameIdentity = await accountStore.markAuthorized('tenant-a', 'inbox-v1', 4, {
      profileId: 'corp-v1:user-v1', corpId: 'corp-v1', dingtalkUserId: 'user-v1',
    }, 'admin:same-reauthorize');
    expect(sameIdentity).toMatchObject({ revision: 5, identityUpdatedAt: identityBeforeSameAuth });
    await rerunV34();
    const sameAuthInbox = await pool.query(`SELECT payload_json FROM ${inboxTable}
      WHERE inbox_id='legacy-same-auth'`);
    expect(sameAuthInbox.rows[0]?.payload_json.accountIdentity).toEqual({
      profileId: 'corp-v1:user-v1', corpId: 'corp-v1', dingtalkUserId: 'user-v1',
    });
    const sameAuthRun = await pool.query(`SELECT metadata FROM ${runsTable}
      WHERE run_id='legacy-completion-same-auth'`);
    expect(sameAuthRun.rows[0]?.metadata.dwsCompletionRoute).toMatchObject({
      profileId: 'corp-v1:user-v1', corpId: 'corp-v1', dingtalkUserId: 'user-v1',
    });
    const sameAuthClaim = await store.claimNext('worker-same-auth', 60_000);
    expect(sameAuthClaim).toMatchObject({ inboxId: 'legacy-same-auth', state: 'processing' });
    await store.complete(sameAuthClaim!.inboxId, 'worker-same-auth', sameAuthClaim!.leaseFence);

    await pool.query(`INSERT INTO ${inboxTable}
      (inbox_id,tenant_id,account_id,event_id,event_type,conversation_id,content,payload_json,state,
       session_id,run_id,response_text,attempt,lease_expires_at,created_at,updated_at)
      VALUES ('v2-reply-recovery','tenant-a','inbox-v1','event-v2-reply','chatbot_message','conv-v2-reply',
        'reply','{"schemaVersion":2,"source":"dws_personal_stream","accountIdentity":{
          "profileId":"corp-v1:user-v1","corpId":"corp-v1","dingtalkUserId":"user-v1"
        }}'::jsonb,'reply_pending','session-v2','run-v2','已持久化回复',1,
        '2025-01-01T00:00:00Z','2026-04-01T00:00:00Z','2026-04-01T00:00:00Z')`);
    const recoveredV2 = await store.claimNext('worker-v2-reply', 60_000);
    expect(recoveredV2).toMatchObject({
      inboxId: 'v2-reply-recovery', state: 'reply_pending', responseText: '已持久化回复',
    });
    await store.complete(recoveredV2!.inboxId, 'worker-v2-reply', recoveredV2!.leaseFence);

    await accountStore.updateRuntimeStatus('inbox-v1', 'ready', undefined, undefined, 5);
    await expect(accountStore.claimRuntimeLease('inbox-v1', 'runtime-v1', 60_000, 5)).resolves.toBe(true);
    await expect(accountStore.markEvent('inbox-v1', 'runtime-v1', new Date(), 5)).resolves.toBe(true);
    await accountStore.releaseRuntimeLease('inbox-v1', 'runtime-v1');
    await pool.query(`INSERT INTO ${inboxTable}
      (inbox_id,tenant_id,account_id,event_id,event_type,conversation_id,content,payload_json,state,
       attempt,created_at,updated_at)
      VALUES ('legacy-runtime','tenant-a','inbox-v1','event-runtime','chatbot_message','conv-runtime',
        'runtime','{"schemaVersion":1,"source":"dws_personal_stream"}'::jsonb,'pending',0,NOW(),NOW())`);
    const runtimeOnly = await store.claimNext('worker-runtime', 60_000);
    const policyRace = await accountStore.setEnabled('tenant-a', 'inbox-v1', true, 5, 'admin:policy-race');
    expect(policyRace).toMatchObject({ revision: 6, identityUpdatedAt: identityBeforeSameAuth });
    await expect(store.pinLegacyIdentityOrTerminate(
      runtimeOnly!.inboxId, 'worker-runtime', runtimeOnly!.leaseFence, {
        profileId: 'corp-v1:user-v1', corpId: 'corp-v1', dingtalkUserId: 'user-v1',
      },
    )).resolves.toMatchObject({ state: 'processing', payload: { accountIdentity: {
      profileId: 'corp-v1:user-v1', corpId: 'corp-v1', dingtalkUserId: 'user-v1',
    } } });

    await pool.query(`INSERT INTO ${inboxTable}
      (inbox_id,tenant_id,account_id,event_id,event_type,conversation_id,content,payload_json,state,
       attempt,created_at,updated_at)
      VALUES ('legacy-changed','tenant-a','inbox-v1','event-changed','chatbot_message','conv-changed',
        'changed','{"schemaVersion":1,"source":"dws_personal_stream"}'::jsonb,'pending',0,
        NOW()-INTERVAL '1 minute',NOW())`);
    await accountStore.markAuthorizing('tenant-a', 'inbox-v1', 6, 'admin:reauthorize');
    const reauthorized = await accountStore.markAuthorized('tenant-a', 'inbox-v1', 7, {
      profileId: 'corp-v2:user-v2', corpId: 'corp-v2', dingtalkUserId: 'user-v2',
    }, 'admin:reauthorize');
    const changed = await store.claimNext('worker-changed', 60_000);
    const terminal = await store.pinLegacyIdentityOrTerminate(
      changed!.inboxId, 'worker-changed', changed!.leaseFence, {
        profileId: 'corp-v2:user-v2', corpId: 'corp-v2', dingtalkUserId: 'user-v2',
      },
    );
    expect(terminal).toMatchObject({
      state: 'dead_letter', lastError: 'DWS_INBOX_V1_IDENTITY_UNPROVABLE',
    });
    expect(terminal.leaseOwner).toBeUndefined();

    await pool.query(`DROP TABLE ${runsTable}`);
    await pool.query(`DELETE FROM ${accountsTable}
      WHERE account_id IN ('inbox-v1','inbox-reauthed')`);
    await pool.query(`DELETE FROM ${prefix}_managed_agents
      WHERE agent_id IN ('agent-inbox-v1','agent-inbox-reauthed')`);
  });
});
