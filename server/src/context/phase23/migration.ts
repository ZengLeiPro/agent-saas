import { contextTableNames, contextTablePrefix } from '../store/migration.js';

export interface ContextPhase23TableNames {
  entityLinks: string;
  consumers: string;
  entities: string;
  derivedItems: string;
  itemEvidence: string;
  reviews: string;
  profileFacets: string;
  profileFacetEvidence: string;
  derivedOutbox: string;
}

export function tableNames(tablePrefix?: string): ContextPhase23TableNames {
  const prefix = contextTablePrefix(tablePrefix);
  return {
    entityLinks: `${prefix}_context_entity_links`,
    consumers: `${prefix}_context_consumers`,
    entities: `${prefix}_context_entities`,
    derivedItems: `${prefix}_context_derived_items`,
    itemEvidence: `${prefix}_context_derived_item_evidence`,
    reviews: `${prefix}_context_derived_item_reviews`,
    profileFacets: `${prefix}_context_profile_facets`,
    profileFacetEvidence: `${prefix}_context_profile_facet_evidence`,
    derivedOutbox: `${prefix}_context_derived_outbox`,
  };
}

/** Phase 2/3 Context Plane schema. Additive only; existing Phase 1 rows are not backfilled. */
export function buildContextPhase23MigrationSql(tablePrefix?: string): string[] {
  const prefix = contextTablePrefix(tablePrefix);
  const base = contextTableNames(prefix);
  const t = tableNames(prefix);

  return [
    `ALTER TABLE ${base.records} ADD COLUMN IF NOT EXISTS entity_type TEXT
      CHECK (entity_type IS NULL OR entity_type IN ('customer','project','person','meeting','task'))`,
    `ALTER TABLE ${base.records} ADD COLUMN IF NOT EXISTS record_kind TEXT
      CHECK (record_kind IS NULL OR record_kind IN ('snapshot','event'))`,
    `ALTER TABLE ${base.records} ADD COLUMN IF NOT EXISTS native_id TEXT`,
    `ALTER TABLE ${base.records} ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ`,
    `ALTER TABLE ${base.records} ADD COLUMN IF NOT EXISTS source_event_id TEXT`,
    `ALTER TABLE ${base.records} ADD COLUMN IF NOT EXISTS owner_principal TEXT`,
    `ALTER TABLE ${base.records} ADD COLUMN IF NOT EXISTS acl_principals JSONB DEFAULT '[]'::jsonb
      CHECK (acl_principals IS NULL OR jsonb_typeof(acl_principals) = 'array')`,
    `ALTER TABLE ${base.revisions} ADD COLUMN IF NOT EXISTS entity_type TEXT
      CHECK (entity_type IS NULL OR entity_type IN ('customer','project','person','meeting','task'))`,
    `ALTER TABLE ${base.revisions} ADD COLUMN IF NOT EXISTS record_kind TEXT
      CHECK (record_kind IS NULL OR record_kind IN ('snapshot','event'))`,
    `ALTER TABLE ${base.revisions} ADD COLUMN IF NOT EXISTS native_id TEXT`,
    `ALTER TABLE ${base.revisions} ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ`,
    `ALTER TABLE ${base.revisions} ADD COLUMN IF NOT EXISTS source_event_id TEXT`,
    `ALTER TABLE ${base.revisions} ADD COLUMN IF NOT EXISTS owner_principal TEXT`,
    `ALTER TABLE ${base.revisions} ADD COLUMN IF NOT EXISTS acl_principals JSONB DEFAULT '[]'::jsonb
      CHECK (acl_principals IS NULL OR jsonb_typeof(acl_principals) = 'array')`,

    `CREATE INDEX IF NOT EXISTS ${prefix}_c23_records_entity_idx
      ON ${base.records} (tenant_id, entity_type, native_id, updated_at DESC)
      WHERE entity_type IS NOT NULL AND native_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_c23_records_event_idx
      ON ${base.records} (tenant_id, source_event_id, occurred_at DESC)
      WHERE source_event_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_c23_records_owner_idx
      ON ${base.records} (tenant_id, owner_principal, occurred_at DESC)
      WHERE owner_principal IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_c23_revisions_entity_idx
      ON ${base.revisions} (tenant_id, entity_type, native_id, occurred_at DESC)
      WHERE entity_type IS NOT NULL AND native_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_c23_revisions_event_idx
      ON ${base.revisions} (tenant_id, source_event_id, occurred_at DESC)
      WHERE source_event_id IS NOT NULL`,

    `CREATE TABLE IF NOT EXISTS ${t.entityLinks} (
      tenant_id TEXT NOT NULL,
      link_id TEXT NOT NULL,
      from_source_id TEXT NOT NULL,
      from_collection_id TEXT NOT NULL,
      from_record_id TEXT NOT NULL,
      from_revision BIGINT NOT NULL CHECK (from_revision >= 1),
      to_source_id TEXT NOT NULL,
      to_collection_id TEXT NOT NULL,
      to_record_id TEXT NOT NULL,
      to_revision BIGINT NOT NULL CHECK (to_revision >= 1),
      link_type TEXT NOT NULL CHECK (link_type IN ('same_as','project_of','task_of','meeting_of','mentions','event_of')),
      evidence_source_id TEXT,
      evidence_collection_id TEXT,
      evidence_record_id TEXT,
      evidence_revision BIGINT CHECK (evidence_revision IS NULL OR evidence_revision >= 1),
      revoked BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, link_id),
      UNIQUE (tenant_id, from_source_id, from_collection_id, from_record_id, from_revision,
        to_source_id, to_collection_id, to_record_id, to_revision, link_type),
      FOREIGN KEY (tenant_id, from_source_id, from_collection_id, from_record_id, from_revision)
        REFERENCES ${base.revisions}(tenant_id, source_id, collection_id, record_id, revision),
      FOREIGN KEY (tenant_id, to_source_id, to_collection_id, to_record_id, to_revision)
        REFERENCES ${base.revisions}(tenant_id, source_id, collection_id, record_id, revision),
      FOREIGN KEY (tenant_id, evidence_source_id, evidence_collection_id, evidence_record_id, evidence_revision)
        REFERENCES ${base.revisions}(tenant_id, source_id, collection_id, record_id, revision),
      CHECK ((evidence_source_id IS NULL AND evidence_collection_id IS NULL AND evidence_record_id IS NULL AND evidence_revision IS NULL)
        OR (evidence_source_id IS NOT NULL AND evidence_collection_id IS NOT NULL AND evidence_record_id IS NOT NULL AND evidence_revision IS NOT NULL)),
      CHECK ((from_source_id, from_collection_id, from_record_id, from_revision)
        <> (to_source_id, to_collection_id, to_record_id, to_revision))
    )`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_c23_links_from_idx
      ON ${t.entityLinks} (tenant_id, from_source_id, from_collection_id, from_record_id, link_type)
      WHERE revoked=FALSE`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_c23_links_to_idx
      ON ${t.entityLinks} (tenant_id, to_source_id, to_collection_id, to_record_id, link_type)
      WHERE revoked=FALSE`,

    `CREATE TABLE IF NOT EXISTS ${t.consumers} (
      tenant_id TEXT NOT NULL,
      consumer_id TEXT NOT NULL,
      cursor_seq BIGINT NOT NULL DEFAULT 0 CHECK (cursor_seq >= 0),
      status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','running','retry_wait','disabled')),
      lease_owner TEXT,
      lease_fence BIGINT NOT NULL DEFAULT 0 CHECK (lease_fence >= 0),
      lease_expires_at TIMESTAMPTZ,
      last_error_code TEXT,
      last_error_message TEXT,
      last_heartbeat_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, consumer_id),
      CHECK ((lease_owner IS NULL AND lease_expires_at IS NULL) OR lease_owner IS NOT NULL)
    )`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_c23_consumers_lease_idx
      ON ${t.consumers} (tenant_id, status, lease_expires_at, updated_at)`,

    `CREATE TABLE IF NOT EXISTS ${t.entities} (
      tenant_id TEXT NOT NULL,
      generation BIGINT NOT NULL CHECK (generation >= 1),
      entity_id TEXT NOT NULL,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('customer','project','person','meeting','task')),
      native_id TEXT NOT NULL,
      source_id TEXT,
      collection_id TEXT,
      record_id TEXT,
      record_revision BIGINT CHECK (record_revision IS NULL OR record_revision >= 1),
      display_name TEXT NOT NULL,
      payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      owner_principal TEXT,
      acl_principals JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(acl_principals) = 'array'),
      valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      valid_to TIMESTAMPTZ,
      lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','superseded','revoked','deleted')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, generation, entity_id),
      UNIQUE (tenant_id, generation, entity_type, source_id, native_id),
      FOREIGN KEY (tenant_id, source_id, collection_id, record_id, record_revision)
        REFERENCES ${base.revisions}(tenant_id, source_id, collection_id, record_id, revision),
      CHECK ((source_id IS NULL AND collection_id IS NULL AND record_id IS NULL AND record_revision IS NULL)
        OR (source_id IS NOT NULL AND collection_id IS NOT NULL AND record_id IS NOT NULL AND record_revision IS NOT NULL)),
      CHECK (valid_to IS NULL OR valid_to >= valid_from)
    )`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_c23_entities_native_idx
      ON ${t.entities} (tenant_id, entity_type, source_id, native_id, generation DESC)
      WHERE lifecycle='active'`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_c23_entities_valid_idx
      ON ${t.entities} (tenant_id, entity_type, valid_from, valid_to, generation DESC)
      WHERE lifecycle='active'`,

    `CREATE TABLE IF NOT EXISTS ${t.derivedItems} (
      tenant_id TEXT NOT NULL,
      generation BIGINT NOT NULL CHECK (generation >= 1),
      item_id TEXT NOT NULL,
      item_type TEXT NOT NULL CHECK (item_type IN ('Decision','Status','Task','Risk','Commitment')),
      subject_generation BIGINT NOT NULL CHECK (subject_generation >= 1),
      subject_entity_id TEXT NOT NULL,
      semantic_key TEXT NOT NULL,
      value_json JSONB NOT NULL,
      search_text TEXT NOT NULL DEFAULT '',
      derivation TEXT NOT NULL CHECK (derivation IN ('source','llm','user','steward')),
      review_status TEXT NOT NULL DEFAULT 'proposed' CHECK (review_status IN ('proposed','confirmed','rejected')),
      authority TEXT NOT NULL DEFAULT 'informational' CHECK (authority IN ('informational','advisory','authoritative')),
      valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      valid_to TIMESTAMPTZ,
      conflict_status TEXT NOT NULL DEFAULT 'none' CHECK (conflict_status IN ('none','open','resolved')),
      lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','superseded','revoked','deleted')),
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
      owner_principal TEXT,
      acl_principals JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(acl_principals) = 'array'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, generation, item_id),
      UNIQUE (tenant_id, generation, subject_generation, subject_entity_id, item_type, semantic_key, revision),
      FOREIGN KEY (tenant_id, subject_generation, subject_entity_id)
        REFERENCES ${t.entities}(tenant_id, generation, entity_id),
      CHECK (valid_to IS NULL OR valid_to >= valid_from)
    )`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_c23_items_subject_idx
      ON ${t.derivedItems} (tenant_id, subject_generation, subject_entity_id, item_type, lifecycle, updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_c23_items_review_idx
      ON ${t.derivedItems} (tenant_id, review_status, conflict_status, updated_at) WHERE lifecycle='active'`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_c23_items_semantic_idx
      ON ${t.derivedItems} (tenant_id, semantic_key, item_type, generation DESC) WHERE lifecycle='active'`,

    `CREATE TABLE IF NOT EXISTS ${t.itemEvidence} (
      tenant_id TEXT NOT NULL,
      generation BIGINT NOT NULL,
      item_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      collection_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      record_revision BIGINT NOT NULL CHECK (record_revision >= 1),
      evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      revoked BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, generation, item_id, evidence_id),
      UNIQUE (tenant_id, generation, item_id, source_id, collection_id, record_id, record_revision),
      FOREIGN KEY (tenant_id, generation, item_id)
        REFERENCES ${t.derivedItems}(tenant_id, generation, item_id),
      FOREIGN KEY (tenant_id, source_id, collection_id, record_id, record_revision)
        REFERENCES ${base.revisions}(tenant_id, source_id, collection_id, record_id, revision)
    )`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_c23_item_evidence_src_idx
      ON ${t.itemEvidence} (tenant_id, source_id, collection_id, record_id, record_revision)
      WHERE revoked=FALSE`,

    `CREATE TABLE IF NOT EXISTS ${t.reviews} (
      tenant_id TEXT NOT NULL,
      generation BIGINT NOT NULL,
      item_id TEXT NOT NULL,
      review_id TEXT NOT NULL,
      review_status TEXT NOT NULL CHECK (review_status IN ('proposed','confirmed','rejected')),
      reviewer_principal TEXT NOT NULL,
      comment TEXT,
      authority TEXT NOT NULL DEFAULT 'informational' CHECK (authority IN ('informational','advisory','authoritative')),
      revoked BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, generation, item_id, review_id),
      FOREIGN KEY (tenant_id, generation, item_id)
        REFERENCES ${t.derivedItems}(tenant_id, generation, item_id)
    )`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_c23_reviews_item_idx
      ON ${t.reviews} (tenant_id, generation, item_id, created_at DESC) WHERE revoked=FALSE`,

    `CREATE TABLE IF NOT EXISTS ${t.profileFacets} (
      tenant_id TEXT NOT NULL,
      generation BIGINT NOT NULL CHECK (generation >= 1),
      principal_id TEXT NOT NULL,
      facet_id TEXT NOT NULL,
      facet_type TEXT NOT NULL CHECK (facet_type IN ('role','tasks','workflow','artifacts','knowhow')),
      semantic_key TEXT NOT NULL,
      value_json JSONB NOT NULL,
      search_text TEXT NOT NULL DEFAULT '',
      derivation TEXT NOT NULL CHECK (derivation IN ('source','llm','user','steward')),
      review_status TEXT NOT NULL DEFAULT 'proposed' CHECK (review_status IN ('proposed','confirmed','rejected')),
      authority TEXT NOT NULL DEFAULT 'informational' CHECK (authority IN ('informational','advisory','authoritative')),
      valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      valid_to TIMESTAMPTZ,
      lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','superseded','revoked','deleted')),
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
      owner_principal TEXT,
      acl_principals JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(acl_principals) = 'array'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, generation, principal_id, facet_id),
      UNIQUE (tenant_id, generation, principal_id, facet_type, semantic_key, revision),
      CHECK (valid_to IS NULL OR valid_to >= valid_from)
    )`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_c23_facets_principal_idx
      ON ${t.profileFacets} (tenant_id, principal_id, facet_type, lifecycle, generation DESC)`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_c23_facets_review_idx
      ON ${t.profileFacets} (tenant_id, review_status, updated_at) WHERE lifecycle='active'`,

    `CREATE TABLE IF NOT EXISTS ${t.profileFacetEvidence} (
      tenant_id TEXT NOT NULL,
      generation BIGINT NOT NULL,
      principal_id TEXT NOT NULL,
      facet_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      collection_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      record_revision BIGINT NOT NULL CHECK (record_revision >= 1),
      evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      revoked BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, generation, principal_id, facet_id, evidence_id),
      UNIQUE (tenant_id, generation, principal_id, facet_id, source_id, collection_id, record_id, record_revision),
      FOREIGN KEY (tenant_id, generation, principal_id, facet_id)
        REFERENCES ${t.profileFacets}(tenant_id, generation, principal_id, facet_id),
      FOREIGN KEY (tenant_id, source_id, collection_id, record_id, record_revision)
        REFERENCES ${base.revisions}(tenant_id, source_id, collection_id, record_id, revision)
    )`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_c23_facet_evidence_src_idx
      ON ${t.profileFacetEvidence} (tenant_id, source_id, collection_id, record_id, record_revision)
      WHERE revoked=FALSE`,

    `CREATE TABLE IF NOT EXISTS ${t.derivedOutbox} (
      tenant_id TEXT NOT NULL,
      seq BIGINT GENERATED ALWAYS AS IDENTITY,
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('context.entity.changed','context.derived_item.changed','context.profile_facet.changed')),
      aggregate_type TEXT NOT NULL CHECK (aggregate_type IN ('entity','derived_item','profile_facet')),
      aggregate_id TEXT NOT NULL,
      generation BIGINT NOT NULL CHECK (generation >= 1),
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
      payload_json JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','delivered','failed','revoked')),
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      lease_owner TEXT,
      lease_expires_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, seq),
      UNIQUE (tenant_id, event_id)
    )`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_c23_derived_outbox_due_idx
      ON ${t.derivedOutbox} (tenant_id, status, seq, lease_expires_at)`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_c23_derived_outbox_agg_idx
      ON ${t.derivedOutbox} (tenant_id, aggregate_type, aggregate_id, generation, revision)`,
  ];
}
