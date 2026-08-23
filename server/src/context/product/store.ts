import { createHash } from 'node:crypto';

import type { PoolClient, QueryResultRow } from 'pg';

import { tableNames, type ContextPhase23TableNames } from '../phase23/migration.js';
import { PgRelationReadStore } from '../relations/pgReadStore.js';
import { contextTableNames, contextTablePrefix, type ContextPgPool, type ContextTableNames } from '../store/migration.js';
import type {
  DerivedEvidenceRef,
  DerivedReviewAuthorizationSnapshot,
  DerivedScope,
} from '../derived/types.js';
import type { ContextJson, ContextObject } from '../store/types.js';
import {
  ContextProductError,
  type ContextProductStore,
  type ProductCorrectionCandidate,
  type ProductEntityCandidate,
  type ProductEvidenceCandidate,
  type ProductItemCandidate,
  type ProductReviewCandidate,
  type ProductStoreListInput,
  type ProductRecordLocator,
  type ProductReviewAuthorizationItemSnapshot,
  type ProductReviewAuthorizationSnapshot,
  type ProductTimelineCandidate,
  type ProductRelationCandidate,
} from './types.js';

/** Candidate-only PG adapter. Every returned row is still authorization='unchecked' at the service boundary. */
export class PgContextProductStore implements ContextProductStore {
  private readonly derived: ContextPhase23TableNames;
  private readonly base: ContextTableNames;
  private readonly relations: PgRelationReadStore;

  constructor(private readonly pool: ContextPgPool, tablePrefix?: string) {
    const prefix = contextTablePrefix(tablePrefix);
    this.derived = tableNames(prefix);
    this.base = contextTableNames(prefix);
    this.relations = new PgRelationReadStore(pool, prefix);
  }

  async listTimeline(input: ProductStoreListInput): Promise<ProductTimelineCandidate[]> {
    validateList(input);
    if (input.collectionIds.length === 0) return [];
    const occurredAt = `COALESCE(v.occurred_at,v.source_updated_at,v.observed_at,v.created_at)`;
    const result = await this.pool.query(`SELECT r.source_id,r.collection_id,r.record_id,r.current_revision,
        r.record_kind,r.metadata_json,r.owner_principal,r.acl_principals,r.source_event_id,r.deleted,r.revoked,
        r.updated_at,v.revision AS record_revision,v.content_json,v.entity_type,${occurredAt} AS occurred_at,
        s.kind AS source_kind,en.entity_id,en.display_name,
        EXISTS (SELECT 1 FROM ${this.base.partitions} p WHERE p.tenant_id=r.tenant_id
          AND p.source_id=r.source_id AND p.collection_id=r.collection_id
          AND (p.refused=TRUE OR p.status='refused')) AS refused,
        jsonb_agg(jsonb_build_object('sourceId',ev.source_id,'collectionId',ev.collection_id,
          'recordId',ev.record_id,'recordRevision',ev.revision,'evidenceId',ev.evidence_id)
          ORDER BY ev.evidence_id) AS evidence_json
      FROM ${this.base.records} r
      JOIN ${this.base.revisions} v ON v.tenant_id=r.tenant_id AND v.source_id=r.source_id
        AND v.collection_id=r.collection_id AND v.record_id=r.record_id AND v.revision=r.current_revision
      JOIN ${this.base.evidence} ev ON ev.tenant_id=v.tenant_id AND ev.source_id=v.source_id
        AND ev.collection_id=v.collection_id AND ev.record_id=v.record_id AND ev.revision=v.revision
      JOIN ${this.base.sources} s ON s.tenant_id=r.tenant_id AND s.source_id=r.source_id AND s.status='active'
      JOIN ${this.base.collections} c ON c.tenant_id=r.tenant_id AND c.source_id=r.source_id
        AND c.collection_id=r.collection_id AND c.status='active'
      LEFT JOIN LATERAL (SELECT e.entity_id,e.display_name FROM ${this.derived.entities} e
        WHERE e.tenant_id=r.tenant_id AND e.source_id=r.source_id AND e.collection_id=r.collection_id
          AND e.record_id=r.record_id AND e.lifecycle='active' ORDER BY e.generation DESC LIMIT 1) en ON TRUE
      WHERE r.tenant_id=$1 AND r.collection_id=ANY($2::text[]) AND LOWER(s.kind)<>'dws'
        AND ($3::text IS NULL OR LOWER(COALESCE(v.entity_type,''))=LOWER($3)
          OR LOWER(COALESCE(v.record_kind,''))=LOWER($3)
          OR LOWER(COALESCE(v.metadata_json->>'eventType',v.metadata_json->>'event_type',''))=LOWER($3))
        AND ($4::text IS NULL OR v.content_json::text ILIKE '%'||$4||'%'
          OR v.metadata_json::text ILIKE '%'||$4||'%')
        AND ($5::text IS NULL OR en.entity_id=$5)
        AND ($6::timestamptz IS NULL OR ${occurredAt} >= $6)
        AND ($7::timestamptz IS NULL OR ${occurredAt} <= $7)
      GROUP BY r.tenant_id,r.source_id,r.collection_id,r.record_id,v.revision,v.content_json,v.entity_type,
        v.occurred_at,v.source_updated_at,v.observed_at,v.created_at,s.kind,en.entity_id,en.display_name
      ORDER BY occurred_at DESC,r.source_id,r.collection_id,r.record_id LIMIT $8`,
    [input.tenantId, unique(input.collectionIds), input.type ?? null, input.filter ?? null,
      input.entityId ?? null, input.from ?? null, input.through ?? null, input.limit]);
    return result.rows.map(timelineFromRow);
  }

