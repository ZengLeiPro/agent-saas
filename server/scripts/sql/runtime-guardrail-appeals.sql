-- runtime_guardrail_appeals · 员工申诉表（B4 § 4.3.2 员工申诉设计）
--
-- 员工被专职 Agent 门禁拒答后可提交申诉，管理员在 QaConsole 侧处理：
--   accepted → 门禁 scopeDescription 有误伤、需要调整
--   rejected → 拒答正确、员工被驳回
--
-- 申诉率是"门禁 scope 准不准"的唯一真理指标；上线灰度期观察。
--
-- 执行方式（新建 database 无需手工执行；由 PgAppealStore.init() 幂等建表）：
--   PGPASSWORD=$APP_PW psql -h $RDS_HOST -U agent_runtime_app -d agent_runtime \
--     -v ON_ERROR_STOP=1 -f runtime-guardrail-appeals.sql
--
-- 索引：
--   (tenant_id, status)                     — 管理员按状态过滤 pending 队列
--   (tenant_id, expert_id, created_at DESC) — 按专家维度看申诉趋势
--
-- 幂等键：UNIQUE (guardrail_event_id, user_id)
--   同一员工对同一条 guardrail_event 只能申诉一次。

\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS runtime_guardrail_appeals (
    id                    TEXT PRIMARY KEY,
    tenant_id             TEXT NOT NULL,
    guardrail_event_id    TEXT NOT NULL,       -- FK 语义指向 runtime_guardrail_events.id（未强约束，遵循 runtime_* 表跨表软引用惯例）
    user_id               TEXT NOT NULL,       -- 提申诉的员工 userId
    user_message          TEXT NOT NULL,       -- 被拒答的原始消息（冗余存，便于队列独立浏览）
    expert_id             TEXT NOT NULL,       -- 涉及的企业专家 orgAgent id（冗余存）
    appeal_reason         TEXT,                -- 员工填写的申诉理由，可选
    status                TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'accepted' | 'rejected'
    handled_by            TEXT,                -- 管理员 userId
    handled_at            TIMESTAMPTZ,
    handle_note           TEXT,                -- 管理员处理留言（内部备注）
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (guardrail_event_id, user_id)
);

CREATE INDEX IF NOT EXISTS runtime_guardrail_appeals_tenant_status_idx
    ON runtime_guardrail_appeals (tenant_id, status);

CREATE INDEX IF NOT EXISTS runtime_guardrail_appeals_tenant_expert_idx
    ON runtime_guardrail_appeals (tenant_id, expert_id, created_at DESC);

COMMENT ON TABLE runtime_guardrail_appeals IS
    'B4 § 4.3.2 员工申诉表。门禁拒答后员工申诉、管理员处理；申诉率为 scope 准确度的真理指标。';
