// release-migration: expand
/** KY App V2 非对称部署身份。只新增表、列、索引与兼容约束，不改写 V1 数据。 */
export function governanceV48KyAppAsymmetricIdentityStatements(prefix: string): string[] {
  const installations = `${prefix}_ky_app_tenant_system_installations`;
  const operations = `${prefix}_ky_app_enrollment_operations`;
  const deploymentKeys = `${prefix}_ky_app_deployment_keys`;
  const replays = `${prefix}_ky_app_dpop_replays`;
  return [
    `ALTER TABLE ${installations}
      ADD COLUMN IF NOT EXISTS auth_mode TEXT NOT NULL DEFAULT 'v1_symmetric',
      ADD COLUMN IF NOT EXISTS deployment_id TEXT,
      ADD COLUMN IF NOT EXISTS current_key_id TEXT,
      ADD COLUMN IF NOT EXISTS identity_generation BIGINT NOT NULL DEFAULT 0`,
    `DO $$ BEGIN
      ALTER TABLE ${installations} ADD CONSTRAINT ${installations}_auth_mode_check
        CHECK (auth_mode IN ('v1_symmetric','v2_asymmetric'));
    EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
    `DO $$ BEGIN
      ALTER TABLE ${installations} ADD CONSTRAINT ${installations}_v2_identity_check
        CHECK (auth_mode <> 'v2_asymmetric' OR status <> 'enabled' OR
          (deployment_id IS NOT NULL AND current_key_id IS NOT NULL AND identity_generation >= 1));
    EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
    `CREATE TABLE IF NOT EXISTS ${operations} (
      operation_id TEXT PRIMARY KEY,
      installation_id TEXT NOT NULL REFERENCES ${installations}(installation_id) ON DELETE CASCADE,
      actor_user_id TEXT NOT NULL,
      request_digest TEXT NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
      deployment_id TEXT,
      key_id TEXT,
      public_jwk_json JSONB,
      origin TEXT,
      callback_url TEXT,
      callback_state TEXT,
      pkce_challenge TEXT,
      granted_scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
      status TEXT NOT NULL DEFAULT 'created' CHECK (status IN (
        'created','challenge_verified','awaiting_consent','code_issued','exchanged','activating',
        'ready','expired','cancelled','failed_retryable','needs_human'
      )),
      version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
      code_sha256 TEXT UNIQUE CHECK (code_sha256 IS NULL OR code_sha256 ~ '^[0-9a-f]{64}$'),
      code_expires_at TIMESTAMPTZ,
      code_consumed_at TIMESTAMPTZ,
      grant_jti TEXT,
      result_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result_json)='object'),
      last_error_code TEXT,
      diagnostic_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CHECK (public_jwk_json IS NULL OR jsonb_typeof(public_jwk_json)='object'),
      CHECK (callback_state IS NULL OR char_length(callback_state) BETWEEN 22 AND 128),
      CHECK (jsonb_typeof(granted_scopes)='array')
    )`,
    `CREATE INDEX IF NOT EXISTS ${operations}_installation_idx
      ON ${operations}(installation_id,updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS ${operations}_status_expiry_idx
      ON ${operations}(status,code_expires_at)`,
    `CREATE TABLE IF NOT EXISTS ${deploymentKeys} (
      installation_id TEXT NOT NULL REFERENCES ${installations}(installation_id) ON DELETE CASCADE,
      key_id TEXT NOT NULL CHECK (key_id ~ '^[A-Za-z0-9_-]{43}$'),
      deployment_id TEXT NOT NULL,
      public_jwk_json JSONB NOT NULL CHECK (jsonb_typeof(public_jwk_json)='object'),
      alg TEXT NOT NULL DEFAULT 'ES256' CHECK (alg='ES256'),
      status TEXT NOT NULL CHECK (status IN ('current','next','previous','revoked')),
      not_before TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      accept_until TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      generation BIGINT NOT NULL CHECK (generation >= 1),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (installation_id,key_id),
      CHECK (status <> 'previous' OR accept_until IS NOT NULL),
      CHECK (status <> 'revoked' OR revoked_at IS NOT NULL)
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ${deploymentKeys}_current_idx
      ON ${deploymentKeys}(installation_id) WHERE status='current'`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ${deploymentKeys}_next_idx
      ON ${deploymentKeys}(installation_id) WHERE status='next'`,
    `CREATE TABLE IF NOT EXISTS ${replays} (
      key_id TEXT NOT NULL,
      jti TEXT NOT NULL,
      proof_kind TEXT NOT NULL CHECK (proof_kind IN ('client_assertion','dpop')),
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (key_id,jti)
    )`,
    `CREATE INDEX IF NOT EXISTS ${replays}_expiry_idx ON ${replays}(expires_at)`,
  ];
}
