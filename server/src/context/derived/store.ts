import { createHash } from 'node:crypto';

import type { PoolClient, QueryResultRow } from 'pg';

import { tableNames, type ContextPhase4TableNames } from '../phase4/migration.js';
import { contextTableNames, contextTablePrefix, type ContextPgPool, type ContextTableNames } from '../store/migration.js';
import type { ContextJson, ContextObject } from '../store/types.js';
import { DeterministicContextProjector, fingerprint } from './projector.js';
import { reduceDerivedProfile } from './profileReducer.js';
import {
  DerivedStoreError,
  type AppendReviewInput,
  type ClaimedContextRecord,
  type ConsumerLease,
  type DerivedEntityCandidate,
  type DerivedEvidenceRef,
  type DerivedItemCandidate,
  type DerivedItemType,
  type DerivedProfile,
  type DerivedProjection,
  type DerivedReview,
  type DerivedReviewAuthorizationSnapshot,
  type ReviewRoleGate,
} from './types.js';

const RELATION_RESOLVE_LIMIT = 100;

export interface DerivedStoreOptions {
  pool: ContextPgPool;
  tablePrefix?: string;
  roleGate: ReviewRoleGate;
  now?: () => Date;
}

export interface ClaimContextOutboxInput {
  tenantId: string;
  consumerId: string;
  leaseOwner: string;
  leaseMs: number;
  limit?: number;
}

export interface ListActiveItemsInput {
  tenantId: string;
  entityId: string;
  viewerId?: string;
  includeProposed?: boolean;
}

export interface ResolvePendingRelationCandidatesInput {
  tenantId: string;
  limit?: number;
}

export interface ResolvePendingRelationCandidatesResult {
  materialized: number;
  pending: boolean;
}

interface ItemRow extends QueryResultRow {
  generation: string | number;
  item_id: string;
  subject_entity_id: string;
  item_type: DerivedItemType;
  semantic_key: string;
  value_json: unknown;
  derivation: 'source' | 'llm' | 'user' | 'steward';
  review_status: 'proposed' | 'confirmed' | 'rejected';
  authority: 'informational' | 'advisory' | 'authoritative';
  valid_from: Date | string;
  valid_to: Date | string | null;
  lifecycle: string;
  owner_principal: string | null;
  evidence_json: unknown;
}

/** PostgreSQL relational store for Phase 3 derived context. */
export class DerivedContextStore {
  readonly tables: ContextPhase4TableNames;
  readonly baseTables: ContextTableNames;
  private readonly now: () => Date;

  constructor(private readonly options: DerivedStoreOptions) {
    const prefix = contextTablePrefix(options.tablePrefix);
    this.tables = tableNames(prefix);
    this.baseTables = contextTableNames(prefix);
    this.now = options.now ?? (() => new Date());
  }

