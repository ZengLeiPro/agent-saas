import { createHash, randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { tableNames as phase4TableNames } from '../phase4/migration.js';
import { contextTableNames, contextTablePrefix, type ContextPgPool } from '../store/migration.js';
import { contextRetentionTableNames } from './migration.js';

const DEFAULT_AUDIT_LEASE_MS = 5 * 60_000;
const DEFAULT_AUDIT_MAX_ATTEMPTS = 5;
const DEFAULT_AUDIT_RETRY_BASE_MS = 1_000;
const DEFAULT_AUDIT_RETRY_MAX_MS = 5 * 60_000;

export interface ContextRetentionRequest {
  tenantId: string;
  /** Inclusive source outbox sequence that the operator has approved for collection. */
  sourceOutboxWatermark: string;
  /** Inclusive derived outbox sequence that the operator has approved for collection. */
  derivedOutboxWatermark: string;
  /** Rows must be older than this instant in addition to being below the watermarks. */
  retainAfter: string;
  /** Defaults to true. Apply must always be explicit. */
  dryRun?: boolean;
}

export interface ContextRetentionCounts {
  sourceOutbox: number;
  derivedOutbox: number;
  evidence: number;
  revisions: number;
}

export interface ContextRetentionReceipt extends ContextRetentionRequest {
  receiptId: string;
  dryRun: boolean;
  safeSourceOutboxWatermark: string;
  startedAt: string;
  completedAt: string;
  counts: ContextRetentionCounts;
  receiptSha256: string;
}

export interface ContextRetentionStoreOptions {
  pool: ContextPgPool;
  tablePrefix?: string;
  now?: () => Date;
  auditLeaseMs?: number;
  auditMaxAttempts?: number;
  auditRetryBaseMs?: number;
  auditRetryMaxMs?: number;
}

export type ContextRetentionAuditStatus = 'pending' | 'delivering' | 'retry_wait' | 'delivered' | 'dead_letter';

export interface ContextRetentionAuditState {
  status: ContextRetentionAuditStatus;
  revision: number;
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  leaseExpiresAt: string | null;
  lastError: string | null;
  deliveredAt: string | null;
}

export interface ContextRetentionAuditClaim {
  tenantId: string;
  receiptId: string;
  receipt: ContextRetentionReceipt;
  leaseId: string;
}

/**
 * Tenant-scoped Context history collection. The two explicit watermarks and age
 * cutoff are conjunctive. Current revisions and any revision still referenced
 * by an outbox/derived projection are never candidates.
 */
export class ContextRetentionStore {
  private readonly base;
  private readonly derived;
  private readonly lifecycle;
  private readonly now: () => Date;
  private readonly auditLeaseMs: number;
  private readonly auditMaxAttempts: number;
  private readonly auditRetryBaseMs: number;
  private readonly auditRetryMaxMs: number;

  constructor(private readonly options: ContextRetentionStoreOptions) {
    const prefix = contextTablePrefix(options.tablePrefix);
    this.base = contextTableNames(prefix);
    this.derived = phase4TableNames(prefix);
    this.lifecycle = contextRetentionTableNames(prefix);
    this.now = options.now ?? (() => new Date());
    this.auditLeaseMs = positiveInt(options.auditLeaseMs, DEFAULT_AUDIT_LEASE_MS);
    this.auditMaxAttempts = positiveInt(options.auditMaxAttempts, DEFAULT_AUDIT_MAX_ATTEMPTS);
    this.auditRetryBaseMs = positiveInt(options.auditRetryBaseMs, DEFAULT_AUDIT_RETRY_BASE_MS);
    this.auditRetryMaxMs = Math.max(this.auditRetryBaseMs, positiveInt(options.auditRetryMaxMs, DEFAULT_AUDIT_RETRY_MAX_MS));
  }

  async collect(request: ContextRetentionRequest): Promise<ContextRetentionReceipt> {
    validateRequest(request);
    const dryRun = request.dryRun !== false;
    const startedAt = this.now().toISOString();
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      // Serialize plans for one tenant without blocking unrelated tenants.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`context-retention:${request.tenantId}`]);
      const safeWatermark = await this.safeSourceWatermark(client, request.tenantId);
      if (BigInt(request.sourceOutboxWatermark) > BigInt(safeWatermark)) {
        throw new Error(`CONTEXT_RETENTION_UNSAFE_WATERMARK requested=${request.sourceOutboxWatermark} safe=${safeWatermark}`);
      }
      const counts = dryRun
        ? await this.countCandidates(client, request)
        : await this.deleteCandidates(client, request);
      const completedAt = this.now().toISOString();
      const unsignedReceipt = {
        ...request, dryRun, receiptId: randomUUID(), safeSourceOutboxWatermark: safeWatermark,
        startedAt, completedAt, counts,
      };
      const receipt = { ...unsignedReceipt, receiptSha256: receiptHash(unsignedReceipt) };
      // The receipt/outbox insert is in the same transaction as the deletion.
      await client.query(`INSERT INTO ${this.lifecycle.receipts}
        (tenant_id,receipt_id,receipt_json,max_audit_attempts,audit_next_attempt_at)
        VALUES ($1,$2,$3::jsonb,$4,NOW())`,
      [request.tenantId, receipt.receiptId, JSON.stringify(receipt), this.auditMaxAttempts]);
      await client.query('COMMIT');
      return receipt;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async safeSourceWatermark(client: PoolClient, tenantId: string): Promise<string> {
    const result = await client.query(`SELECT COALESCE(MIN(cursor_seq),0) AS watermark
      FROM ${this.derived.consumers} WHERE tenant_id=$1`, [tenantId]);
    return String(result.rows[0]?.watermark ?? '0');
  }

  /** Reads mutable audit delivery state without exposing or changing the immutable receipt proof. */
  async getAuditState(tenantId: string, receiptId: string): Promise<ContextRetentionAuditState> {
    const result = await this.options.pool.query(`SELECT audit_status,audit_revision,audit_attempt,max_audit_attempts,
      audit_next_attempt_at,audit_lease_expires_at,last_audit_error,delivered_at
      FROM ${this.lifecycle.receipts} WHERE tenant_id=$1 AND receipt_id=$2::uuid`, [tenantId, receiptId]);
    if (!result.rowCount) throw new Error('CONTEXT_RETENTION_RECEIPT_NOT_FOUND');
    const row = result.rows[0];
    return {
      status: row.audit_status as ContextRetentionAuditStatus,
      revision: Number(row.audit_revision),
      attempt: Number(row.audit_attempt),
      maxAttempts: Number(row.max_audit_attempts),
      nextAttemptAt: nullableIso(row.audit_next_attempt_at),
      leaseExpiresAt: nullableIso(row.audit_lease_expires_at),
      lastError: row.last_audit_error === null ? null : String(row.last_audit_error),
      deliveredAt: nullableIso(row.delivered_at),
    };
  }

  /** Claims one tenant-owned receipt for an explicit, tenant-scoped admin replay. */
  async claimAudit(tenantId: string, receiptId: string): Promise<{ receipt: ContextRetentionReceipt; delivered: boolean; leaseId?: string }> {
    const leaseId = randomUUID();
    const result = await this.options.pool.query(`UPDATE ${this.lifecycle.receipts}
      SET audit_status='delivering',audit_attempt=audit_attempt+1,audit_revision=audit_revision+1,audit_lease_owner=$3::uuid,
        audit_lease_expires_at=NOW()+($4::bigint * INTERVAL '1 millisecond'),last_audit_error=NULL,updated_at=NOW()
      WHERE tenant_id=$1 AND receipt_id=$2::uuid AND audit_attempt<max_audit_attempts AND (
        audit_status IN ('pending','retry_wait') OR
        (audit_status='delivering' AND audit_lease_expires_at<NOW()))
      RETURNING receipt_json`, [tenantId, receiptId, leaseId, this.auditLeaseMs]);
    if (result.rowCount) return { receipt: result.rows[0].receipt_json as ContextRetentionReceipt, delivered: false, leaseId };
    const existing = await this.options.pool.query(`SELECT receipt_json,audit_status
      FROM ${this.lifecycle.receipts} WHERE tenant_id=$1 AND receipt_id=$2::uuid`, [tenantId, receiptId]);
    if (!existing.rowCount) throw new Error('CONTEXT_RETENTION_RECEIPT_NOT_FOUND');
    if (existing.rows[0].audit_status === 'delivered') {
      return { receipt: existing.rows[0].receipt_json as ContextRetentionReceipt, delivered: true };
    }
    if (existing.rows[0].audit_status === 'dead_letter') throw new Error('CONTEXT_RETENTION_AUDIT_DEAD_LETTER');
    throw new Error('CONTEXT_RETENTION_AUDIT_IN_PROGRESS');
  }

  /** Resets and claims one dead-letter receipt under tenant, status, and revision CAS. */
  async replayDeadLetterAudit(tenantId: string, receiptId: string, expectedRevision: number): Promise<ContextRetentionAuditClaim> {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error('CONTEXT_RETENTION_AUDIT_REPLAY_INVALID');
    const leaseId = randomUUID();
    const result = await this.options.pool.query(`UPDATE ${this.lifecycle.receipts}
      SET audit_status='delivering',audit_attempt=1,audit_revision=audit_revision+1,
        audit_lease_owner=$4::uuid,audit_lease_expires_at=NOW()+($5::bigint * INTERVAL '1 millisecond'),
        audit_next_attempt_at=NULL,last_audit_error=NULL,delivered_at=NULL,updated_at=NOW()
      WHERE tenant_id=$1 AND receipt_id=$2::uuid AND audit_status='dead_letter' AND audit_revision=$3
      RETURNING receipt_json`, [tenantId, receiptId, expectedRevision, leaseId, this.auditLeaseMs]);
    if (result.rowCount) {
      return { tenantId, receiptId, receipt: result.rows[0].receipt_json as ContextRetentionReceipt, leaseId };
    }
    const existing = await this.options.pool.query(`SELECT audit_status,audit_revision FROM ${this.lifecycle.receipts}
      WHERE tenant_id=$1 AND receipt_id=$2::uuid`, [tenantId, receiptId]);
    if (!existing.rowCount) throw new Error('CONTEXT_RETENTION_RECEIPT_NOT_FOUND');
    throw new Error('CONTEXT_RETENTION_AUDIT_REPLAY_CONFLICT');
  }

  /** Atomically leases ready receipts across tenants. SKIP LOCKED prevents one tenant from blocking another. */
  async claimNextAudits(leaseOwner: string, limit: number): Promise<ContextRetentionAuditClaim[]> {
    if (!leaseOwner || !Number.isInteger(limit) || limit < 1) throw new Error('CONTEXT_RETENTION_AUDIT_CLAIM_INVALID');
    const leaseId = randomUUID();
    const result = await this.options.pool.query(`WITH candidates AS (
      SELECT tenant_id,receipt_id FROM ${this.lifecycle.receipts}
      WHERE audit_attempt<max_audit_attempts AND (
        (audit_status IN ('pending','retry_wait') AND audit_next_attempt_at<=NOW()) OR
        (audit_status='delivering' AND audit_lease_expires_at<NOW())
      )
      ORDER BY audit_next_attempt_at NULLS FIRST,created_at,tenant_id,receipt_id
      FOR UPDATE SKIP LOCKED LIMIT $1
    )
    UPDATE ${this.lifecycle.receipts} receipt
    SET audit_status='delivering',audit_attempt=receipt.audit_attempt+1,audit_revision=receipt.audit_revision+1,
      audit_lease_owner=$2::uuid,audit_lease_expires_at=NOW()+($3::bigint * INTERVAL '1 millisecond'),
      last_audit_error=NULL,updated_at=NOW()
    FROM candidates
    WHERE receipt.tenant_id=candidates.tenant_id AND receipt.receipt_id=candidates.receipt_id
    RETURNING receipt.tenant_id,receipt.receipt_id,receipt.receipt_json`, [limit, leaseId, this.auditLeaseMs]);
    return result.rows.map(row => ({
      tenantId: String(row.tenant_id), receiptId: String(row.receipt_id),
      receipt: row.receipt_json as ContextRetentionReceipt, leaseId,
    }));
  }

  /** Converts abandoned/exhausted deliveries into observable terminal failures. */
  async deadLetterExhaustedAudits(): Promise<number> {
    const result = await this.options.pool.query(`UPDATE ${this.lifecycle.receipts}
      SET audit_status='dead_letter',audit_revision=audit_revision+1,audit_lease_owner=NULL,audit_lease_expires_at=NULL,
        audit_next_attempt_at=NULL,last_audit_error=COALESCE(last_audit_error,'CONTEXT_RETENTION_AUDIT_MAX_ATTEMPTS'),updated_at=NOW()
      WHERE audit_attempt>=max_audit_attempts AND (
        audit_status IN ('pending','retry_wait') OR (audit_status='delivering' AND audit_lease_expires_at<NOW())
      )`);
    return result.rowCount ?? 0;
  }

  async completeAudit(tenantId: string, receiptId: string, leaseId?: string): Promise<void> {
    const result = await this.options.pool.query(`UPDATE ${this.lifecycle.receipts}
      SET audit_status='delivered',audit_revision=audit_revision+1,audit_lease_owner=NULL,
        audit_lease_expires_at=NULL,audit_next_attempt_at=NULL,last_audit_error=NULL,delivered_at=NOW(),updated_at=NOW()
      WHERE tenant_id=$1 AND receipt_id=$2::uuid AND audit_status='delivering'
        AND ($3::uuid IS NULL OR audit_lease_owner=$3::uuid)`, [tenantId, receiptId, leaseId ?? null]);
    if (!result.rowCount) throw new Error('CONTEXT_RETENTION_AUDIT_CLAIM_LOST');
  }

  async failAudit(tenantId: string, receiptId: string, error: string, leaseId?: string): Promise<void> {
    const result = await this.options.pool.query(`UPDATE ${this.lifecycle.receipts}
      SET audit_status=CASE WHEN audit_attempt>=max_audit_attempts THEN 'dead_letter' ELSE 'retry_wait' END,
        audit_revision=audit_revision+1,audit_lease_owner=NULL,audit_lease_expires_at=NULL,
        audit_next_attempt_at=CASE WHEN audit_attempt>=max_audit_attempts THEN NULL
          ELSE NOW()+(LEAST($5::bigint,$4::bigint * (2 ^ GREATEST(audit_attempt-1,0))) * INTERVAL '1 millisecond') END,
        last_audit_error=$3,updated_at=NOW()
      WHERE tenant_id=$1 AND receipt_id=$2::uuid AND audit_status='delivering'
        AND ($6::uuid IS NULL OR audit_lease_owner=$6::uuid)`,
    [tenantId, receiptId, safeError(error), this.auditRetryBaseMs, this.auditRetryMaxMs, leaseId ?? null]);
    if (!result.rowCount) throw new Error('CONTEXT_RETENTION_AUDIT_CLAIM_LOST');
  }

  private async countCandidates(client: PoolClient, request: ContextRetentionRequest): Promise<ContextRetentionCounts> {
    const params = retentionParams(request);
    const source = await client.query(`SELECT COUNT(*)::integer count FROM ${this.base.outbox}
      WHERE tenant_id=$1 AND seq<=$3::bigint AND created_at<$2::timestamptz`, params.slice(0, 3));
    const derived = await client.query(`SELECT COUNT(*)::integer count FROM ${this.derived.derivedOutbox}
      WHERE tenant_id=$1 AND seq<=$3::bigint AND created_at<$2::timestamptz AND status IN ('delivered','revoked')`, [params[0], params[1], params[3]]);
    const evidence = await client.query(`SELECT COUNT(*)::integer count FROM ${this.base.evidence} e
      WHERE ${this.collectibleRevisionPredicate('e')}`, params.slice(0, 3));
    const revisions = await client.query(`SELECT COUNT(*)::integer count FROM ${this.base.revisions} r
      WHERE ${this.collectibleRevisionPredicate('r')}`, params.slice(0, 3));
    return {
      sourceOutbox: count(source.rows[0]), derivedOutbox: count(derived.rows[0]),
      evidence: count(evidence.rows[0]), revisions: count(revisions.rows[0]),
    };
  }

  private async deleteCandidates(client: PoolClient, request: ContextRetentionRequest): Promise<ContextRetentionCounts> {
    const params = retentionParams(request);
    const sourceOutbox = await client.query(`DELETE FROM ${this.base.outbox}
      WHERE tenant_id=$1 AND seq<=$3::bigint AND created_at<$2::timestamptz`, params.slice(0, 3));
    const derivedOutbox = await client.query(`DELETE FROM ${this.derived.derivedOutbox}
      WHERE tenant_id=$1 AND seq<=$3::bigint AND created_at<$2::timestamptz AND status IN ('delivered','revoked')`, [params[0], params[1], params[3]]);
    const evidence = await client.query(`DELETE FROM ${this.base.evidence} e
      WHERE ${this.collectibleRevisionPredicate('e')}`, params.slice(0, 3));
    const revisions = await client.query(`DELETE FROM ${this.base.revisions} r
      WHERE ${this.collectibleRevisionPredicate('r')}`, params.slice(0, 3));
    return {
      sourceOutbox: sourceOutbox.rowCount ?? 0, derivedOutbox: derivedOutbox.rowCount ?? 0,
      evidence: evidence.rowCount ?? 0, revisions: revisions.rowCount ?? 0,
    };
  }

  private collectibleRevisionPredicate(alias: string): string {
    const b = this.base;
    const d = this.derived;
    return `${alias}.tenant_id=$1 AND ${alias}.created_at<$2::timestamptz
      AND EXISTS (SELECT 1 FROM ${b.records} current
        WHERE current.tenant_id=${alias}.tenant_id AND current.source_id=${alias}.source_id
          AND current.collection_id=${alias}.collection_id AND current.record_id=${alias}.record_id
          AND current.current_revision<>${alias}.revision)
      AND NOT EXISTS (SELECT 1 FROM ${b.outbox} o
        WHERE o.tenant_id=${alias}.tenant_id AND o.source_id=${alias}.source_id
          AND o.collection_id=${alias}.collection_id AND o.record_id=${alias}.record_id
          AND o.record_revision=${alias}.revision AND NOT (o.seq<=$3::bigint AND o.created_at<$2::timestamptz))
      AND NOT EXISTS (SELECT 1 FROM ${d.entities} x WHERE x.tenant_id=${alias}.tenant_id
        AND x.source_id=${alias}.source_id AND x.collection_id=${alias}.collection_id
        AND x.record_id=${alias}.record_id AND x.record_revision=${alias}.revision)
      AND NOT EXISTS (SELECT 1 FROM ${d.itemEvidence} x WHERE x.tenant_id=${alias}.tenant_id
        AND x.source_id=${alias}.source_id AND x.collection_id=${alias}.collection_id
        AND x.record_id=${alias}.record_id AND x.record_revision=${alias}.revision)
      AND NOT EXISTS (SELECT 1 FROM ${d.profileFacetEvidence} x WHERE x.tenant_id=${alias}.tenant_id
        AND x.source_id=${alias}.source_id AND x.collection_id=${alias}.collection_id
        AND x.record_id=${alias}.record_id AND x.record_revision=${alias}.revision)
      AND NOT EXISTS (SELECT 1 FROM ${d.entityLinks} x WHERE x.tenant_id=${alias}.tenant_id AND (
        (x.from_source_id=${alias}.source_id AND x.from_collection_id=${alias}.collection_id
          AND x.from_record_id=${alias}.record_id AND x.from_revision=${alias}.revision) OR
        (x.to_source_id=${alias}.source_id AND x.to_collection_id=${alias}.collection_id
          AND x.to_record_id=${alias}.record_id AND x.to_revision=${alias}.revision) OR
        (x.evidence_source_id=${alias}.source_id AND x.evidence_collection_id=${alias}.collection_id
          AND x.evidence_record_id=${alias}.record_id AND x.evidence_revision=${alias}.revision)))
      AND NOT EXISTS (SELECT 1 FROM ${d.relationCandidates} x WHERE x.tenant_id=${alias}.tenant_id AND (
        (x.source_id=${alias}.source_id AND x.collection_id=${alias}.collection_id
          AND x.record_id=${alias}.record_id AND x.record_revision=${alias}.revision) OR
        (x.evidence_source_id=${alias}.source_id AND x.evidence_collection_id=${alias}.collection_id
          AND x.evidence_record_id=${alias}.record_id AND x.evidence_revision=${alias}.revision)))`;
  }
}

export interface ContextRetentionWorkerFailure {
  tenantId: string;
  error: string;
  /** Present when collection committed but audit delivery failed; safe to redeliver by receiptId. */
  receipt?: ContextRetentionReceipt;
}

export interface ContextRetentionWorkerStore {
  collect(request: ContextRetentionRequest): Promise<ContextRetentionReceipt>;
  getAuditState(tenantId: string, receiptId: string): Promise<ContextRetentionAuditState>;
  claimAudit(tenantId: string, receiptId: string): Promise<{ receipt: ContextRetentionReceipt; delivered: boolean; leaseId?: string }>;
  replayDeadLetterAudit(tenantId: string, receiptId: string, expectedRevision: number): Promise<ContextRetentionAuditClaim>;
  completeAudit(tenantId: string, receiptId: string, leaseId?: string): Promise<void>;
  failAudit(tenantId: string, receiptId: string, error: string, leaseId?: string): Promise<void>;
}

/** Runs independent tenant plans and delivers their durable audit outbox receipts. */
export class ContextRetentionWorker {
  constructor(
    private readonly store: ContextRetentionWorkerStore,
    private readonly audit: (receipt: ContextRetentionReceipt) => Promise<void>,
  ) {}

  async run(requests: readonly ContextRetentionRequest[]): Promise<{
    receipts: ContextRetentionReceipt[];
    failures: ContextRetentionWorkerFailure[];
  }> {
    const receipts: ContextRetentionReceipt[] = [];
    const failures: ContextRetentionWorkerFailure[] = [];
    for (const request of requests) {
      let committedReceipt: ContextRetentionReceipt | undefined;
      try {
        committedReceipt = await this.store.collect(request);
        await this.deliver(committedReceipt);
        receipts.push(committedReceipt);
      } catch (error) {
        failures.push({ tenantId: request.tenantId, error: safeError(error), ...(committedReceipt ? { receipt: committedReceipt } : {}) });
      }
    }
    return { receipts, failures };
  }

  /** Returns only mutable audit state for the tenant-owned receipt. */
  async getAuditState(tenantId: string, receiptId: string): Promise<ContextRetentionAuditState> {
    return this.store.getAuditState(tenantId, receiptId);
  }

  /** Tenant and receipt id are both required; callers cannot replay another tenant's receipt. */
  async retryAudit(tenantId: string, receiptId: string): Promise<ContextRetentionReceipt> {
    const claimed = await this.store.claimAudit(tenantId, receiptId);
    if (claimed.delivered) return claimed.receipt;
    return this.deliverClaim({ tenantId, receiptId, receipt: claimed.receipt, leaseId: claimed.leaseId! });
  }

  /** Explicit dead-letter recovery requires the exact tenant-owned receipt revision. */
  async replayDeadLetterAudit(tenantId: string, receiptId: string, expectedRevision: number): Promise<ContextRetentionReceipt> {
    return this.deliverClaim(await this.store.replayDeadLetterAudit(tenantId, receiptId, expectedRevision));
  }

  private async deliverClaim(claimed: ContextRetentionAuditClaim): Promise<ContextRetentionReceipt> {
    try {
      await this.audit(claimed.receipt);
      await this.store.completeAudit(claimed.tenantId, claimed.receiptId, claimed.leaseId);
      return claimed.receipt;
    } catch (error) {
      await this.store.failAudit(claimed.tenantId, claimed.receiptId, safeError(error), claimed.leaseId).catch(() => undefined);
      throw error;
    }
  }

  private async deliver(receipt: ContextRetentionReceipt): Promise<void> {
    await this.retryAudit(receipt.tenantId, receipt.receiptId);
  }
}

export interface ContextRetentionAuditConsumerStore {
  deadLetterExhaustedAudits(): Promise<number>;
  claimNextAudits(leaseOwner: string, limit: number): Promise<ContextRetentionAuditClaim[]>;
  completeAudit(tenantId: string, receiptId: string, leaseId?: string): Promise<void>;
  failAudit(tenantId: string, receiptId: string, error: string, leaseId?: string): Promise<void>;
}

export interface ContextRetentionAuditConsumerOptions {
  batchSize?: number;
  intervalMs?: number;
  logger?: { info(message: string): void; warn(message: string): void };
}

/**
 * Controlled runtime entrypoint for post-commit audit delivery. It never initiates
 * collection (and therefore preserves retention's default dry-run policy).
 */
export class ContextRetentionAuditConsumer {
  private readonly leaseOwner = randomUUID();
  private readonly batchSize: number;
  private readonly intervalMs: number;
  private readonly logger: { info(message: string): void; warn(message: string): void };
  private timer?: NodeJS.Timeout;
  private running?: Promise<ContextRetentionAuditConsumerResult>;

  constructor(
    private readonly store: ContextRetentionAuditConsumerStore,
    private readonly audit: (receipt: ContextRetentionReceipt) => Promise<void>,
    options: ContextRetentionAuditConsumerOptions = {},
  ) {
    this.batchSize = positiveInt(options.batchSize, 50);
    this.intervalMs = positiveInt(options.intervalMs, 30_000);
    this.logger = options.logger ?? { info: () => undefined, warn: () => undefined };
  }

  start(): void {
    if (this.timer) return;
    void this.trigger();
    this.timer = setInterval(() => void this.trigger(), this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  async runOnce(): Promise<ContextRetentionAuditConsumerResult> {
    const deadLettered = await this.store.deadLetterExhaustedAudits();
    const claims = await this.store.claimNextAudits(this.leaseOwner, this.batchSize);
    let delivered = 0;
    let failed = 0;
    for (const claim of claims) {
      try {
        await this.audit(claim.receipt);
        await this.store.completeAudit(claim.tenantId, claim.receiptId, claim.leaseId);
        delivered += 1;
      } catch (error) {
        failed += 1;
        const message = safeError(error);
        try {
          await this.store.failAudit(claim.tenantId, claim.receiptId, message, claim.leaseId);
        } catch (persistError) {
          this.logger.warn(`Context retention audit failure persistence failed tenant=${claim.tenantId} receipt=${claim.receiptId}: ${safeError(persistError)}`);
        }
        this.logger.warn(`Context retention audit delivery failed tenant=${claim.tenantId} receipt=${claim.receiptId}: ${message}`);
      }
    }
    if (deadLettered) this.logger.warn(`Context retention audit dead-lettered receipts=${deadLettered}`);
    return { claimed: claims.length, delivered, failed, deadLettered };
  }

  private trigger(): Promise<ContextRetentionAuditConsumerResult> {
    if (this.running) return this.running;
    this.running = this.runOnce()
      .catch(error => {
        this.logger.warn(`Context retention audit consumer failed: ${safeError(error)}`);
        return { claimed: 0, delivered: 0, failed: 0, deadLettered: 0 };
      })
      .finally(() => { this.running = undefined; });
    return this.running;
  }
}

export interface ContextRetentionAuditConsumerResult {
  claimed: number;
  delivered: number;
  failed: number;
  deadLettered: number;
}

function validateRequest(request: ContextRetentionRequest): void {
  if (!request.tenantId || request.tenantId.trim() !== request.tenantId) throw new Error('CONTEXT_RETENTION_INVALID');
  if (!/^\d+$/.test(request.sourceOutboxWatermark) || !/^\d+$/.test(request.derivedOutboxWatermark)) {
    throw new Error('CONTEXT_RETENTION_INVALID');
  }
  if (!Number.isFinite(Date.parse(request.retainAfter))) throw new Error('CONTEXT_RETENTION_INVALID');
}

function retentionParams(request: ContextRetentionRequest): [string, string, string, string] {
  return [request.tenantId, new Date(request.retainAfter).toISOString(), request.sourceOutboxWatermark, request.derivedOutboxWatermark];
}

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback;
}
function count(row: Record<string, unknown> | undefined): number { return Number(row?.count ?? 0); }
function nullableIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}
function receiptHash(receipt: object): string { return createHash('sha256').update(JSON.stringify(receipt)).digest('hex'); }
function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 300);
}
