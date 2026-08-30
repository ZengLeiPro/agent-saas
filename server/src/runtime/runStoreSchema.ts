import type { PgPool } from './runStoreTypes.js';
import { LEGACY_TENANT_ID } from '../data/tenants/types.js';

export interface PgRunStoreSchemaTarget {
  pool: PgPool;
  runsTable: string;
  messageSubmissionsTable: string;
  steeringInputsTable: string;
  steeringSessionsTable: string;
}

export async function initializePgRunStore(store: PgRunStoreSchemaTarget): Promise<void> {
    // 门禁加固（2026-06-22）：用 PG advisory lock 串行化并发 init。多进程（many-brains
    // 多实例同时启动 / chaos 多 worker 同时 init）会并发跑 `CREATE INDEX IF NOT EXISTS`，
    // 而 IF NOT EXISTS 对并发不原子——两端都判定"不存在"→ 都建 → 撞 pg_class 唯一约束
    // (23505)。锁绑定单条 dedicated 连接，覆盖全部 DDL 后释放；后到者阻塞到先到者建完，
    // 届时 IF NOT EXISTS 命中已存在→跳过。
    const lockKey = `${store.runsTable}:init`;
    const client = await store.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${store.runsTable} (
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
          idempotency_key TEXT,
          execution_target TEXT,
          workspace_id TEXT,
          metadata JSONB NOT NULL DEFAULT '{}'
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${store.messageSubmissionsTable} (
          tenant_id TEXT NOT NULL,
          user_scope TEXT NOT NULL,
          client_message_id TEXT NOT NULL,
          run_id TEXT NOT NULL UNIQUE,
          session_id TEXT NOT NULL,
          delivery_mode TEXT NOT NULL,
          accepted_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (tenant_id, user_scope, client_message_id)
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${store.steeringInputsTable} (
          input_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
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
        CREATE TABLE IF NOT EXISTS ${store.steeringSessionsTable} (
          tenant_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          stopped_at TIMESTAMPTZ,
          PRIMARY KEY (tenant_id, session_id)
        )
      `);
      // Runtime identity must exist before auxiliary backfill on pre-tenant deployments.
      await client.query(`ALTER TABLE ${store.runsTable} ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT '${LEGACY_TENANT_ID}'`);
      // Existing auxiliary rows inherit tenant from their globally unique source run.
      await client.query(`ALTER TABLE ${store.messageSubmissionsTable} ADD COLUMN IF NOT EXISTS tenant_id TEXT`);
      await client.query(`ALTER TABLE ${store.steeringInputsTable} ADD COLUMN IF NOT EXISTS tenant_id TEXT`);
      await client.query(`ALTER TABLE ${store.steeringSessionsTable} ADD COLUMN IF NOT EXISTS tenant_id TEXT`);
      await client.query(`
        UPDATE ${store.messageSubmissionsTable} submission SET tenant_id = run.tenant_id
        FROM ${store.runsTable} run
        WHERE submission.run_id = run.run_id AND submission.tenant_id IS NULL
      `);
      await client.query(`
        UPDATE ${store.steeringInputsTable} input SET tenant_id = source.tenant_id
        FROM ${store.runsTable} source
        WHERE input.source_run_id = source.run_id AND input.tenant_id IS NULL
      `);
      await client.query(`
        UPDATE ${store.steeringSessionsTable} steering_session SET tenant_id = identity.tenant_id
        FROM (
          SELECT session_id, MIN(tenant_id) AS tenant_id FROM ${store.runsTable}
          GROUP BY session_id HAVING COUNT(DISTINCT tenant_id) = 1
        ) identity
        WHERE steering_session.session_id = identity.session_id AND steering_session.tenant_id IS NULL
      `);
      await client.query(`ALTER TABLE ${store.messageSubmissionsTable} ALTER COLUMN tenant_id SET NOT NULL`);
      await client.query(`ALTER TABLE ${store.steeringInputsTable} ALTER COLUMN tenant_id SET NOT NULL`);
      await client.query(`ALTER TABLE ${store.steeringSessionsTable} ALTER COLUMN tenant_id SET NOT NULL`);
      await client.query(`ALTER TABLE ${store.messageSubmissionsTable} DROP CONSTRAINT IF EXISTS ${store.messageSubmissionsTable}_pkey`);
      await client.query(`ALTER TABLE ${store.messageSubmissionsTable} ADD CONSTRAINT ${store.messageSubmissionsTable}_pkey PRIMARY KEY (tenant_id, user_scope, client_message_id)`);
      await client.query(`ALTER TABLE ${store.steeringSessionsTable} DROP CONSTRAINT IF EXISTS ${store.steeringSessionsTable}_pkey`);
      await client.query(`ALTER TABLE ${store.steeringSessionsTable} ADD CONSTRAINT ${store.steeringSessionsTable}_pkey PRIMARY KEY (tenant_id, session_id)`);
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${store.messageSubmissionsTable}_tenant_idempotency_uidx ON ${store.messageSubmissionsTable} (tenant_id, user_scope, client_message_id)`);
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${store.steeringSessionsTable}_tenant_session_uidx ON ${store.steeringSessionsTable} (tenant_id, session_id)`);
      await client.query(`ALTER TABLE ${store.steeringInputsTable} ADD COLUMN IF NOT EXISTS sequence BIGSERIAL`);
      await client.query(`ALTER TABLE ${store.steeringInputsTable} ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${store.steeringInputsTable}_target_sequence_idx ON ${store.steeringInputsTable} (target_run_id, state, sequence)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${store.steeringInputsTable}_source_idx ON ${store.steeringInputsTable} (source_run_id, state)`);
      const existingColumns = new Set((await client.query<{ column_name: string }>(`
        SELECT attname AS column_name
        FROM pg_attribute
        WHERE attrelid = $1::regclass
          AND attnum > 0
          AND NOT attisdropped
      `, [store.runsTable])).rows.map((row) => row.column_name));
      // 严格 FIFO 使用数据库分配的单调序号，避免同毫秒 client runId 的随机后缀打乱顺序。
      if (!existingColumns.has('enqueue_seq')) {
        await client.query(`ALTER TABLE ${store.runsTable} ADD COLUMN enqueue_seq BIGSERIAL`);
        // BIGSERIAL 的默认回填取决于物理扫描顺序；按历史 requested_at 重排后再推进 sequence。
        await client.query(`
          WITH ordered AS (
            SELECT run_id, ROW_NUMBER() OVER (ORDER BY requested_at ASC, run_id ASC) AS seq
            FROM ${store.runsTable}
          )
          UPDATE ${store.runsTable} run
          SET enqueue_seq = ordered.seq
          FROM ordered
          WHERE run.run_id = ordered.run_id
        `);
        await client.query(`
          SELECT setval(
            pg_get_serial_sequence('${store.runsTable}', 'enqueue_seq'),
            COALESCE((SELECT MAX(enqueue_seq) FROM ${store.runsTable}), 1),
            EXISTS (SELECT 1 FROM ${store.runsTable})
          )
        `);
        await client.query(`ALTER TABLE ${store.runsTable} ALTER COLUMN enqueue_seq SET NOT NULL`);
      }
      // RFC v1 P0.4：Responses API session state 字段。先查 catalog 再按缺口 ALTER，
      // 避免每次启动为已存在的列申请强表锁。
      if (!existingColumns.has('last_response_id')) {
        await client.query(`ALTER TABLE ${store.runsTable} ADD COLUMN last_response_id TEXT`);
      }
      if (!existingColumns.has('last_response_expire_at')) {
        await client.query(`ALTER TABLE ${store.runsTable} ADD COLUMN last_response_expire_at TIMESTAMPTZ`);
      }
      if (!existingColumns.has('actual_model_seen')) {
        await client.query(`ALTER TABLE ${store.runsTable} ADD COLUMN actual_model_seen TEXT`);
      }
      // 2026-07-02：接力身份键（切模型后跨后端接力必炸，见 findLatestResponseSessionStateBySession 调用方）
      if (!existingColumns.has('last_response_model')) {
        await client.query(`ALTER TABLE ${store.runsTable} ADD COLUMN last_response_model TEXT`);
      }
      if (!existingColumns.has('last_response_profile_digest')) {
        await client.query(`ALTER TABLE ${store.runsTable} ADD COLUMN last_response_profile_digest TEXT`);
      }
      if (!existingColumns.has('cumulative_input_tokens')) {
        await client.query(`ALTER TABLE ${store.runsTable} ADD COLUMN cumulative_input_tokens BIGINT NOT NULL DEFAULT 0`);
      }
      if (!existingColumns.has('sandbox_scope_id')) {
        await client.query(`ALTER TABLE ${store.runsTable} ADD COLUMN sandbox_scope_id TEXT`);
      }
      // PR 3：多组织改造 — 加 tenant_id 列，旧数据回填 LEGACY_TENANT_ID，新 run 由
      // dispatch 层（PR 4）显式传入；UpsertRunInput 已加可选 tenantId 字段。
      if (!existingColumns.has('tenant_id')) {
        await client.query(`ALTER TABLE ${store.runsTable} ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT '${LEGACY_TENANT_ID}'`);
      }
      if (!existingColumns.has('submitter_scope')) {
        await client.query(`ALTER TABLE ${store.runsTable} ADD COLUMN submitter_scope TEXT`);
      }
      await client.query(`UPDATE ${store.runsTable} SET sandbox_scope_id = metadata->>'sandboxScopeId' WHERE sandbox_scope_id IS NULL AND metadata ? 'sandboxScopeId'`);
      // wakeMessage 是活跃 Run 的 durable 恢复载荷；Run 进入终态后已无恢复用途，启动时清理历史遗留正文。
      await client.query(`UPDATE ${store.runsTable} SET metadata = metadata - 'wakeMessage' WHERE status IN ('completed','failed','cancelled','orphaned') AND metadata ? 'wakeMessage'`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${store.runsTable}_tenant_idx ON ${store.runsTable} (tenant_id, updated_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${store.runsTable}_user_idx ON ${store.runsTable} (user_id, updated_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${store.runsTable}_sandbox_scope_idx ON ${store.runsTable} (sandbox_scope_id, updated_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${store.runsTable}_status_idx ON ${store.runsTable} (status, updated_at)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${store.runsTable}_session_idx ON ${store.runsTable} (session_id, updated_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${store.runsTable}_session_enqueue_idx ON ${store.runsTable} (session_id, enqueue_seq)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${store.runsTable}_background_parent_session_idx ON ${store.runsTable} ((metadata->>'parentSessionId'), requested_at DESC) WHERE metadata->>'backgroundTask' = 'true'`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${store.runsTable}_background_top_session_idx ON ${store.runsTable} ((metadata->>'topLevelSessionId'), requested_at DESC) WHERE metadata->>'backgroundTask' = 'true'`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${store.runsTable}_background_parent_run_idx ON ${store.runsTable} ((metadata->>'parentRunId'), status) WHERE metadata->>'backgroundTask' = 'true'`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${store.runsTable}_background_tenant_status_idx ON ${store.runsTable} (tenant_id, status, updated_at) WHERE metadata->>'backgroundTask' = 'true'`);
      // RFC v1 P0.4：按 sessionId 找最近完成 run 的 last_response_id（跨 run 接力查询路径）
      await client.query(`CREATE INDEX IF NOT EXISTS ${store.runsTable}_session_last_response_idx ON ${store.runsTable} (session_id, updated_at DESC) WHERE last_response_id IS NOT NULL`);
      await client.query(`DROP INDEX IF EXISTS ${store.runsTable}_active_idempotency_idx`);
      await client.query(`DROP INDEX IF EXISTS ${store.runsTable}_active_idempotency_v2_idx`);
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${store.runsTable}_active_idempotency_v3_idx ON ${store.runsTable} ((COALESCE(submitter_scope, user_id, '__anonymous__')), idempotency_key) WHERE idempotency_key IS NOT NULL AND status IN ('pending','running','waiting_approval','waiting_user','waiting_hand')`);
      await client.query(`DROP INDEX IF EXISTS ${store.runsTable}_idempotency_lookup_idx`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${store.runsTable}_idempotency_lookup_v2_idx ON ${store.runsTable} ((COALESCE(submitter_scope, user_id, '__anonymous__')), idempotency_key, updated_at DESC) WHERE idempotency_key IS NOT NULL`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${store.messageSubmissionsTable}_session_idx ON ${store.messageSubmissionsTable} (tenant_id, session_id, accepted_at)`);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
      client.release();
    }
  }
