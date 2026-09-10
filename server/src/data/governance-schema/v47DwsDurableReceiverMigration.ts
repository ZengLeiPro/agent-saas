// release-migration: expand
/** Additive reader-first schema. Applying it never migrates an account or starts a source. */
export function governanceV47DwsDurableReceiverStatements(prefix: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${prefix}_dws_receiver_owners (
      account_id TEXT PRIMARY KEY REFERENCES ${prefix}_agent_dws_accounts(account_id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL,
      receiver_id TEXT NOT NULL UNIQUE,
      source_json JSONB NOT NULL CHECK (jsonb_typeof(source_json)='object'),
      workspace_json JSONB NOT NULL CHECK (jsonb_typeof(workspace_json)='object'),
      owner_epoch BIGINT NOT NULL DEFAULT 0 CHECK (owner_epoch >= 0),
      owner_id TEXT,
      account_revision BIGINT NOT NULL,
      lease_expires_at TIMESTAMPTZ,
      received_cursor BIGINT NOT NULL DEFAULT 0 CHECK (received_cursor BETWEEN 0 AND 9007199254740991),
      acknowledged_cursor BIGINT NOT NULL DEFAULT 0 CHECK (acknowledged_cursor BETWEEN 0 AND received_cursor),
      state TEXT NOT NULL DEFAULT 'registered' CHECK (state IN ('registered','receiving','stopping','stopped','blocked')),
      last_error_code TEXT,
      bridge_evidence_json JSONB NOT NULL CHECK (jsonb_typeof(bridge_evidence_json)='object'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    )`,
    `CREATE TABLE IF NOT EXISTS ${prefix}_dws_receiver_inbox (
      account_id TEXT NOT NULL REFERENCES ${prefix}_agent_dws_accounts(account_id) ON DELETE CASCADE,
      receiver_id TEXT NOT NULL,
      sequence BIGINT NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
      tenant_id TEXT NOT NULL,
      account_revision BIGINT NOT NULL,
      account_identity_json JSONB NOT NULL,
      payload BYTEA NOT NULL CHECK (octet_length(payload) <= 1048576),
      payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
      received_at_ms BIGINT NOT NULL CHECK (received_at_ms > 0),
      event_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('pending','forwarded','dead_letter')),
      reason_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      forwarded_at TIMESTAMPTZ,
      PRIMARY KEY (account_id,receiver_id,sequence)
    )`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_dws_receiver_inbox_pending_idx
      ON ${prefix}_dws_receiver_inbox(account_id,receiver_id,sequence) WHERE state='pending'`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_dws_receiver_inbox_event_idx
      ON ${prefix}_dws_receiver_inbox(account_id,event_id) WHERE event_id IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS ${prefix}_dws_receiver_migrations (
      migration_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES ${prefix}_agent_dws_accounts(account_id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL,
      expected_revision BIGINT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('planned','handoff_pending','blocked','activated','aborted')),
      evidence_json JSONB NOT NULL,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ${prefix}_dws_receiver_migration_active_idx
      ON ${prefix}_dws_receiver_migrations(account_id) WHERE state IN ('planned','handoff_pending','blocked')`,
  ];
}