  async listEntities(input: ProductStoreListInput): Promise<ProductEntityCandidate[]> {
    validateList(input);
    if (input.collectionIds.length === 0) return [];
    const result = await this.pool.query(`SELECT DISTINCT ON (en.entity_id)
        en.entity_id,en.entity_type,en.display_name,en.payload_json,en.generation,en.updated_at,
        en.source_id,en.collection_id,en.record_id,en.record_revision,
        s.kind AS source_kind,r.current_revision,r.record_kind,r.metadata_json,r.owner_principal,
        r.acl_principals,r.source_event_id,r.deleted,r.revoked,
        EXISTS (SELECT 1 FROM ${this.base.partitions} p WHERE p.tenant_id=en.tenant_id
          AND p.source_id=en.source_id AND p.collection_id=en.collection_id
          AND (p.refused=TRUE OR p.status='refused')) AS refused
      FROM ${this.derived.entities} en
      JOIN ${this.base.records} r ON r.tenant_id=en.tenant_id AND r.source_id=en.source_id
        AND r.collection_id=en.collection_id AND r.record_id=en.record_id
      JOIN ${this.base.sources} s ON s.tenant_id=en.tenant_id AND s.source_id=en.source_id AND s.status='active'
      JOIN ${this.base.collections} c ON c.tenant_id=en.tenant_id AND c.source_id=en.source_id
        AND c.collection_id=en.collection_id AND c.status='active'
      WHERE en.tenant_id=$1 AND en.collection_id=ANY($2::text[]) AND en.lifecycle='active'
        AND r.deleted=FALSE AND r.revoked=FALSE
        AND ($3::text IS NULL OR en.entity_type=$3)
        AND ($4::text IS NULL OR en.display_name ILIKE '%'||$4||'%'
          OR en.payload_json::text ILIKE '%'||$4||'%')
      ORDER BY en.entity_id,en.generation DESC LIMIT $5`,
    [input.tenantId, unique(input.collectionIds), input.type ?? null, input.filter ?? null, input.limit]);
    return result.rows.map(entityFromRow);
  }

  async getEntity(tenantId: string, entityId: string, collectionIds: string[], actorId: string): Promise<ProductEntityCandidate | null> {
    validateId(tenantId); validateId(entityId); validateId(actorId);
    if (collectionIds.length === 0) return null;
    return this.getEntityExact(tenantId, entityId, collectionIds, actorId);
  }

  private async getEntityExact(tenantId: string, entityId: string, collectionIds: string[], actorId: string): Promise<ProductEntityCandidate | null> {
    const result = await this.pool.query(`SELECT en.entity_id,en.entity_type,en.display_name,en.payload_json,en.generation,en.updated_at,
        en.source_id,en.collection_id,en.record_id,en.record_revision,
        s.kind AS source_kind,r.current_revision,r.record_kind,r.metadata_json,r.owner_principal,
        r.acl_principals,r.source_event_id,r.deleted,r.revoked,
        (SELECT 1+COUNT(DISTINCT rv.review_id)::integer
          FROM ${this.derived.reviews} rv JOIN ${this.derived.derivedItems} ri
            ON ri.tenant_id=rv.tenant_id AND ri.generation=rv.generation AND ri.item_id=rv.item_id
          WHERE ri.tenant_id=en.tenant_id AND ri.subject_entity_id=en.entity_id
            AND rv.comment->>'action' IN ('assert','reject')
            AND rv.comment->'scope'->>'type'='person' AND rv.comment->'scope'->>'personId'=$4
        ) AS personal_correction_revision,
        (SELECT 1+COUNT(DISTINCT rv.review_id)::integer
          FROM ${this.derived.reviews} rv JOIN ${this.derived.derivedItems} ri
            ON ri.tenant_id=rv.tenant_id AND ri.generation=rv.generation AND ri.item_id=rv.item_id
          WHERE ri.tenant_id=en.tenant_id AND ri.subject_entity_id=en.entity_id
            AND rv.comment->>'action' IN ('assert','reject')
            AND rv.comment->'scope'->>'type'='org'
        ) AS organization_correction_revision,
        EXISTS (SELECT 1 FROM ${this.base.partitions} p WHERE p.tenant_id=en.tenant_id
          AND p.source_id=en.source_id AND p.collection_id=en.collection_id
          AND (p.refused=TRUE OR p.status='refused')) AS refused
      FROM ${this.derived.entities} en
      JOIN ${this.base.records} r ON r.tenant_id=en.tenant_id AND r.source_id=en.source_id
        AND r.collection_id=en.collection_id AND r.record_id=en.record_id
      JOIN ${this.base.sources} s ON s.tenant_id=en.tenant_id AND s.source_id=en.source_id AND s.status='active'
      JOIN ${this.base.collections} c ON c.tenant_id=en.tenant_id AND c.source_id=en.source_id
        AND c.collection_id=en.collection_id AND c.status='active'
      WHERE en.tenant_id=$1 AND en.entity_id=$2 AND en.collection_id=ANY($3::text[])
        AND en.lifecycle='active' AND r.deleted=FALSE AND r.revoked=FALSE
      ORDER BY en.generation DESC LIMIT 1`, [tenantId, entityId, unique(collectionIds), actorId]);
    return result.rows[0] ? entityFromRow(result.rows[0]) : null;
  }

  async listItems(tenantId: string, entityId: string): Promise<ProductItemCandidate[]> {
    return this.queryItems({ tenantId, entityId, collectionIds: [], limit: 200 }, true);
  }

  async getItem(tenantId: string, entityId: string, itemId: string): Promise<ProductItemCandidate | null> {
    validateId(itemId);
    return (await this.listItems(tenantId, entityId)).find(item => item.itemId === itemId) ?? null;
  }

