import { Buffer } from 'node:buffer';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { tableNames as contextPhase23TableNames } from '../phase23/migration.js';
import { contextTableNames, contextTablePrefix, type ContextPgPool } from '../store/index.js';
import type { ContextObject } from '../store/types.js';
import type { ContextRecallService } from './ports.js';
import {
  ContextSourceAuthorizationRegistry,
  contextSourceLocatorFromRow,
  type ContextSourceAuthorizationDenyReason,
} from './sourceAuthorization.js';
import { contextDisplayKind, normalizeContextFilterValues } from './taxonomy.js';
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
  idSigningKey?: string;
  /** Optional for legacy chat/wiki/minutes compatibility; taskboard fails closed without it. */
  sourceAuthorizationRegistry?: ContextSourceAuthorizationRegistry;
}

const PROCESS_CONTEXT_ID_SIGNING_KEY = randomBytes(32).toString('base64url');
const MIN_RECALL_CANDIDATE_SCAN = 200;
const MAX_RECALL_CANDIDATE_SCAN = 1_000;

/**
 * PostgreSQL baseline recall. It intentionally uses only exact matches, ILIKE and
 * source-time filters; vector/embedding availability cannot affect authorization.
 */
export class PgContextRecallService implements ContextRecallService {
  private readonly tables;
  private readonly derivedTables;
  private readonly agentDwsAccountsTable: string;
  private readonly idSigningKey: string;

  constructor(private readonly options: PgContextRecallServiceOptions) {
    const tablePrefix = contextTablePrefix(options.tablePrefix);
    this.tables = contextTableNames(tablePrefix);
    this.derivedTables = contextPhase23TableNames(tablePrefix);
    this.agentDwsAccountsTable = `${tablePrefix}_agent_dws_accounts`;
    this.idSigningKey = options.idSigningKey?.trim() || PROCESS_CONTEXT_ID_SIGNING_KEY;
  }

