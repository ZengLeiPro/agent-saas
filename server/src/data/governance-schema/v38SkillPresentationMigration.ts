export function governanceV38SkillPresentationStatements(prefix: string): string[] {
  const presentations = `${prefix}_skill_presentations`;
  return [
    `CREATE TABLE IF NOT EXISTS ${presentations} (
      resource_scope TEXT NOT NULL CHECK (resource_scope IN ('platform','tenant')),
      resource_tenant_id TEXT NOT NULL DEFAULT '',
      skill_id TEXT NOT NULL,
      audience_tenant_id TEXT NOT NULL DEFAULT '',
      locale TEXT NOT NULL DEFAULT 'zh-CN',
      display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
      summary TEXT NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 240),
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by TEXT NOT NULL,
      PRIMARY KEY (resource_scope,resource_tenant_id,skill_id,audience_tenant_id,locale),
      CHECK (
        (resource_scope='platform' AND resource_tenant_id='')
        OR (resource_scope='tenant' AND resource_tenant_id<>'' AND audience_tenant_id='')
      )
    )`,
    `CREATE INDEX IF NOT EXISTS ${presentations}_audience_idx
      ON ${presentations} (audience_tenant_id,resource_scope,locale,skill_id)`,
  ];
}