  async listCorrections(tenantId: string, entityId: string, actorId: string): Promise<ProductCorrectionCandidate[]> {
    validateId(tenantId); validateId(entityId); validateId(actorId);
    const result = await this.pool.query(`SELECT r.*,i.subject_entity_id,i.value_json,i.updated_at,
        COALESCE(jsonb_agg(jsonb_build_object('sourceId',ie.source_id,'collectionId',ie.collection_id,
          'recordId',ie.record_id,'recordRevision',ie.record_revision,'evidenceId',ie.evidence_id)
          ORDER BY ie.evidence_id) FILTER (WHERE ie.evidence_id IS NOT NULL),'[]'::jsonb) evidence_json
      FROM ${this.derived.reviews} r JOIN ${this.derived.derivedItems} i
        ON i.tenant_id=r.tenant_id AND i.generation=r.generation AND i.item_id=r.item_id
      LEFT JOIN ${this.derived.itemEvidence} ie ON ie.tenant_id=i.tenant_id AND ie.generation=i.generation
        AND ie.item_id=i.item_id AND ie.revoked=FALSE
      WHERE r.tenant_id=$1 AND i.subject_entity_id=$2 AND r.revoked=FALSE
        AND r.comment->>'action' IN ('assert','reject')
        AND (i.owner_principal IS NULL OR i.owner_principal=$3)
      GROUP BY r.tenant_id,r.generation,r.item_id,r.review_id,r.review_status,r.reviewer_principal,
        r.comment,r.authority,r.revoked,r.created_at,r.updated_at,i.subject_entity_id,i.value_json,i.updated_at
      ORDER BY r.created_at DESC LIMIT 200`, [tenantId, entityId, actorId]);
    return result.rows.map(row => correctionFromRow(row)).filter(item =>
      item.scope.type === 'org' || (item.scope.type === 'person' && item.scope.personId === actorId));
  }

  async listReviews(input: ProductStoreListInput): Promise<ProductReviewCandidate[]> {
    validateList(input);
    if (input.collectionIds.length === 0) return [];
    const stateFilter = input.filter === 'proposed' || input.filter === 'conflicted' ? input.filter : null;
    return this.queryReviewCandidates({ ...input, ...(stateFilter ? { filter: undefined } : {}) }, {
      stateFilter, organizationOnly: true, ignoreCollections: false, includeAllSiblings: false,
    });
  }

  async getReviewGroup(tenantId: string, itemId: string, limit: number): Promise<ProductReviewCandidate[]> {
    validateId(tenantId); validateId(itemId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) invalid();
    const identity = await this.pool.query(`SELECT subject_entity_id,item_type,semantic_key
      FROM ${this.derived.derivedItems}
      WHERE tenant_id=$1 AND item_id=$2 AND lifecycle='active'
        AND (review_status='proposed' OR conflict_status='open')
      ORDER BY generation DESC LIMIT 1`, [tenantId, itemId]);
    const target = identity.rows[0];
    if (!target) return [];
    return this.queryReviewCandidates({
      tenantId, collectionIds: [], limit,
      entityId: String(target.subject_entity_id), type: String(target.item_type),
    }, { stateFilter: null, organizationOnly: true, ignoreCollections: true,
      includeAllSiblings: true, semanticKey: String(target.semantic_key) });
  }

  async getCorrectionAuthorizationSnapshot(input: {
    tenantId: string;
    entityId: string;
    generation: string;
    itemId: string;
    scope: DerivedScope;
  }): Promise<DerivedReviewAuthorizationSnapshot | null> {
    const result = await this.pool.query(`SELECT i.generation,i.item_id,i.item_type,i.semantic_key,
        i.value_json->>'valueFingerprint' AS value_fingerprint,i.owner_principal,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('sourceId',ie.source_id,'collectionId',ie.collection_id,
          'recordId',ie.record_id,'recordRevision',ie.record_revision,'evidenceId',ie.evidence_id)
          ORDER BY ie.source_id,ie.collection_id,ie.record_id,ie.record_revision,ie.evidence_id)
          FROM ${this.derived.itemEvidence} ie WHERE ie.tenant_id=i.tenant_id AND ie.generation=i.generation
            AND ie.item_id=i.item_id AND ie.revoked=FALSE),'[]'::jsonb) evidence_json
      FROM ${this.derived.derivedItems} i
      WHERE i.tenant_id=$1 AND i.subject_entity_id=$2 AND i.generation=$3 AND i.item_id=$4
        AND i.lifecycle='active' AND i.review_status='confirmed'`,
    [input.tenantId, input.entityId, input.generation, input.itemId]);
    const row = result.rows[0];
    if (!row) return null;
    return immutableCorrectionSnapshot({
      tenantId: input.tenantId,
      entityId: input.entityId,
      generation: String(row.generation),
      itemId: String(row.item_id),
      itemType: String(row.item_type) as DerivedReviewAuthorizationSnapshot['itemType'],
      semanticKey: String(row.semantic_key),
      valueFingerprint: String(row.value_fingerprint),
      ownerPrincipal: row.owner_principal == null ? null : String(row.owner_principal),
      evidence: evidenceRefs(row.evidence_json),
      scope: input.scope,
    });
  }

  async getReviewAuthorizationSnapshot(
    tenantId: string,
    itemId: string,
    limit: number,
  ): Promise<ProductReviewAuthorizationSnapshot | null> {
    validateId(tenantId); validateId(itemId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) invalid();
    const identity = await this.pool.query(`SELECT subject_entity_id,item_type,semantic_key
      FROM ${this.derived.derivedItems}
      WHERE tenant_id=$1 AND item_id=$2 AND lifecycle='active' AND owner_principal IS NULL
        AND (review_status='proposed' OR conflict_status='open')
      ORDER BY generation DESC LIMIT 1`, [tenantId, itemId]);
    const target = identity.rows[0];
    if (!target) return null;
    const result = await this.pool.query(`SELECT i.generation,i.item_id,i.revision,i.review_status,i.conflict_status,
        i.value_json->>'valueFingerprint' AS value_fingerprint,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('sourceId',ie.source_id,'collectionId',ie.collection_id,
          'recordId',ie.record_id,'recordRevision',ie.record_revision,'evidenceId',ie.evidence_id)
          ORDER BY ie.source_id,ie.collection_id,ie.record_id,ie.record_revision,ie.evidence_id)
          FROM ${this.derived.itemEvidence} ie WHERE ie.tenant_id=i.tenant_id AND ie.generation=i.generation
            AND ie.item_id=i.item_id AND ie.revoked=FALSE),'[]'::jsonb) evidence_json
      FROM ${this.derived.derivedItems} i
      WHERE i.tenant_id=$1 AND i.subject_entity_id=$2 AND i.item_type=$3 AND i.semantic_key=$4
        AND i.lifecycle='active' AND i.owner_principal IS NULL
      ORDER BY i.generation,i.item_id LIMIT $5`,
    [tenantId, target.subject_entity_id, target.item_type, target.semantic_key, limit]);
    const items = result.rows.map(reviewAuthorizationItemFromRow);
    return immutableReviewAuthorizationSnapshot({
      tenantId,
      targetItemId: itemId,
      entityId: String(target.subject_entity_id),
      itemType: String(target.item_type) as ProductReviewAuthorizationSnapshot['itemType'],
      semanticKey: String(target.semantic_key),
      count: items.length,
      fingerprint: reviewGroupFingerprint(items),
      items,
    });
  }