  async search(request: ContextRecallSearchRequest): Promise<ContextRecallSearchResult> {
    throwIfAborted(request.signal);
    const assignmentVersions = scopeVersions(request.scope.collections);
    if (assignmentVersions.size === 0) return { hits: [], degraded: false };
    const collectionIds = [...assignmentVersions.keys()];
    const escapedPattern = `%${escapeLike(request.query.normalize('NFKC'))}%`;
    const kinds = normalizeContextFilterValues(request.filters.kinds);
    const sources = normalizeContextFilterValues(request.filters.sources);
    const from = request.filters.timeRange?.from ?? null;
    const to = request.filters.timeRange?.to ?? null;
    const scanLimit = Math.min(
      MAX_RECALL_CANDIDATE_SCAN,
      Math.max(MIN_RECALL_CANDIDATE_SCAN, request.limit * 20),
    );

    const result = await this.options.pool.query(`
      SELECT r.tenant_id,r.source_id,r.collection_id,r.record_id,r.current_revision,
             r.content_json,r.metadata_json,r.source_updated_at,r.observed_at,
             s.kind AS source_kind,s.display_name AS source_display_name,c.external_key AS collection_external_key,
             r.deleted,r.entity_type,r.native_id,r.occurred_at,r.source_event_id,r.owner_principal,r.acl_principals,
             COALESCE(r.record_kind,NULLIF(r.metadata_json->>'kind',''),s.kind) AS record_kind,
             COALESCE(sync_health.degraded,FALSE) AS sync_degraded,
             sync_health.sync_as_of,
             COALESCE(evidence.items,'[]'::jsonb) AS evidence_items,
             COALESCE(derived_context.items,'[]'::jsonb) AS derived_items,
             COALESCE(derived_context.matches_query,FALSE) AS derived_match,
             CASE
               WHEN r.record_id=$3 OR r.external_record_id=$3 THEN 1
               WHEN r.content_json::text=$3 OR r.metadata_json::text=$3 THEN 2
               WHEN COALESCE(derived_context.matches_query,FALSE) THEN 3
               ELSE 4
             END AS route_rank
      FROM ${this.tables.records} r
      JOIN ${this.tables.sources} s
        ON s.tenant_id=r.tenant_id AND s.source_id=r.source_id
      LEFT JOIN ${this.agentDwsAccountsTable} a
        ON a.tenant_id=r.tenant_id AND a.account_id=s.config_json->>'accountId'
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
      LEFT JOIN LATERAL (
        SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
          'itemId',i.item_id,'itemType',i.item_type,'semanticKey',i.semantic_key,
          'value',i.value_json->'value','authority',i.authority,'conflictStatus',i.conflict_status,
          'validFrom',i.valid_from,'validTo',i.valid_to,
          'evidence',JSONB_BUILD_OBJECT('sourceId',ie.source_id,'collectionId',ie.collection_id,
            'recordId',ie.record_id,'recordRevision',ie.record_revision,'evidenceId',ie.evidence_id)
        ) ORDER BY CASE i.authority WHEN 'authoritative' THEN 3 WHEN 'advisory' THEN 2 ELSE 1 END DESC,
          i.semantic_key,i.item_id) AS items,
          BOOL_OR(i.search_text ILIKE $4 ESCAPE '\\') AS matches_query
        FROM ${this.derivedTables.derivedItems} i
        JOIN ${this.derivedTables.itemEvidence} ie ON ie.tenant_id=i.tenant_id
          AND ie.generation=i.generation AND ie.item_id=i.item_id AND ie.revoked=FALSE
          AND ie.source_id=r.source_id AND ie.collection_id=r.collection_id
          AND ie.record_id=r.record_id AND ie.record_revision=r.current_revision
        WHERE i.tenant_id=r.tenant_id AND i.lifecycle='active' AND i.review_status='confirmed'
          AND i.valid_from<=NOW() AND (i.valid_to IS NULL OR i.valid_to>NOW())
          AND (i.derivation='source' OR i.owner_principal IS NULL OR i.owner_principal=$10)
          AND NOT EXISTS (
            SELECT 1 FROM ${this.derivedTables.itemEvidence} other
            WHERE other.tenant_id=i.tenant_id AND other.generation=i.generation AND other.item_id=i.item_id
              AND (other.revoked=TRUE OR other.source_id<>r.source_id OR other.collection_id<>r.collection_id
                OR other.record_id<>r.record_id OR other.record_revision<>r.current_revision)
          )
          AND NOT EXISTS (
            SELECT 1 FROM ${this.derivedTables.reviews} rejected
            WHERE rejected.tenant_id=i.tenant_id AND rejected.review_status='rejected' AND rejected.revoked=FALSE
              AND rejected.comment IS NOT NULL AND PG_INPUT_IS_VALID(rejected.comment,'jsonb')
              AND rejected.comment::jsonb->>'rejectFingerprint'=i.value_json->>'valueFingerprint'
              AND (rejected.comment::jsonb #>> '{scope,type}'='org'
                OR rejected.comment::jsonb #>> '{scope,personId}'=$10)
          )
      ) derived_context ON TRUE
      WHERE r.tenant_id=$1 AND r.collection_id=ANY($2::text[])
        AND r.deleted=FALSE AND r.revoked=FALSE
        AND s.status='active' AND c.status='active'
        AND (s.kind<>'dws' OR a.status='active')
        AND NOT EXISTS (
          SELECT 1 FROM ${this.tables.partitions} auth_partition
          WHERE auth_partition.tenant_id=r.tenant_id AND auth_partition.source_id=r.source_id
            AND auth_partition.collection_id=r.collection_id
            AND (auth_partition.refused=TRUE OR auth_partition.status='refused')
        )
        ${chatPolicySql('r', 's', 'c', 'a')}
        AND (
          r.record_id=$3 OR r.external_record_id=$3
          OR r.content_json::text ILIKE $4 ESCAPE '\\'
          OR r.metadata_json::text ILIKE $4 ESCAPE '\\'
          OR COALESCE(derived_context.matches_query,FALSE)
        )
        AND ($5::text[] IS NULL
          OR LOWER(NORMALIZE(COALESCE(r.entity_type,''), NFKC))=ANY($5::text[])
          OR LOWER(NORMALIZE(COALESCE(r.record_kind,NULLIF(r.metadata_json->>'kind',''),s.kind), NFKC))=ANY($5::text[])
          OR LOWER(NORMALIZE(COALESCE(r.metadata_json->>'eventType',r.metadata_json->>'event_type',''), NFKC))=ANY($5::text[]))
        AND ($6::text[] IS NULL
          OR LOWER(NORMALIZE(r.source_id, NFKC))=ANY($6::text[])
          OR LOWER(NORMALIZE(s.kind, NFKC))=ANY($6::text[])
          OR LOWER(NORMALIZE(r.collection_id, NFKC))=ANY($6::text[])
          OR LOWER(NORMALIZE(c.external_key, NFKC))=ANY($6::text[]))
        AND ($7::timestamptz IS NULL OR COALESCE(r.occurred_at,r.source_updated_at,r.observed_at) >= $7)
        AND ($8::timestamptz IS NULL OR COALESCE(r.occurred_at,r.source_updated_at,r.observed_at) < $8)
      ORDER BY route_rank,COALESCE(r.occurred_at,r.source_updated_at,r.observed_at) DESC,r.record_id
      LIMIT $9
    `, [request.subject.tenantId, collectionIds, request.query, escapedPattern, kinds, sources, from, to,
      scanLimit + 1, request.subject.userId]);
    throwIfAborted(request.signal);

    const fetchedRows = result.rows as Row[];
    const candidateRows = fetchedRows.slice(0, scanLimit);
    const authorization = await this.authorizeNativeRows(request.subject, candidateRows);
    const hits = authorization.rows.slice(0, request.limit)
      .map(row => this.hitFromRow(row, assignmentVersions));
    const scopeHealth = await this.loadScopeHealth(request.subject.tenantId, collectionIds);
    const scanCapped = fetchedRows.length > scanLimit && hits.length < request.limit;
    const reasons = [...new Set([
      ...scopeHealth.reasons,
      ...authorization.reasons,
      ...(scanCapped ? ['context_candidate_scan_limit'] : []),
    ])];
    return {
      hits,
      degraded: reasons.length > 0,
      ...(reasons.length ? { degradationReasons: reasons } : {}),
      diagnostics: { normalizedFilters: { kinds: kinds ?? [], sources: sources ?? [] } },
    };
  }

