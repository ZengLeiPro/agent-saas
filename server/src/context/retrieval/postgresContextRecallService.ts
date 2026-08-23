import { Buffer } from 'node:buffer';

import { contextTableNames, type ContextPgPool } from '../store/index.js';
import type { ContextObject } from '../store/types.js';
import type { ContextRecallService } from './ports.js';
import type {
  ContextRecallEvidence,
  ContextRecallFreshness,
  ContextRecallGetRequest,
  ContextRecallGetResult,
  ContextRecallHit,
  ContextRecallSearchRequest,
  ContextRecallSearchResult,
} from './types.js';

type Row = Record<string, unknown>;

interface RecallIdPayload {
  t: string;
  s: string;
  c: string;
  r: string;
  v: number;
}

export interface PgContextRecallServiceOptions {
  pool: ContextPgPool;
  tablePrefix?: string;
}

/**
 * PostgreSQL baseline recall. It intentionally uses only exact matches, ILIKE and
 * source-time filters; vector/embedding availability cannot affect authorization.
 */
export class PgContextRecallService implements ContextRecallService {
  private readonly tables;

  constructor(private readonly options: PgContextRecallServiceOptions) {
    this.tables = contextTableNames(options.tablePrefix);
  }

  async search(request: ContextRecallSearchRequest): Promise<ContextRecallSearchResult> {
    throwIfAborted(request.signal);
    const assignmentVersions = scopeVersions(request.scope.collections);
    if (assignmentVersions.size === 0) return { hits: [], degraded: false };
    const collectionIds = [...assignmentVersions.keys()];
    const escapedPattern = `%${escapeLike(request.query)}%`;
    const kinds = request.filters.kinds?.length ? [...request.filters.kinds] : null;
    const sources = request.filters.sources?.length ? [...request.filters.sources] : null;
    const from = request.filters.timeRange?.from ?? null;
    const to = request.filters.timeRange?.to ?? null;

    const result = await this.options.pool.query(`
      SELECT r.tenant_id,r.source_id,r.collection_id,r.record_id,r.current_revision,
             r.content_json,r.metadata_json,r.source_updated_at,r.observed_at,
             s.kind AS source_kind,s.display_name AS source_display_name,
             COALESCE(NULLIF(r.metadata_json->>'kind',''),s.kind) AS record_kind,
             COALESCE(sync_health.degraded,FALSE) AS sync_degraded,
             sync_health.sync_as_of,
             COALESCE(evidence.items,'[]'::jsonb) AS evidence_items,
             CASE
               WHEN r.record_id=$3 OR r.external_record_id=$3 THEN 1
               WHEN r.content_json::text=$3 OR r.metadata_json::text=$3 THEN 2
               ELSE 3
             END AS route_rank
      FROM ${this.tables.records} r
      JOIN ${this.tables.sources} s
        ON s.tenant_id=r.tenant_id AND s.source_id=r.source_id
      JOIN ${this.tables.collections} c
        ON c.tenant_id=r.tenant_id AND c.source_id=r.source_id AND c.collection_id=r.collection_id
      LEFT JOIN LATERAL (
        SELECT BOOL_OR(p.refused OR p.truncated OR p.status IN ('retry_wait','refused')) AS degraded,
               MAX(p.updated_at) AS sync_as_of
        FROM ${this.tables.partitions} p
        WHERE p.tenant_id=r.tenant_id AND p.source_id=r.source_id AND p.collection_id=r.collection_id
      ) sync_health ON TRUE
      LEFT JOIN LATERAL (
        SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
          'evidenceId',e.evidence_id,'kind',e.kind,'data',e.data_json
        ) ORDER BY e.evidence_id) AS items
        FROM ${this.tables.evidence} e
        WHERE e.tenant_id=r.tenant_id AND e.source_id=r.source_id
          AND e.collection_id=r.collection_id AND e.record_id=r.record_id
          AND e.revision=r.current_revision
      ) evidence ON TRUE
      WHERE r.tenant_id=$1 AND r.collection_id=ANY($2::text[])
        AND r.deleted=FALSE AND r.revoked=FALSE
        AND s.status='active' AND c.status='active'
        AND (
          r.record_id=$3 OR r.external_record_id=$3
          OR r.content_json::text ILIKE $4 ESCAPE '\\'
          OR r.metadata_json::text ILIKE $4 ESCAPE '\\'
        )
        AND ($5::text[] IS NULL OR COALESCE(NULLIF(r.metadata_json->>'kind',''),s.kind)=ANY($5::text[]))
        AND ($6::text[] IS NULL OR r.source_id=ANY($6::text[]) OR s.kind=ANY($6::text[]))
        AND ($7::timestamptz IS NULL OR COALESCE(r.source_updated_at,r.observed_at) >= $7)
        AND ($8::timestamptz IS NULL OR COALESCE(r.source_updated_at,r.observed_at) < $8)
      ORDER BY route_rank,COALESCE(r.source_updated_at,r.observed_at) DESC,r.record_id
      LIMIT $9
    `, [request.subject.tenantId, collectionIds, request.query, escapedPattern, kinds, sources, from, to, request.limit]);
    throwIfAborted(request.signal);

    const hits = result.rows.map(row => this.hitFromRow(row as Row, assignmentVersions));
    const scopeHealth = await this.loadScopeHealth(request.subject.tenantId, collectionIds);
    return {
      hits,
      degraded: scopeHealth.reasons.length > 0,
      ...(scopeHealth.reasons.length ? { degradationReasons: scopeHealth.reasons } : {}),
    };
  }