  async getEvidence(tenantId: string, ref: import('../derived/types.js').DerivedEvidenceRef): Promise<ProductEvidenceCandidate | null> {
    validateId(tenantId); validateId(ref.sourceId); validateId(ref.collectionId); validateId(ref.recordId); validateId(ref.evidenceId);
    if (!Number.isSafeInteger(ref.recordRevision) || ref.recordRevision < 1) invalid();
    const result = await this.pool.query(`SELECT ev.kind,ev.data_json,ev.created_at,
        s.kind AS source_kind,s.display_name AS source_display_name,v.content_json,v.source_updated_at,v.observed_at,
        r.current_revision,r.record_kind,r.metadata_json,r.owner_principal,
        r.acl_principals,r.source_event_id,r.deleted,r.revoked,
        EXISTS (SELECT 1 FROM ${this.base.partitions} p WHERE p.tenant_id=ev.tenant_id
          AND p.source_id=ev.source_id AND p.collection_id=ev.collection_id
          AND (p.refused=TRUE OR p.status='refused')) AS refused
      FROM ${this.base.evidence} ev
      JOIN ${this.base.revisions} v ON v.tenant_id=ev.tenant_id AND v.source_id=ev.source_id
        AND v.collection_id=ev.collection_id AND v.record_id=ev.record_id AND v.revision=ev.revision
      JOIN ${this.base.records} r ON r.tenant_id=ev.tenant_id AND r.source_id=ev.source_id
        AND r.collection_id=ev.collection_id AND r.record_id=ev.record_id
      JOIN ${this.base.sources} s ON s.tenant_id=ev.tenant_id AND s.source_id=ev.source_id AND s.status='active'
      JOIN ${this.base.collections} c ON c.tenant_id=ev.tenant_id AND c.source_id=ev.source_id
        AND c.collection_id=ev.collection_id AND c.status='active'
      WHERE ev.tenant_id=$1 AND ev.source_id=$2 AND ev.collection_id=$3 AND ev.record_id=$4
        AND ev.revision=$5 AND ev.evidence_id=$6`,
    [tenantId, ref.sourceId, ref.collectionId, ref.recordId, ref.recordRevision, ref.evidenceId]);
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    const data = object(row.data_json);
    return {
      ref,
      locator: locatorFromRow(row, ref),
      kind: String(row.kind),
      source: stringField(data, 'source') ?? String(row.source_display_name ?? row.source_kind),
      author: stringField(data, 'author') ?? null,
      excerpt: truncate(stringField(data, 'excerpt') ?? evidenceExcerpt(json(row.content_json))),
      url: stringField(data, 'url') ?? null,
      occurredAt: optionalIso(stringField(data, 'occurredAt') ?? stringField(data, 'businessTime')
        ?? stringField(data, 'sourceUpdatedAt') ?? row.source_updated_at ?? row.observed_at ?? row.created_at),
      createdAt: iso(row.created_at),
      label: stringField(data, 'label') ?? String(row.kind),
      summary: truncate(stringField(data, 'excerpt') ?? stringField(data, 'summary')),
    };
  }

  async getCurrentRecordLocator(tenantId: string, ref: {
    sourceId: string; collectionId: string; recordId: string; recordRevision: number;
  }): Promise<ProductRecordLocator | null> {
    validateId(tenantId); validateId(ref.sourceId); validateId(ref.collectionId); validateId(ref.recordId);
    if (!Number.isSafeInteger(ref.recordRevision) || ref.recordRevision < 1) invalid();
    const result = await this.pool.query(`SELECT s.kind AS source_kind,r.current_revision,r.record_kind,
        r.metadata_json,r.owner_principal,r.acl_principals,r.source_event_id,r.deleted,r.revoked,
        EXISTS (SELECT 1 FROM ${this.base.partitions} p WHERE p.tenant_id=r.tenant_id
          AND p.source_id=r.source_id AND p.collection_id=r.collection_id
          AND (p.refused=TRUE OR p.status='refused')) AS refused
      FROM ${this.base.records} r
      JOIN ${this.base.revisions} v ON v.tenant_id=r.tenant_id AND v.source_id=r.source_id
        AND v.collection_id=r.collection_id AND v.record_id=r.record_id AND v.revision=$5
      JOIN ${this.base.sources} s ON s.tenant_id=r.tenant_id AND s.source_id=r.source_id AND s.status='active'
      JOIN ${this.base.collections} c ON c.tenant_id=r.tenant_id AND c.source_id=r.source_id
        AND c.collection_id=r.collection_id AND c.status='active'
      WHERE r.tenant_id=$1 AND r.source_id=$2 AND r.collection_id=$3 AND r.record_id=$4
      LIMIT 1`, [tenantId, ref.sourceId, ref.collectionId, ref.recordId, ref.recordRevision]);
    return result.rows[0] ? locatorFromRow(result.rows[0], ref) : null;
  }

  async listAdjacent(tenantId: string, entityIds: string[], limit: number): Promise<{
    items: ProductRelationCandidate[];
    degraded: boolean;
  }> {
    const raw = await this.relations.listAdjacent({ tenantId, entityIds, limit: limit + 1 });
    const rawCapped = raw.length > limit;
    const edges = raw.slice(0, limit);
    const candidates = await Promise.all(edges.map(async edge => {
      const evidence = await this.getEvidence(tenantId, edge.evidence);
      return evidence ? { edge, locator: evidence.locator } : null;
    }));
    const items = candidates.filter((value): value is ProductRelationCandidate => value !== null);
    return { items, degraded: rawCapped || items.length !== edges.length };
  }