  async claimContextOutbox(input: ClaimContextOutboxInput): Promise<ConsumerLease | null> {
    assertId(input.tenantId); assertId(input.consumerId); assertId(input.leaseOwner);
    if (!Number.isInteger(input.leaseMs) || input.leaseMs < 1_000 || input.leaseMs > 3_600_000) invalid();
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) invalid();
    return this.tx(async client => {
      await client.query(`INSERT INTO ${this.tables.consumers} (tenant_id,consumer_id)
        VALUES ($1,$2) ON CONFLICT DO NOTHING`, [input.tenantId, input.consumerId]);
      const locked = await client.query(`SELECT * FROM ${this.tables.consumers}
        WHERE tenant_id=$1 AND consumer_id=$2 FOR UPDATE`, [input.tenantId, input.consumerId]);
      const row = locked.rows[0];
      if (!row || row.status === 'disabled') return null;
      const now = this.now();
      const expiresAt = row.lease_expires_at ? new Date(row.lease_expires_at) : undefined;
      const owned = row.lease_owner === input.leaseOwner && expiresAt && expiresAt > now;
      if (!owned && row.lease_owner && expiresAt && expiresAt > now) return null;
      const fence = owned ? String(row.lease_fence) : (BigInt(String(row.lease_fence)) + 1n).toString();
      const leaseExpiresAt = new Date(now.getTime() + input.leaseMs).toISOString();
      await client.query(`UPDATE ${this.tables.consumers}
        SET status='running',lease_owner=$3,lease_fence=$4,lease_expires_at=$5,
            last_heartbeat_at=$6,updated_at=$6
        WHERE tenant_id=$1 AND consumer_id=$2`,
      [input.tenantId, input.consumerId, input.leaseOwner, fence, leaseExpiresAt, now.toISOString()]);
      const cursorSeq = String(row.cursor_seq);
      const events = await loadExactOutbox(client, this.baseTables, input.tenantId, cursorSeq, limit);
      return {
        tenantId: input.tenantId,
        consumerId: input.consumerId,
        leaseOwner: input.leaseOwner,
        leaseFence: fence,
        cursorSeq,
        events,
        leaseExpiresAt,
      };
    });
  }

  async renewConsumerLease(lease: ConsumerLease, leaseMs: number): Promise<boolean> {
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 3_600_000) invalid();
    const expiresAt = new Date(this.now().getTime() + leaseMs).toISOString();
    const result = await this.options.pool.query(`UPDATE ${this.tables.consumers}
      SET lease_expires_at=$6,last_heartbeat_at=NOW(),updated_at=NOW()
      WHERE tenant_id=$1 AND consumer_id=$2 AND lease_owner=$3 AND lease_fence=$4
        AND cursor_seq=$5 AND lease_expires_at>NOW()`,
    [lease.tenantId, lease.consumerId, lease.leaseOwner, lease.leaseFence, lease.cursorSeq, expiresAt]);
    return result.rowCount === 1;
  }

  async releaseConsumerLease(lease: ConsumerLease): Promise<boolean> {
    const result = await this.options.pool.query(`UPDATE ${this.tables.consumers}
      SET status='idle',lease_owner=NULL,lease_expires_at=NULL,updated_at=NOW()
      WHERE tenant_id=$1 AND consumer_id=$2 AND lease_owner=$3 AND lease_fence=$4`,
    [lease.tenantId, lease.consumerId, lease.leaseOwner, lease.leaseFence]);
    return result.rowCount === 1;
  }

  /** Resolves one tenant-scoped, bounded batch. Concurrent workers share work via SKIP LOCKED. */
  async resolvePendingRelationCandidates(
    input: ResolvePendingRelationCandidatesInput,
  ): Promise<ResolvePendingRelationCandidatesResult> {
    assertId(input.tenantId);
    const limit = input.limit ?? RELATION_RESOLVE_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > RELATION_RESOLVE_LIMIT) invalid();
    return this.tx(async client => {
      const materialized = await this.materializePendingRelations(client, input.tenantId, limit);
      const pendingResult = await client.query(`SELECT EXISTS (
        SELECT 1 FROM ${this.tables.relationCandidates}
        WHERE tenant_id=$1 AND lifecycle='active' AND resolution_status='pending'
          AND review_status<>'rejected'
      ) AS pending`, [input.tenantId]);
      return { materialized, pending: Boolean(pendingResult.rows[0]?.pending) };
    });
  }

  /** Projects a claimed batch and advances the cursor in the same fenced transaction. */
  async projectClaimed(
    lease: ConsumerLease,
    projector = new DeterministicContextProjector(),
  ): Promise<{ projected: number; cursorSeq: string }> {
    return this.tx(async client => {
      await this.assertLease(client, lease);
      // Reload by seq under the lease: callers cannot substitute a different revision or evidence set.
      const exact = await loadExactOutboxBySeqs(client, this.baseTables, lease.tenantId, lease.events.map(event => event.seq));
      if (exact.length !== lease.events.length) throw new DerivedStoreError('DERIVED_LEASE_LOST');
      let cursor = lease.cursorSeq;
      for (const event of exact) {
        if (BigInt(event.seq) <= BigInt(cursor)) continue;
        await this.applyEvent(client, event, projector.project(event));
        cursor = event.seq;
      }
      const advanced = await client.query(`UPDATE ${this.tables.consumers}
        SET cursor_seq=$6,status='idle',lease_owner=NULL,lease_expires_at=NULL,
            last_error_code=NULL,last_error_message=NULL,updated_at=NOW()
        WHERE tenant_id=$1 AND consumer_id=$2 AND lease_owner=$3 AND lease_fence=$4 AND cursor_seq=$5`,
      [lease.tenantId, lease.consumerId, lease.leaseOwner, lease.leaseFence, lease.cursorSeq, cursor]);
      if (advanced.rowCount !== 1) throw new DerivedStoreError('DERIVED_LEASE_LOST');
      return { projected: exact.length, cursorSeq: cursor };
    });
  }

  async listActiveItems(input: ListActiveItemsInput): Promise<DerivedItemCandidate[]> {
    assertId(input.tenantId); assertId(input.entityId);
    if (input.viewerId !== undefined) assertId(input.viewerId);
    const result = await this.options.pool.query<ItemRow>(`
      SELECT i.*,
        COALESCE(jsonb_agg(jsonb_build_object(
          'sourceId',ie.source_id,'collectionId',ie.collection_id,'recordId',ie.record_id,
          'recordRevision',ie.record_revision,'evidenceId',ie.evidence_id
        ) ORDER BY ie.evidence_id) FILTER (WHERE ie.evidence_id IS NOT NULL),'[]'::jsonb) AS evidence_json
      FROM ${this.tables.derivedItems} i
      JOIN LATERAL (
        SELECT current_entity.* FROM ${this.tables.entities} current_entity
        WHERE current_entity.tenant_id=i.tenant_id AND current_entity.entity_id=i.subject_entity_id
          AND current_entity.lifecycle='active'
        ORDER BY current_entity.generation DESC LIMIT 1
      ) en ON TRUE
      JOIN ${this.baseTables.records} er ON er.tenant_id=en.tenant_id AND er.source_id=en.source_id
        AND er.collection_id=en.collection_id AND er.record_id=en.record_id
        AND er.deleted=FALSE AND er.revoked=FALSE
      JOIN ${this.tables.itemEvidence} ie ON ie.tenant_id=i.tenant_id
        AND ie.generation=i.generation AND ie.item_id=i.item_id AND ie.revoked=FALSE
      JOIN ${this.baseTables.evidence} ev ON ev.tenant_id=ie.tenant_id AND ev.source_id=ie.source_id
        AND ev.collection_id=ie.collection_id AND ev.record_id=ie.record_id
        AND ev.revision=ie.record_revision AND ev.evidence_id=ie.evidence_id
      JOIN ${this.baseTables.records} r ON r.tenant_id=ie.tenant_id AND r.source_id=ie.source_id
        AND r.collection_id=ie.collection_id AND r.record_id=ie.record_id
        AND r.deleted=FALSE AND r.revoked=FALSE
      WHERE i.tenant_id=$1 AND i.subject_entity_id=$2 AND i.lifecycle='active'
        AND en.lifecycle='active'
        AND i.valid_from<=NOW() AND (i.valid_to IS NULL OR i.valid_to>NOW())
        AND ($3::boolean OR i.review_status='confirmed')
        AND (i.owner_principal IS NULL OR i.owner_principal=$4)
      GROUP BY i.tenant_id,i.generation,i.item_id
      ORDER BY CASE i.authority WHEN 'authoritative' THEN 3 WHEN 'advisory' THEN 2 ELSE 1 END DESC,
        i.semantic_key,i.item_id`,
    [input.tenantId, input.entityId, input.includeProposed === true, input.viewerId ?? null]);
    const visibleRows = await this.applyReviewRejections(input, result.rows);
    return visibleRows.map(itemFromRow);
  }

  async appendReview(input: AppendReviewInput): Promise<DerivedReview> {
    validateReview(input);
    const authority = input.scope.type === 'org' ? 'steward' : 'user';
    if (input.scope.type === 'person' && input.scope.personId !== input.actorId) {
      throw new DerivedStoreError('DERIVED_FORBIDDEN');
    }
    const reviewId = reviewFingerprint(input);
    return this.tx(async client => {
      const entity = await this.currentEntity(client, input.tenantId, input.entityId, true);
      if (!entity) throw new DerivedStoreError('DERIVED_NOT_FOUND');
      const target = await findReviewTarget(client, this.tables, input);
      if (!target) throw new DerivedStoreError('DERIVED_NOT_FOUND');
      const targetEvidence = await lockTargetEvidence(
        client, this.tables, input.tenantId, target.generation, target.item_id,
      );
      if (targetEvidence.length === 0 || input.evidence.some(ref => !targetEvidence.some(value => sameEvidenceRef(value, ref)))) {
        throw new DerivedStoreError('DERIVED_EVIDENCE_INVALID');
      }
      if (input.scope.type === 'org') {
        try {
          if (!await this.options.roleGate.mayCorrectOrganization({
            tenantId: input.tenantId,
            actorId: input.actorId,
          })) throw new DerivedStoreError('DERIVED_FORBIDDEN');
        } catch {
          throw new DerivedStoreError('DERIVED_FORBIDDEN');
        }
      }
      const snapshot = immutableReviewSnapshot({
        tenantId: input.tenantId,
        entityId: input.entityId,
        generation: target.generation,
        itemId: target.item_id,
        itemType: target.item_type,
        semanticKey: target.semantic_key,
        valueFingerprint: target.value_fingerprint,
        ownerPrincipal: target.owner_principal,
        evidence: targetEvidence,
        scope: input.scope,
      });
      try {
        if (typeof input.authorize !== 'function' || !await input.authorize(snapshot)) {
          throw new DerivedStoreError('DERIVED_FORBIDDEN');
        }
      } catch {
        throw new DerivedStoreError('DERIVED_FORBIDDEN');
      }

      // Idempotent retries are still live-authorized against the locked target snapshot.
      const existing = await client.query(`SELECT r.*,i.subject_entity_id FROM ${this.tables.reviews} r
        JOIN ${this.tables.derivedItems} i ON i.tenant_id=r.tenant_id AND i.generation=r.generation AND i.item_id=r.item_id
        WHERE r.tenant_id=$1 AND r.review_id=$2`, [input.tenantId, reviewId]);
      if (existing.rows[0]) return reviewFromRow(existing.rows[0], input.entityId);
      const revision = await reviewRevision(client, this.tables, input.tenantId, input.entityId, input.scope);
      if (revision !== input.expectedRevision) throw new DerivedStoreError('DERIVED_VERSION_CONFLICT');
      const nextRevision = revision + 1;
      let itemId: string;
      let reviewGeneration = entity.generation;
      if (input.action === 'assert') {
        if (!input.itemType || !input.semanticKey || input.value === undefined
          || input.itemType !== target.item_type || input.semanticKey !== target.semantic_key) invalid();
        itemId = `ctx-review-${reviewId}`;
        const envelope = itemEnvelope({
          itemId, entityId: input.entityId, itemType: input.itemType, semanticKey: input.semanticKey,
          value: input.value, valueFingerprint: fingerprint(input.value), derivation: 'review', authority,
          state: 'confirmed', scope: input.scope, observedAt: input.observedAt ?? this.now().toISOString(),
          evidence: input.evidence, ...(input.validFrom ? { validFrom: input.validFrom } : {}),
          ...(input.validTo ? { validTo: input.validTo } : {}), ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
        });
        await client.query(`INSERT INTO ${this.tables.derivedItems}
          (tenant_id,generation,item_id,item_type,subject_generation,subject_entity_id,semantic_key,
           value_json,search_text,derivation,review_status,authority,valid_from,valid_to,lifecycle,revision,owner_principal,acl_principals)
          VALUES ($1,$2,$3,$4,$2,$5,$6,$7::jsonb,$8,$9,'confirmed',$10,$11,$12,'active',$13,$14,$15::jsonb)`,
        [input.tenantId, entity.generation, itemId, input.itemType, input.entityId, input.semanticKey,
          JSON.stringify(envelope), searchable(input.value), authority === 'steward' ? 'steward' : 'user',
          authority === 'steward' ? 'authoritative' : 'advisory', input.validFrom ?? this.now().toISOString(),
          input.validTo ?? null, nextRevision, input.scope.type === 'person' ? input.scope.personId : null,
          JSON.stringify(input.scope.type === 'person' ? [input.scope.personId] : [])]);
        await insertEvidence(client, this.tables, this.baseTables, input.tenantId, entity.generation, itemId, input.evidence);
      } else {
        itemId = target.item_id;
        reviewGeneration = target.generation;
      }
      const comment = JSON.stringify({ scope: input.scope, action: input.action,
        targetItemId: input.targetItemId, rejectFingerprint: input.rejectFingerprint ?? null,
        entityRevision: nextRevision });
      await client.query(`INSERT INTO ${this.tables.reviews}
        (tenant_id,generation,item_id,review_id,review_status,reviewer_principal,comment,authority)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [input.tenantId, reviewGeneration, itemId, reviewId, input.action === 'reject' ? 'rejected' : 'confirmed',
        input.actorId, comment, authority === 'steward' ? 'authoritative' : 'advisory']);
      return {
        reviewId, tenantId: input.tenantId, entityId: input.entityId, entityRevision: nextRevision,
        actorId: input.actorId, scope: input.scope, authority, action: input.action,
        ...(input.action === 'assert' ? { itemId } : {}),
        ...(input.rejectFingerprint ? { rejectFingerprint: input.rejectFingerprint } : {}),
        createdAt: this.now().toISOString(),
      };
    });
  }

  async appendProposed(tenantId: string, item: DerivedItemCandidate): Promise<void> {
    if (item.state !== 'proposed' || item.derivation !== 'distill' || item.evidence.length === 0) invalid();
    await this.tx(async client => {
      const entity = await this.currentEntity(client, tenantId, item.entityId, true);
      if (!entity) throw new DerivedStoreError('DERIVED_NOT_FOUND');
      await client.query(`INSERT INTO ${this.tables.derivedItems}
        (tenant_id,generation,item_id,item_type,subject_generation,subject_entity_id,semantic_key,
         value_json,search_text,derivation,review_status,authority,valid_from,valid_to,lifecycle,revision)
        VALUES ($1,$2,$3,$4,$2,$5,$6,$7::jsonb,$8,'llm','proposed','informational',$9,$10,'active',1)
        ON CONFLICT (tenant_id,generation,item_id) DO NOTHING`,
      [tenantId, entity.generation, item.itemId, item.itemType, item.entityId, item.semanticKey,
        JSON.stringify(itemEnvelope(item)), searchable(item.value), item.validFrom ?? item.observedAt, item.validTo ?? null]);
      await insertEvidence(client, this.tables, this.baseTables, tenantId, entity.generation, item.itemId, item.evidence);
    });
  }

  async getProfile(tenantId: string, entityId: string, viewerId?: string): Promise<DerivedProfile> {
    const entity = await this.currentEntity(this.options.pool, tenantId, entityId, false);
    const items = entity ? await this.listActiveItems({ tenantId, entityId, ...(viewerId ? { viewerId } : {}) }) : [];
    return reduceDerivedProfile({ tenantId, entityId, ...(viewerId ? { viewerId } : {}), entityVisible: Boolean(entity), items });
  }

  async entityExists(tenantId: string, entityId: string): Promise<boolean> {
    assertId(tenantId); assertId(entityId);
    return Boolean(await this.currentEntity(this.options.pool, tenantId, entityId, false));
  }

  async loadEvidence(tenantId: string, evidence: DerivedEvidenceRef): Promise<{
    exists: boolean; recordVisible: boolean; content: ContextJson;
  } | null> {
    assertId(tenantId); validateEvidence(evidence);
    const result = await this.options.pool.query(`SELECT v.content_json,
        (r.deleted=FALSE AND r.revoked=FALSE) AS record_visible
      FROM ${this.baseTables.evidence} ev
      JOIN ${this.baseTables.revisions} v ON v.tenant_id=ev.tenant_id AND v.source_id=ev.source_id
        AND v.collection_id=ev.collection_id AND v.record_id=ev.record_id AND v.revision=ev.revision
      JOIN ${this.baseTables.records} r ON r.tenant_id=ev.tenant_id AND r.source_id=ev.source_id
        AND r.collection_id=ev.collection_id AND r.record_id=ev.record_id
      WHERE ev.tenant_id=$1 AND ev.source_id=$2 AND ev.collection_id=$3 AND ev.record_id=$4
        AND ev.revision=$5 AND ev.evidence_id=$6`,
    [tenantId, evidence.sourceId, evidence.collectionId, evidence.recordId, evidence.recordRevision, evidence.evidenceId]);
    return result.rows[0] ? {
      exists: true, recordVisible: Boolean(result.rows[0].record_visible), content: jsonValue(result.rows[0].content_json),
    } : null;
  }

  private async applyEvent(client: PoolClient, event: ClaimedContextRecord, projection: DerivedProjection): Promise<void> {
    // Every canonical item/evidence writer serializes through the current entity row before item rows.
    await this.lockCanonicalEntities(client, event, projection.entities.map(entity => entity.entityId));
    if (event.deleted || event.revoked || event.eventType !== 'context.record.upserted') {
      const lifecycle = event.deleted ? 'deleted' : 'revoked';
      await client.query(`UPDATE ${this.tables.entities} SET lifecycle=$6,updated_at=NOW()
        WHERE tenant_id=$1 AND source_id=$2 AND collection_id=$3 AND record_id=$4 AND record_revision<=$5`,
      [event.tenantId, event.sourceId, event.collectionId, event.recordId, event.recordRevision, lifecycle]);
      await client.query(`UPDATE ${this.tables.derivedItems} i SET lifecycle=$6,updated_at=NOW()
        FROM ${this.tables.itemEvidence} ie WHERE i.tenant_id=$1 AND ie.tenant_id=i.tenant_id
          AND ie.generation=i.generation AND ie.item_id=i.item_id AND ie.source_id=$2
          AND ie.collection_id=$3 AND ie.record_id=$4 AND ie.record_revision<=$5`,
      [event.tenantId, event.sourceId, event.collectionId, event.recordId, event.recordRevision, lifecycle]);
      await client.query(`UPDATE ${this.tables.relationCandidates} c
        SET lifecycle=$6,resolution_status='pending',valid_to=COALESCE(valid_to,GREATEST(valid_from,NOW())),updated_at=NOW()
        WHERE c.tenant_id=$1 AND (
          (c.source_id=$2 AND c.collection_id=$3 AND c.record_id=$4 AND c.record_revision<=$5)
          OR (c.evidence_source_id=$2 AND c.evidence_collection_id=$3
            AND c.evidence_record_id=$4 AND c.evidence_revision<=$5)
          OR EXISTS (SELECT 1 FROM ${this.tables.entities} en
            WHERE en.tenant_id=c.tenant_id AND en.entity_id IN (c.from_entity_id,c.to_entity_id)
              AND en.source_id=$2 AND en.collection_id=$3 AND en.record_id=$4 AND en.record_revision<=$5)
        )`,
      [event.tenantId, event.sourceId, event.collectionId, event.recordId, event.recordRevision, lifecycle]);
      await client.query(`UPDATE ${this.tables.entityLinks}
        SET revoked=TRUE,lifecycle=$6,valid_to=COALESCE(valid_to,GREATEST(valid_from,NOW())),updated_at=NOW()
        WHERE tenant_id=$1 AND (
          (from_source_id=$2 AND from_collection_id=$3 AND from_record_id=$4 AND from_revision<=$5)
          OR (to_source_id=$2 AND to_collection_id=$3 AND to_record_id=$4 AND to_revision<=$5)
          OR (evidence_source_id=$2 AND evidence_collection_id=$3 AND evidence_record_id=$4 AND evidence_revision<=$5)
        )`,
      [event.tenantId, event.sourceId, event.collectionId, event.recordId, event.recordRevision, lifecycle]);
      await client.query(`UPDATE ${this.tables.itemEvidence} SET revoked=TRUE,updated_at=NOW()
        WHERE tenant_id=$1 AND source_id=$2 AND collection_id=$3 AND record_id=$4 AND record_revision<=$5`,
      [event.tenantId, event.sourceId, event.collectionId, event.recordId, event.recordRevision]);
      await client.query(`UPDATE ${this.tables.profileFacetEvidence} SET revoked=TRUE,updated_at=NOW()
        WHERE tenant_id=$1 AND source_id=$2 AND collection_id=$3 AND record_id=$4 AND record_revision<=$5`,
      [event.tenantId, event.sourceId, event.collectionId, event.recordId, event.recordRevision]);
      return;
    }
    const generation = event.seq;
    // A source revision replaces all candidates emitted by the previous revision.
    // Stable relation IDs that are emitted again are reactivated below.
    await client.query(`UPDATE ${this.tables.relationCandidates}
      SET lifecycle='superseded',resolution_status='pending',valid_to=COALESCE(valid_to,GREATEST(valid_from,NOW())),updated_at=NOW()
      WHERE tenant_id=$1 AND source_id=$2 AND collection_id=$3 AND record_id=$4
        AND record_revision<$5 AND lifecycle='active'`,
    [event.tenantId, event.sourceId, event.collectionId, event.recordId, event.recordRevision]);
    await client.query(`UPDATE ${this.tables.entityLinks} l
      SET revoked=TRUE,lifecycle='superseded',valid_to=COALESCE(l.valid_to,GREATEST(l.valid_from,NOW())),updated_at=NOW()
      WHERE l.tenant_id=$1 AND l.lifecycle='active' AND EXISTS (
        SELECT 1 FROM ${this.tables.relationCandidates} c
        WHERE c.tenant_id=l.tenant_id AND c.relation_id=l.link_id
          AND c.source_id=$2 AND c.collection_id=$3 AND c.record_id=$4 AND c.record_revision<$5
      )`, [event.tenantId, event.sourceId, event.collectionId, event.recordId, event.recordRevision]);

    for (const entity of projection.entities) await this.upsertEntity(client, event.tenantId, generation, entity);
    const changedEntityIds = [...new Set(projection.entities.map(entity => entity.entityId))];
    if (changedEntityIds.length > 0) {
      await client.query(`UPDATE ${this.tables.relationCandidates}
        SET resolution_status='pending',updated_at=NOW()
        WHERE tenant_id=$1 AND lifecycle='active'
          AND (from_entity_id=ANY($2::text[]) OR to_entity_id=ANY($2::text[]))`,
      [event.tenantId, changedEntityIds]);
    }
    for (const item of projection.items) await this.upsertSourceItem(client, event.tenantId, generation, item);
    for (const relation of projection.relations) await this.upsertRelationCandidate(client, event.tenantId, relation);
    await this.materializePendingRelations(client, event.tenantId, RELATION_RESOLVE_LIMIT);
  }

  private async upsertEntity(client: PoolClient, tenantId: string, generation: string, entity: DerivedEntityCandidate): Promise<void> {
    await client.query(`UPDATE ${this.tables.entities} SET lifecycle='superseded',valid_to=NOW(),updated_at=NOW()
      WHERE tenant_id=$1 AND entity_id=$2 AND source_id=$3 AND collection_id=$4 AND record_id=$5
        AND record_revision<$6 AND lifecycle='active'`,
    [tenantId, entity.entityId, entity.sourceId, entity.collectionId, entity.recordId, entity.recordRevision]);
    await client.query(`INSERT INTO ${this.tables.entities}
      (tenant_id,generation,entity_id,entity_type,native_id,source_id,collection_id,record_id,record_revision,
       display_name,payload_json,valid_from,lifecycle,owner_principal,acl_principals)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,NOW(),'active',$12,$13::jsonb)
      ON CONFLICT (tenant_id,generation,entity_id) DO UPDATE SET
        display_name=EXCLUDED.display_name,payload_json=EXCLUDED.payload_json,lifecycle='active',
        owner_principal=EXCLUDED.owner_principal,acl_principals=EXCLUDED.acl_principals,updated_at=NOW()`,
    [tenantId, generation, entity.entityId, entity.entityType.toLowerCase(), entity.stableKey,
      entity.sourceId, entity.collectionId, entity.recordId, entity.recordRevision,
      entity.label ?? entity.stableKey, JSON.stringify(entity.metadata), entity.ownerPrincipal ?? null,
      JSON.stringify(entity.aclPrincipals ?? [])]);
  }

  private async upsertSourceItem(client: PoolClient, tenantId: string, generation: string, item: DerivedItemCandidate): Promise<void> {
    if (item.itemType !== 'Status' && item.itemType !== 'Task') return;
    await client.query(`UPDATE ${this.tables.derivedItems} old SET lifecycle='superseded',valid_to=NOW(),updated_at=NOW()
      FROM ${this.tables.itemEvidence} ie
      WHERE old.tenant_id=$1 AND old.subject_entity_id=$2 AND old.item_type=$3 AND old.semantic_key=$4
        AND old.lifecycle='active' AND old.derivation='source' AND ie.tenant_id=old.tenant_id AND ie.generation=old.generation AND ie.item_id=old.item_id
        AND ie.source_id=$5 AND ie.collection_id=$6 AND ie.record_id=$7 AND ie.record_revision<$8`,
    [tenantId, item.entityId, item.itemType, item.semanticKey, item.sourceId, item.collectionId, item.recordId, item.recordRevision]);
    await client.query(`INSERT INTO ${this.tables.derivedItems}
      (tenant_id,generation,item_id,item_type,subject_generation,subject_entity_id,semantic_key,
       value_json,search_text,derivation,review_status,authority,valid_from,valid_to,lifecycle,revision,
       owner_principal,acl_principals)
      VALUES ($1,$2,$3,$4,$2,$5,$6,$7::jsonb,$8,'source','confirmed','informational',$9,$10,'active',$11,$12,$13::jsonb)
      ON CONFLICT (tenant_id,generation,item_id) DO UPDATE SET
        value_json=EXCLUDED.value_json,review_status='confirmed',lifecycle='active',
        owner_principal=EXCLUDED.owner_principal,acl_principals=EXCLUDED.acl_principals,updated_at=NOW()`,
    [tenantId, generation, item.itemId, item.itemType, item.entityId, item.semanticKey,
      JSON.stringify(itemEnvelope(item)), searchable(item.value), item.validFrom ?? item.observedAt,
      item.validTo ?? null, item.recordRevision ?? 1, item.ownerPrincipal ?? null,
      JSON.stringify(item.aclPrincipals ?? [])]);
    await insertEvidence(client, this.tables, this.baseTables, tenantId, generation, item.itemId, item.evidence);
    const conflict = await client.query(`SELECT COUNT(DISTINCT i.value_json->>'valueFingerprint')::integer count
      FROM ${this.tables.derivedItems} i
      WHERE i.tenant_id=$1 AND i.subject_entity_id=$2 AND i.item_type=$3 AND i.semantic_key=$4
        AND i.lifecycle='active' AND i.review_status='confirmed' AND i.owner_principal IS NULL`,
    [tenantId, item.entityId, item.itemType, item.semanticKey]);
    if (Number(conflict.rows[0]?.count ?? 0) > 1) {
      await client.query(`UPDATE ${this.tables.derivedItems} SET conflict_status='open',updated_at=NOW()
        WHERE tenant_id=$1 AND subject_entity_id=$2 AND item_type=$3 AND semantic_key=$4
          AND lifecycle='active' AND review_status='confirmed' AND owner_principal IS NULL`,
      [tenantId, item.entityId, item.itemType, item.semanticKey]);
    }
  }

  private async upsertRelationCandidate(
    client: PoolClient,
    tenantId: string,
    relation: DerivedProjection['relations'][number],
  ): Promise<void> {
    const evidence = relation.evidence[0];
    if (!evidence) return; // all persisted relations are evidence-bound
    await client.query(`INSERT INTO ${this.tables.relationCandidates}
      (tenant_id,relation_id,from_entity_id,to_entity_id,relation_type,relation_class,authority,review_status,
       source_id,collection_id,record_id,record_revision,
       evidence_source_id,evidence_collection_id,evidence_record_id,evidence_revision,evidence_id,
       valid_from,valid_to,lifecycle,resolution_status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'active','pending')
      ON CONFLICT (tenant_id,relation_id) DO UPDATE SET
        from_entity_id=EXCLUDED.from_entity_id,to_entity_id=EXCLUDED.to_entity_id,
        relation_type=EXCLUDED.relation_type,relation_class=EXCLUDED.relation_class,
        authority=EXCLUDED.authority,review_status=EXCLUDED.review_status,
        source_id=EXCLUDED.source_id,collection_id=EXCLUDED.collection_id,
        record_id=EXCLUDED.record_id,record_revision=EXCLUDED.record_revision,
        evidence_source_id=EXCLUDED.evidence_source_id,evidence_collection_id=EXCLUDED.evidence_collection_id,
        evidence_record_id=EXCLUDED.evidence_record_id,evidence_revision=EXCLUDED.evidence_revision,
        evidence_id=EXCLUDED.evidence_id,valid_from=EXCLUDED.valid_from,valid_to=EXCLUDED.valid_to,
        lifecycle='active',resolution_status='pending',updated_at=NOW()`,
    [tenantId, relation.relationId, relation.fromEntityId, relation.toEntityId, relation.relationType,
      relation.relationClass, relation.authority, relation.reviewStatus,
      relation.sourceId, relation.collectionId, relation.recordId, relation.recordRevision,
      evidence.sourceId, evidence.collectionId, evidence.recordId, evidence.recordRevision, evidence.evidenceId,
      relation.validFrom, relation.validTo ?? null]);
  }

  /** Materializes at most limit resolvable candidates; unresolved rows remain pending. */
  private async materializePendingRelations(client: PoolClient, tenantId: string, limit: number): Promise<number> {
    const result = await client.query(`WITH resolvable AS (
      SELECT c.*,
        f.source_id AS from_source_id,f.collection_id AS from_collection_id,
        f.record_id AS from_record_id,f.record_revision AS from_revision,
        t.source_id AS to_source_id,t.collection_id AS to_collection_id,
        t.record_id AS to_record_id,t.record_revision AS to_revision
      FROM ${this.tables.relationCandidates} c
      JOIN LATERAL (
        SELECT en.source_id,en.collection_id,en.record_id,en.record_revision
        FROM ${this.tables.entities} en
        JOIN ${this.baseTables.records} r ON r.tenant_id=en.tenant_id AND r.source_id=en.source_id
          AND r.collection_id=en.collection_id AND r.record_id=en.record_id
          AND r.deleted=FALSE AND r.revoked=FALSE
        WHERE en.tenant_id=c.tenant_id AND en.entity_id=c.from_entity_id AND en.lifecycle='active'
        ORDER BY en.generation DESC LIMIT 1
      ) f ON TRUE
      JOIN LATERAL (
        SELECT en.source_id,en.collection_id,en.record_id,en.record_revision
        FROM ${this.tables.entities} en
        JOIN ${this.baseTables.records} r ON r.tenant_id=en.tenant_id AND r.source_id=en.source_id
          AND r.collection_id=en.collection_id AND r.record_id=en.record_id
          AND r.deleted=FALSE AND r.revoked=FALSE
        WHERE en.tenant_id=c.tenant_id AND en.entity_id=c.to_entity_id AND en.lifecycle='active'
        ORDER BY en.generation DESC LIMIT 1
      ) t ON TRUE
      WHERE c.tenant_id=$1 AND c.lifecycle='active' AND c.resolution_status='pending'
        AND c.review_status<>'rejected'
        AND (f.source_id,f.collection_id,f.record_id,f.record_revision)
          IS DISTINCT FROM (t.source_id,t.collection_id,t.record_id,t.record_revision)
      ORDER BY c.updated_at,c.relation_id
      LIMIT $2
      FOR UPDATE OF c SKIP LOCKED
    ), materialized AS (
      INSERT INTO ${this.tables.entityLinks}
        (tenant_id,link_id,from_source_id,from_collection_id,from_record_id,from_revision,
         to_source_id,to_collection_id,to_record_id,to_revision,link_type,
         evidence_source_id,evidence_collection_id,evidence_record_id,evidence_revision,
         from_entity_id,to_entity_id,relation_class,authority,review_status,evidence_id,
         valid_from,valid_to,lifecycle,revoked)
      SELECT tenant_id,relation_id,from_source_id,from_collection_id,from_record_id,from_revision,
        to_source_id,to_collection_id,to_record_id,to_revision,relation_type,
        evidence_source_id,evidence_collection_id,evidence_record_id,evidence_revision,
        from_entity_id,to_entity_id,relation_class,authority,review_status,evidence_id,
        valid_from,valid_to,'active',FALSE
      FROM resolvable
      ON CONFLICT (tenant_id,link_id) DO UPDATE SET
        from_source_id=EXCLUDED.from_source_id,from_collection_id=EXCLUDED.from_collection_id,
        from_record_id=EXCLUDED.from_record_id,from_revision=EXCLUDED.from_revision,
        to_source_id=EXCLUDED.to_source_id,to_collection_id=EXCLUDED.to_collection_id,
        to_record_id=EXCLUDED.to_record_id,to_revision=EXCLUDED.to_revision,
        link_type=EXCLUDED.link_type,from_entity_id=EXCLUDED.from_entity_id,to_entity_id=EXCLUDED.to_entity_id,
        relation_class=EXCLUDED.relation_class,authority=EXCLUDED.authority,review_status=EXCLUDED.review_status,
        evidence_source_id=EXCLUDED.evidence_source_id,evidence_collection_id=EXCLUDED.evidence_collection_id,
        evidence_record_id=EXCLUDED.evidence_record_id,evidence_revision=EXCLUDED.evidence_revision,
        evidence_id=EXCLUDED.evidence_id,valid_from=EXCLUDED.valid_from,valid_to=EXCLUDED.valid_to,
        lifecycle='active',revoked=FALSE,updated_at=NOW()
      RETURNING tenant_id,link_id
    )
    UPDATE ${this.tables.relationCandidates} c
      SET resolution_status='materialized',updated_at=NOW()
      FROM materialized m
      WHERE c.tenant_id=m.tenant_id AND c.relation_id=m.link_id
      RETURNING c.relation_id`, [tenantId, limit]);
    return result.rowCount ?? 0;
  }

  private async applyReviewRejections(input: ListActiveItemsInput, items: ItemRow[]): Promise<ItemRow[]> {
    if (items.length === 0) return items;
    const rows = await this.options.pool.query(`SELECT r.generation,r.item_id,r.comment FROM ${this.tables.reviews} r
      JOIN ${this.tables.derivedItems} i ON i.tenant_id=r.tenant_id AND i.generation=r.generation AND i.item_id=r.item_id
      WHERE r.tenant_id=$1 AND i.subject_entity_id=$2 AND r.review_status='rejected' AND r.revoked=FALSE
        AND r.comment->>'action'='reject'`,
    [input.tenantId, input.entityId]);
    const rejected = new Set<string>();
    for (const row of rows.rows) {
      const parsed = parseObject(row.comment);
      const scope = parseObject(parsed?.scope);
      const visible = scope?.type === 'org' || (scope?.type === 'person' && scope.personId === input.viewerId);
      if (visible) rejected.add(`${String(row.generation)}\u0000${String(row.item_id)}`);
    }
    return items.filter(item => !rejected.has(`${String(item.generation)}\u0000${item.item_id}`));
  }

  private async assertLease(client: PoolClient, lease: ConsumerLease): Promise<void> {
    const result = await client.query(`SELECT 1 FROM ${this.tables.consumers}
      WHERE tenant_id=$1 AND consumer_id=$2 AND lease_owner=$3 AND lease_fence=$4
        AND cursor_seq=$5 AND lease_expires_at>NOW() FOR UPDATE`,
    [lease.tenantId, lease.consumerId, lease.leaseOwner, lease.leaseFence, lease.cursorSeq]);
    if (!result.rows[0]) throw new DerivedStoreError('DERIVED_LEASE_LOST');
  }

  private async lockCanonicalEntities(
    client: PoolClient,
    event: ClaimedContextRecord,
    projectedEntityIds: string[],
  ): Promise<void> {
    await client.query(`SELECT en.generation FROM ${this.tables.entities} en
      WHERE en.tenant_id=$1 AND en.lifecycle='active' AND (
        en.entity_id=ANY($2::text[])
        OR (en.source_id=$3 AND en.collection_id=$4 AND en.record_id=$5)
        OR en.entity_id IN (SELECT i.subject_entity_id FROM ${this.tables.derivedItems} i
          JOIN ${this.tables.itemEvidence} ie ON ie.tenant_id=i.tenant_id AND ie.generation=i.generation
            AND ie.item_id=i.item_id
          WHERE ie.tenant_id=$1 AND ie.source_id=$3 AND ie.collection_id=$4 AND ie.record_id=$5)
      )
      ORDER BY en.entity_id,en.generation FOR UPDATE OF en`,
    [event.tenantId, [...new Set(projectedEntityIds)].sort(), event.sourceId, event.collectionId, event.recordId]);
  }

  private async currentEntity(
    client: Pick<PoolClient, 'query'> | ContextPgPool,
    tenantId: string,
    entityId: string,
    lock: boolean,
  ): Promise<{ generation: string } | null> {
    const result = await client.query(`SELECT en.generation FROM ${this.tables.entities} en
      JOIN ${this.baseTables.records} r ON r.tenant_id=en.tenant_id AND r.source_id=en.source_id
        AND r.collection_id=en.collection_id AND r.record_id=en.record_id
        AND r.deleted=FALSE AND r.revoked=FALSE
      WHERE en.tenant_id=$1 AND en.entity_id=$2 AND en.lifecycle='active'
      ORDER BY en.generation DESC LIMIT 1${lock ? ' FOR UPDATE OF en' : ''}`, [tenantId, entityId]);
    return result.rows[0] ? { generation: String(result.rows[0].generation) } : null;
  }

  private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await fn(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function loadExactOutbox(
  client: PoolClient,
  tables: ContextTableNames,
  tenantId: string,
  afterSeq: string,
  limit: number,
): Promise<ClaimedContextRecord[]> {
  const result = await client.query(`
    SELECT o.*,v.content_json,v.metadata_json,v.entity_type,v.record_kind,v.native_id,v.occurred_at,
      v.source_event_id,v.owner_principal,v.acl_principals,v.deleted,v.revoked,v.source_updated_at,v.observed_at,
      COALESCE(jsonb_agg(jsonb_build_object('evidenceId',e.evidence_id,'kind',e.kind,'data',e.data_json)
        ORDER BY e.evidence_id) FILTER (WHERE e.evidence_id IS NOT NULL),'[]'::jsonb) evidence_json
    FROM ${tables.outbox} o
    JOIN ${tables.revisions} v ON v.tenant_id=o.tenant_id AND v.source_id=o.source_id
      AND v.collection_id=o.collection_id AND v.record_id=o.record_id AND v.revision=o.record_revision
    LEFT JOIN ${tables.evidence} e ON e.tenant_id=v.tenant_id AND e.source_id=v.source_id
      AND e.collection_id=v.collection_id AND e.record_id=v.record_id AND e.revision=v.revision
    WHERE o.tenant_id=$1 AND o.seq>$2
    GROUP BY o.tenant_id,o.seq,v.tenant_id,v.source_id,v.collection_id,v.record_id,v.revision
    ORDER BY o.seq LIMIT $3`, [tenantId, afterSeq, limit]);
  return result.rows.map(claimedRecordFromRow);
}

async function loadExactOutboxBySeqs(
  client: PoolClient,
  tables: ContextTableNames,
  tenantId: string,
  seqs: string[],
): Promise<ClaimedContextRecord[]> {
  if (seqs.length === 0) return [];
  const result = await client.query(`
    SELECT o.*,v.content_json,v.metadata_json,v.entity_type,v.record_kind,v.native_id,v.occurred_at,
      v.source_event_id,v.owner_principal,v.acl_principals,v.deleted,v.revoked,v.source_updated_at,v.observed_at,
      COALESCE(jsonb_agg(jsonb_build_object('evidenceId',e.evidence_id,'kind',e.kind,'data',e.data_json)
        ORDER BY e.evidence_id) FILTER (WHERE e.evidence_id IS NOT NULL),'[]'::jsonb) evidence_json
    FROM ${tables.outbox} o
    JOIN ${tables.revisions} v ON v.tenant_id=o.tenant_id AND v.source_id=o.source_id
      AND v.collection_id=o.collection_id AND v.record_id=o.record_id AND v.revision=o.record_revision
    LEFT JOIN ${tables.evidence} e ON e.tenant_id=v.tenant_id AND e.source_id=v.source_id
      AND e.collection_id=v.collection_id AND e.record_id=v.record_id AND e.revision=v.revision
    WHERE o.tenant_id=$1 AND o.seq=ANY($2::bigint[])
    GROUP BY o.tenant_id,o.seq,v.tenant_id,v.source_id,v.collection_id,v.record_id,v.revision
    ORDER BY o.seq`, [tenantId, seqs]);
  return result.rows.map(claimedRecordFromRow);
}

function claimedRecordFromRow(row: QueryResultRow): ClaimedContextRecord {
  return {
    tenantId: String(row.tenant_id),
    seq: String(row.seq),
    eventType: row.event_type,
    sourceId: String(row.source_id),
    collectionId: String(row.collection_id),
    recordId: String(row.record_id),
    recordRevision: Number(row.record_revision),
    content: jsonValue(row.content_json),
    metadata: jsonObject(row.metadata_json),
    ...(row.entity_type ? { entityType: String(row.entity_type) as ClaimedContextRecord['entityType'] } : {}),
    ...(row.record_kind ? { recordKind: String(row.record_kind) as ClaimedContextRecord['recordKind'] } : {}),
    ...(row.native_id ? { nativeId: String(row.native_id) } : {}),
    ...(row.occurred_at ? { occurredAt: iso(row.occurred_at) } : {}),
    ...(row.source_event_id ? { sourceEventId: String(row.source_event_id) } : {}),
    ...(row.owner_principal ? { ownerPrincipal: String(row.owner_principal) } : {}),
    ...(Array.isArray(row.acl_principals) ? { aclPrincipals: row.acl_principals.map(String) } : {}),
    deleted: Boolean(row.deleted),
    revoked: Boolean(row.revoked),
    ...(row.source_updated_at ? { sourceUpdatedAt: iso(row.source_updated_at) } : {}),
    observedAt: iso(row.observed_at),
    evidence: Array.isArray(row.evidence_json) ? row.evidence_json.map((value: unknown) => {
      const object = parseObject(value) ?? {};
      return {
        evidenceId: String(object.evidenceId ?? ''),
        kind: String(object.kind ?? ''),
        data: jsonObject(object.data),
      };
    }) : [],
  };
}

function itemEnvelope(item: DerivedItemCandidate): ContextObject {
  return {
    value: item.value,
    valueFingerprint: item.valueFingerprint,
    occurredAt: item.occurredAt ?? null,
    observedAt: item.observedAt,
    scope: item.scope.type === 'org' ? { type: 'org' } : { type: 'person', personId: item.scope.personId },
  };
}

function itemFromRow(row: ItemRow): DerivedItemCandidate {
  const envelope = parseObject(row.value_json) ?? {};
  const derivation = row.derivation === 'llm' ? 'distill' : row.derivation === 'source' ? 'source' : 'review';
  const authority = row.authority === 'authoritative' ? 'steward' : row.authority === 'advisory' ? 'user' : 'source';
  const scopeObject = parseObject(envelope.scope);
  const scope = scopeObject?.type === 'person' && typeof scopeObject.personId === 'string'
    ? { type: 'person' as const, personId: scopeObject.personId }
    : { type: 'org' as const };
  return {
    itemId: row.item_id,
    entityId: row.subject_entity_id,
    itemType: row.item_type,
    semanticKey: row.semantic_key,
    value: jsonValue(envelope.value),
    valueFingerprint: typeof envelope.valueFingerprint === 'string'
      ? envelope.valueFingerprint : fingerprint(jsonValue(envelope.value)),
    derivation,
    authority,
    state: row.review_status === 'proposed' ? 'proposed' : 'confirmed',
    scope,
    validFrom: iso(row.valid_from),
    ...(row.valid_to ? { validTo: iso(row.valid_to) } : {}),
    ...(typeof envelope.occurredAt === 'string' ? { occurredAt: envelope.occurredAt } : {}),
    observedAt: typeof envelope.observedAt === 'string' ? envelope.observedAt : iso(row.valid_from),
    evidence: Array.isArray(row.evidence_json)
      ? row.evidence_json.map(value => evidenceRefFromUnknown(value)).filter((value): value is DerivedEvidenceRef => Boolean(value))
      : [],
  };
}

async function insertEvidence(
  client: PoolClient,
  tables: ContextPhase4TableNames,
  baseTables: ContextTableNames,
  tenantId: string,
  generation: string,
  itemId: string,
  values: DerivedEvidenceRef[],
): Promise<void> {
  const uniqueRecords = new Set<string>();
  for (const value of values) {
    validateEvidence(value);
    const recordKey = [value.sourceId, value.collectionId, value.recordId, value.recordRevision].join('\0');
    if (uniqueRecords.has(recordKey)) continue; // migration intentionally allows one evidence row per source revision/item
    uniqueRecords.add(recordKey);
    const visible = await client.query(`SELECT 1 FROM ${baseTables.evidence} ev
      JOIN ${baseTables.records} r ON r.tenant_id=ev.tenant_id AND r.source_id=ev.source_id
        AND r.collection_id=ev.collection_id AND r.record_id=ev.record_id
      WHERE ev.tenant_id=$1 AND ev.source_id=$2 AND ev.collection_id=$3 AND ev.record_id=$4
        AND ev.revision=$5 AND ev.evidence_id=$6 AND r.deleted=FALSE AND r.revoked=FALSE`,
    [tenantId, value.sourceId, value.collectionId, value.recordId, value.recordRevision, value.evidenceId]);
    if (!visible.rows[0]) throw new DerivedStoreError('DERIVED_EVIDENCE_INVALID');
    await client.query(`INSERT INTO ${tables.itemEvidence}
      (tenant_id,generation,item_id,evidence_id,source_id,collection_id,record_id,record_revision,evidence_json)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
      ON CONFLICT (tenant_id,generation,item_id,evidence_id) DO UPDATE SET revoked=FALSE,updated_at=NOW()`,
    [tenantId, generation, itemId, value.evidenceId, value.sourceId, value.collectionId,
      value.recordId, value.recordRevision, JSON.stringify(value)]);
  }
}

async function reviewRevision(
  client: PoolClient,
  tables: ContextPhase4TableNames,
  tenantId: string,
  entityId: string,
  scope: AppendReviewInput['scope'],
): Promise<number> {
  const result = await client.query(`SELECT 1+COUNT(DISTINCT r.review_id) FILTER (WHERE
      ($3='person' AND r.comment->'scope'->>'type'='person' AND r.comment->'scope'->>'personId'=$4)
      OR ($3='org' AND r.comment->'scope'->>'type'='org')
    )::integer AS revision
    FROM ${tables.derivedItems} i LEFT JOIN ${tables.reviews} r
      ON r.tenant_id=i.tenant_id AND r.generation=i.generation AND r.item_id=i.item_id
    WHERE i.tenant_id=$1 AND i.subject_entity_id=$2
      AND r.comment->>'action' IN ('assert','reject')`,
  [tenantId, entityId, scope.type, scope.type === 'person' ? scope.personId : null]);
  return Number(result.rows[0]?.revision ?? 1);
}

async function findReviewTarget(
  client: PoolClient,
  tables: ContextPhase4TableNames,
  input: AppendReviewInput,
): Promise<{
  item_id: string;
  generation: string;
  item_type: DerivedItemType;
  semantic_key: string;
  value_fingerprint: string;
  owner_principal: string | null;
} | null> {
  const result = await client.query(`SELECT i.item_id,i.generation,i.item_type,i.semantic_key,
      i.value_json->>'valueFingerprint' AS value_fingerprint,i.owner_principal
    FROM ${tables.derivedItems} i
    WHERE i.tenant_id=$1 AND i.subject_entity_id=$2 AND i.item_id=$3
      AND i.lifecycle='active' AND i.review_status='confirmed'
      AND ($4='person' AND (i.owner_principal IS NULL OR i.owner_principal=$5)
        OR $4='org' AND i.owner_principal IS NULL)
      AND ($6::text IS NULL OR i.value_json->>'valueFingerprint'=$6)
      AND NOT EXISTS (SELECT 1 FROM ${tables.derivedItems} newer
        WHERE newer.tenant_id=i.tenant_id AND newer.subject_entity_id=i.subject_entity_id
          AND newer.item_id=i.item_id AND newer.lifecycle='active' AND newer.generation>i.generation)
    ORDER BY i.generation DESC LIMIT 1 FOR UPDATE OF i`,
  [input.tenantId, input.entityId, input.targetItemId, input.scope.type,
    input.scope.type === 'person' ? input.scope.personId : null,
    input.action === 'reject' ? input.rejectFingerprint : null]);
  return result.rows[0] ? {
    item_id: String(result.rows[0].item_id),
    generation: String(result.rows[0].generation),
    item_type: String(result.rows[0].item_type) as DerivedItemType,
    semantic_key: String(result.rows[0].semantic_key),
    value_fingerprint: String(result.rows[0].value_fingerprint),
    owner_principal: result.rows[0].owner_principal == null ? null : String(result.rows[0].owner_principal),
  } : null;
}

async function lockTargetEvidence(
  client: PoolClient,
  tables: ContextPhase4TableNames,
  tenantId: string,
  generation: string,
  itemId: string,
): Promise<DerivedEvidenceRef[]> {
  const result = await client.query(`SELECT source_id,collection_id,record_id,record_revision,evidence_id,revoked
    FROM ${tables.itemEvidence}
    WHERE tenant_id=$1 AND generation=$2 AND item_id=$3
    ORDER BY source_id,collection_id,record_id,record_revision,evidence_id
    FOR UPDATE`, [tenantId, generation, itemId]);
  return result.rows.filter(row => !Boolean(row.revoked)).map(row => ({
    sourceId: String(row.source_id),
    collectionId: String(row.collection_id),
    recordId: String(row.record_id),
    recordRevision: Number(row.record_revision),
    evidenceId: String(row.evidence_id),
  }));
}

function immutableReviewSnapshot(snapshot: DerivedReviewAuthorizationSnapshot): DerivedReviewAuthorizationSnapshot {
  const evidence = snapshot.evidence.map(ref => Object.freeze({ ...ref }));
  return Object.freeze({ ...snapshot, scope: Object.freeze({ ...snapshot.scope }), evidence: Object.freeze(evidence) });
}

function sameEvidenceRef(left: DerivedEvidenceRef, right: DerivedEvidenceRef): boolean {
  return left.sourceId === right.sourceId && left.collectionId === right.collectionId
    && left.recordId === right.recordId && left.recordRevision === right.recordRevision
    && left.evidenceId === right.evidenceId;
}

function reviewFingerprint(input: AppendReviewInput): string {
  return createHash('sha256').update(JSON.stringify({
    tenantId: input.tenantId,
    actorId: input.actorId,
    entityId: input.entityId,
    expectedRevision: input.expectedRevision,
    scope: input.scope,
    action: input.action,
    targetItemId: input.targetItemId,
    itemType: input.itemType,
    semanticKey: input.semanticKey,
    value: input.value,
    rejectFingerprint: input.rejectFingerprint,
    evidence: input.evidence,
  })).digest('hex');
}

function reviewFromRow(row: QueryResultRow, entityId: string): DerivedReview {
  const comment = parseObject(row.comment) ?? {};
  const rawScope = parseObject(comment.scope);
  const scope = rawScope?.type === 'person' && typeof rawScope.personId === 'string'
    ? { type: 'person' as const, personId: rawScope.personId } : { type: 'org' as const };
  const action = comment.action === 'reject' ? 'reject' : 'assert';
  return {
    reviewId: String(row.review_id),
    tenantId: String(row.tenant_id),
    entityId,
    entityRevision: typeof comment.entityRevision === 'number' ? comment.entityRevision : 0,
    actorId: String(row.reviewer_principal),
    scope,
    authority: row.authority === 'authoritative' ? 'steward' : 'user',
    action,
    ...(action === 'assert' ? { itemId: String(row.item_id) } : {}),
    ...(typeof comment.rejectFingerprint === 'string' ? { rejectFingerprint: comment.rejectFingerprint } : {}),
    createdAt: iso(row.created_at),
  };
}

function validateReview(input: AppendReviewInput): void {
  assertId(input.tenantId); assertId(input.actorId); assertId(input.entityId); assertId(input.targetItemId);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || input.evidence.length < 1) invalid();
  if (input.scope.type === 'person') assertId(input.scope.personId);
  if (input.action === 'assert') {
    if (!input.itemType || !['Decision', 'Status', 'Task', 'Risk', 'Commitment'].includes(input.itemType)
      || !input.semanticKey || input.value === undefined) invalid();
  } else if (!input.rejectFingerprint || !/^[0-9a-f]{64}$/.test(input.rejectFingerprint)) invalid();
  for (const evidence of input.evidence) validateEvidence(evidence);
}

function validateEvidence(value: DerivedEvidenceRef): void {
  assertId(value.sourceId); assertId(value.collectionId); assertId(value.recordId); assertId(value.evidenceId);
  if (!Number.isSafeInteger(value.recordRevision) || value.recordRevision < 1) invalid();
}

function evidenceRefFromUnknown(value: unknown): DerivedEvidenceRef | undefined {
  const object = parseObject(value);
  if (!object || typeof object.sourceId !== 'string' || typeof object.collectionId !== 'string'
    || typeof object.recordId !== 'string' || typeof object.evidenceId !== 'string') return undefined;
  const recordRevision = Number(object.recordRevision);
  if (!Number.isSafeInteger(recordRevision) || recordRevision < 1) return undefined;
  return { sourceId: object.sourceId, collectionId: object.collectionId, recordId: object.recordId, recordRevision, evidenceId: object.evidenceId };
}

function assertId(value: string): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > 500 || value.trim() !== value
    || /[\u0000-\u001f]/u.test(value)) invalid();
}

function invalid(): never { throw new DerivedStoreError('DERIVED_INVALID'); }
function iso(value: unknown): string { return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString(); }
function jsonValue(value: unknown): ContextJson {
  if (value === undefined) return null;
  return value as ContextJson;
}
function jsonObject(value: unknown): ContextObject { return parseObject(value) as ContextObject ?? {}; }
function parseObject(value: unknown): Record<string, any> | undefined {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return undefined; }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined;
}
function searchable(value: ContextJson): string {
  return (typeof value === 'string' ? value : JSON.stringify(value)).normalize('NFKC').slice(0, 4_000);
}
