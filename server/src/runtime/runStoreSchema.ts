import type { PgPool } from './runStoreTypes.js';
import { LEGACY_TENANT_ID } from '../data/tenants/types.js';
import { sandboxRunAdmissionFenceSql } from './sandboxRunAdmissionFence.js';

export async function initializePgRunStoreSchema(input: {
  pool: PgPool;
  runsTable: string;
  messageSubmissionsTable: string;
  steeringInputsTable: string;
  steeringSessionsTable: string;
}): Promise<void> {
    // 门禁加固（2026-06-22）：用 PG advisory lock 串行化并发 init。多进程（many-brains
    // 多实例同时启动 / chaos 多 worker 同时 init）会并发跑 `CREATE INDEX IF NOT EXISTS`，
    // 而 IF NOT EXISTS 对并发不原子——两端都判定"不存在"→ 都建 → 撞 pg_class 唯一约束
    // (23505)。锁绑定单条 dedicated 连接，覆盖全部 DDL 后释放；后到者阻塞到先到者建完，
    // 届时 IF NOT EXISTS 命中已存在→跳过。
    const lockKey = `${input.runsTable}:init`;
    const client = await input.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${input.runsTable} (
          run_id TEXT PRIMARY KEY,
          enqueue_seq BIGSERIAL NOT NULL,
          session_id TEXT NOT NULL,
          user_id TEXT,
          submitter_scope TEXT,
          status TEXT NOT NULL,
          status_reason TEXT,
          model TEXT,
          channel TEXT,
          requested_at TIMESTAMPTZ NOT NULL,
          started_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL,
          completed_at TIMESTAMPTZ,
          failed_at TIMESTAMPTZ,
          cancelled_at TIMESTAMPTZ,
          worker_id TEXT,
          lease_expires_at TIMESTAMPTZ,
          last_heartbeat_at TIMESTAMPTZ,
          liveness_state TEXT,
          liveness_reason_code TEXT,
          liveness_detected_at TIMESTAMPTZ,
          liveness_version BIGINT,
          idempotency_key TEXT,
          execution_target TEXT,
          workspace_id TEXT,
          metadata JSONB NOT NULL DEFAULT '{}'
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${input.messageSubmissionsTable} (
          user_scope TEXT NOT NULL,
          client_message_id TEXT NOT NULL,
          run_id TEXT NOT NULL UNIQUE,
          session_id TEXT NOT NULL,
          delivery_mode TEXT NOT NULL,
          accepted_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (user_scope, client_message_id)
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${input.steeringInputsTable} (
          input_id TEXT PRIMARY KEY,
          source_run_id TEXT NOT NULL UNIQUE,
          target_run_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending',
          sequence BIGSERIAL NOT NULL,
          accepted_at TIMESTAMPTZ NOT NULL,
          reserved_at TIMESTAMPTZ,
          applied_at TIMESTAMPTZ
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${input.steeringSessionsTable} (
          session_id TEXT PRIMARY KEY,
          stopped_at TIMESTAMPTZ
        )
      `);
      await client.query(`ALTER TABLE ${input.steeringInputsTable} ADD COLUMN IF NOT EXISTS sequence BIGSERIAL`);
      await client.query(`ALTER TABLE ${input.steeringInputsTable} ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${input.steeringInputsTable}_target_sequence_idx ON ${input.steeringInputsTable} (target_run_id, state, sequence)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${input.steeringInputsTable}_source_idx ON ${input.steeringInputsTable} (source_run_id, state)`);
      const existingColumns = new Set((await client.query<{ column_name: string }>(`
        SELECT attname AS column_name
        FROM pg_attribute
        WHERE attrelid = $1::regclass
          AND attnum > 0
          AND NOT attisdropped
      `, [input.runsTable])).rows.map((row) => row.column_name));
      // 严格 FIFO 使用数据库分配的单调序号，避免同毫秒 client runId 的随机后缀打乱顺序。
      if (!existingColumns.has('enqueue_seq')) {
        await client.query(`ALTER TABLE ${input.runsTable} ADD COLUMN enqueue_seq BIGSERIAL`);
        // BIGSERIAL 的默认回填取决于物理扫描顺序；按历史 requested_at 重排后再推进 sequence。
        await client.query(`
          WITH ordered AS (
            SELECT run_id, ROW_NUMBER() OVER (ORDER BY requested_at ASC, run_id ASC) AS seq
            FROM ${input.runsTable}
          )
          UPDATE ${input.runsTable} run
          SET enqueue_seq = ordered.seq
          FROM ordered
          WHERE run.run_id = ordered.run_id
        `);
        await client.query(`
          SELECT setval(
            pg_get_serial_sequence('${input.runsTable}', 'enqueue_seq'),
            COALESCE((SELECT MAX(enqueue_seq) FROM ${input.runsTable}), 1),
            EXISTS (SELECT 1 FROM ${input.runsTable})
          )
        `);
        await client.query(`ALTER TABLE ${input.runsTable} ALTER COLUMN enqueue_seq SET NOT NULL`);
      }
      // RFC v1 P0.4：Responses API session state 字段。先查 catalog 再按缺口 ALTER，
      // 避免每次启动为已存在的列申请强表锁。
      if (!existingColumns.has('last_response_id')) {
        await client.query(`ALTER TABLE ${input.runsTable} ADD COLUMN last_response_id TEXT`);
      }
      if (!existingColumns.has('last_response_expire_at')) {
        await client.query(`ALTER TABLE ${input.runsTable} ADD COLUMN last_response_expire_at TIMESTAMPTZ`);
      }
      if (!existingColumns.has('actual_model_seen')) {
        await client.query(`ALTER TABLE ${input.runsTable} ADD COLUMN actual_model_seen TEXT`);
      }
      // 2026-07-02：接力身份键（切模型后跨后端接力必炸，见 findLatestResponseSessionStateBySession 调用方）
      if (!existingColumns.has('last_response_model')) {
        await client.query(`ALTER TABLE ${input.runsTable} ADD COLUMN last_response_model TEXT`);
      }
      if (!existingColumns.has('last_response_profile_digest')) {
        await client.query(`ALTER TABLE ${input.runsTable} ADD COLUMN last_response_profile_digest TEXT`);
      }
      if (!existingColumns.has('cumulative_input_tokens')) {
        await client.query(`ALTER TABLE ${input.runsTable} ADD COLUMN cumulative_input_tokens BIGINT NOT NULL DEFAULT 0`);
      }
      if (!existingColumns.has('sandbox_scope_id')) {
        await client.query(`ALTER TABLE ${input.runsTable} ADD COLUMN sandbox_scope_id TEXT`);
      }
      // PR 3：多组织改造 — 加 tenant_id 列，旧数据回填 LEGACY_TENANT_ID，新 run 由
      // dispatch 层（PR 4）显式传入；UpsertRunInput 已加可选 tenantId 字段。
      if (!existingColumns.has('tenant_id')) {
        await client.query(`ALTER TABLE ${input.runsTable} ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '${LEGACY_TENANT_ID}'`);
      }
      if (!existingColumns.has('submitter_scope')) {
        await client.query(`ALTER TABLE ${input.runsTable} ADD COLUMN submitter_scope TEXT`);
      }
      // M40-02 intentionally leaves existing rows NULL: missing version projects as unknown.
      if (!existingColumns.has('last_heartbeat_at')) {
        await client.query(`ALTER TABLE ${input.runsTable} ADD COLUMN last_heartbeat_at TIMESTAMPTZ`);
      }
      if (!existingColumns.has('liveness_state')) {
        await client.query(`ALTER TABLE ${input.runsTable} ADD COLUMN liveness_state TEXT`);
      }
      if (!existingColumns.has('liveness_reason_code')) {
        await client.query(`ALTER TABLE ${input.runsTable} ADD COLUMN liveness_reason_code TEXT`);
      }
      if (!existingColumns.has('liveness_detected_at')) {
        await client.query(`ALTER TABLE ${input.runsTable} ADD COLUMN liveness_detected_at TIMESTAMPTZ`);
      }
      if (!existingColumns.has('liveness_version')) {
        await client.query(`ALTER TABLE ${input.runsTable} ADD COLUMN liveness_version BIGINT`);
      }
      await client.query(`UPDATE ${input.runsTable} SET sandbox_scope_id = metadata->>'sandboxScopeId' WHERE sandbox_scope_id IS NULL AND metadata ? 'sandboxScopeId'`);
      // wakeMessage 是活跃 Run 的 durable 恢复载荷；Run 进入终态后已无恢复用途，启动时清理历史遗留正文。
      await client.query(`UPDATE ${input.runsTable} SET metadata = metadata - 'wakeMessage' WHERE status IN ('completed','failed','cancelled','orphaned') AND metadata ? 'wakeMessage'`);
      await client.query(sandboxRunAdmissionFenceSql(input.runsTable).join(';\n'));
      await client.query(`CREATE INDEX IF NOT EXISTS ${input.runsTable}_tenant_idx ON ${input.runsTable} (tenant_id, updated_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${input.runsTable}_user_idx ON ${input.runsTable} (user_id, updated_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${input.runsTable}_sandbox_scope_idx ON ${input.runsTable} (sandbox_scope_id, updated_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${input.runsTable}_sandbox_terminal_scope_idx ON ${input.runsTable} (tenant_id, workspace_id, sandbox_scope_id, updated_at DESC) WHERE status IN ('completed','failed','cancelled','orphaned') AND metadata->>'sandboxWorkloadTopLevel' = 'true'`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${input.runsTable}_status_idx ON ${input.runsTable} (status, updated_at)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${input.runsTable}_liveness_reap_idx ON ${input.runsTable} (liveness_state, lease_expires_at, liveness_detected_at) WHERE liveness_version IS NOT NULL`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${input.runsTable}_session_idx ON ${input.runsTable} (session_id, updated_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${input.runsTable}_session_enqueue_idx ON ${input.runsTable} (session_id, enqueue_seq)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${input.runsTable}_background_parent_session_idx ON ${input.runsTable} ((metadata->>'parentSessionId'), requested_at DESC) WHERE metadata->>'backgroundTask' = 'true'`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${input.runsTable}_background_top_session_idx ON ${input.runsTable} ((metadata->>'topLevelSessionId'), requested_at DESC) WHERE metadata->>'backgroundTask' = 'true'`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${input.runsTable}_background_parent_run_idx ON ${input.runsTable} ((metadata->>'parentRunId'), status) WHERE metadata->>'backgroundTask' = 'true'`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${input.runsTable}_background_tenant_status_idx ON ${input.runsTable} (tenant_id, status, updated_at) WHERE metadata->>'backgroundTask' = 'true'`);
      // RFC v1 P0.4：按 sessionId 找最近完成 run 的 last_response_id（跨 run 接力查询路径）
      await client.query(`CREATE INDEX IF NOT EXISTS ${input.runsTable}_session_last_response_idx ON ${input.runsTable} (session_id, updated_at DESC) WHERE last_response_id IS NOT NULL`);
      await client.query(`DROP INDEX IF EXISTS ${input.runsTable}_active_idempotency_idx`);
      await client.query(`DROP INDEX IF EXISTS ${input.runsTable}_active_idempotency_v2_idx`);
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${input.runsTable}_active_idempotency_v3_idx ON ${input.runsTable} ((COALESCE(submitter_scope, user_id, '__anonymous__')), idempotency_key) WHERE idempotency_key IS NOT NULL AND status IN ('pending','running','waiting_approval','waiting_user','waiting_hand')`);
      await client.query(`DROP INDEX IF EXISTS ${input.runsTable}_idempotency_lookup_idx`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${input.runsTable}_idempotency_lookup_v2_idx ON ${input.runsTable} ((COALESCE(submitter_scope, user_id, '__anonymous__')), idempotency_key, updated_at DESC) WHERE idempotency_key IS NOT NULL`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${input.messageSubmissionsTable}_session_idx ON ${input.messageSubmissionsTable} (session_id, accepted_at)`);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
      client.release();
    }

}
