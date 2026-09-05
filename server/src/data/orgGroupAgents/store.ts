import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';

import { PgGovernanceMigrationRunner, governanceTablePrefix } from '../governance-schema/index.js';
import {
  type DwsDeliveryIntent,
  type DwsDeliveryIntentCreate,
  type DwsReplyRecoveryState,
  type ExternalActorRef,
  type OrgAgentChannelActorRef,
  type OrgAgentChannelBinding,
  type OrgAgentChannelPolicy,
  type OrgAgentEffectiveConfig,
  type OrgAgentWorkConversation,
  type OrgAgentWorkAttempt,
  type OrgAgentWorkOrder,
  type OrgAgentWorkOrderControl,
  type OrgAgentWorkOrderState,
  type OrgAgentResultEnvelope,
  type OrgAgentMemory,
  type OrgGroupAgentStore,
} from './types.js';
import {
  mapBinding, mapDelivery, mapMemory, mapWorkAttempt, mapWorkConversation, mapWorkOrder,
  requiredRow, validateDestination, validateEffectiveConfig, validatePolicy,
} from './storeMappers.js';
import {
  cancelUnstartedDeliveryIntentsForInbox,
  claimDeliveryIntent,
  claimNextDeliveryIntent,
  compactDeliveryError,
  finishClaimedDelivery,
  getDeliveryIntent,
  getReplyRecoveryStateForInbox,
  listDeliveryIntents,
  reconcileExpiredDeliveriesForAccount,
  reconcileExpiredAndStaleDeliveries,
  reconcileUnknownDelivery,
  releaseDeliveryBeforeProvider,
  sanitizeDeliveryReceipt,
  startDeliveryProviderAttempt,
} from './deliveryClaims.js';
import {
  transitionWorkAttempt as transitionAttempt,
  transitionWorkAttemptPublishState as transitionAttemptPublishState,
} from './workAttemptArtifacts.js';
import { getStoredWorkConversation, listStoredWorkConversations } from './workConversationQueries.js';
import { listStoredWorkAttempts, loadStoredGroupWorkspace } from './groupWorkspaceQueries.js';
import {
  getWorkOrder as selectWorkOrder,
  getWorkOrderByShortId as selectWorkOrderByShortId,
  pauseWorkOrder as pauseStoredWorkOrder,
  queueWorkOrderAttempt as queueStoredWorkOrderAttempt,
  updateWorkOrderControl as updateStoredWorkOrderControl,
} from './workOrderLifecycle.js';
import { changeStoredMemoryStatus, promoteStoredMemory } from './memoryLifecycle.js';
import {
  ensureIdentityBoundShadowBinding,
  type EnsureIdentityBoundShadowBindingInput,
} from './bindingIdentityStore.js';

const MAX_DELIVERY_LEASE_MS = 24 * 60 * 60 * 1_000;

export class PgOrgGroupAgentStore implements OrgGroupAgentStore {
  private readonly prefix: string;
  private readonly bindingsTable: string;
  private readonly conversationsTable: string;
  private readonly inboxTable: string;
  private readonly accountsTable: string;
  private readonly managedAgentsTable: string;
  private readonly deliveriesTable: string;
  private readonly workOrdersTable: string;
  private readonly attemptsTable: string;
  private readonly memoriesTable: string;

