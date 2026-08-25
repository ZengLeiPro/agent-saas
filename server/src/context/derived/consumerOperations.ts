import type { PoolClient } from 'pg';

import type { ContextPhase4TableNames } from '../phase4/migration.js';
import type { ContextPgPool } from '../store/migration.js';
import { DerivedStoreError, type ConsumerLease } from './types.js';

export interface ResetDerivedConsumerInput {
  tenantId: string;
  consumerId: string;
  expectedCursorSeq: string;
}

export interface DerivedConsumerFailureState {
  state: 'retry' | 'dead_letter';
  attempts: number;
  errorCode: string;
  failedAt: string;
}

const DERIVED_DEAD_LETTER_ATTEMPTS = 5;

export async function failDerivedConsumerLease(
  pool: ContextPgPool,
  tables: ContextPhase4TableNames,
  lease: ConsumerLease,
  errorCode: string,
  now: Date,
): Promise<boolean> {
  if (!/^[A-Z0-9_]{1,100}$/.test(errorCode)) throw new DerivedStoreError('DERIVED_INVALID');
  const failedAt = now.toISOString();
  const result = await pool.query(`UPDATE ${tables.consumers}
    SET status=CASE
          WHEN COALESCE(NULLIF(substring(last_error_message FROM '"attempts"\\s*:\\s*([0-9]+)'), '')::integer,0)+1 >= $7
            THEN 'disabled' ELSE 'retry_wait' END,
        lease_owner=NULL,lease_expires_at=NULL,last_error_code=$5,
        last_error_message=jsonb_build_object(
          'state',CASE
            WHEN COALESCE(NULLIF(substring(last_error_message FROM '"attempts"\\s*:\\s*([0-9]+)'), '')::integer,0)+1 >= $7
              THEN 'dead_letter' ELSE 'retry' END,
          'attempts',COALESCE(NULLIF(substring(last_error_message FROM '"attempts"\\s*:\\s*([0-9]+)'), '')::integer,0)+1,
          'errorCode',$5::text,'failedAt',$6::text
        )::text,
        last_heartbeat_at=$6,updated_at=$6
    WHERE tenant_id=$1 AND consumer_id=$2 AND lease_owner=$3 AND lease_fence=$4`,
  [lease.tenantId, lease.consumerId, lease.leaseOwner, lease.leaseFence,
    errorCode, failedAt, DERIVED_DEAD_LETTER_ATTEMPTS]);
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
  const result = await client.query(`SELECT cursor_seq,status,lease_owner,lease_expires_at,last_error_message
    FROM ${tables.consumers}
    WHERE tenant_id=$1 AND consumer_id=$2 FOR UPDATE`, [input.tenantId, input.consumerId]);
  const row = result.rows[0];
  if (!row) throw new DerivedStoreError('DERIVED_NOT_FOUND');
  const previousCursorSeq = String(row.cursor_seq);
  // Cursor CAS plus the active-lease check below make dead-letter replay explicit
  // and fenced. An administratively disabled consumer remains fail-closed.
  const failure = parseFailureState(row.last_error_message);
  if (previousCursorSeq !== input.expectedCursorSeq
    || (row.status === 'disabled' && failure?.state !== 'dead_letter')) {
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

function parseFailureState(value: unknown): DerivedConsumerFailureState | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<DerivedConsumerFailureState>;
    if ((parsed.state !== 'retry' && parsed.state !== 'dead_letter')
      || !Number.isSafeInteger(parsed.attempts) || Number(parsed.attempts) < 1
      || typeof parsed.errorCode !== 'string' || typeof parsed.failedAt !== 'string') return undefined;
    return parsed as DerivedConsumerFailureState;
  } catch {
    return undefined;
  }
}
