import { randomUUID } from 'node:crypto';

import { governanceTablePrefix, type GovernancePgPool } from '../governance-schema/index.js';
import {
  GovernanceProjectionInvariantError,
  type GovernanceProjectionClaimInput,
  type GovernanceProjectionEnqueueInput,
  type GovernanceProjectionFailInput,
  type GovernanceProjectionLeaseInput,
  type GovernanceProjectionOutboxItem,
  type GovernanceProjectionOutboxStore,
  type GovernanceProjectionPayload,
} from './types.js';

const SAFE_NAME_PATTERN = /^[a-zA-Z0-9_.:-]{1,200}$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,119}$/;
const SENSITIVE_WORD_PATTERN = /(?:secret|token|password)/i;
const JWT_PATTERN = /(?:^|\s)eyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}(?:\s|$)/;
const AUTH_VALUE_PATTERN = /^(?:bearer|basic)\s+\S+/i;
const MAX_PAYLOAD_BYTES = 256 * 1024;

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function optionalIso(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : iso(value);
}

function parsePayload(value: unknown): GovernanceProjectionPayload {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new GovernanceProjectionInvariantError('GOVERNANCE_PROJECTION_INVALID');
  }
  return parsed as GovernanceProjectionPayload;
}

function rowToItem(row: Record<string, unknown>): GovernanceProjectionOutboxItem {
  return {
    outboxId: String(row.outbox_id),
    tenantId: String(row.tenant_id),
    projector: String(row.projector),
    idempotencyKey: String(row.idempotency_key),
    payload: parsePayload(row.payload_json),
    status: row.status as GovernanceProjectionOutboxItem['status'],
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    leaseFence: Number(row.lease_fence),
    ...(row.lease_owner ? { leaseOwner: String(row.lease_owner) } : {}),
    ...(optionalIso(row.lease_expires_at) ? { leaseExpiresAt: optionalIso(row.lease_expires_at) } : {}),
    ...(optionalIso(row.next_attempt_at) ? { nextAttemptAt: optionalIso(row.next_attempt_at) } : {}),
    ...(row.last_error_code ? { lastErrorCode: String(row.last_error_code) } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(optionalIso(row.completed_at) ? { completedAt: optionalIso(row.completed_at) } : {}),
  };
}

function assertJsonSafe(value: unknown, seen: Set<object>): void {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new GovernanceProjectionInvariantError('GOVERNANCE_PROJECTION_INVALID');
    return;
  }
  if (typeof value === 'string') {
    if (SENSITIVE_WORD_PATTERN.test(value) || JWT_PATTERN.test(value) || AUTH_VALUE_PATTERN.test(value)) {
      throw new GovernanceProjectionInvariantError('GOVERNANCE_PROJECTION_PAYLOAD_SENSITIVE');
    }
    if (/\u0000/.test(value)) throw new GovernanceProjectionInvariantError('GOVERNANCE_PROJECTION_INVALID');
    return;
  }
  if (typeof value !== 'object') {
    throw new GovernanceProjectionInvariantError('GOVERNANCE_PROJECTION_INVALID');
  }
  if (seen.has(value)) throw new GovernanceProjectionInvariantError('GOVERNANCE_PROJECTION_INVALID');
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach(child => assertJsonSafe(child, seen));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new GovernanceProjectionInvariantError('GOVERNANCE_PROJECTION_INVALID');
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_WORD_PATTERN.test(key)) {
        throw new GovernanceProjectionInvariantError('GOVERNANCE_PROJECTION_PAYLOAD_SENSITIVE');
      }
      assertJsonSafe(child, seen);
    }
  }
  seen.delete(value);
}

export function assertGovernanceProjectionPayloadSafe(
  payload: GovernanceProjectionPayload,
): GovernanceProjectionPayload {
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
    throw new GovernanceProjectionInvariantError('GOVERNANCE_PROJECTION_INVALID');
  }
  assertJsonSafe(payload, new Set());
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new GovernanceProjectionInvariantError('GOVERNANCE_PROJECTION_INVALID');
  }
  return JSON.parse(serialized) as GovernanceProjectionPayload;
}

function assertDate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new GovernanceProjectionInvariantError('GOVERNANCE_PROJECTION_INVALID');
  }
  return parsed.toISOString();
}

function assertLeaseInput(input: GovernanceProjectionLeaseInput): void {
  if (!input.outboxId.trim() || !input.leaseOwner.trim()
    || !Number.isSafeInteger(input.leaseFence) || input.leaseFence < 1) {
    throw new GovernanceProjectionInvariantError('GOVERNANCE_PROJECTION_INVALID');
  }
}

export class PgGovernanceProjectionOutboxStore implements GovernanceProjectionOutboxStore {
  readonly outboxTable: string;

  constructor(private readonly options: { pool: GovernancePgPool; tablePrefix?: string }) {
    const prefix = governanceTablePrefix(options.tablePrefix);
    this.outboxTable = `${prefix}_governance_projection_outbox`;
  }