  async decideReview(input: { tenantId: string; actorId: string; itemId: string; expectedRevision: number;
    decision: 'confirmed' | 'rejected'; authorize: import('./types.js').ProductReviewAuthorizer;
  }): Promise<{ status: 'confirmed' | 'rejected' }> {
    validateId(input.tenantId); validateId(input.actorId); validateId(input.itemId);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new ContextProductError('CONTEXT_PRODUCT_INVALID');
    }
    return this.tx(async client => {
      // The entity row is the common serialization lock for projector, proposed, correction and decision writers.
      const identity = await client.query(`SELECT i.generation,i.subject_entity_id,i.item_type,i.semantic_key,en.generation AS entity_generation
        FROM ${this.derived.derivedItems} i
        JOIN LATERAL (SELECT current_entity.generation FROM ${this.derived.entities} current_entity
          WHERE current_entity.tenant_id=i.tenant_id AND current_entity.entity_id=i.subject_entity_id
            AND current_entity.lifecycle='active'
          ORDER BY current_entity.generation DESC LIMIT 1 FOR UPDATE OF current_entity) en ON TRUE
        WHERE i.tenant_id=$1 AND i.item_id=$2 AND i.lifecycle='active' AND i.owner_principal IS NULL
        ORDER BY i.generation DESC LIMIT 1`, [input.tenantId, input.itemId]);
      const candidate = identity.rows[0];
      if (!candidate) throw new ContextProductError('CONTEXT_PRODUCT_NOT_FOUND');
      const group = await client.query(`SELECT i.generation,i.item_id,i.subject_entity_id,i.item_type,i.semantic_key,
          i.revision,i.review_status,i.conflict_status,i.value_json->>'valueFingerprint' AS value_fingerprint
        FROM ${this.derived.derivedItems} i
        WHERE i.tenant_id=$1 AND i.subject_entity_id=$2 AND i.item_type=$3 AND i.semantic_key=$4
          AND i.lifecycle='active' AND i.owner_principal IS NULL
        ORDER BY i.generation,i.item_id FOR UPDATE OF i`,
      [input.tenantId, candidate.subject_entity_id, candidate.item_type, candidate.semantic_key]);
      const row = group.rows.find(value => String(value.item_id) === input.itemId
        && String(value.generation) === String(candidate.generation));
      if (!row) throw new ContextProductError('CONTEXT_PRODUCT_NOT_FOUND');
      const conflicted = String(row.conflict_status) === 'open';
      if (!conflicted && String(row.review_status) !== 'proposed') {
        throw new ContextProductError('CONTEXT_PRODUCT_NOT_FOUND');
      }
      if (Number(row.revision) !== input.expectedRevision) throw new ContextProductError('CONTEXT_PRODUCT_CONFLICT');

      const evidenceRows = await client.query(`SELECT ie.generation,ie.item_id,ie.source_id,ie.collection_id,
          ie.record_id,ie.record_revision,ie.evidence_id,ie.revoked
        FROM ${this.derived.itemEvidence} ie
        JOIN ${this.derived.derivedItems} i ON i.tenant_id=ie.tenant_id AND i.generation=ie.generation
          AND i.item_id=ie.item_id
        WHERE i.tenant_id=$1 AND i.subject_entity_id=$2 AND i.item_type=$3 AND i.semantic_key=$4
          AND i.lifecycle='active' AND i.owner_principal IS NULL
        ORDER BY ie.generation,ie.item_id,ie.source_id,ie.collection_id,ie.record_id,ie.record_revision,ie.evidence_id
        FOR UPDATE OF ie`,
      [input.tenantId, candidate.subject_entity_id, candidate.item_type, candidate.semantic_key]);
      const evidenceByItem = new Map<string, DerivedEvidenceRef[]>();
      for (const evidenceRow of evidenceRows.rows) {
        if (Boolean(evidenceRow.revoked)) continue;
        const key = `${String(evidenceRow.generation)}\u0000${String(evidenceRow.item_id)}`;
        const refs = evidenceByItem.get(key) ?? [];
        refs.push({
          sourceId: String(evidenceRow.source_id),
          collectionId: String(evidenceRow.collection_id),
          recordId: String(evidenceRow.record_id),
          recordRevision: Number(evidenceRow.record_revision),
          evidenceId: String(evidenceRow.evidence_id),
        });
        evidenceByItem.set(key, refs);
      }
      const snapshotItems = group.rows.map(value => reviewAuthorizationItemFromRow({
        ...value,
        evidence_json: evidenceByItem.get(`${String(value.generation)}\u0000${String(value.item_id)}`) ?? [],
      }));
      const snapshot = immutableReviewAuthorizationSnapshot({
        tenantId: input.tenantId,
        targetItemId: input.itemId,
        entityId: String(candidate.subject_entity_id),
        itemType: String(candidate.item_type) as ProductReviewAuthorizationSnapshot['itemType'],
        semanticKey: String(candidate.semantic_key),
        count: snapshotItems.length,
        fingerprint: reviewGroupFingerprint(snapshotItems),
        items: snapshotItems,
      });
      try {
        if (typeof input.authorize !== 'function' || !await input.authorize(snapshot)) {
          throw new ContextProductError('CONTEXT_PRODUCT_FORBIDDEN');
        }
      } catch {
        throw new ContextProductError('CONTEXT_PRODUCT_FORBIDDEN');
      }

      const revision = input.expectedRevision + 1;
      const groupParams = [input.tenantId, row.subject_entity_id, row.item_type, row.semantic_key];
      let remainingValueFingerprints: number | undefined;
      if (!conflicted) {
        const updated = await client.query(`UPDATE ${this.derived.derivedItems}
          SET review_status=$5,revision=$4,updated_at=NOW()
          WHERE tenant_id=$1 AND generation=$2 AND item_id=$3 AND revision=$6 AND review_status='proposed'
            AND conflict_status<>'open' AND owner_principal IS NULL`,
        [input.tenantId, row.generation, input.itemId, revision, input.decision, input.expectedRevision]);
        if (updated.rowCount !== 1) throw new ContextProductError('CONTEXT_PRODUCT_CONFLICT');
      } else {
        const updated = await client.query(`UPDATE ${this.derived.derivedItems}
          SET review_status=$5,conflict_status='resolved',revision=$4,updated_at=NOW()
          WHERE tenant_id=$1 AND generation=$2 AND item_id=$3 AND revision=$6
            AND lifecycle='active' AND conflict_status='open' AND owner_principal IS NULL`,
        [input.tenantId, row.generation, input.itemId, revision, input.decision, input.expectedRevision]);
        if (updated.rowCount !== 1) throw new ContextProductError('CONTEXT_PRODUCT_CONFLICT');
        if (input.decision === 'confirmed') {
          await client.query(`UPDATE ${this.derived.derivedItems}
            SET lifecycle='superseded',conflict_status='resolved',valid_to=COALESCE(valid_to,NOW()),updated_at=NOW()
            WHERE tenant_id=$1 AND subject_entity_id=$2 AND item_type=$3 AND semantic_key=$4
              AND lifecycle='active' AND conflict_status='open' AND owner_principal IS NULL
              AND NOT (generation=$5 AND item_id=$6)`,
          [...groupParams, row.generation, input.itemId]);
        } else {
          const remaining = await client.query(`SELECT COUNT(DISTINCT value_json->>'valueFingerprint')::integer AS count
            FROM ${this.derived.derivedItems}
            WHERE tenant_id=$1 AND subject_entity_id=$2 AND item_type=$3 AND semantic_key=$4
              AND lifecycle='active' AND review_status<>'rejected' AND owner_principal IS NULL`, groupParams);
          remainingValueFingerprints = Number(remaining.rows[0]?.count ?? 0);
          await client.query(`UPDATE ${this.derived.derivedItems}
            SET conflict_status=$5,updated_at=NOW()
            WHERE tenant_id=$1 AND subject_entity_id=$2 AND item_type=$3 AND semantic_key=$4
              AND lifecycle='active' AND review_status<>'rejected' AND owner_principal IS NULL`,
          [...groupParams, remainingValueFingerprints > 1 ? 'open' : 'resolved']);
        }
      }
      const reviewId = createHash('sha256').update(JSON.stringify({
        tenantId: input.tenantId,
        actorId: input.actorId,
        itemId: input.itemId,
        expectedRevision: input.expectedRevision,
        decision: input.decision,
      })).digest('hex');
      await client.query(`INSERT INTO ${this.derived.reviews}
        (tenant_id,generation,item_id,review_id,review_status,reviewer_principal,comment,authority)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'authoritative')`,
      [input.tenantId, row.generation, input.itemId, reviewId, input.decision, input.actorId,
        JSON.stringify({ action: 'review_decision', expectedRevision: input.expectedRevision, revision,
          conflict: conflicted, ...(remainingValueFingerprints === undefined ? {} : { remainingValueFingerprints }) })]);
      return { status: input.decision };
    });
  }

  private async queryReviewCandidates(input: ProductStoreListInput, options: {
    stateFilter: 'proposed' | 'conflicted' | null;
    organizationOnly: boolean;
    ignoreCollections: boolean;
    includeAllSiblings: boolean;
    semanticKey?: string;
  }): Promise<ProductReviewCandidate[]> {
    const result = await this.pool.query(`SELECT i.*,en.display_name,original.value_json AS original_value_json,
        COALESCE(jsonb_agg(jsonb_build_object('sourceId',ie.source_id,'collectionId',ie.collection_id,
          'recordId',ie.record_id,'recordRevision',ie.record_revision,'evidenceId',ie.evidence_id)
          ORDER BY ie.evidence_id) FILTER (WHERE ie.evidence_id IS NOT NULL),'[]'::jsonb) evidence_json
      FROM ${this.derived.derivedItems} i
      JOIN LATERAL (SELECT e.* FROM ${this.derived.entities} e WHERE e.tenant_id=i.tenant_id
        AND e.entity_id=i.subject_entity_id AND e.lifecycle='active' ORDER BY e.generation DESC LIMIT 1) en ON TRUE
      LEFT JOIN LATERAL (SELECT sibling.value_json FROM ${this.derived.derivedItems} sibling
        WHERE sibling.tenant_id=i.tenant_id AND sibling.subject_entity_id=i.subject_entity_id
          AND sibling.item_type=i.item_type AND sibling.semantic_key=i.semantic_key
          AND sibling.lifecycle='active' AND sibling.review_status='confirmed'
          AND sibling.owner_principal IS NOT DISTINCT FROM i.owner_principal
          AND NOT (sibling.generation=i.generation AND sibling.item_id=i.item_id)
        ORDER BY CASE sibling.authority WHEN 'authoritative' THEN 3 WHEN 'advisory' THEN 2 ELSE 1 END DESC,
          sibling.updated_at DESC,sibling.generation DESC LIMIT 1) original ON TRUE
      LEFT JOIN ${this.derived.itemEvidence} ie ON ie.tenant_id=i.tenant_id AND ie.generation=i.generation
        AND ie.item_id=i.item_id AND ie.revoked=FALSE
      WHERE i.tenant_id=$1 AND i.lifecycle='active' AND i.review_status<>'rejected'
        AND ($2::text IS NULL OR i.subject_entity_id=$2)
        AND ($3::text IS NULL OR i.item_type=$3)
        AND ($4::text IS NULL OR i.search_text ILIKE '%'||$4||'%')
        AND ($5::timestamptz IS NULL OR i.valid_from >= $5)
        AND ($6::timestamptz IS NULL OR i.valid_from <= $6)
        AND ($7::boolean OR en.collection_id=ANY($8::text[]))
        AND ($10::text IS NULL
          OR ($10='proposed' AND i.review_status='proposed' AND i.conflict_status<>'open')
          OR ($10='conflicted' AND i.conflict_status='open'))
        AND ($13::boolean OR $10::text IS NOT NULL OR i.review_status='proposed' OR i.conflict_status='open')
        AND ($11::boolean=FALSE OR i.owner_principal IS NULL)
        AND ($12::text IS NULL OR i.semantic_key=$12)
      GROUP BY i.tenant_id,i.generation,i.item_id,en.display_name,original.value_json
      ORDER BY i.valid_from DESC,i.item_id LIMIT $9`,
    [input.tenantId, input.entityId ?? null, input.type ?? null, input.filter ?? null,
      input.from ?? null, input.through ?? null, options.ignoreCollections, unique(input.collectionIds), input.limit,
      options.stateFilter, options.organizationOnly, options.semanticKey ?? null, options.includeAllSiblings]);
    return result.rows.map(row => {
      const item = itemFromRow(row);
      const originalEnvelope = object(row.original_value_json);
      return {
        ...item,
        entityLabel: String(row.display_name),
        originalSummary: row.original_value_json == null ? null : truncate(summary(json(originalEnvelope.value))),
        conflict: item.state === 'conflicted' ? '存在待处理冲突' : null,
      };
    }).filter(item => options.includeAllSiblings || (options.stateFilter ? item.state === options.stateFilter
      : item.state === 'proposed' || item.state === 'conflicted'));
  }

  private async queryItems(input: ProductStoreListInput, ignoreCollections: boolean,
    reviewState: 'proposed' | 'conflicted' | null = null, organizationReviewOnly = false): Promise<ProductItemCandidate[]> {
    validateList(input);
    if (!ignoreCollections && input.collectionIds.length === 0) return [];
    const result = await this.pool.query(`SELECT i.*,en.display_name,
        COALESCE(jsonb_agg(jsonb_build_object('sourceId',ie.source_id,'collectionId',ie.collection_id,
          'recordId',ie.record_id,'recordRevision',ie.record_revision,'evidenceId',ie.evidence_id)
          ORDER BY ie.evidence_id) FILTER (WHERE ie.evidence_id IS NOT NULL),'[]'::jsonb) evidence_json
      FROM ${this.derived.derivedItems} i
      JOIN LATERAL (SELECT e.* FROM ${this.derived.entities} e WHERE e.tenant_id=i.tenant_id
        AND e.entity_id=i.subject_entity_id AND e.lifecycle='active' ORDER BY e.generation DESC LIMIT 1) en ON TRUE
      LEFT JOIN ${this.derived.itemEvidence} ie ON ie.tenant_id=i.tenant_id AND ie.generation=i.generation
        AND ie.item_id=i.item_id AND ie.revoked=FALSE
      WHERE i.tenant_id=$1 AND i.lifecycle='active' AND i.review_status<>'rejected'
        AND ($2::text IS NULL OR i.subject_entity_id=$2)
        AND ($3::text IS NULL OR i.item_type=$3)
        AND ($4::text IS NULL OR i.search_text ILIKE '%'||$4||'%')
        AND ($5::timestamptz IS NULL OR i.valid_from >= $5)
        AND ($6::timestamptz IS NULL OR i.valid_from <= $6)
        AND ($7::boolean OR en.collection_id=ANY($8::text[]))
        AND ($10::text IS NULL
          OR ($10='proposed' AND i.review_status='proposed' AND i.conflict_status<>'open')
          OR ($10='conflicted' AND i.conflict_status='open'))
        AND ($11::boolean=FALSE OR i.owner_principal IS NULL)
      GROUP BY i.tenant_id,i.generation,i.item_id,en.display_name
      ORDER BY i.valid_from DESC,i.item_id LIMIT $9`,
    [input.tenantId, input.entityId ?? null, input.type ?? null, input.filter ?? null,
      input.from ?? null, input.through ?? null, ignoreCollections, unique(input.collectionIds), input.limit, reviewState,
      organizationReviewOnly]);
    return result.rows.map(itemFromRow);
  }

  private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}