  async get(request: ContextRecallGetRequest): Promise<ContextRecallGetResult> {
    throwIfAborted(request.signal);
    const id = decodeRecallId(request.id, this.idSigningKey);
    if (!id || id.t !== request.subject.tenantId) return { hit: null, degraded: false };
    const assignmentVersions = scopeVersions(request.scope.collections);
    if (!assignmentVersions.has(id.c)) return { hit: null, degraded: false };

    const result = await this.options.pool.query(`
      SELECT v.tenant_id,v.source_id,v.collection_id,v.record_id,v.revision AS current_revision,
             v.content_json,v.metadata_json,v.source_updated_at,v.observed_at,
             s.kind AS source_kind,s.display_name AS source_display_name,c.external_key AS collection_external_key,
             v.deleted,v.entity_type,v.native_id,v.occurred_at,v.source_event_id,
             r.owner_principal,r.acl_principals,
             COALESCE(v.record_kind,NULLIF(v.metadata_json->>'kind',''),s.kind) AS record_kind,
             COALESCE(sync_health.degraded,FALSE) AS sync_degraded,
             sync_health.sync_as_of,
             COALESCE(evidence.items,'[]'::jsonb) AS evidence_items,
             COALESCE(derived_context.items,'[]'::jsonb) AS derived_items,
             FALSE AS derived_match,
             1 AS route_rank
      FROM ${this.tables.records} r
      JOIN ${this.tables.revisions} v
        ON v.tenant_id=r.tenant_id AND v.source_id=r.source_id
          AND v.collection_id=r.collection_id AND v.record_id=r.record_id AND v.revision=$5
      JOIN ${this.tables.sources} s
        ON s.tenant_id=r.tenant_id AND s.source_id=r.source_id
      LEFT JOIN ${this.agentDwsAccountsTable} a
        ON a.tenant_id=r.tenant_id AND a.account_id=s.config_json->>'accountId'
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
        WHERE e.tenant_id=v.tenant_id AND e.source_id=v.source_id
          AND e.collection_id=v.collection_id AND e.record_id=v.record_id
          AND e.revision=v.revision
      ) evidence ON TRUE
      LEFT JOIN LATERAL (
        SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
          'itemId',i.item_id,'itemType',i.item_type,'semanticKey',i.semantic_key,
          'value',i.value_json->'value','authority',i.authority,'conflictStatus',i.conflict_status,
          'validFrom',i.valid_from,'validTo',i.valid_to,
          'evidence',JSONB_BUILD_OBJECT('sourceId',ie.source_id,'collectionId',ie.collection_id,
            'recordId',ie.record_id,'recordRevision',ie.record_revision,'evidenceId',ie.evidence_id)
        ) ORDER BY CASE i.authority WHEN 'authoritative' THEN 3 WHEN 'advisory' THEN 2 ELSE 1 END DESC,
          i.semantic_key,i.item_id) AS items
        FROM ${this.derivedTables.derivedItems} i
        JOIN ${this.derivedTables.itemEvidence} ie ON ie.tenant_id=i.tenant_id
          AND ie.generation=i.generation AND ie.item_id=i.item_id AND ie.revoked=FALSE
          AND ie.source_id=v.source_id AND ie.collection_id=v.collection_id
          AND ie.record_id=v.record_id AND ie.record_revision=v.revision
        WHERE i.tenant_id=v.tenant_id AND i.lifecycle='active' AND i.review_status='confirmed'
          AND i.valid_from<=NOW() AND (i.valid_to IS NULL OR i.valid_to>NOW())
          AND (i.derivation='source' OR i.owner_principal IS NULL OR i.owner_principal=$6)
          AND NOT EXISTS (
            SELECT 1 FROM ${this.derivedTables.itemEvidence} other
            WHERE other.tenant_id=i.tenant_id AND other.generation=i.generation AND other.item_id=i.item_id
              AND (other.revoked=TRUE OR other.source_id<>v.source_id OR other.collection_id<>v.collection_id
                OR other.record_id<>v.record_id OR other.record_revision<>v.revision)
          )
          AND NOT EXISTS (
            SELECT 1 FROM ${this.derivedTables.reviews} rejected
            WHERE rejected.tenant_id=i.tenant_id AND rejected.review_status='rejected' AND rejected.revoked=FALSE
              AND rejected.comment IS NOT NULL AND PG_INPUT_IS_VALID(rejected.comment,'jsonb')
              AND rejected.comment::jsonb->>'rejectFingerprint'=i.value_json->>'valueFingerprint'
              AND (rejected.comment::jsonb #>> '{scope,type}'='org'
                OR rejected.comment::jsonb #>> '{scope,personId}'=$6)
          )
      ) derived_context ON TRUE
      WHERE r.tenant_id=$1 AND r.source_id=$2 AND r.collection_id=$3 AND r.record_id=$4
        AND r.deleted=FALSE AND r.revoked=FALSE
        AND s.status='active' AND c.status='active'
        AND (s.kind<>'dws' OR a.status='active')
        AND NOT EXISTS (
          SELECT 1 FROM ${this.tables.partitions} auth_partition
          WHERE auth_partition.tenant_id=r.tenant_id AND auth_partition.source_id=r.source_id
            AND auth_partition.collection_id=r.collection_id
            AND (auth_partition.refused=TRUE OR auth_partition.status='refused')
        )
        ${chatPolicySql('v', 's', 'c', 'a')}
    `, [id.t, id.s, id.c, id.r, id.v, request.subject.userId]);
    throwIfAborted(request.signal);
    if (!result.rows[0]) return { hit: null, degraded: false };
    const row = result.rows[0] as Row;
    const authorization = await this.authorizeNativeRows(request.subject, [row]);
    if (!authorization.rows[0]) {
      return {
        hit: null,
        degraded: authorization.reasons.length > 0,
        ...(authorization.reasons.length ? { degradationReasons: authorization.reasons } : {}),
      };
    }
    const hit = this.hitFromRow(authorization.rows[0], assignmentVersions);
    const reasons = [
      ...(row.sync_degraded ? ['context_sync_incomplete'] : []),
      ...authorization.reasons,
    ];
    return {
      hit,
      degraded: reasons.length > 0,
      ...(reasons.length ? { degradationReasons: reasons } : {}),
    };
  }

