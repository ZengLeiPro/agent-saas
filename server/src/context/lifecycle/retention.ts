import { createHash, randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { tableNames as phase4TableNames } from '../phase4/migration.js';
import { contextTableNames, contextTablePrefix, type ContextPgPool } from '../store/migration.js';

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
}

/**
 * Tenant-scoped Context history collection. The two explicit watermarks and age
 * cutoff are conjunctive. Current revisions and any revision still referenced
 * by an outbox/derived projection are never candidates.
 */
export class ContextRetentionStore {
  private readonly base;
  private readonly derived;
  private readonly now: () => Date;

  constructor(private readonly options: ContextRetentionStoreOptions) {
    const prefix = contextTablePrefix(options.tablePrefix);
    this.base = contextTableNames(prefix);
    this.derived = phase4TableNames(prefix);
    this.now = options.now ?? (() => new Date());
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
      await client.query('COMMIT');
      const completedAt = this.now().toISOString();
      const receipt = {
        ...request, dryRun, receiptId: randomUUID(), safeSourceOutboxWatermark: safeWatermark,
        startedAt, completedAt, counts,
      };
      return { ...receipt, receiptSha256: receiptHash(receipt) };
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

  private async countCandidates(client: PoolClient, request: ContextRetentionRequest): Promise<ContextRetentionCounts> {
    const params = retentionParams(request);
    const source = await client.query(`SELECT COUNT(*)::integer count FROM ${this.base.outbox}
      WHERE tenant_id=$1 AND seq<=$3 AND created_at<$2`, params);
    const derived = await client.query(`SELECT COUNT(*)::integer count FROM ${this.derived.derivedOutbox}
      WHERE tenant_id=$1 AND seq<=$4 AND created_at<$2 AND status IN ('delivered','revoked')`, params);
    const evidence = await client.query(`SELECT COUNT(*)::integer count FROM ${this.base.evidence} e
      WHERE ${this.collectibleRevisionPredicate('e')}`, params);
    const revisions = await client.query(`SELECT COUNT(*)::integer count FROM ${this.base.revisions} r
      WHERE ${this.collectibleRevisionPredicate('r')}`, params);
    return {
      sourceOutbox: count(source.rows[0]), derivedOutbox: count(derived.rows[0]),
      evidence: count(evidence.rows[0]), revisions: count(revisions.rows[0]),
    };
  }

  private async deleteCandidates(client: PoolClient, request: ContextRetentionRequest): Promise<ContextRetentionCounts> {
    const params = retentionParams(request);
    const sourceOutbox = await client.query(`DELETE FROM ${this.base.outbox}
      WHERE tenant_id=$1 AND seq<=$3 AND created_at<$2`, params);
    const derivedOutbox = await client.query(`DELETE FROM ${this.derived.derivedOutbox}
      WHERE tenant_id=$1 AND seq<=$4 AND created_at<$2 AND status IN ('delivered','revoked')`, params);
    const evidence = await client.query(`DELETE FROM ${this.base.evidence} e
      WHERE ${this.collectibleRevisionPredicate('e')}`, params);
    const revisions = await client.query(`DELETE FROM ${this.base.revisions} r
      WHERE ${this.collectibleRevisionPredicate('r')}`, params);
    return {
      sourceOutbox: sourceOutbox.rowCount ?? 0, derivedOutbox: derivedOutbox.rowCount ?? 0,
      evidence: evidence.rowCount ?? 0, revisions: revisions.rowCount ?? 0,
    };
  }

  private collectibleRevisionPredicate(alias: string): string {
    const b = this.base;
    const d = this.derived;
    return `${alias}.tenant_id=$1 AND ${alias}.created_at<$2
      AND EXISTS (SELECT 1 FROM ${b.records} current
        WHERE current.tenant_id=${alias}.tenant_id AND current.source_id=${alias}.source_id
          AND current.collection_id=${alias}.collection_id AND current.record_id=${alias}.record_id
          AND current.current_revision<>${alias}.revision)
      AND NOT EXISTS (SELECT 1 FROM ${b.outbox} o
        WHERE o.tenant_id=${alias}.tenant_id AND o.source_id=${alias}.source_id
          AND o.collection_id=${alias}.collection_id AND o.record_id=${alias}.record_id
          AND o.record_revision=${alias}.revision AND NOT (o.seq<=$3 AND o.created_at<$2))
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

/** Runs independent tenant plans; a failure is returned and never aborts later tenants. */
export class ContextRetentionWorker {
  constructor(
    private readonly store: Pick<ContextRetentionStore, 'collect'>,
    private readonly audit: (receipt: ContextRetentionReceipt) => Promise<void> = async () => undefined,
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
        await this.audit(committedReceipt);
        receipts.push(committedReceipt);
      } catch (error) {
        failures.push({
          tenantId: request.tenantId, error: safeError(error),
          ...(committedReceipt ? { receipt: committedReceipt } : {}),
        });
      }
    }
    return { receipts, failures };
  }
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

function count(row: Record<string, unknown> | undefined): number { return Number(row?.count ?? 0); }
function receiptHash(receipt: object): string { return createHash('sha256').update(JSON.stringify(receipt)).digest('hex'); }
function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 300);
}
