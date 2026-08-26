export function governanceV32Statements(prefix: string): string[] {
  const accounts = `${prefix}_agent_dws_accounts`;
  const requesterBindings = `${prefix}_agent_dws_requester_conversation_bindings`;
  return [
    `CREATE TABLE IF NOT EXISTS ${requesterBindings} (
      binding_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      FOREIGN KEY (tenant_id,account_id)
        REFERENCES ${accounts}(tenant_id,account_id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL,
      requester_user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      peer_open_dingtalk_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (account_id,conversation_id,requester_user_id),
      UNIQUE (session_id)
    )`,
    `CREATE INDEX IF NOT EXISTS ${requesterBindings}_tenant_idx
      ON ${requesterBindings} (tenant_id,updated_at DESC)`,
  ];
}

export function governanceV33Statements(assignments: string): string[] {
  return [
    `ALTER TABLE ${assignments} DROP CONSTRAINT IF EXISTS ${assignments}_resource_type_check`,
    `ALTER TABLE ${assignments} ADD CONSTRAINT ${assignments}_resource_type_check CHECK (
      resource_type IN ('org_agent','skill','credential','environment_template','org_knowledge','connector','org_memory','dws_delegation')
    )`,
  ];
}
