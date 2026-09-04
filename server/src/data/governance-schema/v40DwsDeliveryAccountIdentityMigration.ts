// Legacy N rows stay all-NULL; N+1 rows are required to carry a complete identity tuple.
export function governanceV40DwsDeliveryAccountIdentityStatements(prefix: string): string[] {
  const deliveries = `${prefix}_agent_dws_delivery_intents`;
  const completeIdentity = `${prefix}_adws_di_identity_ck`;
  return [
    `ALTER TABLE ${deliveries}
      ADD COLUMN IF NOT EXISTS account_profile_id TEXT,
      ADD COLUMN IF NOT EXISTS account_corp_id TEXT,
      ADD COLUMN IF NOT EXISTS account_dingtalk_user_id TEXT,
      ADD COLUMN IF NOT EXISTS account_identity_updated_at TIMESTAMPTZ`,
    `DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='${completeIdentity}') THEN
        ALTER TABLE ${deliveries}
          ADD CONSTRAINT ${completeIdentity}
          CHECK (
            (account_profile_id IS NULL AND account_corp_id IS NULL
              AND account_dingtalk_user_id IS NULL AND account_identity_updated_at IS NULL)
            OR
            (account_profile_id IS NOT NULL AND account_corp_id IS NOT NULL
              AND account_dingtalk_user_id IS NOT NULL AND account_identity_updated_at IS NOT NULL)
          ) NOT VALID;
      END IF;
    END $$`,
    `ALTER TABLE ${deliveries}
      VALIDATE CONSTRAINT ${completeIdentity}`,
  ];
}