function timelineFromRow(row: QueryResultRow): ProductTimelineCandidate {
  const content = json(row.content_json);
  const contentObject = object(content);
  const type = titleCase(String(row.entity_type ?? row.record_kind ?? 'record'));
  const label = stringField(contentObject, 'title') ?? stringField(contentObject, 'label')
    ?? stringField(contentObject, 'name') ?? type;
  return {
    timelineId: `${String(row.source_id)}:${String(row.collection_id)}:${String(row.record_id)}:${Number(row.record_revision)}`,
    type, label, summary: truncate(summary(content)), occurredAt: iso(row.occurred_at), updatedAt: iso(row.updated_at),
    entityId: row.entity_id ? String(row.entity_id) : null,
    entityLabel: row.display_name ? String(row.display_name) : null,
    locator: locatorFromRow(row, {
      sourceId: String(row.source_id), collectionId: String(row.collection_id), recordId: String(row.record_id),
      recordRevision: Number(row.record_revision),
    }),
    evidence: evidenceRefs(row.evidence_json),
  };
}

function entityFromRow(row: QueryResultRow): ProductEntityCandidate {
  const payload = object(row.payload_json);
  return {
    entityId: String(row.entity_id), entityType: titleCase(String(row.entity_type)),
    label: String(row.display_name), summary: truncate(stringField(payload, 'summary')),
    revision: Number(row.generation),
    correctionRevisions: {
      personal: Number(row.personal_correction_revision ?? 1),
      organization: Number(row.organization_correction_revision ?? 1),
    },
    updatedAt: iso(row.updated_at),
    locator: locatorFromRow(row, {
      sourceId: String(row.source_id), collectionId: String(row.collection_id), recordId: String(row.record_id),
      recordRevision: Number(row.record_revision),
    }),
  };
}

