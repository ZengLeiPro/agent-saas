import type { PoolClient } from 'pg';

import {
  contextTableNames,
  contextTablePrefix,
  type ContextPgPool,
  type ContextTableNames,
} from './migration.js';
import { tableNames as contextPhase4TableNames } from '../phase4/migration.js';
import { contextRetentionTableNames } from '../lifecycle/migration.js';
import {
  ContextStoreError,
  type ContextCollection,
  type ContextEvidence,
  type ContextJson,
  type ContextObject,
  type ContextOutboxCursor,
  type ContextOutboxEvent,
  type ContextRecordRevision,
  type ContextRecordWithRevision,
  type ContextSource,
  type ContextSourceRecord,
  type ContextSyncPartition,
  type ContextTypedEnvelope,
  type CreateContextCollectionInput,
  type CreateContextSourceInput,
  type EnsureContextPartitionInput,
  type FailContextPartitionInput,
  type IngestContextPageInput,
  type IngestContextPageResult,
  type ContextPartitionFenceInput,
  type ContextPartitionLeaseInput,
  type UpdateContextCollectionInput,
  type UpdateContextSourceInput,
} from './types.js';
import {
  assertContextBigIntDecimal,
  assertContextErrorCode,
  assertContextId,
  assertContextJson,
  assertContextLeaseMs,
  assertContextObject,
  assertContextRecordInput,
  assertContextRevision,
  assertContextStatus,
  assertContextText,
  computeContextVersionFingerprint,
  normalizeContextAclPrincipals,
  parseContextDate,
  parseContextEnvelopeDate,
} from './validation.js';

type Row = Record<string, unknown>;

async function mapIdentityConflict<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
      throw new ContextStoreError('CONTEXT_IDENTITY_CONFLICT');
    }
    throw error;
  }
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function optionalIso(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : iso(value);
}

function json<T extends ContextJson>(value: unknown): T {
  // node-postgres already decodes JSON/JSONB. Re-parsing a decoded scalar string
  // throws for values such as "inventory-v1" and corrupts "123" into a number.
  return value as T;
}

function envelopeFromRow(row: Row): ContextTypedEnvelope {
  const rawAclPrincipals = typeof row.acl_principals === 'string'
    ? json<ContextJson>(row.acl_principals)
    : row.acl_principals;
  const aclPrincipals = Array.isArray(rawAclPrincipals)
    ? rawAclPrincipals.map(value => String(value))
    : undefined;
  return {
    ...(row.entity_type === null || row.entity_type === undefined ? {} : { entityType: String(row.entity_type) as ContextTypedEnvelope['entityType'] }),
    ...(row.record_kind === null || row.record_kind === undefined ? {} : { recordKind: String(row.record_kind) as ContextTypedEnvelope['recordKind'] }),
    ...(row.native_id === null || row.native_id === undefined ? {} : { nativeId: String(row.native_id) }),
    ...(optionalIso(row.occurred_at) ? { occurredAt: optionalIso(row.occurred_at) } : {}),
    ...(row.source_event_id === null || row.source_event_id === undefined ? {} : { sourceEventId: String(row.source_event_id) }),
    ...(row.owner_principal === null || row.owner_principal === undefined ? {} : { ownerPrincipal: String(row.owner_principal) }),
    ...(aclPrincipals === undefined ? {} : { aclPrincipals }),
  };
}