  constructor(
    private readonly pool: pg.Pool,
    tablePrefix?: string,
  ) {
    this.prefix = governanceTablePrefix(tablePrefix);
    this.bindingsTable = `${this.prefix}_org_agent_channel_bindings`;
    this.conversationsTable = `${this.prefix}_org_agent_work_conversations`;
    this.inboxTable = `${this.prefix}_agent_dws_event_inbox`;
    this.accountsTable = `${this.prefix}_agent_dws_accounts`;
    this.managedAgentsTable = `${this.prefix}_managed_agents`;
    this.deliveriesTable = `${this.prefix}_agent_dws_delivery_intents`;
    this.workOrdersTable = `${this.prefix}_org_agent_work_orders`;
    this.attemptsTable = `${this.prefix}_org_agent_work_attempts`;
    this.memoriesTable = `${this.prefix}_org_agent_memories`;
  }

  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(this.pool, this.prefix).run();
  }

  async ensureShadowBinding(
    input: EnsureIdentityBoundShadowBindingInput,
  ): Promise<OrgAgentChannelBinding> {
    return await ensureIdentityBoundShadowBinding(this.pool, this.bindingsTable, input);
  }

  async getBinding(
    tenantId: string,
    accountId: string,
    conversationId: string,
  ): Promise<OrgAgentChannelBinding | null> {
    assertTexts(tenantId, accountId, conversationId);
    const result = await this.pool.query(
      `SELECT * FROM ${this.bindingsTable}
      WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3`,
      [tenantId, accountId, conversationId],
    );
    return result.rows[0] ? mapBinding(result.rows[0] as Record<string, unknown>) : null;
  }

  async getBindingById(
    tenantId: string,
    bindingId: string,
  ): Promise<OrgAgentChannelBinding | null> {
    assertTexts(tenantId, bindingId);
    const result = await this.pool.query(
      `SELECT * FROM ${this.bindingsTable}
      WHERE tenant_id=$1 AND binding_id=$2`,
      [tenantId, bindingId],
    );
    return result.rows[0] ? mapBinding(result.rows[0] as Record<string, unknown>) : null;
  }

  async listBindings(tenantId: string, accountId: string): Promise<OrgAgentChannelBinding[]> {
    assertTexts(tenantId, accountId);
    const result = await this.pool.query(
      `SELECT * FROM ${this.bindingsTable}
      WHERE tenant_id=$1 AND account_id=$2 ORDER BY updated_at DESC,binding_id`,
      [tenantId, accountId],
    );
    return result.rows.map((row) => mapBinding(row as Record<string, unknown>));
  }

  async updateBinding(input: {
    tenantId: string;
    accountId: string;
    conversationId: string;
    expectedRevision: number;
    enabled: boolean;
    policy: OrgAgentChannelPolicy;
    effectiveConfig: OrgAgentEffectiveConfig;
  }): Promise<OrgAgentChannelBinding> {
    assertTexts(input.tenantId, input.accountId, input.conversationId);
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1)
      throw new Error('ORG_AGENT_BINDING_INVALID');
    const policy = validatePolicy({ ...input.policy, enabled: input.enabled });
    const config = validateEffectiveConfig(input.effectiveConfig);
    const result = await this.pool.query(
      `UPDATE ${this.bindingsTable}
      SET enabled=$4,activation_state=CASE WHEN $4 THEN 'active' ELSE 'disabled' END,
          policy_json=$5::jsonb,effective_config_json=$6::jsonb,
          revision=revision+1,updated_at=NOW()
      WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND revision=$7
      RETURNING *`,
      [
        input.tenantId,
        input.accountId,
        input.conversationId,
        input.enabled,
        JSON.stringify(policy),
        JSON.stringify(config),
        input.expectedRevision,
      ],
    );
    if (!result.rows[0]) throw new Error('ORG_AGENT_BINDING_VERSION_CONFLICT');
    return mapBinding(result.rows[0] as Record<string, unknown>);
  }

  async getOrCreateWorkConversation(input: {
    tenantId: string;
    bindingId: string;
    rootKey: string;
    rootMessageId?: string;
  }): Promise<OrgAgentWorkConversation> {
    assertTexts(input.tenantId, input.bindingId, input.rootKey);
    const result = await this.pool.query(
      `INSERT INTO ${this.conversationsTable} AS conversation (
      work_conversation_id,tenant_id,binding_id,root_key,root_message_id,session_id,state,created_at,updated_at
    ) SELECT $1,$2,binding_id,$4,$5,$6,'active',NOW(),NOW()
      FROM ${this.bindingsTable} WHERE binding_id=$3 AND tenant_id=$2 AND enabled=TRUE
    ON CONFLICT (binding_id,root_key) DO UPDATE SET updated_at=conversation.updated_at
    RETURNING conversation.*`,
      [
        `workconv-${randomUUID()}`,
        input.tenantId,
        input.bindingId,
        input.rootKey,
        input.rootMessageId ?? null,
        `agent-dws-work-${randomUUID()}`,
      ],
    );
    return mapWorkConversation(requiredRow(result.rows[0]));
  }

  async findWorkConversationByMessage(input: {
    tenantId: string;
    bindingId: string;
    accountId: string;
    conversationId: string;
    messageIds: string[];
  }): Promise<OrgAgentWorkConversation | null> {
    assertTexts(input.tenantId, input.bindingId, input.accountId, input.conversationId);
    const messageIds = [...new Set(input.messageIds.filter(Boolean))].slice(0, 10);
    if (messageIds.length === 0) return null;
    const result = await this.pool.query(
      `SELECT conversation.* FROM (
        SELECT inbox.work_conversation_id, inbox.created_at AS matched_at
        FROM ${this.inboxTable} inbox
        WHERE inbox.tenant_id=$1 AND inbox.account_id=$2 AND inbox.conversation_id=$3
          AND inbox.message_id=ANY($5::text[])
        UNION ALL
        SELECT delivery.work_conversation_id, delivery.updated_at AS matched_at
        FROM ${this.deliveriesTable} delivery
        WHERE delivery.tenant_id=$1 AND delivery.account_id=$2 AND delivery.conversation_id=$3
          AND delivery.delivery_state='sent' AND delivery.work_conversation_id IS NOT NULL
          AND (delivery.provider_receipt_json->>'messageId'=ANY($5::text[])
            OR delivery.provider_receipt_json->>'processQueryKey'=ANY($5::text[]))
      ) matched
      JOIN ${this.conversationsTable} conversation
        ON conversation.work_conversation_id=matched.work_conversation_id
      WHERE conversation.binding_id=$4
      ORDER BY matched.matched_at DESC LIMIT 1`,
      [input.tenantId, input.accountId, input.conversationId, input.bindingId, messageIds],
    );
    return result.rows[0] ? mapWorkConversation(result.rows[0] as Record<string, unknown>) : null;
  }

  async pinInboxRouting(input: {
    inboxId: string;
    conversationSpaceId: string;
    workConversationId: string;
    policyRevision: number;
  }): Promise<void> {
    assertTexts(input.inboxId, input.conversationSpaceId, input.workConversationId);
    const result = await this.pool.query(
      `UPDATE ${this.inboxTable}
      SET conversation_space_id=COALESCE(conversation_space_id,$2),
          work_conversation_id=COALESCE(work_conversation_id,$3),
          channel_policy_revision=COALESCE(channel_policy_revision,$4),updated_at=NOW()
      WHERE inbox_id=$1
        AND (conversation_space_id IS NULL OR conversation_space_id=$2)
        AND (work_conversation_id IS NULL OR work_conversation_id=$3)
        AND (channel_policy_revision IS NULL OR channel_policy_revision=$4)
      RETURNING inbox_id`,
      [input.inboxId, input.conversationSpaceId, input.workConversationId, input.policyRevision],
    );
    if (!result.rows[0]) throw new Error('ORG_AGENT_INBOX_NOT_FOUND');
  }

  async pinInboxContext(input: {
    inboxId: string;
    externalActor: OrgAgentChannelActorRef;
    conversationSpaceId: string;
    workConversationId: string;
    policyRevision: number;
  }): Promise<void> {
    assertTexts(input.inboxId, input.conversationSpaceId, input.workConversationId);
    const actorJson = JSON.stringify(input.externalActor);
    const result = await this.pool.query(
      `UPDATE ${this.inboxTable}
      SET external_actor_ref_json=COALESCE(external_actor_ref_json,$2::jsonb),
          conversation_space_id=COALESCE(conversation_space_id,$3),
          work_conversation_id=COALESCE(work_conversation_id,$4),
          channel_policy_revision=COALESCE(channel_policy_revision,$5),updated_at=NOW()
      WHERE inbox_id=$1
        AND (external_actor_ref_json IS NULL OR external_actor_ref_json=$2::jsonb)
        AND (conversation_space_id IS NULL OR conversation_space_id=$3)
        AND (work_conversation_id IS NULL OR work_conversation_id=$4)
        AND (channel_policy_revision IS NULL OR channel_policy_revision=$5)
      RETURNING inbox_id`,
      [
        input.inboxId,
        actorJson,
        input.conversationSpaceId,
        input.workConversationId,
        input.policyRevision,
      ],
    );
    if (!result.rows[0]) throw new Error('ORG_AGENT_INBOX_NOT_FOUND');
  }

  async createDelivery(input: DwsDeliveryIntentCreate): Promise<DwsDeliveryIntent> {
    assertTexts(
      input.tenantId,
      input.accountId,
      input.conversationId,
      input.accountIdentity.profileId,
      input.accountIdentity.corpId,
      input.accountIdentity.dingtalkUserId,
      input.accountIdentity.identityUpdatedAt,
      input.content,
      input.idempotencyKey,
    );
    // 所有新 delivery 都固定账号身份纪元；NULL 仅代表迁移前 legacy 记录。
    const result = await this.pool.query(
      `INSERT INTO ${this.deliveriesTable} AS delivery (
      delivery_id,tenant_id,inbox_id,account_id,conversation_id,work_conversation_id,source,
      agent_id,binding_id,conversation_space_id,policy_revision,visibility,source_work_order_id,source_attempt_id,
      delivery_kind,disposition,delivery_state,destination_json,content,idempotency_key,
      provider_receipt_json,attempt,lease_fence,created_at,updated_at,completed_at,
      account_profile_id,account_corp_id,account_dingtalk_user_id,account_identity_updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pending',$17::jsonb,$18,$19,$20::jsonb,0,0,NOW(),NOW(),$21,$22,$23,$24,$25::timestamptz)
    ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key=delivery.idempotency_key
    RETURNING delivery.*`,
      [
        `dwsd-${randomUUID()}`,
        input.tenantId,
        input.inboxId ?? null,
        input.accountId,
        input.conversationId,
        input.workConversationId ?? null,
        input.source,
        input.agentId ?? null,
        input.bindingId ?? null,
        input.conversationSpaceId ?? null,
        input.policyRevision ?? null,
        input.visibility ?? null,
        input.sourceWorkOrderId ?? null,
        input.sourceAttemptId ?? null,
        input.deliveryKind,
        input.disposition,
        JSON.stringify(
          validateDestination(input.destination, input.accountId, input.conversationId),
        ),
        input.content,
        input.idempotencyKey,
        input.providerReceipt ? JSON.stringify(sanitizeDeliveryReceipt(input.providerReceipt)) : null,
        input.completedAt ?? null,
        input.accountIdentity.profileId,
        input.accountIdentity.corpId,
        input.accountIdentity.dingtalkUserId,
        input.accountIdentity.identityUpdatedAt,
      ],
    );
    return mapDelivery(requiredRow(result.rows[0]));
  }

  async claimDelivery(
    deliveryId: string,
    owner: string,
    ttlMs: number,
  ): Promise<DwsDeliveryIntent> {
    assertTexts(deliveryId, owner);
    if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_DELIVERY_LEASE_MS)
      throw new Error('DWS_DELIVERY_INVALID');
    const delivery = await claimDeliveryIntent(this.pool, this.deliveryTables(), deliveryId, owner, ttlMs);
    if (!delivery) throw new Error('DWS_DELIVERY_NOT_CLAIMABLE');
    return delivery;
  }

  async claimNextDelivery(owner: string, ttlMs: number): Promise<DwsDeliveryIntent | null> {
    assertTexts(owner);
    if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_DELIVERY_LEASE_MS)
      throw new Error('DWS_DELIVERY_INVALID');
    return claimNextDeliveryIntent(this.pool, this.deliveryTables(), owner, ttlMs);
  }

  async cancelUnstartedDeliveriesForInbox(
    tenantId: string,
    inboxId: string,
    reason: string,
  ): Promise<number> {
    assertTexts(tenantId, inboxId, reason);
    return cancelUnstartedDeliveryIntentsForInbox(
      this.pool,
      this.deliveriesTable,
      tenantId,
      inboxId,
      reason,
    );
  }

  async getReplyRecoveryStateForInbox(
    tenantId: string,
    inboxId: string,
  ): Promise<DwsReplyRecoveryState> {
    assertTexts(tenantId, inboxId);
    return getReplyRecoveryStateForInbox(
      this.pool, this.deliveriesTable, tenantId, inboxId,
    );
  }

  async reconcileAllExpiredDeliveries(limit = 100): Promise<number> {
    const bounded = Math.max(1, Math.min(1_000, Math.trunc(limit)));
    return reconcileExpiredAndStaleDeliveries(this.pool, this.deliveryTables(), bounded);
  }

  async markDeliveryProviderStarted(
    deliveryId: string,
    owner: string,
    fence: number,
  ): Promise<DwsDeliveryIntent> {
    assertTexts(deliveryId, owner);
    return startDeliveryProviderAttempt(
      this.pool, this.deliveriesTable, this.accountsTable,
      this.bindingsTable, this.managedAgentsTable,
      deliveryId, owner, fence,
    );
  }

  async releaseClaimedDeliveryForRetry(
    deliveryId: string,
    owner: string,
    fence: number,
    error: unknown,
    delayMs: number,
    maxAttempts: number,
  ): Promise<DwsDeliveryIntent> {
    assertTexts(deliveryId, owner);
    if (
      !Number.isInteger(delayMs) ||
      delayMs < 0 ||
      delayMs > 300_000 ||
      !Number.isInteger(maxAttempts) ||
      maxAttempts < 1 ||
      maxAttempts > 100
    ) {
      throw new Error('DWS_DELIVERY_INVALID');
    }
    return releaseDeliveryBeforeProvider(
      this.pool, this.deliveriesTable, deliveryId, owner, fence, error, delayMs, maxAttempts,
    );
  }

  async markDeliverySent(
    deliveryId: string,
    owner: string,
    fence: number,
    receipt: Record<string, unknown>,
  ): Promise<DwsDeliveryIntent> {
    if (Object.keys(sanitizeDeliveryReceipt(receipt)).length === 0)
      throw new Error('DWS_DELIVERY_RECEIPT_REQUIRED');
    assertTexts(deliveryId, owner);
    return await finishClaimedDelivery(
      this.pool, this.deliveriesTable, deliveryId, owner, fence, 'sent', undefined, receipt,
    );
  }

  async markDeliveryUnknown(
    deliveryId: string,
    owner: string,
    fence: number,
    error: unknown,
  ): Promise<DwsDeliveryIntent> {
    assertTexts(deliveryId, owner);
    return await finishClaimedDelivery(
      this.pool, this.deliveriesTable, deliveryId, owner, fence, 'unknown', compactDeliveryError(error),
    );
  }

  async markDeliveryDeadLetter(deliveryId: string, reason: string): Promise<DwsDeliveryIntent> {
    assertTexts(deliveryId, reason);
    const result = await this.pool.query(
      `UPDATE ${this.deliveriesTable}
      SET delivery_state='dead_letter',lease_owner=NULL,lease_expires_at=NULL,last_error=$2,
          completed_at=NOW(),updated_at=NOW()
      WHERE delivery_id=$1 AND delivery_state IN ('pending','unknown') RETURNING *`,
      [deliveryId, compactDeliveryError(reason)],
    );
    if (!result.rows[0]) throw new Error('DWS_DELIVERY_NOT_RECOVERABLE');
    return mapDelivery(result.rows[0] as Record<string, unknown>);
  }

  async markClaimedDeliveryDeadLetter(
    deliveryId: string,
    owner: string,
    fence: number,
    reason: string,
  ): Promise<DwsDeliveryIntent> {
    assertTexts(deliveryId, owner, reason);
    const result = await this.pool.query(
      `UPDATE ${this.deliveriesTable}
      SET delivery_state='dead_letter',lease_owner=NULL,lease_expires_at=NULL,last_error=$4,
          completed_at=NOW(),updated_at=NOW()
      WHERE delivery_id=$1 AND delivery_state='sending' AND lease_owner=$2 AND lease_fence=$3
        AND lease_expires_at>NOW() RETURNING *`,
      [deliveryId, owner, fence, compactDeliveryError(reason)],
    );
    if (!result.rows[0]) throw new Error('DWS_DELIVERY_LEASE_LOST');
    return mapDelivery(result.rows[0] as Record<string, unknown>);
  }

  async reconcileExpiredDeliveries(
    tenantId: string,
    accountId: string,
    limit = 100,
  ): Promise<number> {
    assertTexts(tenantId, accountId);
    const bounded = Math.max(1, Math.min(1_000, Math.trunc(limit)));
    return reconcileExpiredDeliveriesForAccount(
      this.pool, this.deliveriesTable, tenantId, accountId, bounded,
    );
  }

  async listDeliveries(
    tenantId: string,
    accountId: string,
    limit = 50,
  ): Promise<DwsDeliveryIntent[]> {
    assertTexts(tenantId, accountId);
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    return listDeliveryIntents(this.pool, this.deliveriesTable, tenantId, accountId, bounded);
  }

  async getDelivery(tenantId: string, deliveryId: string): Promise<DwsDeliveryIntent | null> {
    assertTexts(tenantId, deliveryId);
    return getDeliveryIntent(this.pool, this.deliveriesTable, tenantId, deliveryId);
  }

  async reconcileDelivery(input: {
    tenantId: string;
    deliveryId: string;
    actorId: string;
    reason: string;
    evidence: Record<string, unknown>;
    outcome: 'confirmed_sent' | 'confirmed_not_sent' | 'indeterminate';
  }): Promise<DwsDeliveryIntent> {
    assertTexts(input.tenantId, input.deliveryId, input.actorId, input.reason);
    return reconcileUnknownDelivery(this.pool, this.deliveriesTable, input);
  }

  async createWorkOrder(input: {
    tenantId: string;
    agentId: string;
    bindingId: string;
    workConversationId: string;
    idempotencyKey: string;
    title: string;
    visibility: 'conversation' | 'requester_only';
    createdByActor: ExternalActorRef;
    policySnapshot: Record<string, unknown>;
    cancelPolicy: Record<string, unknown>;
    workerType?: 'general' | 'explore';
  }): Promise<OrgAgentWorkOrder> {
    assertTexts(
      input.tenantId,
      input.agentId,
      input.bindingId,
      input.workConversationId,
      input.idempotencyKey,
      input.title,
    );
    const shortId = `W-${createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 12).toUpperCase()}`;
    const result = await this.pool.query(
      `INSERT INTO ${this.workOrdersTable} AS work_order (
      work_order_id,tenant_id,agent_id,binding_id,work_conversation_id,idempotency_key,short_id,title,state,
      current_attempt_no,visibility,created_by_actor_json,policy_snapshot_json,cancel_policy_json,
      control_json,version,created_at,updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued',0,$9,$10::jsonb,$11::jsonb,$12::jsonb,
      $13::jsonb,1,NOW(),NOW())
    ON CONFLICT (tenant_id,idempotency_key) DO UPDATE SET idempotency_key=work_order.idempotency_key
    RETURNING work_order.*`,
      [
        `work-${randomUUID()}`,
        input.tenantId,
        input.agentId,
        input.bindingId,
        input.workConversationId,
        input.idempotencyKey,
        shortId,
        input.title.slice(0, 500),
        input.visibility,
        JSON.stringify(input.createdByActor),
        JSON.stringify(input.policySnapshot),
        JSON.stringify(input.cancelPolicy),
        JSON.stringify({ revision: 1, supplements: [], workerType: input.workerType ?? 'general' }),
      ],
    );
    const workOrder = mapWorkOrder(requiredRow(result.rows[0]));
    if (
      workOrder.agentId !== input.agentId ||
      workOrder.bindingId !== input.bindingId ||
      workOrder.workConversationId !== input.workConversationId
    )
      throw new Error('ORG_AGENT_WORK_ORDER_IDEMPOTENCY_CONFLICT');
    return workOrder;
  }

  async createWorkAttempt(input: {
    tenantId: string;
    workOrderId: string;
    runtimeRunId: string;
    attemptId: string;
    parentAttemptId?: string;
    taskWorkspaceId: string;
    sandboxScopeId: string;
    mountSubPath: string;
    sharedReadOnlySubPath: string;
  }): Promise<OrgAgentWorkAttempt> {
    assertTexts(
      input.tenantId,
      input.workOrderId,
      input.runtimeRunId,
      input.attemptId,
      input.taskWorkspaceId,
      input.sandboxScopeId,
      input.mountSubPath,
      input.sharedReadOnlySubPath,
    );
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const work = await client.query(
        `SELECT current_attempt_no,state FROM ${this.workOrdersTable}
        WHERE tenant_id=$1 AND work_order_id=$2 FOR UPDATE`,
        [input.tenantId, input.workOrderId],
      );
      if (!work.rows[0]) throw new Error('ORG_AGENT_WORK_ORDER_NOT_ATTEMPTABLE');
      const existing = await client.query(
        `SELECT * FROM ${this.attemptsTable}
        WHERE tenant_id=$1 AND runtime_run_id=$2`,
        [input.tenantId, input.runtimeRunId],
      );
      if (existing.rows[0]) {
        const attempt = mapWorkAttempt(existing.rows[0] as Record<string, unknown>);
        if (
          attempt.workOrderId !== input.workOrderId ||
          attempt.attemptId !== input.attemptId ||
          attempt.taskWorkspaceId !== input.taskWorkspaceId ||
          attempt.sandboxScopeId !== input.sandboxScopeId ||
          attempt.parentAttemptId !== input.parentAttemptId ||
          attempt.mountSubPath !== input.mountSubPath ||
          attempt.sharedReadOnlySubPath !== input.sharedReadOnlySubPath
        ) {
          throw new Error('ORG_AGENT_WORK_ATTEMPT_IDEMPOTENCY_CONFLICT');
        }
        await client.query('COMMIT');
        return attempt;
      }
      if ((work.rows[0] as Record<string, unknown>).state !== 'queued')
        throw new Error('ORG_AGENT_WORK_ORDER_NOT_ATTEMPTABLE');
      if (input.parentAttemptId) {
        const parent = await client.query(
          `SELECT 1 FROM ${this.attemptsTable}
          WHERE tenant_id=$1 AND work_order_id=$2 AND attempt_id=$3`,
          [input.tenantId, input.workOrderId, input.parentAttemptId],
        );
        if (!parent.rows[0]) throw new Error('ORG_AGENT_PARENT_ATTEMPT_SCOPE_INVALID');
      }
      const attemptNo = Number((work.rows[0] as Record<string, unknown>).current_attempt_no) + 1;
      const result = await client.query(
        `INSERT INTO ${this.attemptsTable} (
        attempt_id,tenant_id,work_order_id,attempt_no,runtime_run_id,parent_attempt_id,status,
        task_workspace_id,sandbox_scope_id,mount_sub_path,shared_read_only_sub_path,publish_state,
        created_at,updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9,$10,'pending',NOW(),NOW()) RETURNING *`,
        [
          input.attemptId,
          input.tenantId,
          input.workOrderId,
          attemptNo,
          input.runtimeRunId,
          input.parentAttemptId ?? null,
          input.taskWorkspaceId,
          input.sandboxScopeId,
          input.mountSubPath,
          input.sharedReadOnlySubPath,
        ],
      );
      await client.query(
        `UPDATE ${this.workOrdersTable} SET current_attempt_no=$3,
        version=version+1,updated_at=NOW() WHERE tenant_id=$1 AND work_order_id=$2`,
        [input.tenantId, input.workOrderId, attemptNo],
      );
      await client.query('COMMIT');
      return mapWorkAttempt(requiredRow(result.rows[0]));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getWorkOrder(tenantId: string, workOrderId: string): Promise<OrgAgentWorkOrder | null> {
    assertTexts(tenantId, workOrderId);
    return await selectWorkOrder(this.pool, this.workOrdersTable, tenantId, workOrderId);
  }

  async getWorkOrderByShortId(
    tenantId: string,
    agentId: string,
    shortId: string,
  ): Promise<OrgAgentWorkOrder | null> {
    assertTexts(tenantId, agentId, shortId);
    return await selectWorkOrderByShortId(this.pool, this.workOrdersTable, tenantId, agentId, shortId);
  }

  async getWorkConversation(
    tenantId: string,
    workConversationId: string,
  ): Promise<OrgAgentWorkConversation | null> {
    assertTexts(tenantId, workConversationId);
    return await getStoredWorkConversation(
      this.pool, this.conversationsTable, tenantId, workConversationId,
    );
  }

  async listWorkConversations(
    tenantId: string,
    bindingId: string,
    limit = 50,
  ): Promise<OrgAgentWorkConversation[]> {
    assertTexts(tenantId, bindingId);
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    return listStoredWorkConversations(
      this.pool, this.conversationsTable, tenantId, bindingId, bounded,
    );
  }

  async listWorkAttempts(tenantId: string, workOrderId: string): Promise<OrgAgentWorkAttempt[]> {
    assertTexts(tenantId, workOrderId);
    return await listStoredWorkAttempts(this.pool, this.attemptsTable, tenantId, workOrderId);
  }

  async loadGroupWorkspace(input: Parameters<OrgGroupAgentStore['loadGroupWorkspace']>[0]) {
    assertTexts(input.tenantId, ...input.bindingIds);
    return await loadStoredGroupWorkspace({
      pool: this.pool, tenantId: input.tenantId, bindingIds: [...new Set(input.bindingIds)],
      limitPerBinding: Math.max(1, Math.min(100, Math.trunc(input.limitPerBinding ?? 50))),
      tables: {
        conversations: this.conversationsTable, workOrders: this.workOrdersTable,
        attempts: this.attemptsTable, memories: this.memoriesTable,
      },
    });
  }

  async transitionWorkAttempt(input: {
    tenantId: string;
    runtimeRunId: string;
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    resultEnvelope?: OrgAgentResultEnvelope;
    failure?: string;
    checkpoint?: Record<string, unknown>;
    artifactManifest?: Record<string, unknown>;
    publishState?: OrgAgentWorkAttempt['publishState'];
  }): Promise<OrgAgentWorkAttempt | null> {
    assertTexts(input.tenantId, input.runtimeRunId);
    return await transitionAttempt(this.pool, this.attemptsTable, this.workOrdersTable, input);
  }

  async transitionWorkAttemptPublishState(input: {
    tenantId: string;
    attemptId: string;
    expectedState: 'pending';
    state: 'published' | 'conflict' | 'rejected';
    artifactManifest?: Record<string, unknown>;
  }): Promise<OrgAgentWorkAttempt> {
    assertTexts(input.tenantId, input.attemptId);
    return await transitionAttemptPublishState(this.pool, this.attemptsTable, input);
  }

  async listWorkOrders(
    tenantId: string,
    bindingId: string,
    limit = 50,
  ): Promise<OrgAgentWorkOrder[]> {
    assertTexts(tenantId, bindingId);
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    const result = await this.pool.query(
      `SELECT * FROM ${this.workOrdersTable}
      WHERE tenant_id=$1 AND binding_id=$2 ORDER BY updated_at DESC,work_order_id DESC LIMIT $3`,
      [tenantId, bindingId, bounded],
    );
    return result.rows.map((row) => mapWorkOrder(row as Record<string, unknown>));
  }

  async listStagedWorkOrders(staleBefore: Date, limit = 100): Promise<OrgAgentWorkOrder[]> {
    const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
    const result = await this.pool.query(
      `SELECT work.* FROM ${this.workOrdersTable} work
      WHERE work.state='queued' AND work.updated_at<$1
      ORDER BY work.updated_at,work.work_order_id LIMIT $2`,
      [staleBefore.toISOString(), bounded],
    );
    return result.rows.map((row) => mapWorkOrder(row as Record<string, unknown>));
  }

  async transitionWorkOrder(input: {
    tenantId: string;
    workOrderId: string;
    expectedVersion: number;
    state: OrgAgentWorkOrderState;
    resultEnvelope?: OrgAgentResultEnvelope;
  }): Promise<OrgAgentWorkOrder> {
    assertTexts(input.tenantId, input.workOrderId);
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1)
      throw new Error('ORG_AGENT_WORK_ORDER_INVALID');
    const terminal = ['completed', 'failed', 'cancelled'].includes(input.state);
    const result = await this.pool.query(
      `UPDATE ${this.workOrdersTable}
      SET state=$4,result_envelope_json=COALESCE($5::jsonb,result_envelope_json),version=version+1,
          completed_at=CASE WHEN $6 THEN NOW() ELSE NULL END,updated_at=NOW()
      WHERE tenant_id=$1 AND work_order_id=$2 AND version=$3
        AND state NOT IN ('completed','failed','cancelled') RETURNING *`,
      [
        input.tenantId,
        input.workOrderId,
        input.expectedVersion,
        input.state,
        input.resultEnvelope ? JSON.stringify(input.resultEnvelope) : null,
        terminal,
      ],
    );
    if (!result.rows[0]) throw new Error('ORG_AGENT_WORK_ORDER_VERSION_OR_TERMINAL_CONFLICT');
    return mapWorkOrder(result.rows[0] as Record<string, unknown>);
  }

  async updateWorkOrderControl(input: {
    tenantId: string;
    workOrderId: string;
    expectedVersion: number;
    control: OrgAgentWorkOrderControl;
  }): Promise<OrgAgentWorkOrder> {
    return await updateStoredWorkOrderControl(this.pool, this.workOrdersTable, input);
  }

  async pauseWorkOrder(input: {
    tenantId: string;
    workOrderId: string;
    expectedVersion: number;
  }): Promise<OrgAgentWorkOrder> {
    return await pauseStoredWorkOrder(this.pool, this.workOrdersTable, this.attemptsTable, input);
  }

  async queueWorkOrderAttempt(input: {
    tenantId: string;
    workOrderId: string;
    expectedVersion: number;
    control?: OrgAgentWorkOrderControl;
    supersedePendingCompletion?: boolean;
  }): Promise<OrgAgentWorkOrder> {
    return await queueStoredWorkOrderAttempt(
      this.pool, this.workOrdersTable, this.deliveriesTable, input,
    );
  }

  async reopenWorkOrder(input: {
    tenantId: string;
    workOrderId: string;
    expectedVersion: number;
  }): Promise<OrgAgentWorkOrder> {
    assertTexts(input.tenantId, input.workOrderId);
    const result = await this.pool.query(
      `UPDATE ${this.workOrdersTable}
      SET state='queued',result_envelope_json=NULL,version=version+1,completed_at=NULL,updated_at=NOW()
      WHERE tenant_id=$1 AND work_order_id=$2 AND version=$3
        AND state IN ('completed','failed','cancelled')
        AND NOT EXISTS (
          SELECT 1 FROM ${this.deliveriesTable} delivery
          WHERE delivery.tenant_id=$1 AND delivery.source_work_order_id=$2
            AND delivery.delivery_kind='task_completion'
            AND delivery.delivery_state IN ('pending','sending','unknown')
        ) RETURNING *`,
      [input.tenantId, input.workOrderId, input.expectedVersion],
    );
    if (!result.rows[0]) throw new Error('ORG_AGENT_WORK_ORDER_RETRY_CONFLICT');
    return mapWorkOrder(result.rows[0] as Record<string, unknown>);
  }

  async createMemory(input: {
    tenantId: string;
    agentId: string;
    bindingId?: string;
    workConversationId?: string;
    workOrderId?: string;
    memoryScope: 'conversation' | 'task_checkpoint';
    content: Record<string, unknown>;
    provenance: Record<string, unknown>;
    policyRevision: number;
  }): Promise<OrgAgentMemory> {
    assertTexts(input.tenantId, input.agentId);
    if (!input.bindingId)
      throw new Error('ORG_AGENT_MEMORY_SCOPE_INVALID');
    if (input.memoryScope === 'task_checkpoint' && !input.workOrderId)
      throw new Error('ORG_AGENT_MEMORY_SCOPE_INVALID');
    const binding = await this.getBindingById(input.tenantId, input.bindingId);
    if (!binding || binding.agentId !== input.agentId || binding.revision !== input.policyRevision)
      throw new Error('ORG_AGENT_MEMORY_ASSOCIATION_INVALID');
    let effectiveWorkConversationId = input.workConversationId;
    if (input.memoryScope === 'task_checkpoint') {
      const work = await this.getWorkOrder(input.tenantId, input.workOrderId!);
      if (
        !work ||
        work.agentId !== input.agentId ||
        work.bindingId !== input.bindingId ||
        (effectiveWorkConversationId && effectiveWorkConversationId !== work.workConversationId)
      ) throw new Error('ORG_AGENT_MEMORY_ASSOCIATION_INVALID');
      effectiveWorkConversationId = work.workConversationId;
    }
    if (!effectiveWorkConversationId)
      throw new Error('ORG_AGENT_MEMORY_SCOPE_INVALID');
    const conversation = await this.getWorkConversation(input.tenantId, effectiveWorkConversationId);
    if (!conversation || conversation.bindingId !== input.bindingId)
      throw new Error('ORG_AGENT_MEMORY_ASSOCIATION_INVALID');
    const result = await this.pool.query(
      `INSERT INTO ${this.memoriesTable} (
      memory_id,tenant_id,agent_id,binding_id,work_conversation_id,work_order_id,memory_scope,status,
      content_json,provenance_json,policy_revision,version,created_at,updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8::jsonb,$9::jsonb,$10,1,NOW(),NOW()) RETURNING *`,
      [
        `memory-${randomUUID()}`,
        input.tenantId,
        input.agentId,
        input.bindingId ?? null,
        effectiveWorkConversationId,
        input.workOrderId ?? null,
        input.memoryScope,
        JSON.stringify(input.content),
        JSON.stringify(input.provenance),
        input.policyRevision,
      ],
    );
    return mapMemory(requiredRow(result.rows[0]));
  }

  async promoteMemory(input: {
    tenantId: string;
    sourceMemoryId: string;
    promotedBy: string;
    reason: string;
    policyRevision: number;
  }): Promise<OrgAgentMemory> {
    assertTexts(input.tenantId, input.sourceMemoryId, input.promotedBy, input.reason);
    return mapMemory(await promoteStoredMemory(this.pool, this.memoriesTable, {
      ...input,
      memoryId: `memory-${randomUUID()}`,
    }));
  }

  async changeMemoryStatus(input: {
    tenantId: string;
    memoryId: string;
    expectedVersion: number;
    status: 'revoked' | 'deleted';
  }): Promise<OrgAgentMemory> {
    assertTexts(input.tenantId, input.memoryId);
    return mapMemory(await changeStoredMemoryStatus(this.pool, this.memoriesTable, input));
  }

  async listMemories(input: {
    tenantId: string;
    agentId: string;
    bindingId?: string;
    workConversationId?: string;
    memoryScope?: 'agent' | 'conversation' | 'task_checkpoint';
    status?: 'active' | 'revoked' | 'deleted';
    limit?: number;
  }): Promise<OrgAgentMemory[]> {
    assertTexts(input.tenantId, input.agentId);
    const bounded = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 50)));
    const result = await this.pool.query(
      `SELECT * FROM ${this.memoriesTable}
      WHERE tenant_id=$1 AND agent_id=$2 AND ($3::text IS NULL OR binding_id=$3)
        AND ($4::text IS NULL OR work_conversation_id=$4) AND ($5::text IS NULL OR memory_scope=$5)
        AND ($6::text IS NULL OR status=$6)
      ORDER BY updated_at DESC,memory_id DESC LIMIT $7`,
      [
        input.tenantId,
        input.agentId,
        input.bindingId ?? null,
        input.workConversationId ?? null,
        input.memoryScope ?? null,
        input.status ?? null,
        bounded,
      ],
    );
    return result.rows.map((row) => mapMemory(row as Record<string, unknown>));
  }

  async getMemory(tenantId: string, memoryId: string): Promise<OrgAgentMemory | null> {
    assertTexts(tenantId, memoryId);
    const result = await this.pool.query(
      `SELECT * FROM ${this.memoriesTable} WHERE tenant_id=$1 AND memory_id=$2`,
      [tenantId, memoryId],
    );
    return result.rows[0] ? mapMemory(result.rows[0] as Record<string, unknown>) : null;
  }

  private deliveryTables() {
    return {
      deliveries: this.deliveriesTable,
      inbox: this.inboxTable,
      workOrders: this.workOrdersTable,
      attempts: this.attemptsTable,
    };
  }

}

function assertTexts(...values: string[]): void {
  if (values.some((value) => typeof value !== 'string' || !value.trim()))
    throw new Error('ORG_AGENT_STORE_INVALID');
}
