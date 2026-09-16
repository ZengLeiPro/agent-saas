function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export interface DatabaseConnectionTables {
  connections: string;
  queryAudit: string;
}

export function databaseConnectionTables(tablePrefix = 'runtime'): DatabaseConnectionTables {
  const safe = tablePrefix.replace(/[^a-zA-Z0-9_]/g, '_');
  const prefix = safe && /^[a-zA-Z_]/.test(safe) ? safe : `runtime_${safe}`;
  return {
    connections: `${prefix}_external_database_connections`,
    queryAudit: `${prefix}_external_database_query_audit`,
  };
}

export function databaseConnectionSchemaStatements(tables: DatabaseConnectionTables): string[] {
  const connections = quoteIdentifier(tables.connections);
  const queryAudit = quoteIdentifier(tables.queryAudit);
  return [
    `CREATE TABLE IF NOT EXISTS ${connections} (
      connection_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      engine TEXT NOT NULL CHECK (engine IN ('postgresql','gateway')),
      host TEXT,
      port INTEGER,
      database_name TEXT,
      username TEXT,
      gateway_url TEXT,
      ssl_mode TEXT NOT NULL CHECK (ssl_mode IN ('disable','require','verify-full')),
      secret_ref TEXT NOT NULL UNIQUE,
      allowed_schemas TEXT[] NOT NULL DEFAULT '{}',
      allowed_tables TEXT[] NOT NULL DEFAULT '{}',
      sensitive_columns TEXT[] NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','ready','disabled','validation_failed','revoked','deleted')),
      last_tested_at TIMESTAMPTZ,
      last_error_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by TEXT NOT NULL,
      revoked_at TIMESTAMPTZ,
      revoked_by TEXT,
      UNIQUE (tenant_id,name),
      CHECK ((engine='postgresql' AND host IS NOT NULL AND port IS NOT NULL
              AND database_name IS NOT NULL AND username IS NOT NULL AND gateway_url IS NULL)
          OR (engine='gateway' AND gateway_url IS NOT NULL AND host IS NULL
              AND port IS NULL AND database_name IS NULL AND username IS NULL))
    )`,
    `CREATE INDEX IF NOT EXISTS ${tables.connections}_tenant_status_idx
      ON ${connections}(tenant_id,status,created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS ${queryAudit} (
      audit_id BIGSERIAL PRIMARY KEY,
      connection_id TEXT NOT NULL REFERENCES ${connections}(connection_id),
      tenant_id TEXT NOT NULL,
      api_client_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      sql_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('completed','rejected','failed')),
      duration_ms INTEGER NOT NULL,
      row_count INTEGER NOT NULL,
      result_bytes INTEGER NOT NULL,
      truncated BOOLEAN NOT NULL,
      error_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS ${tables.queryAudit}_tenant_created_idx
      ON ${queryAudit}(tenant_id,created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS ${tables.queryAudit}_connection_created_idx
      ON ${queryAudit}(connection_id,created_at DESC)`,
  ];
}
