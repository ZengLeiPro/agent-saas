// release-migration: expand
// 旧 binding 保留为历史主体，新身份只占用同账号同会话唯一的未归档槽位。
export function governanceV46OrgGroupBindingGenerationStatements(prefix: string): string[] {
  const bindings = `${prefix}_org_agent_channel_bindings`;
  const deliveries = `${prefix}_agent_dws_delivery_intents`;
  return [
    `ALTER TABLE ${bindings}
      ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS logical_conversation_id TEXT`,
    `DO $migration$
      DECLARE fk_name TEXT;
      BEGIN
        SELECT conname INTO fk_name FROM pg_constraint
        WHERE conrelid='${deliveries}'::regclass AND contype='f'
          AND pg_get_constraintdef(oid) LIKE
            'FOREIGN KEY (tenant_id, binding_id, agent_id, conversation_space_id, account_id, conversation_id)%';
        IF fk_name IS NOT NULL THEN
          EXECUTE format('ALTER TABLE ${deliveries} DROP CONSTRAINT %I',fk_name);
        END IF;
      END $migration$`,
    `ALTER TABLE ${deliveries}
      ADD CONSTRAINT ${deliveries}_binding_generation_fk
      FOREIGN KEY (tenant_id,binding_id,agent_id,conversation_space_id,account_id,conversation_id)
      REFERENCES ${bindings}(tenant_id,binding_id,agent_id,conversation_space_id,account_id,conversation_id)
      ON UPDATE CASCADE NOT VALID`,
    `ALTER TABLE ${deliveries} VALIDATE CONSTRAINT ${deliveries}_binding_generation_fk`,
    `CREATE INDEX IF NOT EXISTS ${bindings}_identity_generation_idx
      ON ${bindings}(tenant_id,account_id,
        COALESCE(logical_conversation_id,conversation_id),account_identity_updated_at DESC)`,
  ];
}