function itemFromRow(row: QueryResultRow): ProductItemCandidate {
  const envelope = object(row.value_json);
  const scopeValue = object(envelope.scope);
  const scope = scopeValue.type === 'person' && typeof scopeValue.personId === 'string'
    ? { type: 'person' as const, personId: scopeValue.personId } : { type: 'org' as const };
  const value = json(envelope.value);
  const conflict = String(row.conflict_status) === 'open';
  return {
    itemId: String(row.item_id), entityId: String(row.subject_entity_id), itemType: String(row.item_type) as ProductItemCandidate['itemType'],
    semanticKey: String(row.semantic_key), value,
    valueFingerprint: typeof envelope.valueFingerprint === 'string' ? envelope.valueFingerprint : hash(value),
    authority: row.authority === 'authoritative' ? 'steward' : row.authority === 'advisory' ? 'user' : 'source',
    state: conflict ? 'conflicted' : row.review_status === 'proposed' ? 'proposed' : 'confirmed', scope,
    revision: Number(row.revision), occurredAt: iso(typeof envelope.occurredAt === 'string' ? envelope.occurredAt : row.valid_from),
    updatedAt: iso(row.updated_at), evidence: evidenceRefs(row.evidence_json),
  };
}

function correctionFromRow(row: QueryResultRow): ProductCorrectionCandidate {
  const comment = object(row.comment);
  const scopeValue = object(comment.scope);
  const scope = scopeValue.type === 'person' && typeof scopeValue.personId === 'string'
    ? { type: 'person' as const, personId: scopeValue.personId } : { type: 'org' as const };
  const envelope = object(row.value_json);
  return {
    reviewId: String(row.review_id), entityId: String(row.subject_entity_id), itemId: String(row.item_id),
    action: comment.action === 'reject' ? 'reject' : 'assert', actorId: String(row.reviewer_principal), scope,
    authority: row.authority === 'authoritative' ? 'steward' : 'user',
    revision: typeof comment.entityRevision === 'number' ? comment.entityRevision : 0,
    summary: truncate(summary(json(envelope.value))), createdAt: iso(row.created_at), evidence: evidenceRefs(row.evidence_json),
  };
}

