import {
  tableNames as phase23TableNames,
  type ContextPhase23TableNames,
} from '../phase23/migration.js';
import { contextTableNames, contextTablePrefix } from '../store/migration.js';

export interface ContextPhase4TableNames extends ContextPhase23TableNames {
  relationCandidates: string;
}

/** All Phase 4 tables, including the additive durable relation candidate table. */
export function tableNames(tablePrefix?: string): ContextPhase4TableNames {
  const prefix = contextTablePrefix(tablePrefix);
  return {
    ...phase23TableNames(prefix),
    relationCandidates: `${prefix}_context_relation_candidates`,
  };
}

/**
 * Phase 4 relational-domain schema. Additive only: nullable link columns keep
 * every v25 link valid, while new projections use the evidence-bound contract.
 */
export function buildContextPhase4MigrationSql(tablePrefix?: string): string[] {
  const prefix = contextTablePrefix(tablePrefix);
  const base = contextTableNames(prefix);
  const tables = tableNames(prefix);
  const links = tables.entityLinks;
  const candidates = tables.relationCandidates;

  return [
    `ALTER TABLE ${links} ADD COLUMN IF NOT EXISTS from_entity_id TEXT`,
    `ALTER TABLE ${links} ADD COLUMN IF NOT EXISTS to_entity_id TEXT`,
    `ALTER TABLE ${links} ADD COLUMN IF NOT EXISTS relation_class TEXT
      CHECK (relation_class IS NULL OR relation_class IN ('explicit','cooccurrence','inferred'))`,
    `ALTER TABLE ${links} ADD COLUMN IF NOT EXISTS authority TEXT
      CHECK (authority IS NULL OR authority IN ('informational','advisory','authoritative'))`,
    `ALTER TABLE ${links} ADD COLUMN IF NOT EXISTS review_status TEXT
      CHECK (review_status IS NULL OR review_status IN ('proposed','confirmed','rejected'))`,
    `ALTER TABLE ${links} ADD COLUMN IF NOT EXISTS evidence_id TEXT`,
    `ALTER TABLE ${links} ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ`,
    `ALTER TABLE ${links} ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ`,
    `ALTER TABLE ${links} ADD COLUMN IF NOT EXISTS lifecycle TEXT
      CHECK (lifecycle IS NULL OR lifecycle IN ('active','superseded','revoked','deleted'))`,
    `DO $context_phase4$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
        WHERE conname='${prefix}_c26_links_contract_ck' AND conrelid=to_regclass('${links}')) THEN
        ALTER TABLE ${links} ADD CONSTRAINT ${prefix}_c26_links_contract_ck CHECK (
          relation_class IS NULL OR (
            from_entity_id IS NOT NULL AND to_entity_id IS NOT NULL AND from_entity_id <> to_entity_id
            AND authority IS NOT NULL AND review_status IS NOT NULL AND evidence_id IS NOT NULL
            AND evidence_source_id IS NOT NULL AND evidence_collection_id IS NOT NULL
            AND evidence_record_id IS NOT NULL AND evidence_revision IS NOT NULL
            AND valid_from IS NOT NULL AND lifecycle IS NOT NULL
            AND (valid_to IS NULL OR valid_to >= valid_from)
            AND (relation_class <> 'inferred' OR review_status = 'proposed')
          )
        );
      END IF;
    END $context_phase4$`,
    `DO $context_phase4$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
        WHERE conname='${prefix}_c26_links_evidence_fk' AND conrelid=to_regclass('${links}')) THEN
        ALTER TABLE ${links} ADD CONSTRAINT ${prefix}_c26_links_evidence_fk
          FOREIGN KEY (tenant_id,evidence_source_id,evidence_collection_id,evidence_record_id,evidence_revision,evidence_id)
          REFERENCES ${base.evidence}(tenant_id,source_id,collection_id,record_id,revision,evidence_id);
      END IF;
    END $context_phase4$`,
    `CREATE TABLE IF NOT EXISTS ${candidates} (
      tenant_id TEXT NOT NULL,
      relation_id TEXT NOT NULL,
      from_entity_id TEXT NOT NULL,
      to_entity_id TEXT NOT NULL,
      relation_type TEXT NOT NULL CHECK (relation_type IN ('same_as','project_of','task_of','meeting_of','mentions','event_of')),
      relation_class TEXT NOT NULL CHECK (relation_class IN ('explicit','cooccurrence','inferred')),
      authority TEXT NOT NULL CHECK (authority IN ('informational','advisory','authoritative')),
      review_status TEXT NOT NULL CHECK (review_status IN ('proposed','confirmed','rejected')),
      source_id TEXT NOT NULL,
      collection_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      record_revision BIGINT NOT NULL CHECK (record_revision > 0),
      evidence_source_id TEXT NOT NULL,
      evidence_collection_id TEXT NOT NULL,
      evidence_record_id TEXT NOT NULL,
      evidence_revision BIGINT NOT NULL CHECK (evidence_revision > 0),
      evidence_id TEXT NOT NULL,
      valid_from TIMESTAMPTZ NOT NULL,
      valid_to TIMESTAMPTZ,
      lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','superseded','revoked','deleted')),
      resolution_status TEXT NOT NULL DEFAULT 'pending' CHECK (resolution_status IN ('pending','materialized')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, relation_id),
      CHECK (from_entity_id <> to_entity_id),
      CHECK (valid_to IS NULL OR valid_to >= valid_from),
      CHECK (relation_class <> 'inferred' OR review_status = 'proposed'),
      FOREIGN KEY (tenant_id,source_id,collection_id,record_id,record_revision)
        REFERENCES ${base.revisions}(tenant_id,source_id,collection_id,record_id,revision),
      FOREIGN KEY (tenant_id,evidence_source_id,evidence_collection_id,evidence_record_id,evidence_revision,evidence_id)
        REFERENCES ${base.evidence}(tenant_id,source_id,collection_id,record_id,revision,evidence_id)
    )`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_c26_relation_candidates_pending_idx
      ON ${candidates} (tenant_id,resolution_status,updated_at,relation_id)
      WHERE lifecycle='active' AND resolution_status='pending'`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_c26_relation_candidates_from_idx
      ON ${candidates} (tenant_id,from_entity_id,relation_type,relation_id)
      WHERE lifecycle='active'`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_c26_relation_candidates_to_idx
      ON ${candidates} (tenant_id,to_entity_id,relation_type,relation_id)
      WHERE lifecycle='active'`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_c26_relation_candidates_source_idx
      ON ${candidates} (tenant_id,source_id,collection_id,record_id,record_revision)`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_c26_links_from_entity_idx
      ON ${links} (tenant_id,from_entity_id,link_type,relation_class,link_id)
      WHERE relation_class IS NOT NULL AND lifecycle='active' AND revoked=FALSE`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_c26_links_to_entity_idx
      ON ${links} (tenant_id,to_entity_id,link_type,relation_class,link_id)
      WHERE relation_class IS NOT NULL AND lifecycle='active' AND revoked=FALSE`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_c26_links_evidence_idx
      ON ${links} (tenant_id,evidence_source_id,evidence_collection_id,evidence_record_id,evidence_revision,evidence_id)
      WHERE relation_class IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_c26_links_lifecycle_idx
      ON ${links} (tenant_id,lifecycle,valid_from,valid_to,link_id)
      WHERE relation_class IS NOT NULL`,
  ];
}
