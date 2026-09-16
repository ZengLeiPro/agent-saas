function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export interface ExternalConversationTables {
  conversations: string;
  executions: string;
  clients: string;
}

export function externalConversationTables(tablePrefix = 'runtime'): ExternalConversationTables {
  const safe = tablePrefix.replace(/[^a-zA-Z0-9_]/g, '_');
  const prefix = safe && /^[a-zA-Z_]/.test(safe) ? safe : `runtime_${safe}`;
  return {
    conversations: `${prefix}_external_conversations`,
    executions: `${prefix}_external_executions`,
    clients: `${prefix}_external_api_clients`,
  };
}

export function externalConversationSchemaStatements(tables: ExternalConversationTables): string[] {
  const conversations = quoteIdentifier(tables.conversations);
  const executions = quoteIdentifier(tables.executions);
  const clients = quoteIdentifier(tables.clients);
  return [
    `CREATE TABLE IF NOT EXISTS ${conversations} (
      conversation_id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES ${clients}(client_id),
      tenant_id TEXT NOT NULL,
      service_account_user_id TEXT NOT NULL,
      external_conversation_id TEXT NOT NULL,
      session_id TEXT,
      database_connection_id TEXT,
      agent_id TEXT,
      metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (client_id, external_conversation_id),
      UNIQUE (client_id, idempotency_key)
    )`,
    `ALTER TABLE ${conversations} ADD COLUMN IF NOT EXISTS agent_id TEXT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ${tables.conversations}_session_uidx
      ON ${conversations}(session_id) WHERE session_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS ${tables.conversations}_tenant_updated_idx
      ON ${conversations}(tenant_id, updated_at DESC)`,
    `CREATE TABLE IF NOT EXISTS ${executions} (
      execution_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES ${conversations}(conversation_id),
      client_id TEXT NOT NULL REFERENCES ${clients}(client_id),
      tenant_id TEXT NOT NULL,
      service_account_user_id TEXT NOT NULL,
      run_id TEXT,
      session_id TEXT,
      client_message_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      submission_status TEXT NOT NULL DEFAULT 'submitting'
        CHECK (submission_status IN ('submitting','accepted','rejected')),
      requested_model TEXT,
      requested_reasoning_effort TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (client_id, idempotency_key),
      UNIQUE (client_message_id)
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ${tables.executions}_run_uidx
      ON ${executions}(run_id) WHERE run_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS ${tables.executions}_conversation_created_idx
      ON ${executions}(conversation_id, created_at DESC)`,
  ];
}