function locatorFromRow(row: QueryResultRow, ref: { sourceId: string; collectionId: string; recordId: string; recordRevision: number }): ProductRecordLocator {
  return {
    sourceKind: String(row.source_kind ?? ''), sourceId: ref.sourceId, collectionId: ref.collectionId,
    recordId: ref.recordId, recordRevision: ref.recordRevision, currentRevision: Number(row.current_revision),
    recordType: row.record_kind === 'event' ? 'event' : 'snapshot', currentDeleted: Boolean(row.deleted),
    currentRevoked: Boolean(row.revoked), refused: Boolean(row.refused), metadata: object(row.metadata_json),
    ...(row.owner_principal ? { ownerPrincipal: String(row.owner_principal) } : {}),
    ...(Array.isArray(row.acl_principals) ? { aclPrincipals: row.acl_principals.map(String) } : {}),
    ...(row.source_event_id ? { sourceEventId: String(row.source_event_id) } : {}),
  };
}

function evidenceRefs(value: unknown): import('../derived/types.js').DerivedEvidenceRef[] {
  const values = array(value);
  return values.flatMap(item => {
    const row = object(item);
    const revision = Number(row.recordRevision);
    return typeof row.sourceId === 'string' && typeof row.collectionId === 'string' && typeof row.recordId === 'string'
      && typeof row.evidenceId === 'string' && Number.isSafeInteger(revision) && revision > 0
      ? [{ sourceId: row.sourceId, collectionId: row.collectionId, recordId: row.recordId,
          recordRevision: revision, evidenceId: row.evidenceId }] : [];
  });
}

function reviewAuthorizationItemFromRow(row: QueryResultRow): ProductReviewAuthorizationItemSnapshot {
  return Object.freeze({
    generation: String(row.generation),
    itemId: String(row.item_id),
    revision: Number(row.revision),
    status: String(row.review_status),
    conflict: String(row.conflict_status),
    valueFingerprint: String(row.value_fingerprint),
    evidence: Object.freeze(evidenceRefs(row.evidence_json).map(ref => Object.freeze({ ...ref }))),
  });
}

function reviewGroupFingerprint(items: readonly ProductReviewAuthorizationItemSnapshot[]): string {
  return createHash('sha256').update(JSON.stringify(items.map(item => ({
    generation: item.generation,
    itemId: item.itemId,
    revision: item.revision,
    status: item.status,
    conflict: item.conflict,
    valueFingerprint: item.valueFingerprint,
    evidence: item.evidence,
  })))).digest('hex');
}

function immutableCorrectionSnapshot(snapshot: DerivedReviewAuthorizationSnapshot): DerivedReviewAuthorizationSnapshot {
  return Object.freeze({
    ...snapshot,
    scope: Object.freeze({ ...snapshot.scope }),
    evidence: Object.freeze(snapshot.evidence.map(ref => Object.freeze({ ...ref }))),
  });
}

function immutableReviewAuthorizationSnapshot(
  snapshot: ProductReviewAuthorizationSnapshot,
): ProductReviewAuthorizationSnapshot {
  return Object.freeze({ ...snapshot, items: Object.freeze([...snapshot.items]) });
}

function validateList(input: ProductStoreListInput): void {
  validateId(input.tenantId);
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500 || input.collectionIds.length > 200) invalid();
  input.collectionIds.forEach(validateId);
  if (input.entityId) validateId(input.entityId);
}
function validateId(value: string): void { if (typeof value !== 'string' || !value || value.length > 500 || /[\u0000-\u001f]/u.test(value)) invalid(); }
function invalid(): never { throw new ContextProductError('CONTEXT_PRODUCT_INVALID'); }
function unique(values: string[]): string[] { return [...new Set(values)]; }
function object(value: unknown): Record<string, any> {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}
function array(value: unknown): unknown[] {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return []; } }
  return Array.isArray(value) ? value : [];
}
function json(value: unknown): ContextJson { return value === undefined ? null : value as ContextJson; }
function stringField(value: Record<string, unknown>, key: string): string | undefined { const item = value[key]; return typeof item === 'string' && item.trim() ? item.trim() : undefined; }
function truncate(value: string | undefined): string | null { return value ? value.slice(0, 500) : null; }
function summary(value: ContextJson): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (!value || Array.isArray(value)) return '';
  for (const key of ['summary', 'label', 'title', 'name', 'subject', 'description', 'status', 'value']) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}
function evidenceExcerpt(value: ContextJson): string {
  const readable = summary(value);
  if (readable) return readable;
  try { return JSON.stringify(value); } catch { return ''; }
}
function iso(value: unknown): string { return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString(); }
function optionalIso(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function titleCase(value: string): string { return value ? `${value[0]!.toUpperCase()}${value.slice(1)}` : 'Unknown'; }
function hash(value: ContextJson): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
