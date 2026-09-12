// release-migration: expand
/** Additive schema only. No Codex table is renamed, rebuilt, copied, or truncated. */
export function grokRuntimeStateSchemaStatements(table: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (
      credential_ref TEXT PRIMARY KEY,
      availability TEXT NOT NULL,
      credential_generation BIGINT NOT NULL DEFAULT 0,
      cooldown_until TIMESTAMPTZ,
      last_failure_code TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT ${table}_availability_check CHECK (availability IN ('available', 'quota_cooldown', 'auth_unavailable'))
    )`,
    `CREATE INDEX IF NOT EXISTS ${table}_cooldown_idx ON ${table} (cooldown_until)`,
  ];
}
export function grokRefreshJournalSchemaStatements(table: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (
    credential_ref TEXT PRIMARY KEY,
    credential_generation BIGINT NOT NULL CHECK (credential_generation > 0),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  ];
}
