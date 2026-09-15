export function governanceV49PlatformDemoStatements(prefix: string): string[] {
  const grants = `${prefix}_membership_capability_grants`;
  const sessions = `${prefix}_platform_demo_sessions`;
  return [
    `CREATE TABLE IF NOT EXISTS ${grants} (
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      capability TEXT NOT NULL CHECK (capability = 'platform_demo_access'),
      granted_by TEXT NOT NULL,
      granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at TIMESTAMPTZ,
      revoked_by TEXT,
      PRIMARY KEY (tenant_id, user_id, capability)
    )`,
    `CREATE INDEX IF NOT EXISTS ${grants}_tenant_active_idx
      ON ${grants} (tenant_id, user_id)
      WHERE revoked_at IS NULL`,
    `CREATE TABLE IF NOT EXISTS ${sessions} (
      session_key TEXT PRIMARY KEY,
      actor_user_id TEXT NOT NULL,
      actor_tenant_id TEXT NOT NULL,
      section_id TEXT NOT NULL,
      draft_json JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      UNIQUE (actor_tenant_id, actor_user_id, section_id)
    )`,
    `CREATE INDEX IF NOT EXISTS ${sessions}_expiry_idx
      ON ${sessions} (expires_at)`,
  ];
}