  private async authorizeNativeRows(
    subject: { tenantId: string; userId: string },
    rows: readonly Row[],
  ): Promise<{ rows: Row[]; reasons: ContextSourceAuthorizationDenyReason[] }> {
    const native = rows.map((row, index) => ({ row, index }))
      .filter(({ row }) => String(row.source_kind).toLowerCase() !== 'dws');
    if (native.length === 0) return { rows: [...rows], reasons: [] };
    const registry = this.options.sourceAuthorizationRegistry ?? new ContextSourceAuthorizationRegistry();
    const decisions = await registry.authorizeBatch(subject, native.map(({ row }) => contextSourceLocatorFromRow(row)));
    const deniedIndexes = new Set<number>();
    const reasons: ContextSourceAuthorizationDenyReason[] = [];
    decisions.forEach((decision, index) => {
      if (!decision.authorized) deniedIndexes.add(native[index]!.index);
      if (decision.reason && !reasons.includes(decision.reason)) reasons.push(decision.reason);
    });
    return { rows: rows.filter((_row, index) => !deniedIndexes.has(index)), reasons };
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
    const occurredAt = optionalIso(row.occurred_at) ?? stringField(metadata, 'occurredAt');
    const syncAsOf = optionalIso(row.sync_as_of);
    const derivedItems = jsonArray(row.derived_items);
    const sourceContent = contentText(row.content_json);
    const content = derivedItems.length > 0
      ? `${sourceContent}\n\n[已确认派生上下文；仍须以所附 Evidence 为准]\n${JSON.stringify(derivedItems)}`
      : sourceContent;
    const freshness: ContextRecallFreshness = row.sync_degraded
      ? { status: 'stale', ...(syncAsOf ? { asOf: syncAsOf } : {}), reason: 'context_sync_incomplete' }
      : syncAsOf
        ? { status: 'fresh', asOf: syncAsOf }
        : { status: 'unknown', ...(observedAt ? { asOf: observedAt } : {}), reason: 'context_sync_status_unavailable' };
    return {
      id: encodeRecallId(
        { t: tenantId, s: sourceId, c: collectionId, r: recordId, v: revision },
        this.idSigningKey,
      ),
      collectionId,
      assignmentVersion: assignmentVersions.get(collectionId)!,
      kind: String(row.record_kind),
      recordKind: String(row.record_kind),
      ...(typeof row.entity_type === 'string' && row.entity_type.trim()
        ? { entityType: contextDisplayKind(row.entity_type, row.record_kind) }
        : {}),
      content,
      score: row.route_rank === 1 ? 1 : row.route_rank === 2 ? 0.8 : row.route_rank === 3 ? 0.7 : 0.5,
      source: {
        sourceId,
        kind: String(row.source_kind),
        displayName: String(row.source_display_name),
        ...(stringField(metadata, 'url') ? { url: stringField(metadata, 'url') } : {}),
      },
      time: {
        ...(occurredAt ? { occurredAt } : {}),
        ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
        ...(observedAt ? { observedAt } : {}),
      },
      freshness,
      route: {
        strategy: 'postgres_exact_ilike_derived',
        stages: row.route_rank === 1 || row.route_rank === 2
          ? ['exact'] : row.route_rank === 3 ? ['derived'] : ['ilike'],
      },
      derived: metadata.derived === true || derivedItems.length > 0,
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
      ...(stringField(data, 'author') ? { author: stringField(data, 'author') } : {}),
      ...(stringField(data, 'url') ? { url: stringField(data, 'url') } : {}),
      ...(stringField(data, 'occurredAt') ? { occurredAt: stringField(data, 'occurredAt') } : {}),
    }];
  });
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function jsonArray(value: unknown): unknown[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed : [];
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

function chatPolicySql(
  recordAlias: string,
  sourceAlias: string,
  collectionAlias: string,
  accountAlias: string,
): string {
  // DWS retrieval reads the account row as the authorization source of truth.
  // The Context Source mirror remains operational metadata, not a security dependency.
  const policy = `(CASE WHEN ${sourceAlias}.kind='dws'
    THEN ${accountAlias}.event_policy_json #> '{contextPolicy}'
    ELSE ${sourceAlias}.config_json #> '{contextPolicy}' END)`;
  const conversation = `COALESCE(${recordAlias}.metadata_json->>'conversationId','')`;
  const occurredAtText = `${recordAlias}.metadata_json->>'occurredAt'`;
  const occurredAt = `COALESCE(
    CASE WHEN PG_INPUT_IS_VALID(${occurredAtText},'timestamp with time zone')
      THEN (${occurredAtText})::timestamptz END,
    ${recordAlias}.source_updated_at,
    ${recordAlias}.observed_at
  )`;
  const selectionAllows = (branch: 'historical' | 'realtime') => `(
    ${policy} #>> '{${branch},mode}' = 'all'
    OR (
      ${policy} #>> '{${branch},mode}' = 'selected'
      AND jsonb_typeof(${policy} #> '{${branch},conversationIds}') = 'array'
      AND (${policy} #> '{${branch},conversationIds}') ? ${conversation}
    )
  )`;
  const historicalDays = `${policy} #>> '{historical,lookbackDays}'`;
  const historical = `(
    ${selectionAllows('historical')}
    AND ${historicalDays} ~ '^[0-9]{1,3}$'
    AND (${historicalDays})::integer BETWEEN 1 AND 365
    AND ${occurredAt} >= NOW() - MAKE_INTERVAL(days => (${historicalDays})::integer)
  )`;
  const effectiveAt = `COALESCE(
    CASE WHEN ${policy} #>> '{realtime,mode}' = 'all'
      THEN ${policy} #>> '{realtimeEffectiveAt,all}'
      ELSE (${policy} #> '{realtimeEffectiveAt,conversations}') ->> ${conversation}
    END,
    ${policy} #>> '{effectiveAt}'
  )`;
  const realtimeCutoff = `CASE
    WHEN PG_INPUT_IS_VALID(${effectiveAt},'timestamp with time zone')
    THEN (${effectiveAt})::timestamptz
  END`;
  const realtime = `(
    ${selectionAllows('realtime')}
    AND ${occurredAt} >= ${realtimeCutoff}
  )`;
  // Every domain is fail-closed. Chat uses the union of time-bounded historical
  // learning and post-effective realtime listening; Wiki/minutes require their
  // explicit opt-in flags.
  return `AND CASE WHEN ${sourceAlias}.kind<>'dws' THEN TRUE ELSE CASE ${collectionAlias}.external_key
    WHEN 'chat' THEN (${historical} OR ${realtime})
    WHEN 'wiki' THEN ${policy} #>> '{wiki,enabled}' = 'true'
    WHEN 'minutes' THEN (
      ${policy} #>> '{minutes,enabled}' = 'true'
      AND ${policy} #>> '{minutes,lookbackDays}' ~ '^[0-9]{1,3}$'
      AND (${policy} #>> '{minutes,lookbackDays}')::integer BETWEEN 1 AND 365
      AND ${occurredAt} >= NOW() - MAKE_INTERVAL(
        days => (${policy} #>> '{minutes,lookbackDays}')::integer
      )
    )
    ELSE FALSE
  END END`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`);
}

function encodeRecallId(value: RecallIdPayload, signingKey: string): string {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `ctx1.${payload}.${signRecallId(payload, signingKey)}`;
}

function decodeRecallId(value: string, signingKey: string): RecallIdPayload | null {
  if (!value.startsWith('ctx1.') || value.length > 512) return null;
  try {
    const parts = value.split('.');
    if (parts.length !== 3 || parts[0] !== 'ctx1' || !parts[1] || !parts[2]) return null;
    const expected = Buffer.from(signRecallId(parts[1], signingKey));
    const actual = Buffer.from(parts[2]);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof parsed.t !== 'string' || typeof parsed.s !== 'string' || typeof parsed.c !== 'string'
      || typeof parsed.r !== 'string' || !Number.isSafeInteger(parsed.v) || Number(parsed.v) < 1) return null;
    return { t: parsed.t, s: parsed.s, c: parsed.c, r: parsed.r, v: Number(parsed.v) };
  } catch {
    return null;
  }
}

function signRecallId(payload: string, signingKey: string): string {
  return createHmac('sha256', signingKey).update(`context-recall:${payload}`).digest('base64url');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('CONTEXT_RECALL_ABORTED');
}
