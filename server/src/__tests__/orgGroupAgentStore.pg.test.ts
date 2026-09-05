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
  const accountIdentity = {
    profileId: 'corp-a:agent-member-a',
    corpId: 'corp-a',
    dingtalkUserId: 'agent-member-a',
    identityUpdatedAt: '2026-09-04T00:00:00.000Z',
  };

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
       'corp-a:agent-member-a',$1,'active','{"kinds":["at_me"]}'::jsonb,'admin','admin')`,
      [accountIdentity.identityUpdatedAt],
    );
    store = new PgOrgGroupAgentStore(pool, prefix);
  }, 60_000);

  // 每个用例共享随机前缀，只清理本测试套件创建的对象。
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

  it('滚动发布仅接管当前身份纪元内由 N 版本创建的全 NULL binding', async () => {
    const current = await store.ensureShadowBinding({
      tenantId: 'tenant-a', accountId: 'account-a', agentId: 'agent-a',
      conversationId: 'group-rolling-current', channelKind: 'group',
      workspaceId: 'agent-workspace-a', accountIdentity,
    });
    await pool.query(`UPDATE ${prefix}_org_agent_channel_bindings
      SET account_profile_id=NULL,account_corp_id=NULL,account_dingtalk_user_id=NULL,
          account_identity_updated_at=NULL
      WHERE binding_id=$1`, [current.bindingId]);
    await expect(store.ensureShadowBinding({
      tenantId: 'tenant-a', accountId: 'account-a', agentId: 'agent-a',
      conversationId: 'group-rolling-current', channelKind: 'group',
      workspaceId: 'agent-workspace-a', accountIdentity,
    })).resolves.toMatchObject({
      bindingId: current.bindingId,
      accountIdentity,
    });

    const old = await store.ensureShadowBinding({
      tenantId: 'tenant-a', accountId: 'account-a', agentId: 'agent-a',
      conversationId: 'group-rolling-old', channelKind: 'group',
      workspaceId: 'agent-workspace-a', accountIdentity,
    });
    await pool.query(`UPDATE ${prefix}_org_agent_channel_bindings
      SET account_profile_id=NULL,account_corp_id=NULL,account_dingtalk_user_id=NULL,
          account_identity_updated_at=NULL,created_at='2026-09-03T00:00:00.000Z'
      WHERE binding_id=$1`, [old.bindingId]);
    await expect(store.ensureShadowBinding({
      tenantId: 'tenant-a', accountId: 'account-a', agentId: 'agent-a',
      conversationId: 'group-rolling-old', channelKind: 'group',
      workspaceId: 'agent-workspace-a', accountIdentity,
    })).rejects.toThrow('ORG_AGENT_BINDING_ACCOUNT_IDENTITY_CONFLICT');
  });

  it('固定账号、binding、topic、work、attempt 身份且 unknown delivery 不自动重发', async () => {
    const shadow = await store.ensureShadowBinding({
      tenantId: 'tenant-a',
      accountId: 'account-a',
      agentId: 'agent-a',
      conversationId: 'group-a',
      channelKind: 'group',
      workspaceId: 'agent-workspace-a',
      accountIdentity,
    });
    expect(shadow.accountIdentity).toEqual(accountIdentity);
    await expect(
      store.ensureShadowBinding({
        tenantId: 'tenant-a',
        accountId: 'account-a',
        agentId: 'agent-a',
        conversationId: 'group-a',
        channelKind: 'group',
        workspaceId: 'agent-workspace-a',
        accountIdentity,
      }),
    ).resolves.toMatchObject({ bindingId: shadow.bindingId });
    await expect(store.ensureShadowBinding({
      tenantId: 'tenant-a', accountId: 'account-a', agentId: 'agent-a',
      conversationId: 'group-a', channelKind: 'group', workspaceId: 'agent-workspace-a',
      accountIdentity: {
        profileId: 'corp-b:agent-member-b', corpId: 'corp-b', dingtalkUserId: 'agent-member-b',
        identityUpdatedAt: '2026-09-05T00:00:00.000Z',
      },
    })).rejects.toThrow('ORG_AGENT_BINDING_ACCOUNT_IDENTITY_CONFLICT');
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
        instructions: { system: '' },
        knowledge: { contextEnabled: true, sourceIds: ['kb-a'] },
        capabilities: { skillIds: ['skill-a'], toolNames: ['ContextSearch'], dwsResourceIds: [] },
        memory: { readAgent: true, readConversation: true, adminWriteConversation: true },
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
      accountIdentity,
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
    expect(intent.accountIdentity).toEqual(accountIdentity);
    const claimed = await store.claimDelivery(intent.deliveryId, 'worker-a', 60_000);
    await store.markDeliveryProviderStarted(intent.deliveryId, 'worker-a', claimed.leaseFence);
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
    await store.markDeliveryProviderStarted(intent.deliveryId, 'worker-b', retried.leaseFence);
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
      accountIdentity,
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

    const workspace = await store.loadGroupWorkspace({
      tenantId: 'tenant-a', bindingIds: [binding.bindingId, otherShadow.bindingId], limitPerBinding: 20,
    });
    expect(workspace.conversations).toEqual(expect.arrayContaining([
      expect.objectContaining({ workConversationId: conversation.workConversationId }),
    ]));
    expect(workspace.workOrders).toEqual(expect.arrayContaining([
      expect.objectContaining({ workOrderId: work.workOrderId }),
    ]));
    expect(workspace.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ attemptId: attempt.attemptId }),
    ]));
    expect(workspace.memories).toEqual(expect.arrayContaining([
      expect.objectContaining({ memoryId: memory.memoryId }),
    ]));

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
      accountIdentity,
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
      accountIdentity,
      tenantId: 'tenant-a', accountId: 'account-a', conversationId: 'direct-expiring',
      source: 'system', deliveryKind: 'system_notice', disposition: 'replied',
      destination: { provider: 'dingtalk', accountId: 'account-a',
        conversationId: 'direct-expiring', kind: 'direct', peerOpenId: 'member-a' },
      content: '租约测试', idempotencyKey: 'delivery-expiring',
    });
    expect(expiring.accountIdentity).toEqual(accountIdentity);
    const expiringClaim = await store.claimDelivery(expiring.deliveryId, 'worker-expired', 60_000);
    await pool.query(`UPDATE ${prefix}_agent_dws_delivery_intents
      SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE delivery_id=$1`, [expiring.deliveryId]);
    await expect(store.markClaimedDeliveryDeadLetter(expiring.deliveryId, 'worker-expired',
      expiringClaim.leaseFence, 'late failure')).rejects.toThrow('DWS_DELIVERY_LEASE_LOST');
    await expect(store.reconcileAllExpiredDeliveries()).resolves.toBe(1);
    await expect(store.getDelivery('tenant-a', expiring.deliveryId)).resolves.toMatchObject({
      deliveryState: 'pending',
      lastError: 'DWS_DELIVERY_RETRY_AFTER_LEASE_EXPIRY_BEFORE_PROVIDER',
    });

    const legacyWriter = await store.createDelivery({
      accountIdentity,
      tenantId: 'tenant-a', accountId: 'account-a', conversationId: 'direct-legacy-writer',
      source: 'system', deliveryKind: 'system_notice', disposition: 'replied',
      destination: { provider: 'dingtalk', accountId: 'account-a',
        conversationId: 'direct-legacy-writer', kind: 'direct', peerOpenId: 'member-a' },
      content: '旧 Worker 租约测试', idempotencyKey: 'delivery-legacy-writer',
    });
    await pool.query(`UPDATE ${prefix}_agent_dws_delivery_intents
      SET delivery_state='sending',attempt=attempt+1,lease_owner='old-worker',lease_fence=1,
        lease_expires_at=NOW()-INTERVAL '1 second'
      WHERE delivery_id=$1`, [legacyWriter.deliveryId]);
    await expect(store.reconcileAllExpiredDeliveries()).resolves.toBe(1);
    await expect(store.getDelivery('tenant-a', legacyWriter.deliveryId)).resolves.toMatchObject({
      deliveryState: 'unknown', providerAttemptPhase: 'legacy_unknown',
      lastError: 'DWS_DELIVERY_RECEIPT_UNKNOWN_AFTER_LEASE_EXPIRY',
    });

    const providerExpiring = await store.createDelivery({
      accountIdentity,
      tenantId: 'tenant-a',
      accountId: 'account-a',
      conversationId: 'direct-provider-expiring',
      source: 'system',
      deliveryKind: 'system_notice',
      disposition: 'replied',
      destination: {
        provider: 'dingtalk',
        accountId: 'account-a',
        conversationId: 'direct-provider-expiring',
        kind: 'direct',
        peerOpenId: 'member-a',
      },
      content: '供应商调用租约测试',
      idempotencyKey: 'delivery-provider-expiring',
    });
    const providerClaim = await store.claimDelivery(
      providerExpiring.deliveryId,
      'worker-provider-expired',
      60_000,
    );
    await store.markDeliveryProviderStarted(
      providerExpiring.deliveryId,
      'worker-provider-expired',
      providerClaim.leaseFence,
    );
    await pool.query(
      `UPDATE ${prefix}_agent_dws_delivery_intents
      SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE delivery_id=$1`,
      [providerExpiring.deliveryId],
    );
    await expect(store.reconcileAllExpiredDeliveries()).resolves.toBe(1);
    await expect(store.getDelivery('tenant-a', providerExpiring.deliveryId)).resolves.toMatchObject(
      {
        deliveryState: 'unknown',
        lastError: 'DWS_DELIVERY_RECEIPT_UNKNOWN_AFTER_LEASE_EXPIRY',
      },
    );
  });

  it('后台 worker 跳过 reply_pending 关联投递，授权拒绝可取消所有 provider 前正文', async () => {
    await pool.query(`UPDATE ${prefix}_agent_dws_delivery_intents
      SET delivery_state='dead_letter',completed_at=NOW()
      WHERE delivery_state='pending'`);
    const inbox = new PgAgentDwsMessageStore(pool, prefix);
    const ingested = await inbox.ingest({
      tenantId: 'tenant-a', accountId: 'account-a', eventId: 'reply-auth-revoked',
      eventType: 'user_im_message_receive_o2o_all', conversationId: 'direct-auth-revoked',
      messageId: 'message-auth-revoked', senderOpenDingtalkId: 'member-a', content: 'hi',
    }, { schemaVersion: 2, source: 'dws_personal_stream', accountIdentity: {
      profileId: accountIdentity.profileId, corpId: accountIdentity.corpId,
      dingtalkUserId: accountIdentity.dingtalkUserId,
    } });
    const claimedInbox = await inbox.claimNext('inbox-worker-auth', 60_000);
    await inbox.saveDispatchResult(
      claimedInbox!.inboxId, 'inbox-worker-auth', claimedInbox!.leaseFence, '旧授权正文',
    );
    const direct = await store.createDelivery({
      accountIdentity,
      tenantId: 'tenant-a', inboxId: ingested.record.inboxId, accountId: 'account-a',
      conversationId: 'direct-auth-revoked', source: 'command', deliveryKind: 'front_reply',
      disposition: 'replied', destination: { provider: 'dingtalk', accountId: 'account-a',
        conversationId: 'direct-auth-revoked', kind: 'direct', peerOpenId: 'member-a' },
      content: '旧授权正文', idempotencyKey: 'delivery-auth-revoked',
    });

    await expect(store.claimNextDelivery('background-worker', 60_000)).resolves.toBeNull();
    await store.claimDelivery(direct.deliveryId, 'immediate-worker', 60_000);
    await expect(store.cancelUnstartedDeliveriesForInbox(
      'tenant-a', ingested.record.inboxId, 'ORG_AGENT_DIRECT_DELIVERY_AUTHORIZATION_REVOKED',
    )).resolves.toBe(1);
    await inbox.blockReply(
      claimedInbox!.inboxId,
      'inbox-worker-auth',
      claimedInbox!.leaseFence,
      'ASSIGNMENT_DENIED',
    );
    await expect(store.getDelivery('tenant-a', direct.deliveryId)).resolves.toMatchObject({
      deliveryState: 'dead_letter',
      lastError: 'ORG_AGENT_DIRECT_DELIVERY_AUTHORIZATION_REVOKED',
    });
  });

  it('uses SKIP LOCKED claims so concurrent delivery workers never own one intent', async () => {
    for (const suffix of ['b', 'c'])
      await store.createDelivery({
        accountIdentity,
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
    const shadow = await store.ensureShadowBinding({
      tenantId: 'tenant-a',
      accountId: 'account-a',
      agentId: 'agent-a',
      conversationId: 'group-parallel',
      channelKind: 'group',
      workspaceId: 'agent-workspace-a',
      accountIdentity,
    });
    const binding = await store.updateBinding({
      tenantId: 'tenant-a',
      accountId: 'account-a',
      conversationId: 'group-parallel',
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
        identity: {},
        instructions: { system: '' },
        knowledge: { contextEnabled: false, sourceIds: [] },
        capabilities: { skillIds: [], toolNames: [], dwsResourceIds: [] },
        access: { triggerRoles: [], approvalRoles: [] },
        memory: { readAgent: true, readConversation: true, adminWriteConversation: true },
        speech: { proactive: false, requireMention: true },
      },
    });
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

  it('真实 store 在普通与拒绝回复发送失败后按退避重领 reply_pending 状态', async () => {
    const inbox = new PgAgentDwsMessageStore(pool, prefix);
    for (const replyKind of ['normal', 'access_rejection'] as const) {
      const eventId = `reply-retry-${replyKind}`;
      const ingested = await inbox.ingest({
        tenantId: 'tenant-a', accountId: 'account-a', eventId,
        eventType: 'user_im_message_receive_o2o_all', conversationId: eventId,
        messageId: `message-${eventId}`, senderOpenDingtalkId: 'member-a', content: 'hi',
      }, { schemaVersion: 2, source: 'dws_personal_stream', accountIdentity: {
        profileId: accountIdentity.profileId, corpId: accountIdentity.corpId,
        dingtalkUserId: accountIdentity.dingtalkUserId,
      } });
      const firstOwner = `worker-${replyKind}-1`;
      const first = await inbox.claimNext(firstOwner, 60_000);
      expect(first?.inboxId).toBe(ingested.record.inboxId);
      if (replyKind === 'normal') {
        await inbox.saveDispatchResult(first!.inboxId, firstOwner, first!.leaseFence, '正常回复');
      } else {
        await inbox.saveRejectionResult(
          first!.inboxId, firstOwner, first!.leaseFence, '拒绝回复', 'ASSIGNMENT_DENIED',
        );
      }
      await inbox.markReplyAttemptStarted(first!.inboxId, firstOwner, first!.leaseFence);
      await expect(inbox.fail(
        first!.inboxId, firstOwner, first!.leaseFence, new Error('provider unavailable'), 60_000,
      )).resolves.toMatchObject({ state: 'reply_pending', nextAttemptAt: expect.any(String) });
      await expect(inbox.claimNext(`worker-${replyKind}-early`, 60_000)).resolves.toBeNull();
      await pool.query(`UPDATE ${prefix}_agent_dws_event_inbox
        SET next_attempt_at=NOW() WHERE inbox_id=$1`, [first!.inboxId]);
      const retryOwner = `worker-${replyKind}-2`;
      const retry = await inbox.claimNext(retryOwner, 60_000);
      expect(retry).toMatchObject({
        inboxId: first!.inboxId,
        state: 'reply_pending',
        responseText: replyKind === 'normal' ? '正常回复' : '拒绝回复',
        replyKind,
      });
      await expect(inbox.markReplyAttemptStarted(
        retry!.inboxId, retryOwner, retry!.leaseFence,
      )).resolves.toMatchObject({ state: 'reply_pending' });
      if (replyKind === 'normal') {
        await inbox.complete(retry!.inboxId, retryOwner, retry!.leaseFence);
      } else {
        await inbox.reject(retry!.inboxId, retryOwner, retry!.leaseFence, 'ASSIGNMENT_DENIED');
      }
    }
  });

  it('真实 store 在已持久化回复达到 maxAttempts 后转 dead_letter', async () => {
    const inbox = new PgAgentDwsMessageStore(pool, prefix);
    const ingested = await inbox.ingest({
      tenantId: 'tenant-a', accountId: 'account-a', eventId: 'reply-max-attempts',
      eventType: 'user_im_message_receive_o2o_all', conversationId: 'reply-max-attempts',
      messageId: 'message-reply-max-attempts', senderOpenDingtalkId: 'member-a', content: 'hi',
    }, { schemaVersion: 2, source: 'dws_personal_stream', accountIdentity: {
      profileId: accountIdentity.profileId, corpId: accountIdentity.corpId,
      dingtalkUserId: accountIdentity.dingtalkUserId,
    } });
    const claimed = await inbox.claimNext('worker-max-attempts', 60_000);
    expect(claimed?.inboxId).toBe(ingested.record.inboxId);
    await inbox.saveDispatchResult(
      claimed!.inboxId, 'worker-max-attempts', claimed!.leaseFence, '最终回复',
    );
    await pool.query(`UPDATE ${prefix}_agent_dws_event_inbox
      SET attempt=max_attempts WHERE inbox_id=$1`, [claimed!.inboxId]);
    await expect(inbox.fail(
      claimed!.inboxId, 'worker-max-attempts', claimed!.leaseFence, new Error('provider unavailable'),
    )).resolves.toMatchObject({ state: 'dead_letter', responseText: '最终回复' });
  });

  it('未固定 topic 的旧消息会阻塞同群已固定 topic 的后续消息', async () => {
    const inbox = new PgAgentDwsMessageStore(pool, prefix);
    const first = await inbox.ingest({
      tenantId: 'tenant-a', accountId: 'account-a', eventId: 'mixed-unpinned-first',
      eventType: 'user_im_message_receive_at', conversationId: 'group-mixed',
      messageId: 'mixed-message-1', senderOpenDingtalkId: 'member-a', content: '第一条',
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
