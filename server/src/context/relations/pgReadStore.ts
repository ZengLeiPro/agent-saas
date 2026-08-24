import type { QueryResultRow } from 'pg';

import { tableNames } from '../phase23/migration.js';
import { contextTablePrefix, type ContextPgPool } from '../store/migration.js';
import type {
  RelationAuthority,
  RelationClass,
  RelationEdgeCandidate,
  RelationLifecycle,
  RelationReadInput,
  RelationReadStore,
  RelationReviewStatus,
  RelationType,
} from './types.js';

const ID_PATTERN = /^[^\u0000]{1,500}$/;

/** PostgreSQL candidate reader. It performs no ACL or evidence authorization. */
export class PgRelationReadStore implements RelationReadStore {
  private readonly links: string;

  constructor(private readonly pool: ContextPgPool, tablePrefix?: string) {
    this.links = tableNames(contextTablePrefix(tablePrefix)).entityLinks;
  }

  async listAdjacent(input: RelationReadInput): Promise<RelationEdgeCandidate[]> {
    validateInput(input);
    const entityIds = [...new Set(input.entityIds)].sort();
    if (entityIds.length === 0) return [];
    const result = await this.pool.query(`SELECT link_id,link_type,relation_class,authority,review_status,lifecycle,
        valid_from,valid_to,from_entity_id,to_entity_id,
        from_source_id,from_collection_id,from_record_id,from_revision,
        to_source_id,to_collection_id,to_record_id,to_revision,
        evidence_source_id,evidence_collection_id,evidence_record_id,evidence_revision,evidence_id
      FROM ${this.links}
      WHERE tenant_id=$1 AND relation_class IS NOT NULL AND lifecycle='active' AND revoked=FALSE
        AND review_status<>'rejected' AND evidence_source_id IS NOT NULL AND evidence_collection_id IS NOT NULL
        AND evidence_record_id IS NOT NULL AND evidence_revision IS NOT NULL AND evidence_id IS NOT NULL
        AND (from_entity_id=ANY($2::text[]) OR to_entity_id=ANY($2::text[]))
      ORDER BY link_id,from_entity_id,to_entity_id
      LIMIT $3`, [input.tenantId, entityIds, input.limit]);
    return result.rows.map(relationFromRow);
  }
}

function validateInput(input: RelationReadInput): void {
  if (!ID_PATTERN.test(input.tenantId) || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
    throw new Error('RELATION_READ_INVALID');
  }
  if (!Array.isArray(input.entityIds) || input.entityIds.length > 200 || input.entityIds.some(id => !ID_PATTERN.test(id))) {
    throw new Error('RELATION_READ_INVALID');
  }
}

function relationFromRow(row: QueryResultRow): RelationEdgeCandidate {
  return {
    relationId: String(row.link_id),
    relationType: String(row.link_type) as RelationType,
    relationClass: String(row.relation_class) as RelationClass,
    authority: String(row.authority) as RelationAuthority,
    reviewStatus: String(row.review_status) as RelationReviewStatus,
    lifecycle: String(row.lifecycle) as RelationLifecycle,
    validFrom: iso(row.valid_from),
    ...(row.valid_to ? { validTo: iso(row.valid_to) } : {}),
    from: {
      entityId: String(row.from_entity_id), sourceId: String(row.from_source_id),
      collectionId: String(row.from_collection_id), recordId: String(row.from_record_id),
      recordRevision: Number(row.from_revision),
    },
    to: {
      entityId: String(row.to_entity_id), sourceId: String(row.to_source_id),
      collectionId: String(row.to_collection_id), recordId: String(row.to_record_id),
      recordRevision: Number(row.to_revision),
    },
    evidence: {
      sourceId: String(row.evidence_source_id), collectionId: String(row.evidence_collection_id),
      recordId: String(row.evidence_record_id), recordRevision: Number(row.evidence_revision),
      evidenceId: String(row.evidence_id),
    },
    authorization: 'unchecked',
  };
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}
