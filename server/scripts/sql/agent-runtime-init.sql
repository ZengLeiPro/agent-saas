-- Agent Runtime PG 初始化 DDL（在 Azeroth RDS 同实例上建独立 database）
--
-- 用途：把 3200 agent-saas 的 runtime event log 跟 Azeroth 业务数据
-- 物理隔离（独立 database + 独立 role + 独立连接池上限），避免互相挤连接、
-- 共用 WAL 带宽、运维耦合。
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
    'Runtime event log for agent-saas (3200). Physically isolated from azeroth business data.';

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
-- 第 5 节（后续可单独跑，不在初始化必跑）：retention 清理函数
-- ─────────────────────────────────────────────────────────────────
-- 暂留作 90 天 retention 草案。等 PG default 切换稳定后再启用，并由 cron 调用。
-- 不在初始化阶段执行，避免在没有数据时给出空函数。
--
-- CREATE OR REPLACE FUNCTION runtime_events_prune_older_than(retain_days INTEGER)
-- RETURNS TABLE(deleted_events BIGINT, oldest_kept TIMESTAMPTZ) AS $$
-- DECLARE
--     v_deleted BIGINT;
--     v_oldest  TIMESTAMPTZ;
-- BEGIN
--     DELETE FROM runtime_events
--     WHERE timestamp < (NOW() - (retain_days || ' days')::INTERVAL);
--     GET DIAGNOSTICS v_deleted = ROW_COUNT;
--     SELECT MIN(timestamp) INTO v_oldest FROM runtime_events;
--     RETURN QUERY SELECT v_deleted, v_oldest;
-- END;
-- $$ LANGUAGE plpgsql;
