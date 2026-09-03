import type pg from 'pg';

import type { DwsDeliveryIntent } from './types.js';
import { mapDelivery } from './storeMappers.js';

export interface DeliveryClaimTables {
  deliveries: string;
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
        lease_owner=NULL,lease_expires_at=NULL,last_error=$6,completed_at=NOW(),updated_at=NOW()
    WHERE delivery_id=$1 AND delivery_state='sending' AND lease_owner=$2 AND lease_fence=$3
      AND lease_expires_at>NOW() RETURNING *`,
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
        lease_expires_at=NOW()+($3::bigint*INTERVAL '1 millisecond'),last_attempt_at=NOW(),updated_at=NOW()
    WHERE delivery_id=$1 AND delivery_state='pending'
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
        lease_expires_at=NOW()+($2::bigint*INTERVAL '1 millisecond'),last_attempt_at=NOW(),updated_at=NOW()
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
    SET delivery_state='unknown',lease_owner=NULL,lease_expires_at=NULL,
        last_error='DWS_DELIVERY_RECEIPT_UNKNOWN_AFTER_LEASE_EXPIRY',completed_at=NOW(),updated_at=NOW()
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
