-- __SYSTEM_NAME__ 的业务表（expand-only，§8.3：DB 迁移 expand → contract，禁 DROP）。
CREATE TABLE IF NOT EXISTS demo_orders (
  order_id    TEXT PRIMARY KEY,
  customer    TEXT        NOT NULL,
  amount      NUMERIC(14, 2) NOT NULL DEFAULT 0,
  status      TEXT        NOT NULL DEFAULT 'draft',
  created_by  TEXT        NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS demo_orders_customer_idx ON demo_orders (customer);

CREATE TABLE IF NOT EXISTS demo_order_line (
  order_id TEXT    NOT NULL REFERENCES demo_orders (order_id) ON DELETE CASCADE,
  line_no  INTEGER NOT NULL,
  sku      TEXT    NOT NULL,
  qty      INTEGER NOT NULL,
  PRIMARY KEY (order_id, line_no)
);

-- 本地业务角色：唯一键 (tid, iid, sub)，与目录里的用户档案分开存（§3.4）。
CREATE TABLE IF NOT EXISTS demo_user_role (
  tenant_id       TEXT   NOT NULL,
  installation_id TEXT   NOT NULL,
  sub             TEXT   NOT NULL,
  roles           TEXT[] NOT NULL DEFAULT '{}',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, installation_id, sub)
);

-- 演示数据：页面 API ↔ 能力一致性用例（§9.3-7）打的就是这两条。
INSERT INTO demo_orders (order_id, customer, amount, status)
VALUES ('SO-DEMO-1', 'C-DEMO', 1200.00, 'confirmed'),
       ('SO-DEMO-2', 'C-DEMO', 860.50, 'draft')
ON CONFLICT (order_id) DO NOTHING;

-- 独立业务身份与会话不依赖 KY 部署身份。初始化管理员由部署方显式写入密码 SHA-256。
CREATE TABLE IF NOT EXISTS demo_local_user (
  user_id TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS demo_local_session (
  token_sha256 TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES demo_local_user(user_id),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS demo_local_session_expiry_idx ON demo_local_session(expires_at);

CREATE TABLE IF NOT EXISTS demo_agent_integration (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id=1),
  allowed BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO demo_agent_integration(id) VALUES(1) ON CONFLICT(id) DO NOTHING;