  async enqueue(input: GovernanceProjectionEnqueueInput): Promise<GovernanceProjectionOutboxItem> {
    if (!input.tenantId.trim() || !SAFE_NAME_PATTERN.test(input.projector)
      || !input.idempotencyKey.trim() || input.idempotencyKey.length > 500
      || (input.maxAttempts !== undefined
        && (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 100))) {
      throw new GovernanceProjectionInvariantError('GOVERNANCE_PROJECTION_INVALID');
    }
    const payload = assertGovernanceProjectionPayloadSafe(input.payload);
    const availableAt = assertDate(input.availableAt);
    const result = await this.options.pool.query(`
      INSERT INTO ${this.outboxTable} (
        outbox_id,tenant_id,projector,idempotency_key,payload_json,status,
        attempt,max_attempts,lease_fence,next_attempt_at,created_at,updated_at
      ) VALUES ($1,$2,$3,$4,$5::jsonb,'pending',0,$6,0,COALESCE($7::timestamptz,NOW()),NOW(),NOW())
      ON CONFLICT (tenant_id,projector,idempotency_key) DO UPDATE
      SET idempotency_key=EXCLUDED.idempotency_key
      RETURNING *
    `, [
      `gpo-${randomUUID()}`, input.tenantId, input.projector, input.idempotencyKey,
      JSON.stringify(payload), input.maxAttempts ?? 8, availableAt ?? null,
    ]);
    if (!result.rows[0]) throw new GovernanceProjectionInvariantError('GOVERNANCE_PROJECTION_INVALID');
    return rowToItem(result.rows[0] as Record<string, unknown>);
  }

  async get(outboxId: string): Promise<GovernanceProjectionOutboxItem | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.outboxTable} WHERE outbox_id=$1`, [outboxId],
    );
    return result.rows[0] ? rowToItem(result.rows[0] as Record<string, unknown>) : null;
  }

  async claim(input: GovernanceProjectionClaimInput): Promise<GovernanceProjectionOutboxItem[]> {
    const limit = input.limit ?? 1;
    if (!input.leaseOwner.trim() || !Number.isInteger(input.leaseMs) || input.leaseMs < 1
      || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new GovernanceProjectionInvariantError('GOVERNANCE_PROJECTION_INVALID');
    }
    const result = await this.options.pool.query(`
      WITH candidates AS (
        SELECT outbox_id
        FROM ${this.outboxTable}
        WHERE (
          (status IN ('pending','retry_wait') AND next_attempt_at <= NOW())
          OR (status='running' AND lease_expires_at <= NOW())
        )
        ORDER BY next_attempt_at ASC, created_at ASC, outbox_id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $3
      )
      UPDATE ${this.outboxTable} o
      SET status='running',attempt=o.attempt+1,lease_owner=$1,
          lease_fence=o.lease_fence+1,
          lease_expires_at=NOW()+($2 * INTERVAL '1 millisecond'),
          next_attempt_at=NULL,updated_at=NOW()
      FROM candidates c
      WHERE o.outbox_id=c.outbox_id
      RETURNING o.*
    `, [input.leaseOwner, input.leaseMs, limit]);
    return result.rows.map(row => rowToItem(row as Record<string, unknown>));
  }

  async renewLease(input: GovernanceProjectionLeaseInput & { leaseMs: number }): Promise<boolean> {
    assertLeaseInput(input);
    if (!Number.isInteger(input.leaseMs) || input.leaseMs < 1) {
      throw new GovernanceProjectionInvariantError('GOVERNANCE_PROJECTION_INVALID');
    }
    const result = await this.options.pool.query(`
      UPDATE ${this.outboxTable}
      SET lease_expires_at=NOW()+($4 * INTERVAL '1 millisecond'),updated_at=NOW()
      WHERE outbox_id=$1 AND status='running' AND lease_owner=$2 AND lease_fence=$3
        AND lease_expires_at > NOW()
      RETURNING outbox_id
    `, [input.outboxId, input.leaseOwner, input.leaseFence, input.leaseMs]);
    return Boolean(result.rows[0]);
  }

  async complete(input: GovernanceProjectionLeaseInput): Promise<GovernanceProjectionOutboxItem> {
    assertLeaseInput(input);
    const result = await this.options.pool.query(`
      UPDATE ${this.outboxTable}
      SET status='succeeded',lease_owner=NULL,lease_expires_at=NULL,
          next_attempt_at=NULL,last_error_code=NULL,completed_at=NOW(),updated_at=NOW()
      WHERE outbox_id=$1 AND status='running' AND lease_owner=$2 AND lease_fence=$3
        AND lease_expires_at > NOW()
      RETURNING *
    `, [input.outboxId, input.leaseOwner, input.leaseFence]);
    if (!result.rows[0]) throw new GovernanceProjectionInvariantError('GOVERNANCE_PROJECTION_LEASE_LOST');
    return rowToItem(result.rows[0] as Record<string, unknown>);
  }

  async fail(input: GovernanceProjectionFailInput): Promise<GovernanceProjectionOutboxItem> {
    assertLeaseInput(input);
    if (!ERROR_CODE_PATTERN.test(input.errorCode)) {
      throw new GovernanceProjectionInvariantError('GOVERNANCE_PROJECTION_INVALID');
    }
    const retryAt = assertDate(input.retryAt);
    const result = await this.options.pool.query(`
      UPDATE ${this.outboxTable}
      SET status=CASE WHEN $5::timestamptz IS NULL THEN 'failed' ELSE 'retry_wait' END,
          lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=$5::timestamptz,
          last_error_code=$4,completed_at=CASE WHEN $5::timestamptz IS NULL THEN NOW() ELSE NULL END,
          updated_at=NOW()
      WHERE outbox_id=$1 AND status='running' AND lease_owner=$2 AND lease_fence=$3
        AND lease_expires_at > NOW()
      RETURNING *
    `, [input.outboxId, input.leaseOwner, input.leaseFence, input.errorCode, retryAt ?? null]);
    if (!result.rows[0]) throw new GovernanceProjectionInvariantError('GOVERNANCE_PROJECTION_LEASE_LOST');
    return rowToItem(result.rows[0] as Record<string, unknown>);
  }
}
