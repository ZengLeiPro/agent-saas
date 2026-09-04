export function governanceV38OrgGroupBindingIdentityStatements(prefix: string): string[] {
  const bindings = `${prefix}_org_agent_channel_bindings`;
  const accounts = `${prefix}_agent_dws_accounts`;
  return [
    `ALTER TABLE ${bindings}
      ADD COLUMN IF NOT EXISTS account_profile_id TEXT,
      ADD COLUMN IF NOT EXISTS account_corp_id TEXT,
      ADD COLUMN IF NOT EXISTS account_dingtalk_user_id TEXT,
      ADD COLUMN IF NOT EXISTS account_identity_updated_at TIMESTAMPTZ`,
    `UPDATE ${bindings} AS binding
      SET account_profile_id=account.profile_id,
          account_corp_id=account.corp_id,
          account_dingtalk_user_id=account.dingtalk_user_id,
          account_identity_updated_at=account.identity_updated_at
      FROM ${accounts} AS account
      WHERE binding.tenant_id=account.tenant_id
        AND binding.account_id=account.account_id
        AND binding.account_profile_id IS NULL
        AND account.profile_id=account.corp_id || ':' || account.dingtalk_user_id
        AND account.identity_updated_at IS NOT NULL
        AND binding.created_at >= account.identity_updated_at`,
  ];
}
