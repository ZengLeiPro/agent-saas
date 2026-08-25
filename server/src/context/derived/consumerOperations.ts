import type { PoolClient } from 'pg';

import type { ContextPhase4TableNames } from '../phase4/migration.js';
import type { ContextPgPool } from '../store/migration.js';
import { DerivedStoreError, type ConsumerLease } from './types.js';

export interface ResetDerivedConsumerInput {
  tenantId: string;
  consumerId: string;
  expectedCursorSeq: string;
}

export async function failDerivedConsumerLease(
  pool: ContextPgPool,
  tables: ContextPhase4TableNames,
  lease: ConsumerLease,
  errorCode: string,
  now: Date,
): Promise<boolean> {
  if (!/^[A-Z0-9_]{1,100}$/.test(errorCode)) throw new DerivedStoreError('DERIVED_INVALID');
  const result = await pool.query(`UPDATE ${tables.consumers}
    SET status='retry_wait',lease_owner=NULL,lease_expires_at=NULL,
        last_error_code=$5,last_error_message=NULL,last_heartbeat_at=$6,updated_at=$6
    WHERE tenant_id=$1 AND consumer_id=$2 AND lease_owner=$3 AND lease_fence=$4`,
  [lease.tenantId, lease.consumerId, lease.leaseOwner, lease.leaseFence,
    errorCode, now.toISOString()]);
  return result.rowCount === 1;
}

export async function resetDerivedConsumerForReplay(
  client: PoolClient,
  tables: ContextPhase4TableNames,
  input: ResetDerivedConsumerInput,
  now: Date,
): Promise<{ previousCursorSeq: string }> {
  if (!input.tenantId || !input.consumerId || !/^\d+$/.test(input.expectedCursorSeq)) {
    throw new DerivedStoreError('DERIVED_INVALID');
  }
  const result = await client.query(`SELECT cursor_seq,status,lease_owner,lease_expires_at
    FROM ${tables.consumers}
    WHERE tenant_id=$1 AND consumer_id=$2 FOR UPDATE`, [input.tenantId, input.consumerId]);
  const row = result.rows[0];
  if (!row) throw new DerivedStoreError('DERIVED_NOT_FOUND');
  const previousCursorSeq = String(row.cursor_seq);
  if (previousCursorSeq !== input.expectedCursorSeq || row.status === 'disabled') {
    throw new DerivedStoreError('DERIVED_VERSION_CONFLICT');
  }
  const leaseActive = row.lease_owner && row.lease_expires_at
    && new Date(row.lease_expires_at).getTime() > now.getTime();
  if (leaseActive) throw new DerivedStoreError('DERIVED_VERSION_CONFLICT');
  await client.query(`UPDATE ${tables.consumers}
    SET cursor_seq=0,status='idle',lease_owner=NULL,lease_fence=lease_fence+1,
        lease_expires_at=NULL,last_error_code=NULL,last_error_message=NULL,updated_at=$3
    WHERE tenant_id=$1 AND consumer_id=$2`,
  [input.tenantId, input.consumerId, now.toISOString()]);
  return { previousCursorSeq };
}
