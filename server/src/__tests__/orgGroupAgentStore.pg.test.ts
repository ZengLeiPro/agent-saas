import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgGovernanceMigrationRunner } from '../data/governance-schema/migrations.js';
import { PgOrgGroupAgentStore } from '../data/orgGroupAgents/store.js';
import { PgAgentDwsMessageStore } from '../data/agentDwsMessages/store.js';

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
        access: { triggerRoles: ['member'], approvalRoles: ['org_admin'] },
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
    const terminalEnvelope = {
      status: 'completed' as const, summary: '完成', facts: [],
      artifacts: [{ path: '报告.txt', digest: `sha256:${'a'.repeat(64)}`, size: 12 }],
      writeScope: ['tasks/a'],
    };
    await expect(store.getWorkOrder('tenant-a', work.workOrderId))
      .resolves.toMatchObject({ state: 'queued', currentAttemptNo: 1 });
    await expect(store.transitionWorkAttempt({
      tenantId: 'tenant-a', runtimeRunId: 'run-a', status: 'running',
    })).resolves.toMatchObject({ status: 'running' });
    await expect(store.getWorkOrder('tenant-a', work.workOrderId))
      .resolves.toMatchObject({ state: 'running', currentAttemptNo: 1 });
    await store.transitionWorkAttempt({ tenantId: 'tenant-a', runtimeRunId: 'run-a',
      status: 'completed', resultEnvelope: terminalEnvelope,
      checkpoint: { step: 'finished' },
      artifactManifest: { version: 1, files: terminalEnvelope.artifacts, totalBytes: 12,
        capturedAt: '2026-09-04T00:00:00.000Z' },
      publishState: 'pending' });
    const publishedAttempt = await store.transitionWorkAttemptPublishState({
      tenantId: 'tenant-a', attemptId: attempt.attemptId, expectedState: 'pending',
      state: 'published', artifactManifest: { version: 1, files: terminalEnvelope.artifacts,
        totalBytes: 12, capturedAt: '2026-09-04T00:00:00.000Z',
        publishedRoot: `published/${work.workOrderId}/${attempt.attemptId}` },
    });
    expect(publishedAttempt).toMatchObject({ publishState: 'published',
      checkpoint: { step: 'finished' }, artifactManifest: { totalBytes: 12 } });
    await expect(store.transitionWorkAttemptPublishState({
      tenantId: 'tenant-a', attemptId: attempt.attemptId, expectedState: 'pending', state: 'rejected',
    })).rejects.toThrow('ORG_AGENT_ARTIFACT_PUBLISH_STATE_CONFLICT');
    const runningWork = await store.getWorkOrder('tenant-a', work.workOrderId);
    await store.transitionWorkOrder({ tenantId: 'tenant-a', workOrderId: work.workOrderId,
      expectedVersion: runningWork!.version, state: 'completed', resultEnvelope: terminalEnvelope });
    await expect(store.createWorkAttempt({
      tenantId: 'tenant-a', workOrderId: work.workOrderId, runtimeRunId: 'run-a',
      attemptId: 'attempt-a', taskWorkspaceId: 'task-workspace-a', sandboxScopeId: 'sandbox-a',
      mountSubPath: 'tasks/a', sharedReadOnlySubPath: 'shared/a',
    })).resolves.toMatchObject({ attemptId: 'attempt-a', status: 'completed',
      resultEnvelope: terminalEnvelope });
    await expect(store.createWorkAttempt({
      tenantId: 'tenant-a', workOrderId: work.workOrderId, runtimeRunId: 'run-a',
      attemptId: 'attempt-a', taskWorkspaceId: 'task-workspace-a', sandboxScopeId: 'sandbox-a',
      mountSubPath: 'tasks/tampered', sharedReadOnlySubPath: 'shared/a',
    })).rejects.toThrow('ORG_AGENT_WORK_ATTEMPT_IDEMPOTENCY_CONFLICT');
    const otherWork = await store.createWorkOrder({
      tenantId: 'tenant-a', agentId: 'agent-a', bindingId: binding.bindingId,
      workConversationId: conversation.workConversationId, idempotencyKey: 'event-other:tool-a',
      title: '另一项工作', visibility: 'conversation', createdByActor: actor,
      policySnapshot: { revision: binding.revision }, cancelPolicy: { mode: 'conversation' },
    });
    await expect(store.createWorkAttempt({
      tenantId: 'tenant-a', workOrderId: otherWork.workOrderId, runtimeRunId: 'run-other',
      attemptId: 'attempt-other', parentAttemptId: attempt.attemptId,
      taskWorkspaceId: 'task-workspace-other', sandboxScopeId: 'sandbox-other',
      mountSubPath: 'tasks/other', sharedReadOnlySubPath: 'shared/a',
    })).rejects.toThrow('ORG_AGENT_PARENT_ATTEMPT_SCOPE_INVALID');

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
    await expect(store.findWorkConversationByMessage({
      tenantId: 'tenant-a', bindingId: binding.bindingId, accountId: 'account-a',
      conversationId: 'group-a', messageIds: ['provider-message-a'],
    })).resolves.toMatchObject({ workConversationId: conversation.workConversationId });

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
    const otherShadow = await store.ensureShadowBinding({
      tenantId: 'tenant-a', accountId: 'account-a', agentId: 'agent-a',
      conversationId: 'group-memory-other', channelKind: 'group', workspaceId: 'agent-workspace-a',
    });
    await expect(store.createMemory({
      tenantId: 'tenant-a', agentId: 'agent-a', bindingId: otherShadow.bindingId,
      workOrderId: work.workOrderId, memoryScope: 'task_checkpoint',
      content: { checkpoint: 'wrong group' }, provenance: {}, policyRevision: otherShadow.revision,
    })).rejects.toThrow('ORG_AGENT_MEMORY_ASSOCIATION_INVALID');
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
        memoryId: memory.memoryId,
        expectedVersion: memory.version,
        status: 'revoked',
      }),
    ).resolves.toMatchObject({ status: 'revoked' });
    await expect(store.getMemory('tenant-a', promoted.memoryId)).resolves.toMatchObject({
      status: 'revoked',
      provenance: expect.objectContaining({ sourceMemoryId: memory.memoryId }),
    });
    await expect(store.listMemories({
      tenantId: 'tenant-a', agentId: 'agent-a', memoryScope: 'agent', status: 'active', limit: 20,
    })).resolves.toEqual([]);

    const checkpoint = await store.createMemory({
      tenantId: 'tenant-a', agentId: 'agent-a', bindingId: binding.bindingId,
      workOrderId: work.workOrderId, memoryScope: 'task_checkpoint',
      content: { checkpoint: '已核对采购异常' }, provenance: { attemptId: attempt.attemptId },
      policyRevision: binding.revision,
    });
    const promotedCheckpoint = await store.promoteMemory({
      tenantId: 'tenant-a', sourceMemoryId: checkpoint.memoryId,
      promotedBy: 'admin', reason: '任务结论转长期记忆', policyRevision: binding.revision,
    });
    await store.changeMemoryStatus({
      tenantId: 'tenant-a', memoryId: checkpoint.memoryId,
      expectedVersion: checkpoint.version, status: 'deleted',
    });
    await expect(store.getMemory('tenant-a', promotedCheckpoint.memoryId)).resolves.toMatchObject({
      status: 'deleted',
      provenance: expect.objectContaining({ sourceMemoryId: checkpoint.memoryId }),
    });
    await expect(
      store.listMemories({ tenantId: 'tenant-b', agentId: 'agent-a', limit: 20 }),
    ).resolves.toEqual([]);

    const completedBeforeRetry = await store.getWorkOrder('tenant-a', work.workOrderId);
    const reopened = await store.reopenWorkOrder({
      tenantId: 'tenant-a', workOrderId: work.workOrderId,
      expectedVersion: completedBeforeRetry!.version,
    });
    await pool.query(`UPDATE ${prefix}_org_agent_work_orders
      SET updated_at=NOW()-INTERVAL '5 minutes' WHERE work_order_id=$1`, [work.workOrderId]);
    await expect(store.listStagedWorkOrders(new Date(), 10)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ workOrderId: work.workOrderId })]),
    );
    const attempt2 = await store.createWorkAttempt({
      tenantId: 'tenant-a', workOrderId: work.workOrderId, runtimeRunId: 'run-a-2',
      attemptId: 'attempt-a-2', parentAttemptId: attempt.attemptId,
      taskWorkspaceId: 'task-workspace-a-2', sandboxScopeId: 'sandbox-a-2',
      mountSubPath: 'tasks/a-2', sharedReadOnlySubPath: 'shared/a',
    });
    await expect(store.getWorkOrder('tenant-a', work.workOrderId))
      .resolves.toMatchObject({ state: 'queued', currentAttemptNo: attempt2.attemptNo });
    await store.transitionWorkAttempt({ tenantId: 'tenant-a', runtimeRunId: 'run-a-2',
      status: 'running' });
    await store.transitionWorkAttempt({ tenantId: 'tenant-a', runtimeRunId: 'run-a-2',
      status: 'completed', resultEnvelope: terminalEnvelope });
    const retryRunning = await store.getWorkOrder('tenant-a', work.workOrderId);
    await store.transitionWorkOrder({ tenantId: 'tenant-a', workOrderId: work.workOrderId,
      expectedVersion: retryRunning!.version, state: 'completed', resultEnvelope: terminalEnvelope });
    expect(attempt2.attemptNo).toBe(reopened.currentAttemptNo + 1);
    const staleIntent = await store.createDelivery({
      tenantId: 'tenant-a', accountId: 'account-a', conversationId: 'group-a',
      agentId: 'agent-a', bindingId: binding.bindingId,
      conversationSpaceId: binding.conversationSpaceId,
      workConversationId: conversation.workConversationId,
      policyRevision: binding.revision, visibility: 'conversation',
      sourceWorkOrderId: work.workOrderId, sourceAttemptId: attempt.attemptId,
      source: 'background_completion', deliveryKind: 'task_completion', disposition: 'replied',
      destination: { provider: 'dingtalk', accountId: 'account-a',
        conversationId: 'group-a', kind: 'group' },
      content: '旧 attempt 完成', idempotencyKey: 'delivery-stale-attempt-a',
    });
    await expect(store.claimDelivery(staleIntent.deliveryId, 'worker-stale', 60_000))
      .rejects.toThrow('DWS_DELIVERY_NOT_CLAIMABLE');
    await expect(store.reconcileAllExpiredDeliveries()).resolves.toBe(1);
    await expect(store.getDelivery('tenant-a', staleIntent.deliveryId)).resolves.toMatchObject({
      deliveryState: 'dead_letter', lastError: 'ORG_AGENT_DELIVERY_STALE_ATTEMPT',
    });

    const expiring = await store.createDelivery({
      tenantId: 'tenant-a', accountId: 'account-a', conversationId: 'direct-expiring',
      source: 'system', deliveryKind: 'system_notice', disposition: 'replied',
      destination: { provider: 'dingtalk', accountId: 'account-a',
        conversationId: 'direct-expiring', kind: 'direct', peerOpenId: 'member-a' },
      content: '租约测试', idempotencyKey: 'delivery-expiring',
    });
    const expiringClaim = await store.claimDelivery(expiring.deliveryId, 'worker-expired', 60_000);
    await pool.query(`UPDATE ${prefix}_agent_dws_delivery_intents
      SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE delivery_id=$1`, [expiring.deliveryId]);
    await expect(store.markClaimedDeliveryDeadLetter(expiring.deliveryId, 'worker-expired',
      expiringClaim.leaseFence, 'late failure')).rejects.toThrow('DWS_DELIVERY_LEASE_LOST');
    await expect(store.reconcileAllExpiredDeliveries()).resolves.toBe(1);
    await expect(store.getDelivery('tenant-a', expiring.deliveryId)).resolves.toMatchObject({
      deliveryState: 'unknown', lastError: 'DWS_DELIVERY_RECEIPT_UNKNOWN_AFTER_LEASE_EXPIRY',
    });
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

  it('serializes one WorkConversation while allowing different topics in the same group to run concurrently', async () => {
    const shadow = await store.ensureShadowBinding({ tenantId: 'tenant-a', accountId: 'account-a',
      agentId: 'agent-a', conversationId: 'group-parallel', channelKind: 'group',
      workspaceId: 'agent-workspace-a' });
    const binding = await store.updateBinding({ tenantId: 'tenant-a', accountId: 'account-a',
      conversationId: 'group-parallel', expectedRevision: shadow.revision, enabled: true,
      policy: { enabled: true, membership: 'members', guest: 'deny', taskVisibility: 'conversation',
        completion: 'reply_to_work_conversation', liveDeny: false },
      effectiveConfig: { identity: {}, knowledge: { contextEnabled: false, sourceIds: [] },
        capabilities: { skillIds: [], toolNames: [] }, access: { triggerRoles: [], approvalRoles: [] },
        speech: { proactive: false, requireMention: true } } });
    const [topicA, topicB] = await Promise.all([
      store.getOrCreateWorkConversation({ tenantId: 'tenant-a', bindingId: binding.bindingId, rootKey: 'root-a' }),
      store.getOrCreateWorkConversation({ tenantId: 'tenant-a', bindingId: binding.bindingId, rootKey: 'root-b' }),
    ]);
    const inbox = new PgAgentDwsMessageStore(pool, prefix);
    const rows = await Promise.all(['a1', 'b1', 'a2'].map(id => inbox.ingest({
      tenantId: 'tenant-a', accountId: 'account-a', eventId: `parallel-${id}`,
      eventType: 'user_im_message_receive_at', conversationId: 'group-parallel',
      messageId: `message-${id}`, senderOpenDingtalkId: 'member-a', content: id,
    }, { schemaVersion: 2, source: 'dws_personal_stream', accountIdentity: {
      profileId: 'corp-a:agent-member-a', corpId: 'corp-a', dingtalkUserId: 'agent-member-a',
    } })));
    await Promise.all(rows.map((row, index) => store.pinInboxRouting({ inboxId: row.record.inboxId,
      conversationSpaceId: binding.conversationSpaceId,
      workConversationId: index === 1 ? topicB.workConversationId : topicA.workConversationId,
      policyRevision: binding.revision })));

    const first = await inbox.claimNext('inbox-worker-a', 60_000);
    const second = await inbox.claimNext('inbox-worker-b', 60_000);
    const blocked = await inbox.claimNext('inbox-worker-c', 60_000);

    expect(new Set([first?.workConversationId, second?.workConversationId])).toEqual(
      new Set([topicA.workConversationId, topicB.workConversationId]),
    );
    expect(blocked).toBeNull();
  });

  it('treats an unpinned row as a group FIFO barrier against an already pinned topic', async () => {
    const inbox = new PgAgentDwsMessageStore(pool, prefix);
    const first = await inbox.ingest({
      tenantId: 'tenant-a', accountId: 'account-a', eventId: 'mixed-unpinned-first',
      eventType: 'user_im_message_receive_at', conversationId: 'group-mixed',
      messageId: 'mixed-message-1', senderOpenDingtalkId: 'member-a', content: 'first',
    }, { schemaVersion: 2, source: 'dws_personal_stream', accountIdentity: {
      profileId: 'corp-a:agent-member-a', corpId: 'corp-a', dingtalkUserId: 'agent-member-a',
    } });
    const second = await inbox.ingest({
      tenantId: 'tenant-a', accountId: 'account-a', eventId: 'mixed-pinned-second',
      eventType: 'user_im_message_receive_at', conversationId: 'group-mixed',
      messageId: 'mixed-message-2', senderOpenDingtalkId: 'member-a', content: 'second',
    }, { schemaVersion: 2, source: 'dws_personal_stream', accountIdentity: {
      profileId: 'corp-a:agent-member-a', corpId: 'corp-a', dingtalkUserId: 'agent-member-a',
    } });
    await store.pinInboxRouting({
      inboxId: second.record.inboxId, conversationSpaceId: 'space-mixed',
      workConversationId: 'topic-mixed', policyRevision: 1,
    });

    const firstClaim = await inbox.claimNext('mixed-worker-1', 60_000);
    expect(firstClaim?.inboxId).toBe(first.record.inboxId);
    await expect(inbox.claimNext('mixed-worker-2', 60_000)).resolves.toBeNull();
    await inbox.complete(firstClaim!.inboxId, 'mixed-worker-1', firstClaim!.leaseFence);
    await expect(inbox.claimNext('mixed-worker-2', 60_000)).resolves.toMatchObject({
      inboxId: second.record.inboxId,
    });
  });
});
