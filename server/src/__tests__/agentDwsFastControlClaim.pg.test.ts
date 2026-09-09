import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgAgentDwsMessageStore } from '../data/agentDwsMessages/store.js';
import { PgOrgGroupAgentStore } from '../data/orgGroupAgents/store.js';

const { Pool } = pg;
const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;

describePg('Agent DWS fast control claim lane', () => {
  const prefix = `fastctl_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgAgentDwsMessageStore;
  let orgStore: PgOrgGroupAgentStore;
  let accountIdentity: {
    profileId: string;
    corpId: string;
    dingtalkUserId: string;
    identityUpdatedAt: string;
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000 });
    store = new PgAgentDwsMessageStore(pool, prefix);
    orgStore = new PgOrgGroupAgentStore(pool, prefix);
    await store.init();
    await pool.query(`INSERT INTO ${prefix}_managed_agents
      (agent_id,tenant_id,kind,owner_user_id,status,revision,created_by,updated_by)
      VALUES ('agent-a','tenant-a','org_agent','admin','enabled',1,'admin','admin')`);
    const inserted = await pool.query(`INSERT INTO ${prefix}_agent_dws_accounts
      (account_id,tenant_id,agent_id,display_name,login_id,corp_id,dingtalk_user_id,profile_id,
       identity_updated_at,status,event_policy_json,created_by,updated_by)
      VALUES ('account-a','tenant-a','agent-a','员工','employee-a','corp-a','member-a',
       'corp-a:member-a',date_trunc('second',NOW()),'active',
       '{"kinds":["at_me"]}'::jsonb,'admin','admin')
       RETURNING profile_id,corp_id,dingtalk_user_id,identity_updated_at`);
    accountIdentity = {
      profileId: String(inserted.rows[0].profile_id), corpId: String(inserted.rows[0].corp_id),
      dingtalkUserId: String(inserted.rows[0].dingtalk_user_id),
      identityUpdatedAt: new Date(inserted.rows[0].identity_updated_at).toISOString(),
    };
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
    const contextual = await ingest('event-contextual-control', '暂停这个任务');
    expect((await ingest('event-control', '暂停 W-ABCDEF123456')).created).toBe(false);

    const normalClaim = await store.claimNext('normal-worker', 60_000);
    expect(normalClaim?.eventId).toBe('event-normal');
    const controlClaim = await store.claimNextControl('control-worker', 60_000);
    expect(controlClaim?.inboxId).toBe(control.record.inboxId);
    expect(controlClaim?.conversationId).toBe(normalClaim?.conversationId);
    await store.complete(controlClaim!.inboxId, 'control-worker', controlClaim!.leaseFence);
    expect((await store.claimNextControl('control-worker', 60_000))?.inboxId)
      .toBe(contextual.record.inboxId);
  });

  it('WorkOrder 变更与控制回执同事务提交，重领只复用结果', async () => {
    const currentAccount = await pool.query(`SELECT agent_id,profile_id,corp_id,
      dingtalk_user_id,identity_updated_at FROM ${prefix}_agent_dws_accounts
      WHERE tenant_id='tenant-a' AND account_id='account-a'`);
    expect(currentAccount.rows[0]).toMatchObject({
      agent_id: 'agent-a', profile_id: accountIdentity.profileId,
      corp_id: accountIdentity.corpId, dingtalk_user_id: accountIdentity.dingtalkUserId,
    });
    expect(Date.parse(currentAccount.rows[0].identity_updated_at))
      .toBe(Date.parse(accountIdentity.identityUpdatedAt));
    const binding = await orgStore.ensureShadowBinding({
      tenantId: 'tenant-a', accountId: 'account-a', agentId: 'agent-a',
      conversationId: 'group-receipt', channelKind: 'group', workspaceId: 'workspace-a',
      accountIdentity,
    });
    await pool.query(`UPDATE ${prefix}_org_agent_channel_bindings
      SET enabled=TRUE WHERE binding_id=$1`, [binding.bindingId]);
    const conversation = await orgStore.getOrCreateWorkConversation({
      tenantId: 'tenant-a', bindingId: binding.bindingId, rootKey: 'root-receipt',
    });
    const work = await orgStore.createWorkOrder({
      tenantId: 'tenant-a', agentId: 'agent-a', bindingId: binding.bindingId,
      workConversationId: conversation.workConversationId, idempotencyKey: 'receipt-work',
      title: '需要暂停的任务', visibility: 'conversation',
      createdByActor: {
        kind: 'external_user', provider: 'dingtalk', corpId: 'corp-a', openId: 'member-a',
        assurance: 'mapped', mappedUserId: 'user-a', role: 'member',
      },
      policySnapshot: {}, cancelPolicy: {},
    });
    const ingested = await store.ingest({
      tenantId: 'tenant-a', accountId: 'account-a', eventId: 'event-receipt',
      eventType: 'user_im_message_receive_at', conversationId: 'group-receipt',
      senderOpenDingtalkId: 'member-a', content: `暂停 ${work.shortId}`,
    }, {
      schemaVersion: 2, source: 'dws_personal_stream',
      accountIdentity: {
        profileId: 'corp-a:member-a', corpId: 'corp-a', dingtalkUserId: 'member-a',
      },
    });
    const claim = (await store.claimNextControl('control-worker', 60_000))!;
    const responseText = `任务 ${work.shortId} 已暂停，当前状态：paused`;
    await orgStore.pauseWorkOrder({
      tenantId: 'tenant-a', workOrderId: work.workOrderId, expectedVersion: work.version,
      inboxReceipt: {
        inboxId: claim.inboxId, leaseOwner: 'control-worker',
        leaseFence: claim.leaseFence, responseText,
      },
    });
    await pool.query(`UPDATE ${prefix}_agent_dws_event_inbox
      SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE inbox_id=$1`, [claim.inboxId]);
    const replay = await store.claimNextControl('next-worker', 60_000);
    expect(replay).toMatchObject({
      inboxId: ingested.record.inboxId, state: 'reply_pending', responseText,
    });
    expect(await orgStore.getWorkOrder('tenant-a', work.workOrderId)).toMatchObject({
      state: 'paused', version: work.version + 1,
    });
  });

  it('租约丢失时 WorkOrder 与控制回执整体回滚', async () => {
    const binding = await orgStore.ensureShadowBinding({
      tenantId: 'tenant-a', accountId: 'account-a', agentId: 'agent-a',
      conversationId: 'group-lost', channelKind: 'group', workspaceId: 'workspace-a',
      accountIdentity,
    });
    await pool.query(`UPDATE ${prefix}_org_agent_channel_bindings
      SET enabled=TRUE WHERE binding_id=$1`, [binding.bindingId]);
    const conversation = await orgStore.getOrCreateWorkConversation({
      tenantId: 'tenant-a', bindingId: binding.bindingId, rootKey: 'root-lost',
    });
    const work = await orgStore.createWorkOrder({
      tenantId: 'tenant-a', agentId: 'agent-a', bindingId: binding.bindingId,
      workConversationId: conversation.workConversationId, idempotencyKey: 'lost-work',
      title: '不应暂停的任务', visibility: 'conversation',
      createdByActor: {
        kind: 'external_user', provider: 'dingtalk', corpId: 'corp-a', openId: 'member-a',
        assurance: 'mapped', mappedUserId: 'user-a', role: 'member',
      },
      policySnapshot: {}, cancelPolicy: {},
    });
    await store.ingest({
      tenantId: 'tenant-a', accountId: 'account-a', eventId: 'event-lost',
      eventType: 'user_im_message_receive_at', conversationId: 'group-lost',
      senderOpenDingtalkId: 'member-a', content: `暂停 ${work.shortId}`,
    }, {
      schemaVersion: 2, source: 'dws_personal_stream',
      accountIdentity: {
        profileId: 'corp-a:member-a', corpId: 'corp-a', dingtalkUserId: 'member-a',
      },
    });
    const claim = (await store.claimNextControl('stale-worker', 60_000))!;
    await pool.query(`UPDATE ${prefix}_agent_dws_event_inbox
      SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE inbox_id=$1`, [claim.inboxId]);
    await expect(orgStore.pauseWorkOrder({
      tenantId: 'tenant-a', workOrderId: work.workOrderId, expectedVersion: work.version,
      inboxReceipt: {
        inboxId: claim.inboxId, leaseOwner: 'stale-worker', leaseFence: claim.leaseFence,
        responseText: '不应提交',
      },
    })).rejects.toThrow('ORG_AGENT_FAST_CONTROL_LEASE_LOST');
    expect(await orgStore.getWorkOrder('tenant-a', work.workOrderId)).toMatchObject({
      state: 'queued', version: work.version,
    });
    expect((await store.getById('tenant-a', claim.inboxId))?.responseText).toBeUndefined();
  });
});