function sourceFromRow(row: Row): ContextSource {
  return {
    tenantId: String(row.tenant_id), sourceId: String(row.source_id), kind: String(row.kind),
    displayName: String(row.display_name), status: row.status as ContextSource['status'],
    config: json<ContextObject>(row.config_json), revision: Number(row.revision),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

function collectionFromRow(row: Row): ContextCollection {
  return {
    tenantId: String(row.tenant_id), sourceId: String(row.source_id), collectionId: String(row.collection_id),
    externalKey: String(row.external_key), displayName: String(row.display_name),
    status: row.status as ContextCollection['status'], metadata: json<ContextObject>(row.metadata_json),
    revision: Number(row.revision), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

function partitionFromRow(row: Row): ContextSyncPartition {
  return {
    tenantId: String(row.tenant_id), sourceId: String(row.source_id), collectionId: String(row.collection_id),
    partitionKey: String(row.partition_key), status: row.status as ContextSyncPartition['status'],
    ...(row.watermark_json === null || row.watermark_json === undefined ? {} : { watermark: json(row.watermark_json) }),
    ...(optionalIso(row.window_start) ? { windowStart: optionalIso(row.window_start) } : {}),
    ...(optionalIso(row.window_end) ? { windowEnd: optionalIso(row.window_end) } : {}),
    ...(row.page_cursor === null || row.page_cursor === undefined ? {} : { pageCursor: String(row.page_cursor) }),
    ...(row.lease_owner === null || row.lease_owner === undefined ? {} : { leaseOwner: String(row.lease_owner) }),
    leaseFence: Number(row.lease_fence),
    ...(optionalIso(row.lease_expires_at) ? { leaseExpiresAt: optionalIso(row.lease_expires_at) } : {}),
    retryCount: Number(row.retry_count),
    ...(optionalIso(row.next_retry_at) ? { nextRetryAt: optionalIso(row.next_retry_at) } : {}),
    ...(row.last_error_code === null || row.last_error_code === undefined ? {} : { lastErrorCode: String(row.last_error_code) }),
    ...(optionalIso(row.coverage_start) ? { coverageStart: optionalIso(row.coverage_start) } : {}),
    ...(optionalIso(row.coverage_end) ? { coverageEnd: optionalIso(row.coverage_end) } : {}),
    truncated: Boolean(row.truncated), refused: Boolean(row.refused), updatedAt: iso(row.updated_at),
  };
}

function recordFromRow(row: Row): ContextSourceRecord {
  return {
    tenantId: String(row.tenant_id), sourceId: String(row.source_id), collectionId: String(row.collection_id),
    recordId: String(row.record_id), externalRecordId: String(row.external_record_id),
    currentRevision: Number(row.current_revision), contentHash: String(row.content_hash),
    ...envelopeFromRow(row),
    content: json(row.content_json), metadata: json<ContextObject>(row.metadata_json),
    deleted: Boolean(row.deleted), revoked: Boolean(row.revoked),
    ...(optionalIso(row.source_updated_at) ? { sourceUpdatedAt: optionalIso(row.source_updated_at) } : {}),
    observedAt: iso(row.observed_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

function revisionFromRow(row: Row): ContextRecordRevision {
  return {
    tenantId: String(row.tenant_id), sourceId: String(row.source_id), collectionId: String(row.collection_id),
    recordId: String(row.record_id), revision: Number(row.revision), contentHash: String(row.content_hash),
    ...envelopeFromRow(row),
    content: json(row.content_json), metadata: json<ContextObject>(row.metadata_json),
    deleted: Boolean(row.deleted), revoked: Boolean(row.revoked),
    ...(optionalIso(row.source_updated_at) ? { sourceUpdatedAt: optionalIso(row.source_updated_at) } : {}),
    observedAt: iso(row.observed_at), createdAt: iso(row.created_at),
  };
}

function evidenceFromRow(row: Row): ContextEvidence {
  return {
    tenantId: String(row.tenant_id), sourceId: String(row.source_id), collectionId: String(row.collection_id),
    recordId: String(row.record_id), revision: Number(row.revision), evidenceId: String(row.evidence_id),
    kind: String(row.kind), data: json<ContextObject>(row.data_json), createdAt: iso(row.created_at),
  };
}

function outboxFromRow(row: Row): ContextOutboxEvent {
  return {
    tenantId: String(row.tenant_id), seq: String(row.seq), eventType: row.event_type as ContextOutboxEvent['eventType'],
    sourceId: String(row.source_id), collectionId: String(row.collection_id), recordId: String(row.record_id),
    recordRevision: Number(row.record_revision), payload: json<ContextObject>(row.payload_json), createdAt: iso(row.created_at),
  };
}

function assertScope(tenantId: string, sourceId?: string, collectionId?: string): void {
  assertContextId(tenantId);
  if (sourceId !== undefined) assertContextId(sourceId);
  if (collectionId !== undefined) assertContextId(collectionId);
}

function assertFence(input: ContextPartitionFenceInput): void {
  assertScope(input.tenantId, input.sourceId, input.collectionId);
  assertContextText(input.partitionKey, 500);
  assertContextId(input.leaseOwner);
  if (!Number.isSafeInteger(input.leaseFence) || input.leaseFence < 1) throw new ContextStoreError('CONTEXT_INVALID');
}

export interface ContextStoreOptions {
  pool: ContextPgPool;
  tablePrefix?: string;
}

/** Durable receipt for a tenant-scoped Context hard delete. */
export interface ContextTenantDeletionReport {
  retentionReceiptsDeleted: number;
  relationCandidatesDeleted: number;
  entityLinksDeleted: number;
  itemEvidenceDeleted: number;
  profileFacetEvidenceDeleted: number;
  reviewsDeleted: number;
  derivedItemsDeleted: number;
  profileFacetsDeleted: number;
  entitiesDeleted: number;
  consumersDeleted: number;
  derivedOutboxDeleted: number;
  outboxDeleted: number;
  evidenceDeleted: number;
  revisionsDeleted: number;
  recordsDeleted: number;
  partitionsDeleted: number;
  collectionsDeleted: number;
  sourcesDeleted: number;
  totalDeleted: number;
}

export class ContextStore {
  readonly tables: ContextTableNames;
  private readonly agentDwsAccountsTable: string;
  private readonly tablePrefix: string;

  constructor(private readonly options: ContextStoreOptions) {
    this.tablePrefix = contextTablePrefix(options.tablePrefix);
    this.tables = contextTableNames(this.tablePrefix);
    this.agentDwsAccountsTable = `${this.tablePrefix}_agent_dws_accounts`;
  }

  /**
   * Permanently removes every Context Plane phase row for one tenant. The explicit
   * reverse-FK order is required because phase 2/3/4 foreign keys intentionally
   * do not all cascade. The transaction makes a failed cleanup auditable and
   * leaves Context data intact for a retry.
   */
  async hardDeleteTenant(tenantId: string): Promise<ContextTenantDeletionReport> {
    assertScope(tenantId);
    const phase4 = contextPhase4TableNames(this.tablePrefix);
    const retention = contextRetentionTableNames(this.tablePrefix);
    const plan: Array<{ key: Exclude<keyof ContextTenantDeletionReport, 'totalDeleted'>; table: string }> = [
      { key: 'retentionReceiptsDeleted', table: retention.receipts },
      { key: 'relationCandidatesDeleted', table: phase4.relationCandidates },
      { key: 'entityLinksDeleted', table: phase4.entityLinks },
      { key: 'itemEvidenceDeleted', table: phase4.itemEvidence },
      { key: 'profileFacetEvidenceDeleted', table: phase4.profileFacetEvidence },
      { key: 'reviewsDeleted', table: phase4.reviews },
      { key: 'derivedItemsDeleted', table: phase4.derivedItems },
      { key: 'profileFacetsDeleted', table: phase4.profileFacets },
      { key: 'entitiesDeleted', table: phase4.entities },
      { key: 'consumersDeleted', table: phase4.consumers },
      { key: 'derivedOutboxDeleted', table: phase4.derivedOutbox },
      { key: 'outboxDeleted', table: this.tables.outbox },
      { key: 'evidenceDeleted', table: this.tables.evidence },
      { key: 'revisionsDeleted', table: this.tables.revisions },
      { key: 'recordsDeleted', table: this.tables.records },
      { key: 'partitionsDeleted', table: this.tables.partitions },
      { key: 'collectionsDeleted', table: this.tables.collections },
      { key: 'sourcesDeleted', table: this.tables.sources },
    ];
    const deleted = {} as Omit<ContextTenantDeletionReport, 'totalDeleted'>;
    const client = await this.options.pool.connect();
    let currentStep = 'BEGIN';
    try {
      await client.query('BEGIN');
      for (const { key, table } of plan) {
        currentStep = key;
        const result = await client.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenantId]);
        deleted[key] = result.rowCount ?? 0;
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(`CONTEXT_TENANT_HARD_DELETE_FAILED tenant=${tenantId} step=${currentStep}: ${cause}`);
    } finally {
      client.release();
    }
    const totalDeleted = Object.values(deleted).reduce((total, count) => total + count, 0);
    return { ...deleted, totalDeleted };
  }

  async createSource(input: CreateContextSourceInput): Promise<ContextSource> {
    assertScope(input.tenantId, input.sourceId);
    assertContextText(input.kind, 200);
    assertContextText(input.displayName);
    assertContextObject(input.config ?? {});
    const result = await this.options.pool.query(`
      INSERT INTO ${this.tables.sources} (tenant_id,source_id,kind,display_name,config_json)
      VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (tenant_id,source_id) DO NOTHING RETURNING *
    `, [input.tenantId, input.sourceId, input.kind, input.displayName, JSON.stringify(input.config ?? {})]);
    if (!result.rows[0]) throw new ContextStoreError('CONTEXT_IDENTITY_CONFLICT');
    return sourceFromRow(result.rows[0]);
  }

  async getSource(tenantId: string, sourceId: string): Promise<ContextSource | null> {
    assertScope(tenantId, sourceId);
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.tables.sources} WHERE tenant_id=$1 AND source_id=$2`, [tenantId, sourceId],
    );
    return result.rows[0] ? sourceFromRow(result.rows[0]) : null;
  }

  async listSources(tenantId: string): Promise<ContextSource[]> {
    assertScope(tenantId);
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.tables.sources} WHERE tenant_id=$1 ORDER BY source_id`, [tenantId],
    );
    return result.rows.map(sourceFromRow);
  }

  async updateSource(input: UpdateContextSourceInput): Promise<ContextSource> {
    assertScope(input.tenantId, input.sourceId);
    assertContextRevision(input.expectedRevision);
    if (input.displayName !== undefined) assertContextText(input.displayName);
    if (input.status !== undefined) assertContextStatus(input.status);
    if (input.config !== undefined) assertContextObject(input.config);
    if (input.displayName === undefined && input.status === undefined && input.config === undefined) {
      throw new ContextStoreError('CONTEXT_INVALID');
    }
    const result = await this.options.pool.query(`
      UPDATE ${this.tables.sources}
      SET display_name=COALESCE($4,display_name),status=COALESCE($5,status),
          config_json=COALESCE($6::jsonb,config_json),revision=revision+1,updated_at=NOW()
      WHERE tenant_id=$1 AND source_id=$2 AND revision=$3 RETURNING *
    `, [input.tenantId, input.sourceId, input.expectedRevision, input.displayName ?? null,
      input.status ?? null, input.config === undefined ? null : JSON.stringify(input.config)]);
    if (!result.rows[0]) await this.throwVersionOrNotFound(this.tables.sources, input.tenantId, input.sourceId);
    return sourceFromRow(result.rows[0]!);
  }

  async deleteSource(tenantId: string, sourceId: string, expectedRevision: number): Promise<ContextSource> {
    return this.updateSource({ tenantId, sourceId, expectedRevision, status: 'deleted' });
  }

  async createCollection(input: CreateContextCollectionInput): Promise<ContextCollection> {
    assertScope(input.tenantId, input.sourceId, input.collectionId);
    assertContextText(input.externalKey, 1000);
    assertContextText(input.displayName);
    assertContextObject(input.metadata ?? {});
    const result = await mapIdentityConflict(() => this.options.pool.query(`
      INSERT INTO ${this.tables.collections}
        (tenant_id,source_id,collection_id,external_key,display_name,metadata_json)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb)
      ON CONFLICT (tenant_id,source_id,collection_id) DO NOTHING RETURNING *
    `, [input.tenantId, input.sourceId, input.collectionId, input.externalKey,
      input.displayName, JSON.stringify(input.metadata ?? {})]));
    if (!result.rows[0]) throw new ContextStoreError('CONTEXT_IDENTITY_CONFLICT');
    return collectionFromRow(result.rows[0]);
  }

  async getCollection(tenantId: string, sourceId: string, collectionId: string): Promise<ContextCollection | null> {
    assertScope(tenantId, sourceId, collectionId);
    const result = await this.options.pool.query(`
      SELECT * FROM ${this.tables.collections}
      WHERE tenant_id=$1 AND source_id=$2 AND collection_id=$3
    `, [tenantId, sourceId, collectionId]);
    return result.rows[0] ? collectionFromRow(result.rows[0]) : null;
  }

  async listCollections(tenantId: string, sourceId?: string): Promise<ContextCollection[]> {
    assertScope(tenantId, sourceId);
    const result = sourceId === undefined
      ? await this.options.pool.query(`SELECT * FROM ${this.tables.collections} WHERE tenant_id=$1 ORDER BY source_id,collection_id`, [tenantId])
      : await this.options.pool.query(`SELECT * FROM ${this.tables.collections} WHERE tenant_id=$1 AND source_id=$2 ORDER BY collection_id`, [tenantId, sourceId]);
    return result.rows.map(collectionFromRow);
  }

  async updateCollection(input: UpdateContextCollectionInput): Promise<ContextCollection> {
    assertScope(input.tenantId, input.sourceId, input.collectionId);
    assertContextRevision(input.expectedRevision);
    if (input.displayName !== undefined) assertContextText(input.displayName);
    if (input.status !== undefined) assertContextStatus(input.status);
    if (input.metadata !== undefined) assertContextObject(input.metadata);
    if (input.displayName === undefined && input.status === undefined && input.metadata === undefined) {
      throw new ContextStoreError('CONTEXT_INVALID');
    }
    const result = await this.options.pool.query(`
      UPDATE ${this.tables.collections}
      SET display_name=COALESCE($5,display_name),status=COALESCE($6,status),
          metadata_json=COALESCE($7::jsonb,metadata_json),revision=revision+1,updated_at=NOW()
      WHERE tenant_id=$1 AND source_id=$2 AND collection_id=$3 AND revision=$4 RETURNING *
    `, [input.tenantId, input.sourceId, input.collectionId, input.expectedRevision,
      input.displayName ?? null, input.status ?? null,
      input.metadata === undefined ? null : JSON.stringify(input.metadata)]);
    if (!result.rows[0]) {
      const current = await this.getCollection(input.tenantId, input.sourceId, input.collectionId);
      throw new ContextStoreError(current ? 'CONTEXT_VERSION_CONFLICT' : 'CONTEXT_NOT_FOUND');
    }
    return collectionFromRow(result.rows[0]);
  }

  async deleteCollection(tenantId: string, sourceId: string, collectionId: string, expectedRevision: number): Promise<ContextCollection> {
    return this.updateCollection({ tenantId, sourceId, collectionId, expectedRevision, status: 'deleted' });
  }

  async ensurePartition(input: EnsureContextPartitionInput): Promise<ContextSyncPartition> {
    assertScope(input.tenantId, input.sourceId, input.collectionId);
    assertContextText(input.partitionKey, 500);
    const windowStart = parseContextDate(input.windowStart);
    const windowEnd = parseContextDate(input.windowEnd);
    if (windowStart && windowEnd && windowEnd < windowStart) throw new ContextStoreError('CONTEXT_INVALID');
    const result = await this.options.pool.query(`
      INSERT INTO ${this.tables.partitions}
        (tenant_id,source_id,collection_id,partition_key,window_start,window_end)
      VALUES ($1,$2,$3,$4,$5::timestamptz,$6::timestamptz)
      ON CONFLICT (tenant_id,source_id,collection_id,partition_key)
      DO UPDATE SET window_start=COALESCE(EXCLUDED.window_start,${this.tables.partitions}.window_start),
                    window_end=COALESCE(EXCLUDED.window_end,${this.tables.partitions}.window_end),updated_at=NOW()
      RETURNING *
    `, [input.tenantId, input.sourceId, input.collectionId, input.partitionKey, windowStart ?? null, windowEnd ?? null]);
    return partitionFromRow(result.rows[0]!);
  }

  async resetPartitionsForPolicyChange(
    tenantId: string,
    sourceId: string,
    collectionId: string,
  ): Promise<number> {
    const result = await this.options.pool.query(`
      UPDATE ${this.tables.partitions}
      SET status='idle',watermark_json=NULL,window_start=NULL,window_end=NULL,page_cursor=NULL,
          lease_owner=NULL,lease_expires_at=NULL,lease_fence=lease_fence+1,
          retry_count=0,next_retry_at=NULL,last_error_code=NULL,
          coverage_start=NULL,coverage_end=NULL,
          truncated=FALSE,refused=FALSE,updated_at=NOW()
      WHERE tenant_id=$1 AND source_id=$2 AND collection_id=$3
      RETURNING partition_key
    `, [tenantId, sourceId, collectionId]);
    return result.rows.length;
  }

  async resetRefusedPartitions(
    tenantId: string,
    sourceId: string,
    collectionId?: string,
  ): Promise<number> {
    const result = await this.options.pool.query(`
      UPDATE ${this.tables.partitions}
      SET status='idle',refused=FALSE,retry_count=0,next_retry_at=NULL,last_error_code=NULL,
          window_start=NULL,window_end=NULL,page_cursor=NULL,truncated=FALSE,updated_at=NOW()
      WHERE tenant_id=$1 AND source_id=$2
        AND ($3::text IS NULL OR collection_id=$3)
        AND (refused=TRUE OR status='refused')
      RETURNING partition_key
    `, [tenantId, sourceId, collectionId ?? null]);
    return result.rows.length;
  }

  async getPartition(tenantId: string, sourceId: string, collectionId: string, partitionKey: string): Promise<ContextSyncPartition | null> {
    assertScope(tenantId, sourceId, collectionId);
    assertContextText(partitionKey, 500);
    const result = await this.options.pool.query(`
      SELECT * FROM ${this.tables.partitions}
      WHERE tenant_id=$1 AND source_id=$2 AND collection_id=$3 AND partition_key=$4
    `, [tenantId, sourceId, collectionId, partitionKey]);
    return result.rows[0] ? partitionFromRow(result.rows[0]) : null;
  }

  async listPartitions(tenantId: string, sourceId?: string, collectionId?: string): Promise<ContextSyncPartition[]> {
    assertScope(tenantId, sourceId, collectionId);
    if (collectionId !== undefined && sourceId === undefined) throw new ContextStoreError('CONTEXT_INVALID');
    const result = await this.options.pool.query(`
      SELECT * FROM ${this.tables.partitions}
      WHERE tenant_id=$1
        AND ($2::text IS NULL OR source_id=$2)
        AND ($3::text IS NULL OR collection_id=$3)
      ORDER BY source_id,collection_id,partition_key
    `, [tenantId, sourceId ?? null, collectionId ?? null]);
    return result.rows.map(partitionFromRow);
  }

  async acquirePartitionLease(input: ContextPartitionLeaseInput): Promise<ContextSyncPartition | null> {
    assertScope(input.tenantId, input.sourceId, input.collectionId);
    assertContextText(input.partitionKey, 500);
    assertContextId(input.leaseOwner);
    assertContextLeaseMs(input.leaseMs);
    const result = await this.options.pool.query(`
      UPDATE ${this.tables.partitions}
      SET status='syncing',lease_owner=$5,lease_fence=lease_fence+1,
          lease_expires_at=NOW()+($6 * INTERVAL '1 millisecond'),next_retry_at=NULL,updated_at=NOW()
      WHERE tenant_id=$1 AND source_id=$2 AND collection_id=$3 AND partition_key=$4
        AND (lease_owner IS NULL OR lease_expires_at <= NOW())
        AND (next_retry_at IS NULL OR next_retry_at <= NOW()) AND refused=FALSE
      RETURNING *
    `, [input.tenantId, input.sourceId, input.collectionId, input.partitionKey, input.leaseOwner, input.leaseMs]);
    return result.rows[0] ? partitionFromRow(result.rows[0]) : null;
  }

  async renewPartitionLease(input: ContextPartitionFenceInput & { leaseMs: number }): Promise<boolean> {
    assertFence(input);
    assertContextLeaseMs(input.leaseMs);
    const result = await this.options.pool.query(`
      UPDATE ${this.tables.partitions}
      SET lease_expires_at=NOW()+($7 * INTERVAL '1 millisecond'),updated_at=NOW()
      WHERE tenant_id=$1 AND source_id=$2 AND collection_id=$3 AND partition_key=$4
        AND lease_owner=$5 AND lease_fence=$6 AND lease_expires_at > NOW() AND status='syncing'
      RETURNING partition_key
    `, [input.tenantId, input.sourceId, input.collectionId, input.partitionKey,
      input.leaseOwner, input.leaseFence, input.leaseMs]);
    return Boolean(result.rows[0]);
  }

  async failPartition(input: FailContextPartitionInput): Promise<ContextSyncPartition> {
    assertFence(input);
    assertContextErrorCode(input.errorCode);
    const retryAt = parseContextDate(input.retryAt);
    if (!input.refused && !retryAt) throw new ContextStoreError('CONTEXT_INVALID');
    const result = await this.options.pool.query(`
      UPDATE ${this.tables.partitions}
      SET status=CASE WHEN $8 THEN 'refused' ELSE 'retry_wait' END,
          refused=$8,lease_owner=NULL,lease_expires_at=NULL,retry_count=retry_count+1,
          next_retry_at=$7::timestamptz,last_error_code=$9,updated_at=NOW()
      WHERE tenant_id=$1 AND source_id=$2 AND collection_id=$3 AND partition_key=$4
        AND lease_owner=$5 AND lease_fence=$6 AND lease_expires_at > NOW() AND status='syncing'
      RETURNING *
    `, [input.tenantId, input.sourceId, input.collectionId, input.partitionKey,
      input.leaseOwner, input.leaseFence, retryAt ?? null, input.refused ?? false, input.errorCode]);
    if (!result.rows[0]) throw new ContextStoreError('CONTEXT_LEASE_LOST');
    return partitionFromRow(result.rows[0]);
  }

  async ingestPage(input: IngestContextPageInput): Promise<IngestContextPageResult> {
    assertFence(input);
    if (!Array.isArray(input.records) || input.records.length > 20_000) throw new ContextStoreError('CONTEXT_INVALID');
    input.records.forEach(assertContextRecordInput);
    const externalIds = new Set<string>();
    for (const record of input.records) {
      if (externalIds.has(record.externalRecordId)) throw new ContextStoreError('CONTEXT_INVALID');
      externalIds.add(record.externalRecordId);
    }
    const checkpoint = input.checkpoint;
    if (!checkpoint || typeof checkpoint !== 'object') throw new ContextStoreError('CONTEXT_INVALID');
    if (checkpoint.watermark !== undefined) assertContextJson(checkpoint.watermark);
    if (checkpoint.pageCursor !== undefined) assertContextText(checkpoint.pageCursor, 4000);
    const windowStart = parseContextDate(checkpoint.windowStart);
    const windowEnd = parseContextDate(checkpoint.windowEnd);
    const coverageStart = parseContextDate(checkpoint.coverageStart);
    const coverageEnd = parseContextDate(checkpoint.coverageEnd);
    if ((windowStart && windowEnd && windowEnd < windowStart)
      || (coverageStart && coverageEnd && coverageEnd < coverageStart)) throw new ContextStoreError('CONTEXT_INVALID');

    return this.withTransaction(async client => {
      // Lock authorization before the partition. Account policy updates must
      // wait for an in-flight ingest, or commit first and make its revision stale.
      const resources = await client.query(`
        SELECT s.kind AS source_kind,s.status AS source_status,s.config_json,
               c.status AS collection_status
        FROM ${this.tables.sources} s
        JOIN ${this.tables.collections} c
          ON c.tenant_id=s.tenant_id AND c.source_id=s.source_id
        WHERE s.tenant_id=$1 AND s.source_id=$2 AND c.collection_id=$3
        FOR SHARE OF s,c
      `, [input.tenantId, input.sourceId, input.collectionId]);
      const resource = resources.rows[0] as Row | undefined;
      if (!resource || resource.source_status !== 'active' || resource.collection_status !== 'active') {
        throw new ContextStoreError('CONTEXT_LEASE_LOST');
      }
      if (resource.source_kind === 'dws') {
        const sourceConfig = json<ContextObject>(resource.config_json);
        const accountId = typeof sourceConfig.accountId === 'string' ? sourceConfig.accountId : '';
        const sourceAccountRevision = sourceConfig.accountRevision;
        const account = await client.query(`
          SELECT status,revision FROM ${this.agentDwsAccountsTable}
          WHERE tenant_id=$1 AND account_id=$2
          FOR SHARE
        `, [input.tenantId, accountId]);
        const accountRow = account.rows[0] as Row | undefined;
        if (!accountRow || accountRow.status !== 'active'
          || String(sourceAccountRevision ?? '') !== String(accountRow.revision ?? '')) {
          throw new ContextStoreError('CONTEXT_LEASE_LOST');
        }
      }
      const locked = await client.query(`
        SELECT * FROM ${this.tables.partitions}
        WHERE tenant_id=$1 AND source_id=$2 AND collection_id=$3 AND partition_key=$4
        FOR UPDATE
      `, [input.tenantId, input.sourceId, input.collectionId, input.partitionKey]);
      const lease = locked.rows[0] as Row | undefined;
      if (!lease || lease.status !== 'syncing' || lease.lease_owner !== input.leaseOwner
        || Number(lease.lease_fence) !== input.leaseFence
        || !lease.lease_expires_at || new Date(iso(lease.lease_expires_at)).getTime() <= Date.now()) {
        throw new ContextStoreError('CONTEXT_LEASE_LOST');
      }

      let created = 0;
      let revised = 0;
      let unchanged = 0;
      const outbox: ContextOutboxEvent[] = [];
      for (const item of input.records) {
        const contentHash = computeContextVersionFingerprint(item);
        const metadata = item.metadata ?? {};
        const deleted = item.deleted ?? false;
        const revoked = item.revoked ?? false;
        const sourceUpdatedAt = parseContextDate(item.sourceUpdatedAt);
        const observedAt = parseContextDate(item.observedAt) ?? new Date().toISOString();
        const occurredAt = parseContextEnvelopeDate(item.occurredAt);
        const aclPrincipals = normalizeContextAclPrincipals(item.aclPrincipals);
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `context-record:${input.tenantId}:${input.sourceId}:${input.collectionId}:${item.externalRecordId}`,
        ]);
        const existingResult = await client.query(`
          SELECT * FROM ${this.tables.records}
          WHERE tenant_id=$1 AND source_id=$2 AND collection_id=$3 AND external_record_id=$4
          FOR UPDATE
        `, [input.tenantId, input.sourceId, input.collectionId, item.externalRecordId]);
        const existing = existingResult.rows[0] as Row | undefined;
        if (existing && String(existing.record_id) !== item.recordId) {
          throw new ContextStoreError('CONTEXT_IDENTITY_CONFLICT');
        }
        if (existing && String(existing.content_hash) === contentHash
          && Boolean(existing.deleted) === deleted && Boolean(existing.revoked) === revoked) {
          unchanged += 1;
          continue;
        }

        const revision = existing ? Number(existing.current_revision) + 1 : 1;
        let recordRow: Row;
        if (existing) {
          const updated = await client.query(`
            UPDATE ${this.tables.records}
            SET current_revision=$5,content_hash=$6,content_json=$7::jsonb,metadata_json=$8::jsonb,
                deleted=$9,revoked=$10,source_updated_at=$11::timestamptz,observed_at=$12::timestamptz,
                entity_type=$13,record_kind=$14,native_id=$15,occurred_at=$16::timestamptz,
                source_event_id=$17,owner_principal=$18,acl_principals=$19::jsonb,updated_at=NOW()
            WHERE tenant_id=$1 AND source_id=$2 AND collection_id=$3 AND record_id=$4 RETURNING *
          `, [input.tenantId, input.sourceId, input.collectionId, item.recordId, revision, contentHash,
            JSON.stringify(item.content), JSON.stringify(metadata), deleted, revoked, sourceUpdatedAt ?? null, observedAt,
            item.entityType ?? null, item.recordKind ?? null, item.nativeId ?? null, occurredAt ?? null,
            item.sourceEventId ?? null, item.ownerPrincipal ?? null,
            aclPrincipals === undefined ? null : JSON.stringify(aclPrincipals)]);
          recordRow = updated.rows[0] as Row;
          revised += 1;
        } else {
          const inserted = await client.query(`
            INSERT INTO ${this.tables.records}
              (tenant_id,source_id,collection_id,record_id,external_record_id,current_revision,content_hash,
               content_json,metadata_json,deleted,revoked,source_updated_at,observed_at,
               entity_type,record_kind,native_id,occurred_at,source_event_id,owner_principal,acl_principals)
            VALUES ($1,$2,$3,$4,$5,1,$6,$7::jsonb,$8::jsonb,$9,$10,$11::timestamptz,$12::timestamptz,
                    $13,$14,$15,$16::timestamptz,$17,$18,$19::jsonb)
            RETURNING *
          `, [input.tenantId, input.sourceId, input.collectionId, item.recordId, item.externalRecordId,
            contentHash, JSON.stringify(item.content), JSON.stringify(metadata), deleted, revoked,
            sourceUpdatedAt ?? null, observedAt, item.entityType ?? null, item.recordKind ?? null,
            item.nativeId ?? null, occurredAt ?? null, item.sourceEventId ?? null,
            item.ownerPrincipal ?? null, aclPrincipals === undefined ? null : JSON.stringify(aclPrincipals)]);
          recordRow = inserted.rows[0] as Row;
          created += 1;
        }

        await client.query(`
          INSERT INTO ${this.tables.revisions}
            (tenant_id,source_id,collection_id,record_id,revision,content_hash,content_json,metadata_json,
             deleted,revoked,source_updated_at,observed_at,entity_type,record_kind,native_id,occurred_at,
             source_event_id,owner_principal,acl_principals)
          VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11::timestamptz,$12::timestamptz,
                  $13,$14,$15,$16::timestamptz,$17,$18,$19::jsonb)
        `, [input.tenantId, input.sourceId, input.collectionId, item.recordId, revision, contentHash,
          JSON.stringify(item.content), JSON.stringify(metadata), deleted, revoked, sourceUpdatedAt ?? null, observedAt,
          item.entityType ?? null, item.recordKind ?? null, item.nativeId ?? null, occurredAt ?? null,
          item.sourceEventId ?? null, item.ownerPrincipal ?? null,
          aclPrincipals === undefined ? null : JSON.stringify(aclPrincipals)]);
        const evidenceItems = [...(item.evidence ?? [])]
          .sort((left, right) => left.evidenceId < right.evidenceId ? -1 : left.evidenceId > right.evidenceId ? 1 : 0);
        for (const evidence of evidenceItems) {
          await client.query(`
            INSERT INTO ${this.tables.evidence}
              (tenant_id,source_id,collection_id,record_id,revision,evidence_id,kind,data_json)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
          `, [input.tenantId, input.sourceId, input.collectionId, item.recordId, revision,
            evidence.evidenceId, evidence.kind, JSON.stringify(evidence.data)]);
        }
        const eventType: ContextOutboxEvent['eventType'] = revoked
          ? 'context.record.revoked' : deleted ? 'context.record.deleted' : 'context.record.upserted';
        const payload: ContextObject = {
          version: 2,
          contentHash,
          deleted,
          revoked,
          externalRecordId: item.externalRecordId,
          ...(item.entityType === undefined ? {} : { entityType: item.entityType }),
          ...(item.recordKind === undefined ? {} : { recordKind: item.recordKind }),
          ...(item.nativeId === undefined ? {} : { nativeId: item.nativeId }),
          ...(occurredAt === undefined ? {} : { occurredAt }),
          ...(item.sourceEventId === undefined ? {} : { sourceEventId: item.sourceEventId }),
          ...(item.ownerPrincipal === undefined ? {} : { ownerPrincipal: item.ownerPrincipal }),
          ...(aclPrincipals === undefined ? {} : { aclPrincipals }),
        };
        const event = await client.query(`
          INSERT INTO ${this.tables.outbox}
            (tenant_id,event_type,source_id,collection_id,record_id,record_revision,payload_json)
          VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *
        `, [input.tenantId, eventType, input.sourceId, input.collectionId, item.recordId, revision,
          JSON.stringify(payload)]);
        outbox.push(outboxFromRow(event.rows[0] as Row));
        void recordRow;
      }

      const partitionResult = await client.query(`
        UPDATE ${this.tables.partitions}
        SET watermark_json=CASE WHEN $7::boolean THEN $8::jsonb ELSE watermark_json END,
            window_start=COALESCE($9::timestamptz,window_start),window_end=COALESCE($10::timestamptz,window_end),
            page_cursor=CASE WHEN $11::boolean THEN NULL WHEN $12::boolean THEN $13 ELSE page_cursor END,
            coverage_start=CASE WHEN $14::timestamptz IS NULL THEN coverage_start
              WHEN coverage_start IS NULL THEN $14::timestamptz ELSE LEAST(coverage_start,$14::timestamptz) END,
            coverage_end=CASE WHEN $15::timestamptz IS NULL THEN coverage_end
              WHEN coverage_end IS NULL THEN $15::timestamptz ELSE GREATEST(coverage_end,$15::timestamptz) END,
            truncated=COALESCE($16,truncated),refused=COALESCE($17,refused),
            status=CASE WHEN COALESCE($17,FALSE) THEN 'refused' WHEN $11 THEN 'complete' ELSE 'syncing' END,
            lease_owner=CASE WHEN $18::boolean OR $11::boolean OR COALESCE($17,FALSE) THEN NULL ELSE lease_owner END,
            lease_expires_at=CASE WHEN $18::boolean OR $11::boolean OR COALESCE($17,FALSE) THEN NULL ELSE lease_expires_at END,
            retry_count=0,next_retry_at=NULL,last_error_code=NULL,updated_at=NOW()
        WHERE tenant_id=$1 AND source_id=$2 AND collection_id=$3 AND partition_key=$4
          AND lease_owner=$5 AND lease_fence=$6 AND lease_expires_at > NOW() AND status='syncing'
        RETURNING *
      `, [input.tenantId, input.sourceId, input.collectionId, input.partitionKey, input.leaseOwner, input.leaseFence,
        checkpoint.watermark !== undefined, checkpoint.watermark === undefined ? null : JSON.stringify(checkpoint.watermark),
        windowStart ?? null, windowEnd ?? null, checkpoint.complete ?? false,
        checkpoint.pageCursor !== undefined, checkpoint.pageCursor ?? null, coverageStart ?? null, coverageEnd ?? null,
        checkpoint.truncated ?? null, checkpoint.refused ?? null, checkpoint.releaseLease ?? false]);
      if (!partitionResult.rows[0]) throw new ContextStoreError('CONTEXT_LEASE_LOST');
      return { partition: partitionFromRow(partitionResult.rows[0]), created, revised, unchanged, outbox };
    });
  }

  async listCurrentExternalRecordIds(
    tenantId: string,
    sourceId: string,
    collectionId: string,
  ): Promise<string[]> {
    assertScope(tenantId, sourceId, collectionId);
    const result = await this.options.pool.query(`
      SELECT external_record_id FROM ${this.tables.records}
      WHERE tenant_id=$1 AND source_id=$2 AND collection_id=$3
        AND deleted=FALSE AND revoked=FALSE
      ORDER BY external_record_id
    `, [tenantId, sourceId, collectionId]);
    return result.rows.map(row => String(row.external_record_id));
  }

  async getRecord(tenantId: string, sourceId: string, collectionId: string, recordId: string): Promise<ContextRecordWithRevision | null> {
    assertScope(tenantId, sourceId, collectionId);
    assertContextId(recordId);
    const result = await this.options.pool.query(`
      SELECT r.*,v.revision AS revision_revision,v.content_hash AS revision_content_hash,
        v.content_json AS revision_content_json,v.metadata_json AS revision_metadata_json,
        v.deleted AS revision_deleted,v.revoked AS revision_revoked,
        v.source_updated_at AS revision_source_updated_at,v.observed_at AS revision_observed_at,
        v.entity_type AS revision_entity_type,v.record_kind AS revision_record_kind,
        v.native_id AS revision_native_id,v.occurred_at AS revision_occurred_at,
        v.source_event_id AS revision_source_event_id,v.owner_principal AS revision_owner_principal,
        v.acl_principals AS revision_acl_principals,v.created_at AS revision_created_at
      FROM ${this.tables.records} r JOIN ${this.tables.revisions} v
        ON v.tenant_id=r.tenant_id AND v.source_id=r.source_id AND v.collection_id=r.collection_id
        AND v.record_id=r.record_id AND v.revision=r.current_revision
      WHERE r.tenant_id=$1 AND r.source_id=$2 AND r.collection_id=$3 AND r.record_id=$4
    `, [tenantId, sourceId, collectionId, recordId]);
    if (!result.rows[0]) return null;
    const row = result.rows[0] as Row;
    return {
      record: recordFromRow(row),
      revision: revisionFromRow({
        ...row,
        revision: row.revision_revision,
        content_hash: row.revision_content_hash,
        content_json: row.revision_content_json,
        metadata_json: row.revision_metadata_json,
        deleted: row.revision_deleted,
        revoked: row.revision_revoked,
        source_updated_at: row.revision_source_updated_at,
        observed_at: row.revision_observed_at,
        entity_type: row.revision_entity_type,
        record_kind: row.revision_record_kind,
        native_id: row.revision_native_id,
        occurred_at: row.revision_occurred_at,
        source_event_id: row.revision_source_event_id,
        owner_principal: row.revision_owner_principal,
        acl_principals: row.revision_acl_principals,
        created_at: row.revision_created_at,
      }),
    };
  }

  async countUnreadableRecords(
    tenantId: string,
    sourceId: string,
    collectionId: string,
  ): Promise<number> {
    assertScope(tenantId, sourceId, collectionId);
    const result = await this.options.pool.query(`
      SELECT COUNT(*)::integer AS count FROM ${this.tables.records}
      WHERE tenant_id=$1 AND source_id=$2 AND collection_id=$3
        AND deleted=FALSE AND revoked=FALSE AND metadata_json->>'unreadable'='true'
    `, [tenantId, sourceId, collectionId]);
    return Number((result.rows[0] as Row | undefined)?.count ?? 0);
  }

  async listEvidence(
    tenantId: string, sourceId: string, collectionId: string, limit = 100,
  ): Promise<ContextEvidence[]> {
    assertScope(tenantId, sourceId, collectionId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new ContextStoreError('CONTEXT_INVALID');
    const result = await this.options.pool.query(`
      SELECT e.* FROM ${this.tables.evidence} e JOIN ${this.tables.records} r
        ON r.tenant_id=e.tenant_id AND r.source_id=e.source_id AND r.collection_id=e.collection_id
        AND r.record_id=e.record_id AND r.current_revision=e.revision
      WHERE e.tenant_id=$1 AND e.source_id=$2 AND e.collection_id=$3
        AND r.deleted=FALSE AND r.revoked=FALSE
      ORDER BY e.record_id,e.evidence_id
      LIMIT $4
    `, [tenantId, sourceId, collectionId, limit]);
    return result.rows.map(evidenceFromRow);
  }

  async getEvidence(
    tenantId: string, sourceId: string, collectionId: string, recordId: string, revision?: number,
  ): Promise<ContextEvidence[]> {
    assertScope(tenantId, sourceId, collectionId);
    assertContextId(recordId);
    if (revision !== undefined) assertContextRevision(revision);
    const result = revision === undefined
      ? await this.options.pool.query(`
          SELECT e.* FROM ${this.tables.evidence} e JOIN ${this.tables.records} r
            ON r.tenant_id=e.tenant_id AND r.source_id=e.source_id AND r.collection_id=e.collection_id
            AND r.record_id=e.record_id AND r.current_revision=e.revision
          WHERE e.tenant_id=$1 AND e.source_id=$2 AND e.collection_id=$3 AND e.record_id=$4
            AND r.deleted=FALSE AND r.revoked=FALSE
          ORDER BY e.evidence_id
        `, [tenantId, sourceId, collectionId, recordId])
      : await this.options.pool.query(`
          SELECT e.* FROM ${this.tables.evidence} e JOIN ${this.tables.records} r
            ON r.tenant_id=e.tenant_id AND r.source_id=e.source_id AND r.collection_id=e.collection_id
            AND r.record_id=e.record_id
          WHERE e.tenant_id=$1 AND e.source_id=$2 AND e.collection_id=$3 AND e.record_id=$4 AND e.revision=$5
            AND r.deleted=FALSE AND r.revoked=FALSE
          ORDER BY e.evidence_id
        `, [tenantId, sourceId, collectionId, recordId, revision]);
    return result.rows.map(evidenceFromRow);
  }

  async getOutboxCursor(tenantId: string): Promise<ContextOutboxCursor> {
    assertScope(tenantId);
    const result = await this.options.pool.query(
      `SELECT COALESCE(MAX(seq),0) AS seq FROM ${this.tables.outbox} WHERE tenant_id=$1`, [tenantId],
    );
    return { tenantId, seq: String(result.rows[0]?.seq ?? '0') };
  }

  async listOutbox(tenantId: string, afterSeq = '0', limit = 100): Promise<ContextOutboxEvent[]> {
    assertScope(tenantId);
    assertContextBigIntDecimal(afterSeq);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new ContextStoreError('CONTEXT_INVALID');
    }
    const result = await this.options.pool.query(`
      SELECT * FROM ${this.tables.outbox}
      WHERE tenant_id=$1 AND seq > $2 ORDER BY seq ASC LIMIT $3
    `, [tenantId, afterSeq, limit]);
    return result.rows.map(outboxFromRow);
  }

  private async throwVersionOrNotFound(table: string, tenantId: string, sourceId: string): Promise<never> {
    const current = await this.options.pool.query(
      `SELECT 1 FROM ${table} WHERE tenant_id=$1 AND source_id=$2`, [tenantId, sourceId],
    );
    throw new ContextStoreError(current.rows[0] ? 'CONTEXT_VERSION_CONFLICT' : 'CONTEXT_NOT_FOUND');
  }

  private async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
