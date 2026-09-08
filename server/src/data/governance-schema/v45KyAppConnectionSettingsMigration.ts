// release-migration: expand
// 平台接入配置独立于不可变 Manifest，不改变历史安装地址或权限。
export function governanceV45KyAppConnectionSettingsStatements(prefix: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${prefix}_ky_app_connection_settings (
    system_id TEXT PRIMARY KEY REFERENCES ${prefix}_ky_app_system_definitions(system_id),
    settings_json JSONB NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    updated_by TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  ];
}
