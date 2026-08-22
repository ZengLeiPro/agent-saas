import type pg from 'pg';

export type ContextPgPool = pg.Pool;

const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
// Longest generated index suffix leaves 20 bytes below PostgreSQL's 63-byte identifier limit.
const MAX_PREFIX_LENGTH = 20;

export function contextTablePrefix(value = 'runtime'): string {
  if (!IDENTIFIER_PATTERN.test(value) || value.length > MAX_PREFIX_LENGTH) {
    throw new Error(`Invalid PostgreSQL identifier: ${value}`);
  }
  return value;
}

export interface ContextTableNames {
  sources: string;
  collections: string;
  partitions: string;
  records: string;
  revisions: string;
  evidence: string;
  outbox: string;
}

export function contextTableNames(tablePrefix?: string): ContextTableNames {
  const prefix = contextTablePrefix(tablePrefix);
  return {
    sources: `${prefix}_context_sources`,
    collections: `${prefix}_context_collections`,
    partitions: `${prefix}_context_sync_partitions`,
    records: `${prefix}_context_source_records`,
    revisions: `${prefix}_context_record_revisions`,
    evidence: `${prefix}_context_evidence`,
    outbox: `${prefix}_context_outbox`,
  };
}

/** Phase 1 schema. Kept as a builder so bootstrap can register the SQL without importing a runner. */
export function buildContextMigrationSql(tablePrefix?: string): string[] {
  const t = contextTableNames(tablePrefix);
  return [
    `CREATE TABLE IF NOT EXISTS ${t.sources} (
      tenant_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','revoked','deleted')),
      config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, source_id)
    )`,
    `CREATE INDEX IF NOT EXISTS ${t.sources}_tenant_status_idx
      ON ${t.sources} (tenant_id, status, updated_at DESC)`,
    `CREATE TABLE IF NOT EXISTS ${t.collections} (
      tenant_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      collection_id TEXT NOT NULL,
      external_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','revoked','deleted')),
      metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, source_id, collection_id),
      UNIQUE (tenant_id, collection_id),
      UNIQUE (tenant_id, source_id, external_key),
      FOREIGN KEY (tenant_id, source_id) REFERENCES ${t.sources}(tenant_id, source_id) ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS ${t.collections}_tenant_status_idx
      ON ${t.collections} (tenant_id, status, source_id, updated_at DESC)`,
    `CREATE TABLE IF NOT EXISTS ${t.partitions} (
      tenant_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      collection_id TEXT NOT NULL,
      partition_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','syncing','retry_wait','complete','refused')),
      watermark_json JSONB,
      window_start TIMESTAMPTZ,
      window_end TIMESTAMPTZ,
      page_cursor TEXT,
      lease_owner TEXT,
      lease_fence BIGINT NOT NULL DEFAULT 0 CHECK (lease_fence >= 0),
      lease_expires_at TIMESTAMPTZ,
      retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
      next_retry_at TIMESTAMPTZ,
      last_error_code TEXT,
      coverage_start TIMESTAMPTZ,
      coverage_end TIMESTAMPTZ,
      truncated BOOLEAN NOT NULL DEFAULT FALSE,
      refused BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, source_id, collection_id, partition_key),
      FOREIGN KEY (tenant_id, source_id, collection_id)
        REFERENCES ${t.collections}(tenant_id, source_id, collection_id) ON DELETE CASCADE,
      CHECK (window_end IS NULL OR window_start IS NULL OR window_end >= window_start),
      CHECK (coverage_end IS NULL OR coverage_start IS NULL OR coverage_end >= coverage_start)
    )`,
    `CREATE INDEX IF NOT EXISTS ${t.partitions}_tenant_due_idx
      ON ${t.partitions} (tenant_id, status, next_retry_at, updated_at)`,
    `CREATE INDEX IF NOT EXISTS ${t.partitions}_tenant_lease_idx
      ON ${t.partitions} (tenant_id, lease_expires_at) WHERE lease_owner IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS ${t.records} (
      tenant_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      collection_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      external_record_id TEXT NOT NULL,
      current_revision BIGINT NOT NULL CHECK (current_revision >= 1),
      content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
      content_json JSONB NOT NULL,
      metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      deleted BOOLEAN NOT NULL DEFAULT FALSE,
      revoked BOOLEAN NOT NULL DEFAULT FALSE,
      source_updated_at TIMESTAMPTZ,
      observed_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, source_id, collection_id, record_id),
      UNIQUE (tenant_id, source_id, collection_id, external_record_id),
      FOREIGN KEY (tenant_id, source_id, collection_id)
        REFERENCES ${t.collections}(tenant_id, source_id, collection_id) ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS ${t.records}_tenant_visible_idx
      ON ${t.records} (tenant_id, source_id, collection_id, updated_at DESC)
      WHERE deleted=FALSE AND revoked=FALSE`,
    `CREATE TABLE IF NOT EXISTS ${t.revisions} (
      tenant_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      collection_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      revision BIGINT NOT NULL CHECK (revision >= 1),
      content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
      content_json JSONB NOT NULL,
      metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      deleted BOOLEAN NOT NULL DEFAULT FALSE,
      revoked BOOLEAN NOT NULL DEFAULT FALSE,
      source_updated_at TIMESTAMPTZ,
      observed_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, source_id, collection_id, record_id, revision),
      FOREIGN KEY (tenant_id, source_id, collection_id, record_id)
        REFERENCES ${t.records}(tenant_id, source_id, collection_id, record_id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS ${t.evidence} (
      tenant_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      collection_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      revision BIGINT NOT NULL,
      evidence_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      data_json JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, source_id, collection_id, record_id, revision, evidence_id),
      FOREIGN KEY (tenant_id, source_id, collection_id, record_id, revision)
        REFERENCES ${t.revisions}(tenant_id, source_id, collection_id, record_id, revision) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS ${t.outbox} (
      tenant_id TEXT NOT NULL,
      seq BIGINT GENERATED ALWAYS AS IDENTITY,
      event_type TEXT NOT NULL CHECK (event_type IN ('context.record.upserted','context.record.deleted','context.record.revoked')),
      source_id TEXT NOT NULL,
      collection_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      record_revision BIGINT NOT NULL CHECK (record_revision >= 1),
      payload_json JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, seq),
      UNIQUE (seq),
      FOREIGN KEY (tenant_id, source_id, collection_id, record_id, record_revision)
        REFERENCES ${t.revisions}(tenant_id, source_id, collection_id, record_id, revision) ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS ${t.outbox}_tenant_seq_idx ON ${t.outbox} (tenant_id, seq)`,
  ];
}
