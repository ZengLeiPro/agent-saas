-- KY App V2 非对称部署身份与多安装实例存储（expand-only，可重复执行）。
-- 私钥、authorization code、access token 均不得进入这些表；key_ref 指向业务系统自己的 KMS/HSM。

CREATE TABLE IF NOT EXISTS ky_app_deployment_key_refs (
  deployment_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  key_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('current', 'next', 'previous', 'revoked')),
  generation BIGINT NOT NULL CHECK (generation > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (deployment_id, key_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ky_app_deployment_key_refs_current_idx
  ON ky_app_deployment_key_refs (deployment_id) WHERE status = 'current';
CREATE UNIQUE INDEX IF NOT EXISTS ky_app_deployment_key_refs_next_idx
  ON ky_app_deployment_key_refs (deployment_id) WHERE status = 'next';
ALTER TABLE ky_app_deployment_key_refs
  ADD COLUMN IF NOT EXISTS public_jwk_json JSONB,
  ADD COLUMN IF NOT EXISTS encrypted_private_key TEXT;

CREATE TABLE IF NOT EXISTS ky_app_installation_bindings (
  installation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  system_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  platform_issuer TEXT NOT NULL,
  platform_api_base_url TEXT NOT NULL,
  key_id TEXT NOT NULL,
  granted_scopes JSONB NOT NULL,
  registered_digest TEXT,
  generation BIGINT NOT NULL CHECK (generation > 0),
  state TEXT NOT NULL CHECK (state IN ('activating', 'connected', 'degraded', 'revoked')),
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS ky_app_installation_bindings_deployment_idx
  ON ky_app_installation_bindings (deployment_id, generation);

CREATE TABLE IF NOT EXISTS ky_app_installation_binding_stages
  (LIKE ky_app_installation_bindings INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES);

CREATE TABLE IF NOT EXISTS ky_app_enrollment_attempts (
  operation_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  state_sha256 TEXT NOT NULL,
  verifier_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'exchanging', 'consumed', 'expired', 'failed')),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ky_app_enrollment_attempts_expiry_idx
  ON ky_app_enrollment_attempts (expires_at);
ALTER TABLE ky_app_enrollment_attempts
  ADD COLUMN IF NOT EXISTS tenant_id TEXT,
  ADD COLUMN IF NOT EXISTS system_id TEXT,
  ADD COLUMN IF NOT EXISTS key_id TEXT,
  ADD COLUMN IF NOT EXISTS deployment_id TEXT,
  ADD COLUMN IF NOT EXISTS public_jwk_json JSONB;

CREATE TABLE IF NOT EXISTS ky_app_enrollment_secrets (
  secret_ref TEXT PRIMARY KEY,
  encrypted_value TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ky_app_enrollment_secrets_expiry_idx
  ON ky_app_enrollment_secrets (expires_at);

-- V2 数据从第一天按 installation_id 分区；旧 V1 单例表保持不变。
CREATE TABLE IF NOT EXISTS ky_app_v2_installation_state (
  installation_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  state_version BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ky_app_v2_event_ack (
  installation_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  ack JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id, event_id)
);
CREATE TABLE IF NOT EXISTS ky_app_v2_directory_user (
  installation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (installation_id, user_id)
);
CREATE TABLE IF NOT EXISTS ky_app_v2_directory_group (
  installation_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (installation_id, group_id)
);
CREATE TABLE IF NOT EXISTS ky_app_v2_directory_checkpoint (
  installation_id TEXT PRIMARY KEY,
  seq BIGINT NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL
);
