// release-migration: expand
//
// WP2a 定制项目对接（规范 §3.1/§3.2/§3.7/§4.6/§8.1/§8.4）的治理库结构。
// 全部 expand-only：CREATE TABLE / CREATE INDEX 均带 IF NOT EXISTS；
// 唯一的既有对象改动是 resource_assignments 的 resource_type CHECK 重建
// （DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT，照 v33 先例），只放宽取值集合，不删列不删表。
export function governanceV41KyAppSystemStatements(prefix: string): string[] {
  const definitions = `${prefix}_ky_app_system_definitions`;
  const definitionVersions = `${prefix}_ky_app_system_definition_versions`;
  const installations = `${prefix}_ky_app_tenant_system_installations`;
  const signingKeys = `${prefix}_ky_app_signing_keys`;
  const nonces = `${prefix}_ky_app_handshake_nonces`;
  const outboundEvents = `${prefix}_ky_app_outbound_events`;
  const installationRuntime = `${prefix}_ky_app_installation_runtime`;
  const serviceCredentials = `${prefix}_ky_app_service_credentials`;
  const installationKeys = `${prefix}_ky_app_installation_keys`;
  const assignments = `${prefix}_resource_assignments`;
  return [
    // §8.1 系统定义：稳定标识 + 状态机 draft→published→disabled→retired（retired 为终态）。
    `CREATE TABLE IF NOT EXISTS ${definitions} (
      system_id TEXT PRIMARY KEY CHECK (char_length(system_id) BETWEEN 3 AND 24),
      name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','published','disabled','retired')),
      published_digest TEXT CHECK (published_digest ~ '^[0-9a-f]{64}$'),
      version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by TEXT NOT NULL
    )`,
    // §8.1 不可变系统版本：manifest 的 JCS digest 为主键的一部分，同 digest 重复上传即幂等。
    `CREATE TABLE IF NOT EXISTS ${definitionVersions} (
      system_id TEXT NOT NULL REFERENCES ${definitions}(system_id) ON DELETE CASCADE,
      digest TEXT NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
      contract_version INTEGER NOT NULL DEFAULT 1 CHECK (contract_version >= 1),
      manifest_json JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','published','disabled','retired')),
      review_status TEXT NOT NULL DEFAULT 'not_required'
        CHECK (review_status IN ('not_required','pending','approved')),
      review_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
      reviewed_by TEXT,
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by TEXT NOT NULL,
      published_at TIMESTAMPTZ,
      published_by TEXT,
      PRIMARY KEY (system_id,digest),
      CHECK (review_status <> 'approved' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
      CHECK (status <> 'published' OR (published_at IS NOT NULL AND published_by IS NOT NULL))
    )`,
    `CREATE INDEX IF NOT EXISTS ${definitionVersions}_recent_idx
      ON ${definitionVersions} (system_id,created_at DESC)`,
    // §8.1 安装实例：一个组织对同一系统只有一个实例；stateVersion 单调递增供 §3.7 事件排序。
    `CREATE TABLE IF NOT EXISTS ${installations} (
      installation_id TEXT PRIMARY KEY CHECK (char_length(installation_id) BETWEEN 3 AND 64),
      tenant_id TEXT NOT NULL,
      system_id TEXT NOT NULL REFERENCES ${definitions}(system_id) ON DELETE RESTRICT,
      base_url TEXT NOT NULL,
      origin TEXT NOT NULL,
      tech_contact_user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','enabled','disabled','deleted')),
      domain_verification_token TEXT,
      domain_verified_at TIMESTAMPTZ,
      registered_digest TEXT CHECK (registered_digest ~ '^[0-9a-f]{64}$'),
      state_version BIGINT NOT NULL DEFAULT 1 CHECK (state_version >= 1),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by TEXT NOT NULL,
      UNIQUE (tenant_id,system_id)
    )`,
    `CREATE INDEX IF NOT EXISTS ${installations}_tenant_idx
      ON ${installations} (tenant_id,status,updated_at DESC)`,
    // §3.1/§8.4 SAT 签名密钥：只登记公钥与 vault 引用，私钥永不入库。
    `CREATE TABLE IF NOT EXISTS ${signingKeys} (
      kid TEXT PRIMARY KEY CHECK (char_length(kid) BETWEEN 8 AND 64),
      public_jwk JSONB NOT NULL,
      secret_ref TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active','next','retiring','revoked')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      activated_at TIMESTAMPTZ,
      retiring_at TIMESTAMPTZ,
      retire_after TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      CHECK (status <> 'revoked' OR revoked_at IS NOT NULL),
      CHECK (status <> 'retiring' OR retire_after IS NOT NULL)
    )`,
    // active / next 各自最多一把，是 §8.4 轮换状态机的硬约束。
    `CREATE UNIQUE INDEX IF NOT EXISTS ${signingKeys}_active_idx
      ON ${signingKeys} (status) WHERE status = 'active'`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ${signingKeys}_next_idx
      ON ${signingKeys} (status) WHERE status = 'next'`,
    // §5.4 握手 nonce：绑定壳会话 + 用户 + 安装实例，原子消费。
    `CREATE TABLE IF NOT EXISTS ${nonces} (
      nonce TEXT PRIMARY KEY CHECK (char_length(nonce) BETWEEN 22 AND 128),
      installation_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS ${nonces}_expiry_idx ON ${nonces} (expires_at)`,
    // §3.7 平台→定制项目事件 outbox：stateVersion 单调，24 小时重试窗口。
    `CREATE TABLE IF NOT EXISTS ${outboundEvents} (
      event_id TEXT PRIMARY KEY,
      installation_id TEXT NOT NULL,
      state_version BIGINT NOT NULL CHECK (state_version >= 1),
      type TEXT NOT NULL CHECK (type IN (
        'installation.enabled','installation.disabled','installation.deleted',
        'jwks.rotated','jwks.revoke','jwks.probe'
      )),
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','delivered','failed','abandoned')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      give_up_at TIMESTAMPTZ NOT NULL,
      delivered_at TIMESTAMPTZ,
      verified_kid TEXT,
      last_error TEXT,
      UNIQUE (installation_id,type,state_version)
    )`,
    `CREATE INDEX IF NOT EXISTS ${outboundEvents}_due_idx
      ON ${outboundEvents} (status,next_attempt_at)`,
    `CREATE INDEX IF NOT EXISTS ${outboundEvents}_stream_idx
      ON ${outboundEvents} (installation_id,state_version)`,
    // §4.6 运行状态：live/ready 探测结果与 digest 比对，连续失败计数驱动告警。
    `CREATE TABLE IF NOT EXISTS ${installationRuntime} (
      installation_id TEXT PRIMARY KEY,
      live_status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (live_status IN ('unknown','ok','maintenance','failed')),
      live_checked_at TIMESTAMPTZ,
      ready_status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (ready_status IN ('unknown','ok','failed')),
      ready_checked_at TIMESTAMPTZ,
      manifest_digest TEXT CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
      contract_version INTEGER,
      app_version TEXT,
      directory_checkpoint TEXT,
      directory_age_seconds INTEGER,
      jwks_kids JSONB NOT NULL DEFAULT '[]'::jsonb,
      consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
      last_error TEXT,
      alerted_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    // §3.6/§8.4 服务凭据：库里只存 sha256，明文经 SecretVault 一次性领取；双凭据重叠轮换。
    `CREATE TABLE IF NOT EXISTS ${serviceCredentials} (
      credential_id TEXT PRIMARY KEY,
      installation_id TEXT NOT NULL,
      token_sha256 TEXT NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
      scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
      status TEXT NOT NULL DEFAULT 'pending_ack'
        CHECK (status IN ('pending_ack','active','revoked','expired')),
      secret_ref TEXT NOT NULL,
      claimed_at TIMESTAMPTZ,
      issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ack_deadline_at TIMESTAMPTZ NOT NULL,
      acked_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      CHECK (status <> 'active' OR acked_at IS NOT NULL),
      CHECK (status <> 'revoked' OR revoked_at IS NOT NULL)
    )`,
    `CREATE INDEX IF NOT EXISTS ${serviceCredentials}_installation_idx
      ON ${serviceCredentials} (installation_id,status,expires_at)`,
    // §3.2/§8.4 安装密钥元数据：明文只在 vault，库里存 keyVersion 与 current/previous 窗口。
    `CREATE TABLE IF NOT EXISTS ${installationKeys} (
      installation_id TEXT NOT NULL,
      key_version TEXT NOT NULL CHECK (char_length(key_version) BETWEEN 1 AND 64),
      secret_ref TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('current','previous','revoked')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      superseded_at TIMESTAMPTZ,
      accept_until TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      PRIMARY KEY (installation_id,key_version),
      CHECK (status <> 'previous' OR accept_until IS NOT NULL),
      CHECK (status <> 'revoked' OR revoked_at IS NOT NULL)
    )`,
    // 每个安装实例只允许一把 current 密钥（§3.2 签发端一律用 current）。
    `CREATE UNIQUE INDEX IF NOT EXISTS ${installationKeys}_current_idx
      ON ${installationKeys} (installation_id) WHERE status = 'current'`,
    // §8.1 分配枚举扩容：resource_type 增加 system_installation（照 v33 重建 CHECK）。
    `ALTER TABLE ${assignments} DROP CONSTRAINT IF EXISTS ${assignments}_resource_type_check`,
    `ALTER TABLE ${assignments} ADD CONSTRAINT ${assignments}_resource_type_check CHECK (
      resource_type IN ('org_agent','skill','credential','environment_template','org_knowledge','connector','org_memory','dws_delegation','system_installation')
    )`,
  ];
}
