import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgAgentDwsMessageStore } from '../data/agentDwsMessages/store.js';

const { Pool } = pg;
const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;

describePg('Agent DWS fast control claim lane', () => {
  const prefix = `fastctl_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgAgentDwsMessageStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000 });
    store = new PgAgentDwsMessageStore(pool, prefix);
    await store.init();
    await pool.query(`INSERT INTO ${prefix}_managed_agents
      (agent_id,tenant_id,kind,owner_user_id,status,revision,created_by,updated_by)
      VALUES ('agent-a','tenant-a','org_agent','admin','enabled',1,'admin','admin')`);
    await pool.query(`INSERT INTO ${prefix}_agent_dws_accounts
      (account_id,tenant_id,agent_id,display_name,login_id,corp_id,dingtalk_user_id,profile_id,
       identity_updated_at,status,event_policy_json,created_by,updated_by)
      VALUES ('account-a','tenant-a','agent-a','员工','employee-a','corp-a','member-a',
       'corp-a:member-a',NOW(),'active','{"kinds":["at_me"]}'::jsonb,'admin','admin')`);
  }, 60_000);

  afterAll(async () => {
    if (!pool) return;
    const tables = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname=current_schema()
       AND LEFT(tablename,LENGTH($1))=$1`,
      [prefix],
    );
    for (const row of tables.rows)
      await pool.query(`DROP TABLE IF EXISTS "${row.tablename}" CASCADE`);
    await pool.end();
  });

  it('普通任务占用同一会话时控制 lane 仍可领取，且重复 event 幂等', async () => {
    const ingest = async (eventId: string, content: string) =>
      await store.ingest(
        {
          tenantId: 'tenant-a',
          accountId: 'account-a',
          eventId,
          eventType: 'user_im_message_receive_at',
          conversationId: 'group-a',
          senderOpenDingtalkId: 'member-a',
          content,
        },
        {
          schemaVersion: 2,
          source: 'dws_personal_stream',
          accountIdentity: {
            profileId: 'corp-a:member-a',
            corpId: 'corp-a',
            dingtalkUserId: 'member-a',
          },
        },
      );
    await ingest('event-normal', '请执行一个很长的普通任务');
    const control = await ingest('event-control', '暂停 W-ABCDEF123456');
    expect((await ingest('event-control', '暂停 W-ABCDEF123456')).created).toBe(false);

    const normalClaim = await store.claimNext('normal-worker', 60_000);
    expect(normalClaim?.eventId).toBe('event-normal');
    const controlClaim = await store.claimNextControl('control-worker', 60_000);
    expect(controlClaim?.inboxId).toBe(control.record.inboxId);
    expect(controlClaim?.conversationId).toBe(normalClaim?.conversationId);
  });
});
