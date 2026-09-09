import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgAgentDwsAccountStore } from '../data/agentDwsAccounts/store.js';

const { Pool } = pg;
const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;

describePg('Agent DWS 账号换绑 PostgreSQL CAS 与身份分代', () => {
  const prefix = `dws_rebind_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const table = `${prefix}_agent_dws_accounts`;
  let pool: InstanceType<typeof Pool>;
  let store: PgAgentDwsAccountStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 2 });
    await pool.query(`CREATE TABLE ${table} (
      account_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      display_name TEXT NOT NULL, login_id TEXT NOT NULL, corp_id TEXT, corp_name TEXT,
      dingtalk_user_id TEXT, dingtalk_user_name TEXT, profile_id TEXT,
      status TEXT NOT NULL, runtime_status TEXT NOT NULL,
      event_policy_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_event_at TIMESTAMPTZ, last_error TEXT, revision INTEGER NOT NULL,
      runtime_lease_owner TEXT, runtime_lease_expires_at TIMESTAMPTZ,
      identity_updated_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL,
      created_by TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL, updated_by TEXT NOT NULL
    )`);
    store = new PgAgentDwsAccountStore(pool, prefix);
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      await pool.query(`DROP TABLE IF EXISTS ${table}`);
    } finally {
      await pool.end();
    }
  });

  it('显式 replace_identity 保留 account/Agent 并推进单调身份 epoch，旧 revision 不能覆盖', async () => {
    await insertAccount('account-replace');
    const authorizing = await store.markAuthorizing(
      'tenant-a',
      'account-replace',
      1,
      'admin-a',
      'replace_identity',
    );
    expect(authorizing).toMatchObject({
      accountId: 'account-replace',
      agentId: 'agent-a',
      revision: 2,
      authorizationIntent: {
        mode: 'replace_identity',
        expectedProfileId: 'corp-a:old-user',
        expectedIdentityUpdatedAt: '2026-09-08T00:00:00.000Z',
      },
    });

    const rebound = await store.markAuthorized(
      'tenant-a',
      'account-replace',
      2,
      { profileId: 'corp-a:new-user', corpId: 'corp-a', dingtalkUserId: 'new-user' },
      'system:agent-dws-auth',
    );
    expect(rebound).toMatchObject({
      accountId: 'account-replace',
      agentId: 'agent-a',
      profileId: 'corp-a:new-user',
      dingtalkUserId: 'new-user',
      revision: 3,
      status: 'active',
    });
    expect(Date.parse(rebound.identityUpdatedAt!)).toBeGreaterThan(
      Date.parse('2026-09-08T00:00:00.000Z'),
    );
    expect(rebound.authorizationIntent).toBeUndefined();
    expect(rebound.identityCleanupPending).toMatchObject({
      previous: {
        profileId: 'corp-a:old-user',
        corpId: 'corp-a',
        dingtalkUserId: 'old-user',
        identityUpdatedAt: '2026-09-08T00:00:00.000Z',
      },
      streamStopped: false,
      contextInvalidated: false,
    });

    await expect(
      store.markAuthorizing('tenant-a', 'account-replace', 3, 'admin-a', 'replace_identity'),
    ).rejects.toMatchObject({ code: 'AGENT_DWS_ACCOUNT_REVISION_CONFLICT' });

    const streamStopped = await store.markIdentityCleanupStep!(
      'tenant-a',
      'account-replace',
      rebound.identityUpdatedAt!,
      'stream_stopped',
    );
    expect(streamStopped.identityCleanupPending?.streamStopped).toBe(true);
    const cleaned = await store.markIdentityCleanupStep!(
      'tenant-a',
      'account-replace',
      rebound.identityUpdatedAt!,
      'context_invalidated',
    );
    expect(cleaned.identityCleanupPending).toBeUndefined();

    await expect(
      store.markAuthorized(
        'tenant-a',
        'account-replace',
        2,
        { profileId: 'corp-a:other-user', corpId: 'corp-a', dingtalkUserId: 'other-user' },
        'system:stale-auth',
      ),
    ).rejects.toMatchObject({ code: 'AGENT_DWS_ACCOUNT_REVISION_CONFLICT' });
  });

  it('首次授权不创建空 previous cleanup pending', async () => {
    await pool.query(
      `INSERT INTO ${table} (
      account_id,tenant_id,agent_id,display_name,login_id,status,runtime_status,
      event_policy_json,revision,created_at,created_by,updated_at,updated_by
    ) VALUES ('account-first','tenant-a','agent-a','数字员工','agent-login',
      'draft','stopped',$1::jsonb,1,NOW(),'admin-a',NOW(),'admin-a')`,
      [JSON.stringify({ kinds: ['at_me'] })],
    );
    await store.markAuthorizing('tenant-a', 'account-first', 1, 'admin-a');
    const authorized = await store.markAuthorized(
      'tenant-a',
      'account-first',
      2,
      { profileId: 'corp-a:first', corpId: 'corp-a', dingtalkUserId: 'first' },
      'system:agent-dws-auth',
    );
    expect(authorized.identityCleanupPending).toBeUndefined();
    const raw = await pool.query(
      `SELECT event_policy_json FROM ${table} WHERE account_id='account-first'`,
    );
    expect(raw.rows[0].event_policy_json).not.toHaveProperty('identityCleanupPending');
  });

  it('普通 reauthorize 不能静默换成另一成员，旧身份保持不变', async () => {
    await insertAccount('account-refresh');
    await store.markAuthorizing('tenant-a', 'account-refresh', 1, 'admin-a', 'reauthorize');

    await expect(
      store.markAuthorized(
        'tenant-a',
        'account-refresh',
        2,
        { profileId: 'corp-a:new-user', corpId: 'corp-a', dingtalkUserId: 'new-user' },
        'system:agent-dws-auth',
      ),
    ).rejects.toMatchObject({ code: 'AGENT_DWS_ACCOUNT_REVISION_CONFLICT' });
    const current = await store.getForTenant('tenant-a', 'account-refresh');
    expect(current).toMatchObject({
      accountId: 'account-refresh',
      agentId: 'agent-a',
      profileId: 'corp-a:old-user',
      dingtalkUserId: 'old-user',
      identityUpdatedAt: '2026-09-08T00:00:00.000Z',
      status: 'authorizing',
      revision: 2,
    });
  });

  async function insertAccount(accountId: string): Promise<void> {
    await pool.query(
      `INSERT INTO ${table} (
      account_id,tenant_id,agent_id,display_name,login_id,corp_id,dingtalk_user_id,
      profile_id,status,runtime_status,event_policy_json,revision,identity_updated_at,
      created_at,created_by,updated_at,updated_by
    ) VALUES ($1,'tenant-a','agent-a','数字员工','agent-login','corp-a','old-user',
      'corp-a:old-user','active','ready',$2::jsonb,1,'2026-09-08T00:00:00.000Z',
      NOW(),'admin-a',NOW(),'admin-a')`,
      [accountId, JSON.stringify({ kinds: ['at_me'] })],
    );
  }
});
