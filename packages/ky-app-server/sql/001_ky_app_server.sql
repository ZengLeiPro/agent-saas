-- @kaiyan/ky-app-server 的 PostgreSQL 存储（expand-only，§8.3：DB 迁移 expand → contract）。
-- 所有语句可重复执行；升级只增列 / 增表，不改名不删列。
-- 表按契约条款分组：jti（§3.1-6）、执行记录（§4.3/§4.4）、安装实例状态与事件（§3.7）、
-- 组织目录（§3.4/§3.6）、本地兜底登录（§3.5）。

-- ---------------------------------------------------------------- §3.1-6 jti 单次消费
CREATE TABLE IF NOT EXISTS ky_app_jti (
  jti        TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ky_app_jti_expires_at_idx ON ky_app_jti (expires_at);

-- ---------------------------------------------------------------- §4.3 / §4.4 执行记录
CREATE TABLE IF NOT EXISTS ky_app_execution (
  installation_id TEXT        NOT NULL,
  capability_id   TEXT        NOT NULL,
  sub             TEXT        NOT NULL,
  lcid            TEXT        NOT NULL,
  input_hash      TEXT        NOT NULL,
  status          TEXT        NOT NULL,
  result          JSONB,
  error           JSONB,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (installation_id, capability_id, sub, lcid)
);
-- §4.4「不属于同 (iid,cap,sub) → 404」需要忽略 sub 的查找。
CREATE INDEX IF NOT EXISTS ky_app_execution_lcid_idx
  ON ky_app_execution (installation_id, capability_id, lcid);
CREATE INDEX IF NOT EXISTS ky_app_execution_expires_at_idx ON ky_app_execution (expires_at);

-- ---------------------------------------------------------------- §3.7 安装实例状态与事件去重
CREATE TABLE IF NOT EXISTS ky_app_installation_state (
  id            SMALLINT    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  state         TEXT        NOT NULL DEFAULT 'enabled',
  state_version BIGINT      NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO ky_app_installation_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS ky_app_event_ack (
  event_id   TEXT PRIMARY KEY,
  ack        JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- §3.4 / §3.6 组织目录
CREATE TABLE IF NOT EXISTS ky_app_directory_user (
  user_id         TEXT PRIMARY KEY,
  display_name    TEXT        NOT NULL,
  employee_no     TEXT,
  status          TEXT        NOT NULL,
  is_tenant_admin BOOLEAN     NOT NULL DEFAULT false,
  group_ids       TEXT[]      NOT NULL DEFAULT '{}',
  -- 本地状态：目录 disabled/removed → suspended，重新启用不自动复活。
  local_status    TEXT        NOT NULL DEFAULT 'active',
  removed         BOOLEAN     NOT NULL DEFAULT false,
  updated_at      TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS ky_app_directory_group (
  group_id        TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  parent_group_id TEXT,
  status          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ky_app_directory_checkpoint (
  id         SMALLINT    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  seq        BIGINT      NOT NULL,
  synced_at  TIMESTAMPTZ NOT NULL
);

-- ---------------------------------------------------------------- §3.5 本地兜底登录
CREATE TABLE IF NOT EXISTS ky_app_break_glass_record (
  sub             TEXT PRIMARY KEY,
  password_hash   TEXT        NOT NULL,
  codes           JSONB       NOT NULL,
  failed_attempts INTEGER     NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS ky_app_break_glass_session (
  id         SMALLINT    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled_by TEXT        NOT NULL,
  enabled_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS ky_app_break_glass_employee_code (
  login_id        TEXT PRIMARY KEY,
  sub             TEXT        NOT NULL,
  code_hash       TEXT        NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  failed_attempts INTEGER     NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ky_app_break_glass_audit (
  id        BIGSERIAL PRIMARY KEY,
  at        TIMESTAMPTZ NOT NULL,
  action    TEXT        NOT NULL,
  outcome   TEXT        NOT NULL,
  sub       TEXT,
  login_id  TEXT,
  ip        TEXT,
  detail    TEXT
);