  async get(request: ContextRecallGetRequest): Promise<ContextRecallGetResult> {
    throwIfAborted(request.signal);
    const id = decodeRecallId(request.id);
    if (!id || id.t !== request.subject.tenantId) return { hit: null, degraded: false };
    const assignmentVersions = scopeVersions(request.scope.collections);
    if (!assignmentVersions.has(id.c)) return { hit: null, degraded: false };

    const result = await this.options.pool.query(`
      SELECT r.tenant_id,r.source_id,r.collection_id,r.record_id,r.current_revision,
             r.content_json,r.metadata_json,r.source_updated_at,r.observed_at,
             s.kind AS source_kind,s.display_name AS source_display_name,
             COALESCE(NULLIF(r.metadata_json->>'kind',''),s.kind) AS record_kind,
             COALESCE(sync_health.degraded,FALSE) AS sync_degraded,
             sync_health.sync_as_of,
             COALESCE(evidence.items,'[]'::jsonb) AS evidence_items,
             1 AS route_rank
      FROM ${this.tables.records} r
      JOIN ${this.tables.sources} s
        ON s.tenant_id=r.tenant_id AND s.source_id=r.source_id
      JOIN ${this.tables.collections} c
        ON c.tenant_id=r.tenant_id AND c.source_id=r.source_id AND c.collection_id=r.collection_id
      LEFT JOIN LATERAL (
        SELECT BOOL_OR(p.refused OR p.truncated OR p.status IN ('retry_wait','refused')) AS degraded,
               MAX(p.updated_at) AS sync_as_of
        FROM ${this.tables.partitions} p
        WHERE p.tenant_id=r.tenant_id AND p.source_id=r.source_id AND p.collection_id=r.collection_id
      ) sync_health ON TRUE
      LEFT JOIN LATERAL (
        SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
          'evidenceId',e.evidence_id,'kind',e.kind,'data',e.data_json
        ) ORDER BY e.evidence_id) AS items
        FROM ${this.tables.evidence} e
        WHERE e.tenant_id=r.tenant_id AND e.source_id=r.source_id
          AND e.collection_id=r.collection_id AND e.record_id=r.record_id
          AND e.revision=r.current_revision
      ) evidence ON TRUE
      WHERE r.tenant_id=$1 AND r.source_id=$2 AND r.collection_id=$3 AND r.record_id=$4
        AND r.current_revision=$5 AND r.deleted=FALSE AND r.revoked=FALSE
        AND s.status='active' AND c.status='active'
    `, [id.t, id.s, id.c, id.r, id.v]);
    throwIfAborted(request.signal);
    if (!result.rows[0]) return { hit: null, degraded: false };
    const hit = this.hitFromRow(result.rows[0] as Row, assignmentVersions);
    const degraded = Boolean((result.rows[0] as Row).sync_degraded);
    return {
      hit,
      degraded,
      ...(degraded ? { degradationReasons: ['context_sync_incomplete'] } : {}),
    };
  }

  private async loadScopeHealth(tenantId: string, collectionIds: string[]): Promise<{ reasons: string[] }> {
    const result = await this.options.pool.query(`
      SELECT
        BOOL_OR(refused OR status='refused') AS refused,
        BOOL_OR(truncated) AS truncated,
        BOOL_OR(status='retry_wait') AS retry_wait
      FROM ${this.tables.partitions}
      WHERE tenant_id=$1 AND collection_id=ANY($2::text[])
    `, [tenantId, collectionIds]);
    const row = result.rows[0] as Row | undefined;
    const reasons: string[] = [];
    if (row?.refused) reasons.push('context_sync_refused');
    if (row?.truncated) reasons.push('context_sync_truncated');
    if (row?.retry_wait) reasons.push('context_sync_retry_wait');
    return { reasons };
  }

