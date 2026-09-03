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
      WHERE delivery_id=$1 AND delivery_state='sending' AND lease_owner=$2 AND lease_fence=$3 RETURNING *`,
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
        `SELECT current_attempt_no FROM ${this.workOrdersTable}
        WHERE tenant_id=$1 AND work_order_id=$2 AND state NOT IN ('completed','cancelled') FOR UPDATE`,
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

function mapBinding(row: Record<string, unknown>): OrgAgentChannelBinding {
  return {
    bindingId: String(row.binding_id),
    tenantId: String(row.tenant_id),
    accountId: String(row.account_id),
    agentId: String(row.agent_id),
    conversationId: String(row.conversation_id),
    channelKind: row.channel_kind as 'group' | 'direct',
    activationState: row.activation_state as 'shadow' | 'active' | 'disabled',
    enabled: row.enabled === true,
    conversationSpaceId: String(row.conversation_space_id),
    serviceSessionId: String(row.service_session_id),
    workspaceId: String(row.workspace_id),
    policy: validatePolicy(parseJson(row.policy_json)),
    effectiveConfig: validateEffectiveConfig(parseJson(row.effective_config_json)),
    revision: Number(row.revision),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapWorkConversation(row: Record<string, unknown>): OrgAgentWorkConversation {
  return {
    workConversationId: String(row.work_conversation_id),
    tenantId: String(row.tenant_id),
    bindingId: String(row.binding_id),
    rootKey: String(row.root_key),
    ...(text(row.root_message_id) ? { rootMessageId: text(row.root_message_id) } : {}),
    sessionId: String(row.session_id),
    state: row.state as 'active' | 'closed',
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapDelivery(row: Record<string, unknown>): DwsDeliveryIntent {
  return {
    deliveryId: String(row.delivery_id),
    tenantId: String(row.tenant_id),
    ...(text(row.inbox_id) ? { inboxId: text(row.inbox_id) } : {}),
    accountId: String(row.account_id),
    conversationId: String(row.conversation_id),
    ...(text(row.agent_id) ? { agentId: text(row.agent_id) } : {}),
    ...(text(row.binding_id) ? { bindingId: text(row.binding_id) } : {}),
    ...(text(row.conversation_space_id)
      ? { conversationSpaceId: text(row.conversation_space_id) }
      : {}),
    ...(text(row.work_conversation_id)
      ? { workConversationId: text(row.work_conversation_id) }
      : {}),
    ...(Number.isSafeInteger(Number(row.policy_revision)) && Number(row.policy_revision) >= 1
      ? { policyRevision: Number(row.policy_revision) }
      : {}),
    ...(row.visibility === 'conversation' ||
    row.visibility === 'requester_only' ||
    row.visibility === 'public_notice'
      ? { visibility: row.visibility }
      : {}),
    ...(text(row.source_work_order_id)
      ? { sourceWorkOrderId: text(row.source_work_order_id) }
      : {}),
    ...(text(row.source_attempt_id) ? { sourceAttemptId: text(row.source_attempt_id) } : {}),
    source: row.source as DwsDeliveryIntent['source'],
    deliveryKind: row.delivery_kind as DwsDeliveryIntent['deliveryKind'],
    disposition: row.disposition as DwsDeliveryIntent['disposition'],
    deliveryState: row.delivery_state as DwsDeliveryIntent['deliveryState'],
    destination: validateDestination(
      parseJson(row.destination_json),
      String(row.account_id),
      String(row.conversation_id),
    ),
    content: String(row.content),
    idempotencyKey: String(row.idempotency_key),
    ...(row.provider_receipt_json ? { providerReceipt: parseJson(row.provider_receipt_json) } : {}),
    attempt: Number(row.attempt),
    ...(text(row.lease_owner) ? { leaseOwner: text(row.lease_owner) } : {}),
    leaseFence: Number(row.lease_fence),
    ...(row.lease_expires_at ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}),
    ...(row.last_attempt_at ? { lastAttemptAt: iso(row.last_attempt_at) } : {}),
    ...(text(row.last_error) ? { lastError: text(row.last_error) } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {}),
  };
}

function mapWorkOrder(row: Record<string, unknown>): OrgAgentWorkOrder {
  const actor = parseJson(row.created_by_actor_json);
  if (actor.kind !== 'external_user' || actor.provider !== 'dingtalk')
    throw new Error('ORG_AGENT_WORK_ORDER_ACTOR_INVALID');
  return {
    workOrderId: String(row.work_order_id),
    tenantId: String(row.tenant_id),
    agentId: String(row.agent_id),
    bindingId: String(row.binding_id),
    workConversationId: String(row.work_conversation_id),
    idempotencyKey: String(row.idempotency_key),
    title: String(row.title),
    state: row.state as OrgAgentWorkOrder['state'],
    visibility: row.visibility as OrgAgentWorkOrder['visibility'],
    currentAttemptNo: Number(row.current_attempt_no),
    createdByActor: actor as unknown as ExternalActorRef,
    policySnapshot: parseJson(row.policy_snapshot_json),
    cancelPolicy: parseJson(row.cancel_policy_json),
    ...(row.result_envelope_json
      ? { resultEnvelope: parseJson(row.result_envelope_json) as unknown as OrgAgentResultEnvelope }
      : {}),
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {}),
  };
}

function mapWorkAttempt(row: Record<string, unknown>): OrgAgentWorkAttempt {
  return {
    attemptId: String(row.attempt_id),
    tenantId: String(row.tenant_id),
    workOrderId: String(row.work_order_id),
    attemptNo: Number(row.attempt_no),
    runtimeRunId: String(row.runtime_run_id),
    status: row.status as OrgAgentWorkAttempt['status'],
    ...(text(row.parent_attempt_id) ? { parentAttemptId: text(row.parent_attempt_id) } : {}),
    taskWorkspaceId: String(row.task_workspace_id),
    sandboxScopeId: String(row.sandbox_scope_id),
    mountSubPath: String(row.mount_sub_path),
    sharedReadOnlySubPath: String(row.shared_read_only_sub_path),
    publishState: row.publish_state as OrgAgentWorkAttempt['publishState'],
    ...(row.checkpoint_json ? { checkpoint: parseJson(row.checkpoint_json) } : {}),
    ...(row.artifact_manifest_json
      ? { artifactManifest: parseJson(row.artifact_manifest_json) }
      : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapMemory(row: Record<string, unknown>): OrgAgentMemory {
  return {
    memoryId: String(row.memory_id),
    tenantId: String(row.tenant_id),
    agentId: String(row.agent_id),
    ...(text(row.binding_id) ? { bindingId: text(row.binding_id) } : {}),
    ...(text(row.work_conversation_id)
      ? { workConversationId: text(row.work_conversation_id) }
      : {}),
    ...(text(row.work_order_id) ? { workOrderId: text(row.work_order_id) } : {}),
    memoryScope: row.memory_scope as OrgAgentMemory['memoryScope'],
    status: row.status as OrgAgentMemory['status'],
    content: parseJson(row.content_json),
    provenance: parseJson(row.provenance_json),
    ...(text(row.promoted_by) ? { promotedBy: text(row.promoted_by) } : {}),
    ...(text(row.promotion_reason) ? { promotionReason: text(row.promotion_reason) } : {}),
    policyRevision: Number(row.policy_revision),
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.revoked_at ? { revokedAt: iso(row.revoked_at) } : {}),
    ...(row.deleted_at ? { deletedAt: iso(row.deleted_at) } : {}),
  };
}

function validatePolicy(value: unknown): OrgAgentChannelPolicy {
  const raw = parseJson(value);
  return {
    enabled: raw.enabled === true,
    membership: raw.membership === 'members_and_guests' ? 'members_and_guests' : 'members',
    guest: raw.guest === 'shared_read_only' ? 'shared_read_only' : 'deny',
    taskVisibility: raw.taskVisibility === 'requester_only' ? 'requester_only' : 'conversation',
    completion: raw.completion === 'silent' ? 'silent' : 'reply_to_work_conversation',
    liveDeny: raw.liveDeny === true,
  };
}

function validateEffectiveConfig(value: unknown): OrgAgentEffectiveConfig {
  const raw = parseJson(value);
  const identity = parseJson(raw.identity);
  const knowledge = parseJson(raw.knowledge);
  const capabilities = parseJson(raw.capabilities);
  const access = parseJson(raw.access);
  const speech = parseJson(raw.speech);
  return {
    identity: {
      ...(text(identity.displayName) ? { displayName: text(identity.displayName) } : {}),
    },
    knowledge: {
      contextEnabled: knowledge.contextEnabled === true,
      sourceIds: stringArray(knowledge.sourceIds),
    },
    capabilities: {
      skillIds: stringArray(capabilities.skillIds),
      toolNames: stringArray(capabilities.toolNames),
    },
    access: {
      triggerRoles: stringArray(access.triggerRoles),
      approvalRoles: stringArray(access.approvalRoles),
    },
    speech: {
      proactive: speech.proactive === true,
      requireMention: speech.requireMention !== false,
    },
  };
}

function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return parseJson(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}
function requiredRow(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new Error('ORG_AGENT_STORE_INVALID');
  return value as Record<string, unknown>;
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error('ORG_AGENT_STORE_INVALID_DATE');
  return date.toISOString();
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

function validateDestination(
  value: unknown,
  accountId: string,
  conversationId: string,
): DwsDeliveryIntent['destination'] {
  const raw = parseJson(value);
  if (
    raw.provider !== 'dingtalk' ||
    raw.accountId !== accountId ||
    raw.conversationId !== conversationId ||
    (raw.kind !== 'group' && raw.kind !== 'direct')
  )
    throw new Error('DWS_DELIVERY_DESTINATION_INVALID');
  if (raw.kind === 'direct' && !text(raw.peerOpenId))
    throw new Error('DWS_DELIVERY_DESTINATION_INVALID');
  return {
    provider: 'dingtalk',
    accountId,
    conversationId,
    kind: raw.kind,
    ...(text(raw.peerOpenId) ? { peerOpenId: text(raw.peerOpenId) } : {}),
  };
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
