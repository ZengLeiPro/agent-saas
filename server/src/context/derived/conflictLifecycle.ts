import type { PoolClient } from 'pg';

import type { ContextPhase4TableNames } from '../phase4/migration.js';
import type { ClaimedContextRecord, DerivedItemType } from './types.js';

export interface ConflictGroupKey {
  subjectEntityId: string;
  itemType: DerivedItemType;
  semanticKey: string;
}

export async function findRecordConflictGroups(
  client: PoolClient,
  tables: ContextPhase4TableNames,
  event: ClaimedContextRecord,
): Promise<ConflictGroupKey[]> {
  const result = await client.query(`SELECT DISTINCT i.subject_entity_id,i.item_type,i.semantic_key
    FROM ${tables.derivedItems} i
    JOIN ${tables.itemEvidence} ie ON ie.tenant_id=i.tenant_id AND ie.generation=i.generation
      AND ie.item_id=i.item_id
    WHERE i.tenant_id=$1 AND ie.source_id=$2 AND ie.collection_id=$3 AND ie.record_id=$4
      AND ie.record_revision<=$5 AND i.lifecycle='active' AND i.review_status='confirmed'
      AND i.owner_principal IS NULL
    ORDER BY i.subject_entity_id,i.item_type,i.semantic_key`,
  [event.tenantId, event.sourceId, event.collectionId, event.recordId, event.recordRevision]);
  return result.rows.map(row => ({
    subjectEntityId: String(row.subject_entity_id),
    itemType: String(row.item_type) as DerivedItemType,
    semanticKey: String(row.semantic_key),
  }));
}

export async function recomputeOrganizationConflicts(
  client: PoolClient,
  tables: ContextPhase4TableNames,
  tenantId: string,
  groups: ConflictGroupKey[],
): Promise<void> {
  const uniqueGroups = new Map<string, ConflictGroupKey>();
  for (const group of groups) {
    uniqueGroups.set([group.subjectEntityId, group.itemType, group.semanticKey].join('\u0000'), group);
  }
  const orderedGroups = [...uniqueGroups.values()].sort((left, right) =>
    left.subjectEntityId.localeCompare(right.subjectEntityId)
    || left.itemType.localeCompare(right.itemType)
    || left.semanticKey.localeCompare(right.semanticKey));
  for (const group of orderedGroups) {
    const fingerprints = await client.query(`SELECT COUNT(DISTINCT i.value_json->>'valueFingerprint')::integer count
      FROM ${tables.derivedItems} i
      WHERE i.tenant_id=$1 AND i.subject_entity_id=$2 AND i.item_type=$3 AND i.semantic_key=$4
        AND i.lifecycle='active' AND i.review_status='confirmed' AND i.owner_principal IS NULL`,
    [tenantId, group.subjectEntityId, group.itemType, group.semanticKey]);
    const conflictOpen = Number(fingerprints.rows[0]?.count ?? 0) > 1;
    await client.query(`UPDATE ${tables.derivedItems}
      SET conflict_status=$5,updated_at=NOW()
      WHERE tenant_id=$1 AND subject_entity_id=$2 AND item_type=$3 AND semantic_key=$4
        AND lifecycle='active' AND review_status='confirmed' AND owner_principal IS NULL
        AND ($5='open' OR conflict_status='open')`,
    [tenantId, group.subjectEntityId, group.itemType, group.semanticKey, conflictOpen ? 'open' : 'none']);
  }
}
