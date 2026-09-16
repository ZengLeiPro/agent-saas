// release-migration: expand

export function externalClientSchemaStatements(table: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (
      client_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      service_account_user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      scopes TEXT[] NOT NULL,
      allowed_connection_ids TEXT[] NOT NULL DEFAULT '{}',
      allowed_agent_ids TEXT[] NOT NULL DEFAULT '{}',
      status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
      expires_at TIMESTAMPTZ,
      last_used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      created_by TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      updated_by TEXT NOT NULL,
      revoked_at TIMESTAMPTZ,
      revoked_by TEXT
    )`,
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS allowed_agent_ids TEXT[] NOT NULL DEFAULT '{}'`,
    `CREATE INDEX IF NOT EXISTS ${table}_tenant_created_idx ON ${table} (tenant_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS ${table}_service_account_idx ON ${table} (service_account_user_id)`,
  ];
}