  private hitFromRow(row: Row, assignmentVersions: ReadonlyMap<string, number>): ContextRecallHit {
    const tenantId = String(row.tenant_id);
    const sourceId = String(row.source_id);
    const collectionId = String(row.collection_id);
    const recordId = String(row.record_id);
    const revision = Number(row.current_revision);
    const metadata = objectValue(row.metadata_json);
    const sourceUpdatedAt = optionalIso(row.source_updated_at);
    const observedAt = optionalIso(row.observed_at);
    const syncAsOf = optionalIso(row.sync_as_of);
    const freshness: ContextRecallFreshness = row.sync_degraded
      ? { status: 'stale', ...(syncAsOf ? { asOf: syncAsOf } : {}), reason: 'context_sync_incomplete' }
      : syncAsOf
        ? { status: 'fresh', asOf: syncAsOf }
        : { status: 'unknown', ...(observedAt ? { asOf: observedAt } : {}), reason: 'context_sync_status_unavailable' };
    return {
      id: encodeRecallId({ t: tenantId, s: sourceId, c: collectionId, r: recordId, v: revision }),
      collectionId,
      assignmentVersion: assignmentVersions.get(collectionId)!,
      kind: String(row.record_kind),
      content: contentText(row.content_json),
      score: row.route_rank === 1 ? 1 : row.route_rank === 2 ? 0.8 : 0.5,
      source: {
        sourceId,
        kind: String(row.source_kind),
        displayName: String(row.source_display_name),
        ...(stringField(metadata, 'url') ? { url: stringField(metadata, 'url') } : {}),
      },
      time: {
        ...(stringField(metadata, 'occurredAt') ? { occurredAt: stringField(metadata, 'occurredAt') } : {}),
        ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
        ...(observedAt ? { observedAt } : {}),
      },
      freshness,
      route: { strategy: 'postgres_exact_ilike', stages: row.route_rank === 1 ? ['exact'] : ['ilike'] },
      derived: metadata.derived === true,
      evidence: evidenceFromRow(row, { sourceId, collectionId, recordId, revision }),
    };
  }
}

function scopeVersions(collections: readonly { collectionId: string; assignmentVersion: number }[]): Map<string, number> {
  const versions = new Map<string, number>();
  for (const collection of collections) {
    const current = versions.get(collection.collectionId);
    if (current === undefined || collection.assignmentVersion > current) {
      versions.set(collection.collectionId, collection.assignmentVersion);
    }
  }
  return versions;
}

function evidenceFromRow(row: Row, identity: {
  sourceId: string;
  collectionId: string;
  recordId: string;
  revision: number;
}): ContextRecallEvidence[] {
  const raw = typeof row.evidence_items === 'string' ? JSON.parse(row.evidence_items) : row.evidence_items;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const data = objectValue(record.data);
    return [{
      evidenceId: String(record.evidenceId),
      sourceId: identity.sourceId,
      collectionId: identity.collectionId,
      recordId: identity.recordId,
      revision: identity.revision,
      kind: String(record.kind),
      ...(stringField(data, 'excerpt') ? { excerpt: stringField(data, 'excerpt') } : {}),
      ...(stringField(data, 'url') ? { url: stringField(data, 'url') } : {}),
      ...(stringField(data, 'occurredAt') ? { occurredAt: stringField(data, 'occurredAt') } : {}),
    }];
  });
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function objectValue(value: unknown): ContextObject {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as ContextObject : {};
}

function stringField(value: ContextObject, key: string): string | undefined {
  return typeof value[key] === 'string' && value[key].trim() ? value[key] : undefined;
}

function optionalIso(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`);
}

function encodeRecallId(value: RecallIdPayload): string {
  return `ctx1.${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
}

function decodeRecallId(value: string): RecallIdPayload | null {
  if (!value.startsWith('ctx1.') || value.length > 512) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value.slice(5), 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof parsed.t !== 'string' || typeof parsed.s !== 'string' || typeof parsed.c !== 'string'
      || typeof parsed.r !== 'string' || !Number.isSafeInteger(parsed.v) || Number(parsed.v) < 1) return null;
    return { t: parsed.t, s: parsed.s, c: parsed.c, r: parsed.r, v: Number(parsed.v) };
  } catch {
    return null;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('CONTEXT_RECALL_ABORTED');
}
