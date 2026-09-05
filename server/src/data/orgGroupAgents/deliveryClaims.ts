import type pg from 'pg';

import type { DwsDeliveryIntent, DwsReplyRecoveryState } from './types.js';
import { mapDelivery } from './storeMappers.js';

export const DELIVERY_MAX_ATTEMPTS = 5;
const DELIVERY_RETRY_BASE_MS = 1_000;
const DELIVERY_RETRY_MAX_MS = 300_000;

export function deliveryRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(8, Math.trunc(attempt) - 1));
  return Math.min(DELIVERY_RETRY_MAX_MS, DELIVERY_RETRY_BASE_MS * 2 ** exponent);
}

export interface DeliveryClaimTables {
  deliveries: string;
  inbox: string;
  workOrders: string;
  attempts: string;
}

export function compactDeliveryError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, ' ')
    .slice(0, 2_000);
}

export function sanitizeDeliveryReceipt(value: Record<string, unknown>): Record<string, unknown> {
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

/** Linearizes the millisecond-normalized account identity fence with provider start. */
export async function startDeliveryProviderAttempt(
  pool: pg.Pool, deliveriesTable: string, accountsTable: string,
  bindingsTable: string, managedAgentsTable: string,
  deliveryId: string, owner: string, fence: number,
): Promise<DwsDeliveryIntent> {
  const result = await pool.query(
    `UPDATE ${deliveriesTable} AS delivery
    SET provider_started_at=NOW(),provider_attempt_phase='provider_started',updated_at=NOW()
    WHERE delivery_id=$1 AND delivery_state='sending' AND lease_owner=$2 AND lease_fence=$3
      AND lease_expires_at>NOW() AND provider_attempt_phase='before_provider'
      AND provider_started_at IS NULL
      AND EXISTS (
        SELECT 1 FROM ${accountsTable} AS account
        WHERE account.tenant_id=delivery.tenant_id AND account.account_id=delivery.account_id
          AND account.status='active'
          AND account.profile_id=delivery.account_profile_id
          AND account.corp_id=delivery.account_corp_id
          AND account.dingtalk_user_id=delivery.account_dingtalk_user_id
          AND date_trunc('milliseconds', account.identity_updated_at)
            =date_trunc('milliseconds', delivery.account_identity_updated_at)
      )
      AND (
        (delivery.binding_id IS NULL AND delivery.agent_id IS NULL
          AND delivery.policy_revision IS NULL)
        OR EXISTS (
          SELECT 1 FROM ${bindingsTable} AS binding
          JOIN ${managedAgentsTable} AS agent
            ON agent.tenant_id=binding.tenant_id AND agent.agent_id=binding.agent_id
          WHERE binding.tenant_id=delivery.tenant_id
            AND binding.account_id=delivery.account_id
            AND binding.conversation_id=delivery.conversation_id
            AND binding.binding_id=delivery.binding_id
            AND binding.agent_id=delivery.agent_id
            AND binding.revision=delivery.policy_revision
            AND binding.activation_state='active' AND binding.enabled=TRUE
            AND binding.policy_json->>'enabled'='true'
            AND COALESCE(binding.policy_json->>'liveDeny','false')='false'
            AND binding.account_profile_id=delivery.account_profile_id
            AND binding.account_corp_id=delivery.account_corp_id
            AND binding.account_dingtalk_user_id=delivery.account_dingtalk_user_id
            AND date_trunc('milliseconds', binding.account_identity_updated_at)
              =date_trunc('milliseconds', delivery.account_identity_updated_at)
            AND agent.status='enabled'
        )
      )
    RETURNING delivery.*`,
    [deliveryId, owner, fence],
  );
  if (!result.rows[0]) throw new Error('DWS_DELIVERY_LEASE_LOST');
  return mapDelivery(result.rows[0] as Record<string, unknown>);
}

export async function releaseDeliveryBeforeProvider(
  pool: pg.Pool, deliveriesTable: string, deliveryId: string, owner: string, fence: number,
  error: unknown, delayMs: number, maxAttempts: number,
): Promise<DwsDeliveryIntent> {
  const result = await pool.query(
    `UPDATE ${deliveriesTable}
    SET delivery_state=CASE WHEN attempt >= $6 THEN 'dead_letter' ELSE 'pending' END,
        lease_owner=NULL,lease_expires_at=NULL,
        next_attempt_at=CASE WHEN attempt >= $6 THEN NULL
          ELSE NOW()+($5::bigint*INTERVAL '1 millisecond') END,
        last_error=$4,completed_at=CASE WHEN attempt >= $6 THEN NOW() ELSE NULL END,updated_at=NOW()
    WHERE delivery_id=$1 AND delivery_state='sending' AND lease_owner=$2 AND lease_fence=$3
      AND provider_attempt_phase='before_provider' AND provider_started_at IS NULL RETURNING *`,
    [deliveryId, owner, fence, compactDeliveryError(error), delayMs, maxAttempts],
  );
  if (!result.rows[0]) throw new Error('DWS_DELIVERY_LEASE_LOST');
  return mapDelivery(result.rows[0] as Record<string, unknown>);
}

export async function reconcileExpiredDeliveriesForAccount(
  pool: pg.Pool, deliveriesTable: string, tenantId: string, accountId: string, limit: number,
): Promise<number> {
  const result = await pool.query(
    `WITH expired AS (
      SELECT delivery_id FROM ${deliveriesTable}
      WHERE tenant_id=$1 AND account_id=$2 AND delivery_state='sending' AND lease_expires_at<=NOW()
      ORDER BY lease_expires_at,delivery_id FOR UPDATE SKIP LOCKED LIMIT $3
    ) UPDATE ${deliveriesTable} delivery
    SET delivery_state=CASE WHEN provider_attempt_phase<>'before_provider' THEN 'unknown'
          WHEN attempt >= $4 THEN 'dead_letter' ELSE 'pending' END,
        lease_owner=NULL,lease_expires_at=NULL,
        next_attempt_at=CASE WHEN provider_attempt_phase='before_provider' AND attempt < $4
          THEN NOW()+(LEAST(${DELIVERY_RETRY_MAX_MS},${DELIVERY_RETRY_BASE_MS}
            * POWER(2,LEAST(8,GREATEST(0,attempt-1))))::bigint * INTERVAL '1 millisecond')
          ELSE NULL END,
        last_error=CASE WHEN provider_attempt_phase<>'before_provider'
          THEN 'DWS_DELIVERY_RECEIPT_UNKNOWN_AFTER_LEASE_EXPIRY'
          WHEN attempt >= $4 THEN 'DWS_DELIVERY_MAX_ATTEMPTS_AFTER_LEASE_EXPIRY'
          ELSE 'DWS_DELIVERY_RETRY_AFTER_LEASE_EXPIRY_BEFORE_PROVIDER' END,
        completed_at=CASE WHEN provider_attempt_phase<>'before_provider' OR attempt >= $4
          THEN NOW() ELSE NULL END,updated_at=NOW()
    FROM expired WHERE delivery.delivery_id=expired.delivery_id`,
    [tenantId, accountId, limit, DELIVERY_MAX_ATTEMPTS],
  );
  return result.rowCount ?? 0;
}

export async function listDeliveryIntents(
  pool: pg.Pool, deliveriesTable: string, tenantId: string, accountId: string, limit: number,
): Promise<DwsDeliveryIntent[]> {
  const result = await pool.query(
    `SELECT * FROM ${deliveriesTable}
    WHERE tenant_id=$1 AND account_id=$2 ORDER BY created_at DESC,delivery_id DESC LIMIT $3`,
    [tenantId, accountId, limit],
  );
  return result.rows.map(row => mapDelivery(row as Record<string, unknown>));
}

export async function getDeliveryIntent(
  pool: pg.Pool, deliveriesTable: string, tenantId: string, deliveryId: string,
): Promise<DwsDeliveryIntent | null> {
  const result = await pool.query(
    `SELECT * FROM ${deliveriesTable} WHERE tenant_id=$1 AND delivery_id=$2`,
    [tenantId, deliveryId],
  );
  return result.rows[0] ? mapDelivery(result.rows[0] as Record<string, unknown>) : null;
}

export async function reconcileUnknownDelivery(
  pool: pg.Pool, deliveriesTable: string, input: {
    tenantId: string; deliveryId: string; actorId: string; reason: string;
    evidence: Record<string, unknown>;
    outcome: 'confirmed_sent' | 'confirmed_not_sent' | 'indeterminate';
  },
): Promise<DwsDeliveryIntent> {
  const evidence = sanitizeDeliveryReceipt({
    ...input.evidence, reconciledAt: new Date().toISOString(), reconcileOutcome: input.outcome,
  });
  const state = input.outcome === 'confirmed_sent' ? 'sent'
    : input.outcome === 'confirmed_not_sent' ? 'pending' : 'unknown';
  const result = await pool.query(
    `UPDATE ${deliveriesTable}
    SET delivery_state=$3,provider_receipt_json=$4::jsonb,lease_owner=NULL,lease_expires_at=NULL,
        last_error=$5,completed_at=CASE WHEN $3='pending' THEN NULL ELSE NOW() END,updated_at=NOW()
    WHERE tenant_id=$1 AND delivery_id=$2 AND delivery_state='unknown' RETURNING *`,
    [input.tenantId, input.deliveryId, state,
      JSON.stringify({ ...evidence, reconciledBy: input.actorId }), compactDeliveryError(input.reason)],
  );
  if (!result.rows[0]) throw new Error('DWS_DELIVERY_NOT_RECONCILABLE');
  return mapDelivery(result.rows[0] as Record<string, unknown>);
}

export async function finishClaimedDelivery(
  pool: pg.Pool,
  deliveriesTable: string,
  deliveryId: string,
  owner: string,
  fence: number,
  state: 'sent' | 'unknown',
  error?: string,
  receipt?: Record<string, unknown>,
): Promise<DwsDeliveryIntent> {
  const result = await pool.query(
    `UPDATE ${deliveriesTable}
    SET delivery_state=$4,provider_receipt_json=COALESCE($5::jsonb,provider_receipt_json),
        lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=NULL,
        last_error=$6,completed_at=NOW(),updated_at=NOW()
    WHERE delivery_id=$1 AND delivery_state='sending' AND lease_owner=$2 AND lease_fence=$3
      AND lease_expires_at>NOW() AND provider_attempt_phase='provider_started'
      AND provider_started_at IS NOT NULL RETURNING *`,
    [
      deliveryId,
      owner,
      fence,
      state,
      receipt ? JSON.stringify(sanitizeDeliveryReceipt(receipt)) : null,
      error ?? null,
    ],
  );
  if (!result.rows[0]) throw new Error('DWS_DELIVERY_LEASE_LOST');
  return mapDelivery(result.rows[0] as Record<string, unknown>);
}

export async function claimDeliveryIntent(
  pool: pg.Pool,
  tables: DeliveryClaimTables,
  deliveryId: string,
  owner: string,
  ttlMs: number,
): Promise<DwsDeliveryIntent | null> {
  const result = await pool.query(
    `UPDATE ${tables.deliveries}
    SET delivery_state='sending',attempt=attempt+1,lease_owner=$2,lease_fence=lease_fence+1,
        lease_expires_at=NOW()+($3::bigint*INTERVAL '1 millisecond'),provider_started_at=NULL,
        provider_attempt_phase='before_provider',
        next_attempt_at=NULL,last_attempt_at=NOW(),updated_at=NOW()
    WHERE delivery_id=$1 AND delivery_state='pending'
      AND (next_attempt_at IS NULL OR next_attempt_at<=NOW())
      AND (delivery_kind<>'task_completion' OR EXISTS (
        SELECT 1 FROM ${tables.workOrders} work
        JOIN ${tables.attempts} attempt
          ON attempt.tenant_id=work.tenant_id AND attempt.work_order_id=work.work_order_id
        WHERE work.tenant_id=${tables.deliveries}.tenant_id
          AND work.work_order_id=${tables.deliveries}.source_work_order_id
          AND attempt.attempt_id=${tables.deliveries}.source_attempt_id
          AND attempt.attempt_no=work.current_attempt_no AND attempt.status=work.state
          AND work.state IN ('completed','failed','cancelled')
      )) RETURNING *`,
    [deliveryId, owner, ttlMs],
  );
  return result.rows[0] ? mapDelivery(result.rows[0] as Record<string, unknown>) : null;
}

export async function cancelUnstartedDeliveryIntentsForInbox(
  pool: pg.Pool,
  deliveriesTable: string,
  tenantId: string,
  inboxId: string,
  reason: string,
): Promise<number> {
  // Unknown legacy claims are quarantined so no worker can send them after inbox recovery.
  const result = await pool.query(
    `UPDATE ${deliveriesTable}
    SET delivery_state=CASE WHEN provider_attempt_phase='before_provider'
          THEN 'dead_letter' ELSE 'unknown' END,
        lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=NULL,
        last_error=$3,completed_at=NOW(),updated_at=NOW()
    WHERE tenant_id=$1 AND inbox_id=$2 AND provider_started_at IS NULL
      AND delivery_state IN ('pending','sending')`,
    [tenantId, inboxId, compactDeliveryError(reason)],
  );
  return result.rowCount ?? 0;
}

export async function getReplyRecoveryStateForInbox(
  pool: pg.Pool,
  deliveriesTable: string,
  tenantId: string,
  inboxId: string,
): Promise<DwsReplyRecoveryState> {
  const result = await pool.query<{ recovery_state: DwsReplyRecoveryState }>(
    `SELECT CASE
      WHEN COUNT(*) FILTER (WHERE delivery_state='unknown'
        OR (delivery_state<>'sent' AND NOT (
          (provider_attempt_phase='before_provider' AND provider_started_at IS NULL)
          OR (delivery_state='dead_letter' AND provider_attempt_phase='provider_started'
            AND provider_started_at IS NOT NULL
            AND COALESCE(last_error,'') LIKE 'ORG_AGENT_PROVIDER_AUTHORIZATION_%')
        ))) > 0 THEN 'unknown'
      WHEN COUNT(*) FILTER (WHERE delivery_state='sent') > 0 THEN 'sent'
      WHEN COUNT(*) > 0 THEN 'unstarted'
      ELSE 'none'
    END AS recovery_state
    FROM ${deliveriesTable}
    WHERE tenant_id=$1 AND inbox_id=$2
      AND delivery_kind='front_reply' AND disposition='replied'`,
    [tenantId, inboxId],
  );
  return result.rows[0]?.recovery_state ?? 'none';
}

export async function claimNextDeliveryIntent(
  pool: pg.Pool,
  tables: DeliveryClaimTables,
  owner: string,
  ttlMs: number,
): Promise<DwsDeliveryIntent | null> {
  const result = await pool.query(
    `WITH candidate AS (
      SELECT delivery_id FROM ${tables.deliveries} pending_delivery
      WHERE delivery_state='pending'
        AND (next_attempt_at IS NULL OR next_attempt_at<=NOW())
        AND (pending_delivery.inbox_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM ${tables.inbox} inbound
          WHERE inbound.tenant_id=pending_delivery.tenant_id
            AND inbound.inbox_id=pending_delivery.inbox_id
            AND inbound.state IN ('reply_pending','dead_letter')
        ))
        AND (delivery_kind<>'task_completion' OR EXISTS (
          SELECT 1 FROM ${tables.workOrders} work
          JOIN ${tables.attempts} attempt
            ON attempt.tenant_id=work.tenant_id AND attempt.work_order_id=work.work_order_id
          WHERE work.tenant_id=pending_delivery.tenant_id
            AND work.work_order_id=pending_delivery.source_work_order_id
            AND attempt.attempt_id=pending_delivery.source_attempt_id
            AND attempt.attempt_no=work.current_attempt_no AND attempt.status=work.state
            AND work.state IN ('completed','failed','cancelled')
        ))
      ORDER BY created_at,delivery_id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE ${tables.deliveries} delivery
    SET delivery_state='sending',attempt=attempt+1,lease_owner=$1,lease_fence=lease_fence+1,
        lease_expires_at=NOW()+($2::bigint*INTERVAL '1 millisecond'),provider_started_at=NULL,
        provider_attempt_phase='before_provider',
        next_attempt_at=NULL,last_attempt_at=NOW(),updated_at=NOW()
    FROM candidate WHERE delivery.delivery_id=candidate.delivery_id RETURNING delivery.*`,
    [owner, ttlMs],
  );
  return result.rows[0] ? mapDelivery(result.rows[0] as Record<string, unknown>) : null;
}

export async function reconcileExpiredAndStaleDeliveries(
  pool: pg.Pool,
  tables: DeliveryClaimTables,
  limit: number,
): Promise<number> {
  const expired = await pool.query(
    `WITH expired AS (
      SELECT delivery_id FROM ${tables.deliveries}
      WHERE delivery_state='sending' AND lease_expires_at<=NOW()
      ORDER BY lease_expires_at,delivery_id FOR UPDATE SKIP LOCKED LIMIT $1
    ) UPDATE ${tables.deliveries} delivery
    SET delivery_state=CASE
          WHEN delivery.provider_attempt_phase<>'before_provider' THEN 'unknown'
          WHEN delivery.attempt >= ${DELIVERY_MAX_ATTEMPTS} THEN 'dead_letter'
          ELSE 'pending'
        END,
        lease_owner=NULL,lease_expires_at=NULL,
        next_attempt_at=CASE
          WHEN delivery.provider_attempt_phase='before_provider'
            AND delivery.attempt < ${DELIVERY_MAX_ATTEMPTS}
          THEN NOW() + (LEAST(${DELIVERY_RETRY_MAX_MS},
            ${DELIVERY_RETRY_BASE_MS} * POWER(2,LEAST(8,GREATEST(0,delivery.attempt-1))))::bigint
            * INTERVAL '1 millisecond')
          ELSE NULL
        END,
        last_error=CASE
          WHEN delivery.provider_attempt_phase<>'before_provider'
            THEN 'DWS_DELIVERY_RECEIPT_UNKNOWN_AFTER_LEASE_EXPIRY'
          WHEN delivery.attempt >= ${DELIVERY_MAX_ATTEMPTS}
            THEN 'DWS_DELIVERY_MAX_ATTEMPTS_AFTER_LEASE_EXPIRY'
          ELSE 'DWS_DELIVERY_RETRY_AFTER_LEASE_EXPIRY_BEFORE_PROVIDER'
        END,
        completed_at=CASE
          WHEN delivery.provider_attempt_phase<>'before_provider'
            OR delivery.attempt >= ${DELIVERY_MAX_ATTEMPTS}
          THEN NOW() ELSE NULL END,
        updated_at=NOW()
    FROM expired WHERE delivery.delivery_id=expired.delivery_id`,
    [limit],
  );
  const stale = await pool.query(
    `UPDATE ${tables.deliveries} delivery
    SET delivery_state='dead_letter',last_error='ORG_AGENT_DELIVERY_STALE_ATTEMPT',
        completed_at=NOW(),updated_at=NOW()
    WHERE delivery.delivery_state='pending' AND delivery.delivery_kind='task_completion'
      AND NOT EXISTS (
        SELECT 1 FROM ${tables.workOrders} work
        JOIN ${tables.attempts} attempt
          ON attempt.tenant_id=work.tenant_id AND attempt.work_order_id=work.work_order_id
        WHERE work.tenant_id=delivery.tenant_id
          AND work.work_order_id=delivery.source_work_order_id
          AND attempt.attempt_id=delivery.source_attempt_id
          AND attempt.attempt_no=work.current_attempt_no AND attempt.status=work.state
          AND work.state IN ('completed','failed','cancelled')
      )`,
  );
  return (expired.rowCount ?? 0) + (stale.rowCount ?? 0);
}
