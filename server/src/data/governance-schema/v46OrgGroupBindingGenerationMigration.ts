// release-migration: expand
// 旧 binding 保留为历史主体，新身份只占用同账号同会话唯一的未归档槽位。
export function governanceV46OrgGroupBindingGenerationStatements(prefix: string): string[] {
  const bindings = `${prefix}_org_agent_channel_bindings`;
  return [
    `ALTER TABLE ${bindings}
      ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS logical_conversation_id TEXT`,
    `CREATE INDEX IF NOT EXISTS ${bindings}_identity_generation_idx
      ON ${bindings}(tenant_id,account_id,
        COALESCE(logical_conversation_id,conversation_id),account_identity_updated_at DESC)`,
  ];
}
