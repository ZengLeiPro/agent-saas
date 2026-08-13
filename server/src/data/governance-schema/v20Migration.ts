export function governanceV20Statements(input: {
  credentialCommits: string;
}): string[] {
  const { credentialCommits } = input;
  return [
    `CREATE TABLE IF NOT EXISTS ${credentialCommits} (
      tenant_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('create','rotate','transfer')),
      idempotency_key TEXT NOT NULL,
      nonce_digest TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      target_id TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','partial','compensation_failed')),
      credential_id TEXT,
      error_code TEXT,
      manual_action_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id,operation,idempotency_key),
      UNIQUE (tenant_id,operation,nonce_digest)
    )`,
  ];
}
