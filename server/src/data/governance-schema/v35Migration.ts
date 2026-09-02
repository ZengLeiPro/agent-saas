export function governanceV35Statements(prefix: string): string[] {
  const nativeOAuthHandoffs = `${prefix}_native_oauth_handoffs`;
  return [
    `ALTER TABLE ${nativeOAuthHandoffs} ADD COLUMN IF NOT EXISTS client_state TEXT`,
    `ALTER TABLE ${nativeOAuthHandoffs} ADD COLUMN IF NOT EXISTS client_state_hash TEXT`,
    `ALTER TABLE ${nativeOAuthHandoffs} ADD COLUMN IF NOT EXISTS pkce_challenge TEXT`,
    `ALTER TABLE ${nativeOAuthHandoffs} ADD COLUMN IF NOT EXISTS callback_provider TEXT`,
    `ALTER TABLE ${nativeOAuthHandoffs} ADD COLUMN IF NOT EXISTS redirect_uri TEXT`,
    `ALTER TABLE ${nativeOAuthHandoffs} ADD COLUMN IF NOT EXISTS identity_generation BIGINT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ${nativeOAuthHandoffs}_client_state_idx ON ${nativeOAuthHandoffs}(client_state_hash) WHERE client_state_hash IS NOT NULL`,
  ];
}
