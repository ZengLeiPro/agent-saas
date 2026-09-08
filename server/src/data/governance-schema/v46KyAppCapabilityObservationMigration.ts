// release-migration: expand
// 记录真实会话构建工具快照时对 /ky/v1/me 的逐用户观测结果。
export function governanceV46KyAppCapabilityObservationStatements(prefix: string): string[] {
  const observations = `${prefix}_ky_app_user_capability_observations`;
  const installations = `${prefix}_ky_app_tenant_system_installations`;
  return [
    `CREATE TABLE IF NOT EXISTS ${observations} (
      tenant_id TEXT NOT NULL,
      installation_id TEXT NOT NULL REFERENCES ${installations}(installation_id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      registered_digest TEXT NOT NULL CHECK (registered_digest ~ '^[0-9a-f]{64}$'),
      status TEXT NOT NULL CHECK (
        status IN ('ready','insufficient_scope','capacity_limited','unavailable')
      ),
      enabled_capability_count INTEGER NOT NULL CHECK (enabled_capability_count >= 0),
      checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id,installation_id,user_id)
    )`,
    `CREATE INDEX IF NOT EXISTS ${observations}_installation_status_idx
      ON ${observations} (tenant_id,installation_id,status,user_id)`,
  ];
}
