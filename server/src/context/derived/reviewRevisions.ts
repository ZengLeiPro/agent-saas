import type { PoolClient } from 'pg';

import type { ContextPhase4TableNames } from '../phase4/migration.js';
import { DerivedStoreError, type AppendReviewInput, type DerivedItemType } from './types.js';

export async function reviewRevision(
  client: PoolClient,
  tables: ContextPhase4TableNames,
  tenantId: string,
  entityId: string,
  scope: AppendReviewInput['scope'],
): Promise<number> {
  const result = await client.query(`SELECT 1+COUNT(DISTINCT r.review_id) FILTER (WHERE
      ($3='person' AND r.comment::jsonb->'scope'->>'type'='person' AND r.comment::jsonb->'scope'->>'personId'=$4)
      OR ($3='org' AND r.comment::jsonb->'scope'->>'type'='org')
    )::integer AS revision
    FROM ${tables.derivedItems} i LEFT JOIN ${tables.reviews} r
      ON r.tenant_id=i.tenant_id AND r.generation=i.generation AND r.item_id=i.item_id
    WHERE i.tenant_id=$1 AND i.subject_entity_id=$2
      AND r.comment::jsonb->>'action' IN ('assert','reject')`,
  [tenantId, entityId, scope.type, scope.type === 'person' ? scope.personId : null]);
  return Number(result.rows[0]?.revision ?? 1);
}

export async function nextItemStorageRevision(
  client: PoolClient,
  tables: ContextPhase4TableNames,
  tenantId: string,
  generation: string,
  entityId: string,
  itemType: DerivedItemType,
  semanticKey: string,
): Promise<number> {
  // Scope-specific CAS revisions may overlap. The v25 item uniqueness contract is global
  // within an entity generation, so allocate a separate storage revision under the entity lock.
  const result = await client.query(`SELECT COALESCE(MAX(i.revision),0)+1 AS revision
    FROM ${tables.derivedItems} i
    WHERE i.tenant_id=$1 AND i.generation=$2 AND i.subject_generation=$2
      AND i.subject_entity_id=$3 AND i.item_type=$4 AND i.semantic_key=$5`,
  [tenantId, generation, entityId, itemType, semanticKey]);
  const revision = Number(result.rows[0]?.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new DerivedStoreError('DERIVED_INVALID');
  return revision;
}
