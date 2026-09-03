import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgGovernanceMigrationRunner } from '../data/governance-schema/migrations.js';
import { PgOrgGroupAgentStore } from '../data/orgGroupAgents/store.js';

const { Pool } = pg;
const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;

describePg('组织群 Agent PostgreSQL 不变量', () => {
  const prefix = `orggroup_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgOrgGroupAgentStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 4 });
    await new PgGovernanceMigrationRunner(pool, prefix).run();
    await pool.query(`INSERT INTO ${prefix}_managed_agents
      (agent_id,tenant_id,kind,owner_user_id,status,revision,created_by,updated_by)
      VALUES ('agent-a','tenant-a','org_agent','admin','enabled',1,'admin','admin')`);
    await pool.query(`INSERT INTO ${prefix}_agent_dws_accounts
      (account_id,tenant_id,agent_id,display_name,login_id,corp_id,dingtalk_user_id,profile_id,
       identity_updated_at,status,event_policy_json,created_by,updated_by)
      VALUES ('account-a','tenant-a','agent-a','群前台','group-frontdesk','corp-a','agent-member-a',
       'corp-a:agent-member-a',NOW(),'active','{"kinds":["at_me"]}'::jsonb,'admin','admin')`);
    store = new PgOrgGroupAgentStore(pool, prefix);
  }, 60_000);

  afterAll(async () => {
    if (!pool) return;
    try {
      const tables = await pool.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables
        WHERE schemaname=current_schema() AND LEFT(tablename,LENGTH($1))=$1`,
        [prefix],
      );
      for (const row of tables.rows)
        await pool.query(`DROP TABLE IF EXISTS "${row.tablename}" CASCADE`);
      const functions = await pool.query<{ proname: string; args: string }>(
        `SELECT p.proname,
        pg_get_function_identity_arguments(p.oid) AS args FROM pg_proc p
        JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname=current_schema() AND LEFT(p.proname,LENGTH($1))=$1`,
        [prefix],
      );
      for (const row of functions.rows)
        await pool.query(`DROP FUNCTION IF EXISTS "${row.proname}"(${row.args}) CASCADE`);
    } finally {
      await pool.end();
    }
  }, 30_000);

  it('pins binding/topic/work/attempt identity and keeps unknown delivery from automatic resend', async () => {
    const shadow = await store.ensureShadowBinding({
      tenantId: 'tenant-a',
      accountId: 'account-a',
      agentId: 'agent-a',
      conversationId: 'group-a',
      channelKind: 'group',
      workspaceId: 'agent-workspace-a',
    });
    await expect(
      store.ensureShadowBinding({
        tenantId: 'tenant-a',
        accountId: 'account-a',
        agentId: 'agent-a',
        conversationId: 'group-a',
        channelKind: 'group',
        workspaceId: 'agent-workspace-a',
      }),
    ).resolves.toMatchObject({ bindingId: shadow.bindingId });
    const binding = await store.updateBinding({
      tenantId: 'tenant-a',
      accountId: 'account-a',
      conversationId: 'group-a',
      expectedRevision: shadow.revision,
      enabled: true,
      policy: {
        enabled: true,
        membership: 'members',
        guest: 'deny',
        taskVisibility: 'conversation',
        completion: 'reply_to_work_conversation',
        liveDeny: false,
      },
      effectiveConfig: {
        identity: { displayName: '开开' },
        knowledge: { contextEnabled: true, sourceIds: ['kb-a'] },
        capabilities: { skillIds: ['skill-a'], toolNames: ['ContextSearch'] },
        access: { triggerRoles: ['member'], approvalRoles: ['admin'] },
        speech: { proactive: false, requireMention: true },
      },
    });
    const conversation = await store.getOrCreateWorkConversation({
      tenantId: 'tenant-a',
      bindingId: binding.bindingId,
      rootKey: 'root-message-a',
      rootMessageId: 'root-message-a',
    });
    await expect(
      store.getOrCreateWorkConversation({
        tenantId: 'tenant-a',
        bindingId: binding.bindingId,
        rootKey: 'root-message-a',
      }),
    ).resolves.toMatchObject({ workConversationId: conversation.workConversationId });

    const actor = {
      kind: 'external_user' as const,
      provider: 'dingtalk' as const,
      corpId: 'corp-a',
      openId: 'member-a',
      mappedUserId: 'user-a',
      assurance: 'mapped' as const,
    };
    const work = await store.createWorkOrder({
      tenantId: 'tenant-a',
      agentId: 'agent-a',
      bindingId: binding.bindingId,
      workConversationId: conversation.workConversationId,
      idempotencyKey: 'event-a:tool-a',
      title: '整理资料',
      visibility: 'conversation',
      createdByActor: actor,
      policySnapshot: { revision: binding.revision },
      cancelPolicy: { mode: 'conversation' },
    });
    await expect(
      store.createWorkOrder({
        tenantId: 'tenant-a',
        agentId: 'agent-a',
        bindingId: binding.bindingId,
        workConversationId: conversation.workConversationId,
        idempotencyKey: 'event-a:tool-a',
        title: '整理资料',
        visibility: 'conversation',
        createdByActor: actor,
        policySnapshot: { revision: binding.revision },
        cancelPolicy: { mode: 'conversation' },
      }),
    ).resolves.toMatchObject({ workOrderId: work.workOrderId });
    const attempt = await store.createWorkAttempt({
      tenantId: 'tenant-a',
      workOrderId: work.workOrderId,
      runtimeRunId: 'run-a',
      attemptId: 'attempt-a',
      taskWorkspaceId: 'task-workspace-a',
      sandboxScopeId: 'sandbox-a',
      mountSubPath: 'tasks/a',
      sharedReadOnlySubPath: 'shared/a',
    });

    const intent = await store.createDelivery({
      tenantId: 'tenant-a',
      accountId: 'account-a',
      conversationId: 'group-a',
      agentId: 'agent-a',
      bindingId: binding.bindingId,
      conversationSpaceId: binding.conversationSpaceId,
      workConversationId: conversation.workConversationId,
      policyRevision: binding.revision,
      visibility: 'conversation',
      sourceWorkOrderId: work.workOrderId,
      sourceAttemptId: attempt.attemptId,
      source: 'background_completion',
      deliveryKind: 'task_completion',
      disposition: 'replied',
      destination: {
        provider: 'dingtalk',
        accountId: 'account-a',
        conversationId: 'group-a',
        kind: 'group',
      },
      content: '任务完成',
      idempotencyKey: 'delivery-a',
    });
    const claimed = await store.claimDelivery(intent.deliveryId, 'worker-a', 60_000);
    await store.markDeliveryUnknown(
      intent.deliveryId,
      'worker-a',
      claimed.leaseFence,
      new Error('timeout after send'),
    );
    await expect(store.claimDelivery(intent.deliveryId, 'worker-b', 60_000)).rejects.toThrow(
      'DWS_DELIVERY_NOT_CLAIMABLE',
    );
    await store.reconcileDelivery({
      tenantId: 'tenant-a',
      deliveryId: intent.deliveryId,
      actorId: 'admin',
      reason: '渠道终态确认未发出',
      evidence: { status: 'not_found' },
      outcome: 'confirmed_not_sent',
    });
    const retried = await store.claimDelivery(intent.deliveryId, 'worker-b', 60_000);
    await expect(
      store.markDeliverySent(intent.deliveryId, 'worker-b', retried.leaseFence, {
        messageId: 'provider-message-a',
        status: 'accepted',
      }),
    ).resolves.toMatchObject({ deliveryState: 'sent' });

    const memory = await store.createMemory({
      tenantId: 'tenant-a',
      agentId: 'agent-a',
      bindingId: binding.bindingId,
      workConversationId: conversation.workConversationId,
      memoryScope: 'conversation',
      content: { fact: '群内事实' },
      provenance: { messageId: 'root-message-a' },
      policyRevision: binding.revision,
    });
    const promoted = await store.promoteMemory({
      tenantId: 'tenant-a',
      sourceMemoryId: memory.memoryId,
      promotedBy: 'admin',
      reason: '管理员确认',
      policyRevision: binding.revision,
    });
    await expect(
      store.changeMemoryStatus({
        tenantId: 'tenant-a',
        memoryId: promoted.memoryId,
        expectedVersion: promoted.version,
        status: 'revoked',
      }),
    ).resolves.toMatchObject({ status: 'revoked' });
    await expect(
      store.listMemories({ tenantId: 'tenant-b', agentId: 'agent-a', limit: 20 }),
    ).resolves.toEqual([]);
  });

  it('uses SKIP LOCKED claims so concurrent delivery workers never own the same intent', async () => {
    for (const suffix of ['b', 'c'])
      await store.createDelivery({
        tenantId: 'tenant-a',
        accountId: 'account-a',
        conversationId: 'direct-a',
        source: 'system',
        deliveryKind: 'system_notice',
        disposition: 'replied',
        destination: {
          provider: 'dingtalk',
          accountId: 'account-a',
          conversationId: 'direct-a',
          kind: 'direct',
          peerOpenId: 'member-a',
        },
        content: `notice-${suffix}`,
        idempotencyKey: `delivery-${suffix}`,
      });

    const claims = await Promise.all([
      store.claimNextDelivery('worker-b', 60_000),
      store.claimNextDelivery('worker-c', 60_000),
    ]);

    expect(claims.every(Boolean)).toBe(true);
    expect(new Set(claims.map((item) => item?.deliveryId)).size).toBe(2);
    expect(new Set(claims.map((item) => item?.leaseOwner))).toEqual(
      new Set(['worker-b', 'worker-c']),
    );
  });
});
