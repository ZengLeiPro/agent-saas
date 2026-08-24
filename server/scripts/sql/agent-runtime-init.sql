-- Agent Runtime PG 初始化 DDL（在 Azeroth RDS 同实例上建独立 database）
--
-- 用途：把 3200 agent-saas 的 runtime event log 跟 Azeroth 业务数据
-- 逻辑隔离（独立 database + 独立 role + 独立连接池上限）。注意：同一 RDS
-- 实例仍共用存储、IOPS、WAL 与备份故障域，不得表述为物理隔离。
--
-- 执行方式：
--   1. 以 RDS 高权限账号（创建 db / role 的权限）登录
--   2. 先在 default db 执行第 1-3 节
--   3. \c agent_runtime 切到新 db
--   4. 执行第 4 节
--
-- 也可以一次性：
--   PGPASSWORD=$ADMIN_PW psql -h $RDS_HOST -U $ADMIN_USER -d postgres -v ON_ERROR_STOP=1 -f agent-runtime-init.sql
--
-- ⚠️ 执行前先生成强密码并替换 :app_password：
--   APP_PW=$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)
--   psql ... -v app_password="'$APP_PW'" -f agent-runtime-init.sql
--   （或者直接编辑 SQL 把 :app_password 换成单引号包的强密码字面量）
--
-- 完成后 connection string 模板见 docs/azeroth-pg-setup.md。

\set ON_ERROR_STOP on

-- ─────────────────────────────────────────────────────────────────
-- 第 1 节：建 database（在 default db，如 postgres 上执行）
-- ─────────────────────────────────────────────────────────────────

-- 注意：CREATE DATABASE 不能跑在事务里
CREATE DATABASE agent_runtime
    TEMPLATE template0
    ENCODING 'UTF8';

COMMENT ON DATABASE agent_runtime IS
    'Runtime event log for agent-saas (3200). Logically isolated database/role; shares the RDS instance failure domain.';

-- ─────────────────────────────────────────────────────────────────
-- 第 2 节：建独立应用 role
-- ─────────────────────────────────────────────────────────────────

CREATE ROLE agent_runtime_app WITH
    LOGIN
    PASSWORD :app_password
    NOCREATEDB
    NOCREATEROLE
    NOSUPERUSER
    NOINHERIT
    NOREPLICATION
    -- 显式 cap 单 role 并发连接数，防止 runtime 把 RDS 主池吃光
    CONNECTION LIMIT 20;

COMMENT ON ROLE agent_runtime_app IS
    '3200 agent-saas application role. Do not reuse for ops or azeroth schemas. CONNECTION LIMIT 20.';

-- ─────────────────────────────────────────────────────────────────
-- 第 3 节：grant CONNECT 到新 database
-- ─────────────────────────────────────────────────────────────────

GRANT CONNECT ON DATABASE agent_runtime TO agent_runtime_app;

-- ─────────────────────────────────────────────────────────────────
-- 第 4 节：切到 agent_runtime database 后执行
--   ⚠️ 上面三节执行完，必须 \c agent_runtime 再继续
-- ─────────────────────────────────────────────────────────────────

\c agent_runtime

-- 收回 public schema 默认的 CREATE 权限（PG14+ 默认已收回，但显式收以兼容老版）
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- 给应用 role 使用 public schema 的权限
GRANT USAGE, CREATE ON SCHEMA public TO agent_runtime_app;

-- 对已建表（首次执行其实是空的）授权
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO agent_runtime_app;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO agent_runtime_app;

-- 对将来 PgEventStore.init() 建的表自动授权
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT ALL PRIVILEGES ON TABLES TO agent_runtime_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT ALL PRIVILEGES ON SEQUENCES TO agent_runtime_app;

-- ─────────────────────────────────────────────────────────────────
-- 验收（可选）：
--   \c agent_runtime agent_runtime_app
--   登录后 \dt 应当为空，但 SELECT 1 OK
--   后续 3200 启动时 PgEventStore.init() 会自动建 runtime_events / runtime_event_cursors
-- ─────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────
-- 第 5 节：retention 明确不由初始化 SQL 执行
-- ─────────────────────────────────────────────────────────────────
-- 禁止按 timestamp 对 runtime_events 做全表 90 天 DELETE：该做法会误删消息、
-- tool_result、工具生命周期以及尚未被 billing projection 消费/尚无法务授权的事实。
--
-- 唯一受支持路径：
--   pnpm -C server maintenance:runtime-events -- --legal-delete-through <seq>
-- 默认严格只读 dry-run；只有审批后同时传 --execute-retention、
-- --legal-delete-through、--authorization-ref 才按事件类别/TTL/双水位分批删除。
-- retention 矩阵、容量门禁、VACUUM/索引回收与恢复演练见：
--   docs/runtime-eventstore-retention-runbook.md
