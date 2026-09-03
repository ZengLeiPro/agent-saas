import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import { PgGovernanceMigrationRunner, governanceTablePrefix } from '../governance-schema/index.js';
import {
  DEFAULT_ORG_AGENT_CHANNEL_POLICY,
  DEFAULT_ORG_AGENT_EFFECTIVE_CONFIG,
  type DwsDeliveryIntent,
  type ExternalActorRef,
  type OrgAgentChannelActorRef,
  type OrgAgentChannelBinding,
  type OrgAgentChannelPolicy,
  type OrgAgentEffectiveConfig,
  type OrgAgentWorkConversation,
  type OrgAgentWorkAttempt,
  type OrgAgentWorkOrder,
  type OrgAgentWorkOrderState,
  type OrgAgentResultEnvelope,
  type OrgAgentMemory,
  type OrgGroupAgentStore,
} from './types.js';
import {
  mapBinding, mapDelivery, mapMemory, mapWorkAttempt, mapWorkConversation, mapWorkOrder,
  requiredRow, validateDestination, validateEffectiveConfig, validatePolicy,
} from './storeMappers.js';

const MAX_DELIVERY_LEASE_MS = 24 * 60 * 60 * 1_000;

export class PgOrgGroupAgentStore implements OrgGroupAgentStore {
  private readonly prefix: string;
  private readonly bindingsTable: string;
  private readonly conversationsTable: string;
  private readonly inboxTable: string;
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
    this.deliveriesTable = `${this.prefix}_agent_dws_delivery_intents`;
    this.workOrdersTable = `${this.prefix}_org_agent_work_orders`;
    this.attemptsTable = `${this.prefix}_org_agent_work_attempts`;
    this.memoriesTable = `${this.prefix}_org_agent_memories`;
  }

  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(this.pool, this.prefix).run();
  }

  async ensureShadowBinding(input: {
    tenantId: string;
    accountId: string;
    agentId: string;
    conversationId: string;
    channelKind: 'group' | 'direct';
    workspaceId: string;
  }): Promise<OrgAgentChannelBinding> {
    assertTexts(
      input.tenantId,
      input.accountId,
      input.agentId,
      input.conversationId,
      input.workspaceId,
    );
    const bindingId = `oacb-${randomUUID()}`;
    const result = await this.pool.query(
      `
      INSERT INTO ${this.bindingsTable} AS binding (
        binding_id,tenant_id,account_id,agent_id,conversation_id,channel_kind,activation_state,enabled,
        conversation_space_id,service_session_id,workspace_id,policy_json,effective_config_json,
        revision,created_at,updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,'shadow',FALSE,$7,$8,$9,$10::jsonb,$11::jsonb,1,NOW(),NOW())
      ON CONFLICT (account_id,conversation_id) DO UPDATE
      SET updated_at=binding.updated_at
      RETURNING binding.*
    `,
      [
        bindingId,
        input.tenantId,
        input.accountId,
        input.agentId,
        input.conversationId,
        input.channelKind,
        `space-${randomUUID()}`,
        `agent-dws-service-${randomUUID()}`,
        input.workspaceId,
        JSON.stringify(DEFAULT_ORG_AGENT_CHANNEL_POLICY),
        JSON.stringify(DEFAULT_ORG_AGENT_EFFECTIVE_CONFIG),
      ],
    );
    const binding = mapBinding(requiredRow(result.rows[0]));
    if (
      binding.tenantId !== input.tenantId ||
      binding.agentId !== input.agentId ||
      binding.channelKind !== input.channelKind ||
      binding.workspaceId !== input.workspaceId
    ) {
      throw new Error('ORG_AGENT_BINDING_IDENTITY_CONFLICT');
    }
    return binding;
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
      `SELECT conversation.* FROM ${this.inboxTable} inbox
      JOIN ${this.conversationsTable} conversation
        ON conversation.work_conversation_id=inbox.work_conversation_id
      WHERE inbox.tenant_id=$1 AND inbox.account_id=$2 AND inbox.conversation_id=$3
        AND conversation.binding_id=$4 AND inbox.message_id=ANY($5::text[])
      ORDER BY inbox.created_at DESC LIMIT 1`,
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

  async createDelivery(
    input: Omit<
      DwsDeliveryIntent,
      'deliveryId' | 'deliveryState' | 'attempt' | 'leaseFence' | 'createdAt' | 'updatedAt'
    >,
  ): Promise<DwsDeliveryIntent> {
    assertTexts(
      input.tenantId,
      input.accountId,
      input.conversationId,
      input.content,
      input.idempotencyKey,
    );
    const result = await this.pool.query(
      `INSERT INTO ${this.deliveriesTable} AS delivery (
      delivery_id,tenant_id,inbox_id,account_id,conversation_id,work_conversation_id,source,
      agent_id,binding_id,conversation_space_id,policy_revision,visibility,source_work_order_id,source_attempt_id,
      delivery_kind,disposition,delivery_state,destination_json,content,idempotency_key,
      provider_receipt_json,attempt,lease_fence,created_at,updated_at,completed_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pending',$17::jsonb,$18,$19,$20::jsonb,0,0,NOW(),NOW(),$21)
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
        input.providerReceipt ? JSON.stringify(sanitizeReceipt(input.providerReceipt)) : null,
        input.completedAt ?? null,
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
    const result = await this.pool.query(
      `UPDATE ${this.deliveriesTable}
      SET delivery_state='sending',attempt=attempt+1,lease_owner=$2,lease_fence=lease_fence+1,
          lease_expires_at=NOW()+($3::bigint*INTERVAL '1 millisecond'),last_attempt_at=NOW(),updated_at=NOW()
      WHERE delivery_id=$1 AND delivery_state='pending' RETURNING *`,
      [deliveryId, owner, ttlMs],
    );
    if (!result.rows[0]) throw new Error('DWS_DELIVERY_NOT_CLAIMABLE');
    return mapDelivery(result.rows[0] as Record<string, unknown>);
  }

  async claimNextDelivery(owner: string, ttlMs: number): Promise<DwsDeliveryIntent | null> {
    assertTexts(owner);
    if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_DELIVERY_LEASE_MS)
      throw new Error('DWS_DELIVERY_INVALID');
    const result = await this.pool.query(
      `WITH candidate AS (
      SELECT delivery_id FROM ${this.deliveriesTable}
      WHERE delivery_state='pending' ORDER BY created_at,delivery_id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE ${this.deliveriesTable} delivery
      SET delivery_state='sending',attempt=attempt+1,lease_owner=$1,lease_fence=lease_fence+1,
          lease_expires_at=NOW()+($2::bigint*INTERVAL '1 millisecond'),last_attempt_at=NOW(),updated_at=NOW()
      FROM candidate WHERE delivery.delivery_id=candidate.delivery_id RETURNING delivery.*`,
      [owner, ttlMs],
    );
    return result.rows[0] ? mapDelivery(result.rows[0] as Record<string, unknown>) : null;
  }

  async reconcileAllExpiredDeliveries(limit = 100): Promise<number> {
    const bounded = Math.max(1, Math.min(1_000, Math.trunc(limit)));
    const result = await this.pool.query(
      `WITH expired AS (
      SELECT delivery_id FROM ${this.deliveriesTable}
      WHERE delivery_state='sending' AND lease_expires_at<=NOW()
      ORDER BY lease_expires_at,delivery_id FOR UPDATE SKIP LOCKED LIMIT $1
    ) UPDATE ${this.deliveriesTable} delivery
      SET delivery_state='unknown',lease_owner=NULL,lease_expires_at=NULL,
          last_error='DWS_DELIVERY_RECEIPT_UNKNOWN_AFTER_LEASE_EXPIRY',completed_at=NOW(),updated_at=NOW()
      FROM expired WHERE delivery.delivery_id=expired.delivery_id`,
      [bounded],
    );
    return result.rowCount ?? 0;
  }

  async markDeliverySent(
    deliveryId: string,
    owner: string,
    fence: number,
    receipt: Record<string, unknown>,
  ): Promise<DwsDeliveryIntent> {
    if (Object.keys(sanitizeReceipt(receipt)).length === 0)
      throw new Error('DWS_DELIVERY_RECEIPT_REQUIRED');
    return await this.finishDelivery(deliveryId, owner, fence, 'sent', undefined, receipt);
  }

  async markDeliveryUnknown(
    deliveryId: string,
    owner: string,
    fence: number,
    error: unknown,
  ): Promise<DwsDeliveryIntent> {
    return await this.finishDelivery(deliveryId, owner, fence, 'unknown', compactError(error));
  }

  async markDeliveryDeadLetter(deliveryId: string, reason: string): Promise<DwsDeliveryIntent> {
    assertTexts(deliveryId, reason);
    const result = await this.pool.query(
      `UPDATE ${this.deliveriesTable}
      SET delivery_state='dead_letter',lease_owner=NULL,lease_expires_at=NULL,last_error=$2,
          completed_at=NOW(),updated_at=NOW()
      WHERE delivery_id=$1 AND delivery_state IN ('pending','unknown') RETURNING *`,
      [deliveryId, compactError(reason)],
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
      [deliveryId, owner, fence, compactError(reason)],
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
    const result = await this.pool.query(
      `WITH expired AS (
      SELECT delivery_id FROM ${this.deliveriesTable}
      WHERE tenant_id=$1 AND account_id=$2 AND delivery_state='sending' AND lease_expires_at<=NOW()
      ORDER BY lease_expires_at,delivery_id FOR UPDATE SKIP LOCKED LIMIT $3
    ) UPDATE ${this.deliveriesTable} delivery
      SET delivery_state='unknown',lease_owner=NULL,lease_expires_at=NULL,
          last_error='DWS_DELIVERY_RECEIPT_UNKNOWN_AFTER_LEASE_EXPIRY',completed_at=NOW(),updated_at=NOW()
      FROM expired WHERE delivery.delivery_id=expired.delivery_id`,
      [tenantId, accountId, bounded],
    );
    return result.rowCount ?? 0;
  }

  async listDeliveries(
    tenantId: string,
    accountId: string,
    limit = 50,
  ): Promise<DwsDeliveryIntent[]> {
    assertTexts(tenantId, accountId);
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    const result = await this.pool.query(
      `SELECT * FROM ${this.deliveriesTable}
      WHERE tenant_id=$1 AND account_id=$2 ORDER BY created_at DESC,delivery_id DESC LIMIT $3`,
      [tenantId, accountId, bounded],
    );
    return result.rows.map((row) => mapDelivery(row as Record<string, unknown>));
  }

  async getDelivery(tenantId: string, deliveryId: string): Promise<DwsDeliveryIntent | null> {
    assertTexts(tenantId, deliveryId);
    const result = await this.pool.query(
      `SELECT * FROM ${this.deliveriesTable} WHERE tenant_id=$1 AND delivery_id=$2`,
      [tenantId, deliveryId],
    );
    return result.rows[0] ? mapDelivery(result.rows[0] as Record<string, unknown>) : null;
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
    const evidence = sanitizeReceipt({
      ...input.evidence,
      reconciledAt: new Date().toISOString(),
      reconcileOutcome: input.outcome,
    });
    const state =
      input.outcome === 'confirmed_sent'
        ? 'sent'
        : input.outcome === 'confirmed_not_sent'
          ? 'pending'
          : 'unknown';
    const result = await this.pool.query(
      `UPDATE ${this.deliveriesTable}
      SET delivery_state=$3,provider_receipt_json=$4::jsonb,lease_owner=NULL,lease_expires_at=NULL,
          last_error=$5,completed_at=CASE WHEN $3='pending' THEN NULL ELSE NOW() END,updated_at=NOW()
      WHERE tenant_id=$1 AND delivery_id=$2 AND delivery_state='unknown' RETURNING *`,
      [
        input.tenantId,
        input.deliveryId,
        state,
        JSON.stringify({ ...evidence, reconciledBy: input.actorId }),
        compactError(input.reason),
      ],
    );
    if (!result.rows[0]) throw new Error('DWS_DELIVERY_NOT_RECONCILABLE');
    return mapDelivery(result.rows[0] as Record<string, unknown>);
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
  }): Promise<OrgAgentWorkOrder> {
    assertTexts(
      input.tenantId,
      input.agentId,
      input.bindingId,
      input.workConversationId,
      input.idempotencyKey,
      input.title,
    );
    const result = await this.pool.query(
      `INSERT INTO ${this.workOrdersTable} AS work_order (
      work_order_id,tenant_id,agent_id,binding_id,work_conversation_id,idempotency_key,title,state,
      current_attempt_no,visibility,created_by_actor_json,policy_snapshot_json,cancel_policy_json,
      version,created_at,updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',0,$8,$9::jsonb,$10::jsonb,$11::jsonb,1,NOW(),NOW())
    ON CONFLICT (tenant_id,idempotency_key) DO UPDATE SET idempotency_key=work_order.idempotency_key
    RETURNING work_order.*`,
      [
        `work-${randomUUID()}`,
        input.tenantId,
        input.agentId,
        input.bindingId,
        input.workConversationId,
        input.idempotencyKey,
        input.title.slice(0, 500),
        input.visibility,
        JSON.stringify(input.createdByActor),
        JSON.stringify(input.policySnapshot),
        JSON.stringify(input.cancelPolicy),
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
          attempt.sandboxScopeId !== input.sandboxScopeId
        ) {
          throw new Error('ORG_AGENT_WORK_ATTEMPT_IDEMPOTENCY_CONFLICT');
        }
        await client.query('COMMIT');
        return attempt;
      }
      if ((work.rows[0] as Record<string, unknown>).state !== 'queued')
        throw new Error('ORG_AGENT_WORK_ORDER_NOT_ATTEMPTABLE');
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
        `UPDATE ${this.workOrdersTable} SET current_attempt_no=$3,state='running',
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
    const result = await this.pool.query(
      `SELECT * FROM ${this.workOrdersTable}
      WHERE tenant_id=$1 AND work_order_id=$2`,
      [tenantId, workOrderId],
    );
    return result.rows[0] ? mapWorkOrder(result.rows[0] as Record<string, unknown>) : null;
  }

  async getWorkConversation(
    tenantId: string,
    workConversationId: string,
  ): Promise<OrgAgentWorkConversation | null> {
    assertTexts(tenantId, workConversationId);
    const result = await this.pool.query(
      `SELECT * FROM ${this.conversationsTable}
      WHERE tenant_id=$1 AND work_conversation_id=$2`,
      [tenantId, workConversationId],
    );
    return result.rows[0] ? mapWorkConversation(result.rows[0] as Record<string, unknown>) : null;
  }

  async listWorkAttempts(tenantId: string, workOrderId: string): Promise<OrgAgentWorkAttempt[]> {
    assertTexts(tenantId, workOrderId);
    const result = await this.pool.query(
      `SELECT * FROM ${this.attemptsTable}
      WHERE tenant_id=$1 AND work_order_id=$2 ORDER BY attempt_no ASC`,
      [tenantId, workOrderId],
    );
    return result.rows.map((row) => mapWorkAttempt(row as Record<string, unknown>));
  }

  async transitionWorkAttempt(input: {
    tenantId: string;
    runtimeRunId: string;
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    resultEnvelope?: OrgAgentResultEnvelope;
    failure?: string;
  }): Promise<OrgAgentWorkAttempt | null> {
    assertTexts(input.tenantId, input.runtimeRunId);
    const terminal = input.status !== 'running';
    const result = await this.pool.query(
      `UPDATE ${this.attemptsTable}
      SET status=$3,result_envelope_json=COALESCE($4::jsonb,result_envelope_json),failure=$5,
          started_at=CASE WHEN $3='running' THEN COALESCE(started_at,NOW()) ELSE started_at END,
          completed_at=CASE WHEN $6 THEN NOW() ELSE completed_at END,updated_at=NOW()
      WHERE tenant_id=$1 AND runtime_run_id=$2 AND status NOT IN ('completed','failed','cancelled') RETURNING *`,
      [
        input.tenantId,
        input.runtimeRunId,
        input.status,
        input.resultEnvelope ? JSON.stringify(input.resultEnvelope) : null,
        input.failure ?? null,
        terminal,
      ],
    );
    return result.rows[0] ? mapWorkAttempt(result.rows[0] as Record<string, unknown>) : null;
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
      `SELECT * FROM ${this.workOrdersTable}
      WHERE state='queued' AND current_attempt_no=0 AND updated_at<$1
      ORDER BY updated_at,work_order_id LIMIT $2`,
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
        AND state IN ('completed','failed','cancelled') RETURNING *`,
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
    if (input.memoryScope === 'conversation' && (!input.bindingId || !input.workConversationId))
      throw new Error('ORG_AGENT_MEMORY_SCOPE_INVALID');
    if (input.memoryScope === 'task_checkpoint' && !input.workOrderId)
      throw new Error('ORG_AGENT_MEMORY_SCOPE_INVALID');
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
        input.workConversationId ?? null,
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
    const result = await this.pool.query(
      `INSERT INTO ${this.memoriesTable} (
      memory_id,tenant_id,agent_id,memory_scope,status,content_json,provenance_json,promoted_by,
      promotion_reason,policy_revision,version,created_at,updated_at
    ) SELECT $1,tenant_id,agent_id,'agent','active',content_json,
      provenance_json || jsonb_build_object('sourceMemoryId',memory_id),$4,$5,$6,1,NOW(),NOW()
      FROM ${this.memoriesTable} WHERE tenant_id=$2 AND memory_id=$3 AND status='active'
        AND memory_scope IN ('conversation','task_checkpoint') RETURNING *`,
      [
        `memory-${randomUUID()}`,
        input.tenantId,
        input.sourceMemoryId,
        input.promotedBy,
        input.reason.slice(0, 1000),
        input.policyRevision,
      ],
    );
    if (!result.rows[0]) throw new Error('ORG_AGENT_MEMORY_NOT_PROMOTABLE');
    return mapMemory(result.rows[0] as Record<string, unknown>);
  }

  async changeMemoryStatus(input: {
    tenantId: string;
    memoryId: string;
    expectedVersion: number;
    status: 'revoked' | 'deleted';
  }): Promise<OrgAgentMemory> {
    assertTexts(input.tenantId, input.memoryId);
    const result = await this.pool.query(
      `UPDATE ${this.memoriesTable}
      SET status=$4,version=version+1,revoked_at=CASE WHEN $4='revoked' THEN NOW() ELSE revoked_at END,
          deleted_at=CASE WHEN $4='deleted' THEN NOW() ELSE deleted_at END,updated_at=NOW()
      WHERE tenant_id=$1 AND memory_id=$2 AND version=$3 AND status='active' RETURNING *`,
      [input.tenantId, input.memoryId, input.expectedVersion, input.status],
    );
    if (!result.rows[0]) throw new Error('ORG_AGENT_MEMORY_VERSION_CONFLICT');
    return mapMemory(result.rows[0] as Record<string, unknown>);
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

  private async finishDelivery(
    deliveryId: string,
    owner: string,
    fence: number,
    state: 'sent' | 'unknown',
    error?: string,
    receipt?: Record<string, unknown>,
  ): Promise<DwsDeliveryIntent> {
    assertTexts(deliveryId, owner);
    const result = await this.pool.query(
      `UPDATE ${this.deliveriesTable}
      SET delivery_state=$4,provider_receipt_json=COALESCE($5::jsonb,provider_receipt_json),
          lease_owner=NULL,lease_expires_at=NULL,last_error=$6,completed_at=NOW(),updated_at=NOW()
      WHERE delivery_id=$1 AND delivery_state='sending' AND lease_owner=$2 AND lease_fence=$3
        AND lease_expires_at>NOW() RETURNING *`,
      [
        deliveryId,
        owner,
        fence,
        state,
        receipt ? JSON.stringify(sanitizeReceipt(receipt)) : null,
        error ?? null,
      ],
    );
    if (!result.rows[0]) throw new Error('DWS_DELIVERY_LEASE_LOST');
    return mapDelivery(result.rows[0] as Record<string, unknown>);
  }
}

function assertTexts(...values: string[]): void {
  if (values.some((value) => typeof value !== 'string' || !value.trim()))
    throw new Error('ORG_AGENT_STORE_INVALID');
}
function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, ' ')
    .slice(0, 2_000);
}

function sanitizeReceipt(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of [
    'messageId',
    'processQueryKey',
    'status',
    'acceptedAt',
    'reconciledAt',
    'reconcileOutcome',
    'reconciledBy',
  ]) {
    const item = value[key];
    if (typeof item === 'string' && item.trim()) result[key] = item.slice(0, 512);
  }
  return result;
}
