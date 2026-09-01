import type pg from 'pg';
import { LEGACY_TENANT_ID } from '../data/tenants/types.js';
import type { PgPool, PgRunStoreWriterCapability } from './runStoreTypes.js';

export interface PgRunStoreSchemaTarget {
  pool: PgPool;
  runsTable: string;
  messageSubmissionsTable: string;
  steeringInputsTable: string;
  steeringSessionsTable: string;
  writerCapability?: PgRunStoreWriterCapability;
}

export const RUN_STORE_TENANT_SCHEMA_VERSION = 1;

/** Capability assigned to every writer allowed after tenant authority contract. */
export const RUN_STORE_TENANT_WRITER_CAPABILITY = 'tenant-native-v1' as const;

export interface PgRunStoreDrainEvidence {
  evidenceId: string;
  capability: typeof RUN_STORE_TENANT_WRITER_CAPABILITY;
  observer: string;
}

export interface PgRunStoreLegacyWriterCapability {
  dbRole: string;
  tenantId: string;
}

export interface PgRunStoreContractGate {
  expectedExpandVersion: typeof RUN_STORE_TENANT_SCHEMA_VERSION;
  /** References evidence durably recorded under the schema migration lock. */
  drainEvidenceId: string;
}

async function bootstrapAndValidateWriter(
  client: pg.PoolClient,
  store: PgRunStoreSchemaTarget,
): Promise<void> {
  const identity = await client.query<{
    db_role: string; rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean;
  }>(`SELECT session_user db_role,rolcanlogin,rolsuper,rolbypassrls
      FROM pg_roles WHERE rolname=session_user`);
  const role = identity.rows[0];
  const declaration = store.writerCapability;
  if (!role && declaration?.capability === 'tenant-native-v1'
    && declaration.allowPrivilegedRoleForTests === true) {
    // The explicit test-only declaration permits minimal fake pools without PG identity semantics.
    return;
  }
  if (!role?.rolcanlogin) throw new Error('run-store writer session_user must be a LOGIN role');
  if ((role.rolsuper || role.rolbypassrls) && !declaration?.allowPrivilegedRoleForTests) {
    throw new Error('run-store production writer must not be SUPERUSER or BYPASSRLS');
  }
  if (declaration) {
    const tenantId = declaration.capability === 'legacy-single-tenant' ? declaration.tenantId.trim() : null;
    if (declaration.capability === 'legacy-single-tenant' && !tenantId) {
      throw new Error('legacy run-store writer requires an explicit tenant binding');
    }
    await client.query(`INSERT INTO ${store.runsTable}_writer_capabilities
      (db_role,capability,tenant_id,enabled,disabled_at)
      VALUES (session_user,$1,$2,true,NULL) ON CONFLICT (db_role) DO NOTHING`,
    [declaration.capability, tenantId]);
  }
  const registered = await client.query<{
    capability: string; tenant_id: string | null; enabled: boolean; phase: string;
  }>(`SELECT registry.capability,registry.tenant_id,registry.enabled,migration.phase
      FROM ${store.runsTable}_writer_capabilities registry
      CROSS JOIN ${store.runsTable}_schema_migrations migration
      WHERE registry.db_role=session_user AND migration.module='tenant_auxiliary_identity'`);
  const writer = registered.rows[0];
  if (!writer?.enabled) throw new Error('run-store writer session_user is not explicitly registered or is disabled');
  if (declaration && (writer.capability !== declaration.capability
    || writer.tenant_id !== (declaration.capability === 'legacy-single-tenant' ? declaration.tenantId.trim() : null))) {
    throw new Error('run-store writer registration conflicts with the explicit immutable capability declaration');
  }
  if (writer.capability === 'legacy-single-tenant' && writer.phase === 'contract') {
    throw new Error('legacy run-store writer capability rejected after contract');
  }
}

export async function initializePgRunStore(store: PgRunStoreSchemaTarget): Promise<void> {
  // One migration lock protects expand, durable evidence, and contract transitions.
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
          tenant_id TEXT,
          user_scope TEXT NOT NULL,
          client_message_id TEXT NOT NULL,
          tenant_user_scope TEXT,
          tenant_client_message_id TEXT,
          run_id TEXT NOT NULL UNIQUE,
          session_id TEXT NOT NULL,
          delivery_mode TEXT NOT NULL,
          accepted_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (user_scope, client_message_id)
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${store.steeringInputsTable} (
          input_id TEXT PRIMARY KEY,
          tenant_id TEXT,
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
          tenant_id TEXT,
          session_id TEXT NOT NULL,
          tenant_session_id TEXT,
          stopped_at TIMESTAMPTZ,
          PRIMARY KEY (session_id)
        )
      `);
      const existingColumns = new Set((await client.query<{ column_name: string }>(`
        SELECT attname AS column_name
        FROM pg_attribute
        WHERE attrelid = $1::regclass
          AND attnum > 0
          AND NOT attisdropped
      `, [store.runsTable])).rows.map((row) => row.column_name));
      // Runtime identity must exist before auxiliary backfill on pre-tenant deployments. Catalog
      // gating keeps compatibility init lock-free once the complete schema is already present.
      if (!existingColumns.has('tenant_id')) {
        await client.query(`ALTER TABLE ${store.runsTable} ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '${LEGACY_TENANT_ID}'`);
        existingColumns.add('tenant_id');
      }
      // A composite FK may only target a matching unique key. Install the parent key before any
      // session-automation schema can add its (tenant, session, run) FK (rolling deploy order).
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${store.runsTable}_tenant_session_run_uidx ON ${store.runsTable} (tenant_id, session_id, run_id)`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${store.runsTable}_schema_migrations (
          module TEXT PRIMARY KEY,
          version INTEGER NOT NULL,
          phase TEXT NOT NULL CHECK (phase IN ('expand','contract')),
          evidence JSONB NOT NULL DEFAULT '{}',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(`ALTER TABLE ${store.runsTable}_schema_migrations ADD COLUMN IF NOT EXISTS evidence JSONB NOT NULL DEFAULT '{}'`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${store.runsTable}_writer_capabilities (
          db_role TEXT PRIMARY KEY,
          capability TEXT NOT NULL CHECK (capability IN ('legacy-single-tenant','${RUN_STORE_TENANT_WRITER_CAPABILITY}')),
          tenant_id TEXT,
          enabled BOOLEAN NOT NULL DEFAULT true,
          registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          disabled_at TIMESTAMPTZ,
          CHECK ((capability='legacy-single-tenant')=(tenant_id IS NOT NULL))
        )
      `);
      await client.query(`
        INSERT INTO ${store.runsTable}_schema_migrations (module, version, phase)
        VALUES ('tenant_auxiliary_identity', ${RUN_STORE_TENANT_SCHEMA_VERSION}, 'expand')
        ON CONFLICT (module) DO UPDATE SET
          version=GREATEST(${store.runsTable}_schema_migrations.version, EXCLUDED.version),
          phase=CASE WHEN ${store.runsTable}_schema_migrations.phase='contract' THEN 'contract' ELSE EXCLUDED.phase END,
          updated_at=now()
      `);
      await bootstrapAndValidateWriter(client, store);
      // Expand is the only phase executed by ordinary startup. The legacy raw-key PKs are the
      // schema-phase constraint that forbids cross-tenant reuse while old writers remain. Contract
      // removes them only after the operator explicitly confirms that every old writer drained.
      await client.query(`ALTER TABLE ${store.messageSubmissionsTable} ADD COLUMN IF NOT EXISTS tenant_id TEXT`);
      await client.query(`ALTER TABLE ${store.messageSubmissionsTable} ADD COLUMN IF NOT EXISTS tenant_user_scope TEXT`);
      await client.query(`ALTER TABLE ${store.messageSubmissionsTable} ADD COLUMN IF NOT EXISTS tenant_client_message_id TEXT`);
      await client.query(`ALTER TABLE ${store.steeringInputsTable} ADD COLUMN IF NOT EXISTS tenant_id TEXT`);
      await client.query(`ALTER TABLE ${store.steeringSessionsTable} ADD COLUMN IF NOT EXISTS tenant_id TEXT`);
      await client.query(`ALTER TABLE ${store.steeringSessionsTable} ADD COLUMN IF NOT EXISTS tenant_session_id TEXT`);
      // session_user is fixed at authentication and cannot be changed with SET ROLE.
      await client.query(`
        CREATE OR REPLACE FUNCTION ${store.runsTable}_writer_capability_fn()
        RETURNS TABLE(capability TEXT, tenant_id TEXT, enabled BOOLEAN) AS $$
          SELECT registry.capability,registry.tenant_id,registry.enabled
          FROM ${store.runsTable}_writer_capabilities registry
          WHERE registry.db_role=session_user
        $$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public
      `);
      await client.query(`
        CREATE OR REPLACE FUNCTION ${store.runsTable}_writer_tenant_guard_fn(row_tenant TEXT)
        RETURNS TEXT AS $$
        DECLARE writer RECORD;
        BEGIN
          SELECT * INTO writer FROM ${store.runsTable}_writer_capability_fn();
          IF writer.capability IS NULL OR NOT writer.enabled THEN
            RAISE EXCEPTION 'run-store writer capability is absent or disabled' USING ERRCODE='42501';
          END IF;
          IF writer.capability='legacy-single-tenant' THEN
            IF (SELECT phase FROM ${store.runsTable}_schema_migrations
                WHERE module='tenant_auxiliary_identity')='contract' THEN
              RAISE EXCEPTION 'legacy run-store writer capability rejected after contract' USING ERRCODE='42501';
            END IF;
            IF row_tenant IS NOT NULL AND row_tenant<>writer.tenant_id THEN
              RAISE EXCEPTION 'legacy run-store writer crossed its tenant fence' USING ERRCODE='42501';
            END IF;
            RETURN writer.tenant_id;
          END IF;
          RETURN row_tenant;
        END $$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public
      `);
      await client.query(`
        CREATE OR REPLACE FUNCTION ${store.runsTable}_tenant_writer_guard_fn() RETURNS trigger AS $$
        BEGIN
          NEW.tenant_id := ${store.runsTable}_writer_tenant_guard_fn(NEW.tenant_id);
          RETURN NEW;
        END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
      `);
      await client.query(`DROP TRIGGER IF EXISTS tenant_writer_fence ON ${store.runsTable}`);
      await client.query(`CREATE TRIGGER tenant_writer_fence BEFORE INSERT OR UPDATE OF tenant_id ON ${store.runsTable} FOR EACH ROW EXECUTE FUNCTION ${store.runsTable}_tenant_writer_guard_fn()`);
      // Continuous legacy catch-up: old writers omit tenant columns. Their registered DB role supplies
      // the single allowed tenant; tenant-native writers carry explicit tenant columns.
      await client.query(`
        CREATE OR REPLACE FUNCTION ${store.messageSubmissionsTable}_tenant_expand_fn() RETURNS trigger AS $$
        BEGIN
          IF NEW.tenant_id IS NULL THEN
            SELECT tenant_id INTO NEW.tenant_id FROM ${store.runsTable}
            WHERE run_id=NEW.run_id AND session_id=NEW.session_id;
          END IF;
          NEW.tenant_id := ${store.runsTable}_writer_tenant_guard_fn(NEW.tenant_id);
          IF NEW.tenant_id IS NOT NULL THEN
            NEW.tenant_user_scope := COALESCE(NEW.tenant_user_scope, NEW.user_scope);
            NEW.tenant_client_message_id := COALESCE(NEW.tenant_client_message_id, NEW.client_message_id);
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql
      `);
      await client.query(`DROP TRIGGER IF EXISTS tenant_expand ON ${store.messageSubmissionsTable}`);
      await client.query(`CREATE TRIGGER tenant_expand BEFORE INSERT ON ${store.messageSubmissionsTable} FOR EACH ROW EXECUTE FUNCTION ${store.messageSubmissionsTable}_tenant_expand_fn()`);
      await client.query(`
        CREATE OR REPLACE FUNCTION ${store.steeringInputsTable}_tenant_expand_fn() RETURNS trigger AS $$
        BEGIN
          IF NEW.tenant_id IS NULL THEN
            SELECT source.tenant_id INTO NEW.tenant_id
            FROM ${store.runsTable} source JOIN ${store.runsTable} target
              ON target.run_id=NEW.target_run_id AND target.tenant_id=source.tenant_id
             AND target.session_id=source.session_id
            WHERE source.run_id=NEW.source_run_id AND source.session_id=NEW.session_id;
          END IF;
          NEW.tenant_id := ${store.runsTable}_writer_tenant_guard_fn(NEW.tenant_id);
          RETURN NEW;
        END $$ LANGUAGE plpgsql
      `);
      await client.query(`DROP TRIGGER IF EXISTS tenant_expand ON ${store.steeringInputsTable}`);
      await client.query(`CREATE TRIGGER tenant_expand BEFORE INSERT ON ${store.steeringInputsTable} FOR EACH ROW EXECUTE FUNCTION ${store.steeringInputsTable}_tenant_expand_fn()`);
      await client.query(`
        CREATE OR REPLACE FUNCTION ${store.steeringSessionsTable}_tenant_expand_fn() RETURNS trigger AS $$
        BEGIN
          IF NEW.tenant_id IS NULL THEN
            SELECT MIN(tenant_id) INTO NEW.tenant_id FROM ${store.runsTable}
            WHERE session_id=NEW.session_id HAVING COUNT(DISTINCT tenant_id)=1;
          END IF;
          NEW.tenant_id := ${store.runsTable}_writer_tenant_guard_fn(NEW.tenant_id);
          IF NEW.tenant_id IS NOT NULL THEN
            NEW.tenant_session_id := COALESCE(NEW.tenant_session_id, NEW.session_id);
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql
      `);
      await client.query(`DROP TRIGGER IF EXISTS tenant_expand ON ${store.steeringSessionsTable}`);
      await client.query(`CREATE TRIGGER tenant_expand BEFORE INSERT ON ${store.steeringSessionsTable} FOR EACH ROW EXECUTE FUNCTION ${store.steeringSessionsTable}_tenant_expand_fn()`);
      await client.query(`
        CREATE OR REPLACE FUNCTION ${store.runsTable}_writer_row_visible_fn(row_tenant TEXT)
        RETURNS boolean AS $$
        DECLARE writer RECORD;
        BEGIN
          SELECT * INTO writer FROM ${store.runsTable}_writer_capability_fn();
          IF writer.capability IS NULL OR NOT writer.enabled THEN
            RAISE EXCEPTION 'run-store reader capability is absent or disabled' USING ERRCODE='42501';
          END IF;
          IF writer.capability='${RUN_STORE_TENANT_WRITER_CAPABILITY}' THEN RETURN true; END IF;
          IF (SELECT phase FROM ${store.runsTable}_schema_migrations
              WHERE module='tenant_auxiliary_identity')='contract' THEN
            RAISE EXCEPTION 'legacy run-store reader capability rejected after contract' USING ERRCODE='42501';
          END IF;
          RETURN writer.tenant_id=row_tenant;
        END $$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public
      `);
      // The authority fence covers the parent as well as every auxiliary table. The policy
      // predicate only reads the capability registry/migration state (never runs), so runs reads
      // performed by SECURITY DEFINER triggers cannot recurse through the runs policy.
      for (const table of [store.runsTable, store.messageSubmissionsTable,
        store.steeringInputsTable, store.steeringSessionsTable]) {
        await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
        await client.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
        await client.query(`DROP POLICY IF EXISTS tenant_writer_capability ON ${table}`);
        await client.query(`CREATE POLICY tenant_writer_capability ON ${table}
          USING (${store.runsTable}_writer_row_visible_fn(tenant_id))
          WITH CHECK (${store.runsTable}_writer_row_visible_fn(tenant_id))`);
      }
      await client.query(`
        CREATE OR REPLACE FUNCTION ${store.runsTable}_tenant_aux_catchup_fn() RETURNS trigger AS $$
        BEGIN
          UPDATE ${store.messageSubmissionsTable}
          SET tenant_id=NEW.tenant_id,
              tenant_user_scope=COALESCE(tenant_user_scope,user_scope),
              tenant_client_message_id=COALESCE(tenant_client_message_id,client_message_id)
          WHERE run_id=NEW.run_id AND session_id=NEW.session_id AND tenant_id IS NULL;
          UPDATE ${store.steeringSessionsTable} stop
          SET tenant_id=NEW.tenant_id, tenant_session_id=stop.session_id
          WHERE stop.session_id=NEW.session_id AND stop.tenant_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM ${store.runsTable} other
              WHERE other.session_id=NEW.session_id AND other.tenant_id<>NEW.tenant_id);
          RETURN NEW;
        END $$ LANGUAGE plpgsql
      `);
      await client.query(`DROP TRIGGER IF EXISTS tenant_aux_catchup ON ${store.runsTable}`);
      await client.query(`CREATE TRIGGER tenant_aux_catchup AFTER INSERT OR UPDATE OF tenant_id, session_id ON ${store.runsTable} FOR EACH ROW EXECUTE FUNCTION ${store.runsTable}_tenant_aux_catchup_fn()`);
      for (const table of [store.messageSubmissionsTable, store.steeringInputsTable, store.steeringSessionsTable]) {
        await client.query(`
          CREATE TABLE IF NOT EXISTS ${table}_tenant_quarantine (
            fingerprint TEXT PRIMARY KEY,
            reason TEXT NOT NULL,
            payload JSONB NOT NULL,
            quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `);
      }
      // Restart-safe best-effort backfill. Unprovable rows remain nullable (and invisible to
      // tenant-aware reads) until the explicit quarantine/contract phase.
      await client.query(`
        UPDATE ${store.messageSubmissionsTable} submission
        SET tenant_id = run.tenant_id,
            tenant_user_scope = COALESCE(submission.tenant_user_scope, submission.user_scope),
            tenant_client_message_id = COALESCE(submission.tenant_client_message_id, submission.client_message_id)
        FROM ${store.runsTable} run
        WHERE submission.run_id = run.run_id AND submission.session_id = run.session_id
          AND (submission.tenant_id IS NULL OR submission.tenant_user_scope IS NULL OR submission.tenant_client_message_id IS NULL)
      `);
      await client.query(`
        UPDATE ${store.steeringInputsTable} input SET tenant_id = source.tenant_id
        FROM ${store.runsTable} source, ${store.runsTable} target
        WHERE input.source_run_id = source.run_id AND input.target_run_id = target.run_id
          AND source.tenant_id = target.tenant_id AND source.session_id = target.session_id
          AND input.session_id = source.session_id AND input.tenant_id IS NULL
      `);
      await client.query(`
        UPDATE ${store.steeringSessionsTable} steering_session
        SET tenant_id = identity.tenant_id,
            tenant_session_id = COALESCE(steering_session.tenant_session_id, steering_session.session_id)
        FROM (
          SELECT session_id, MIN(tenant_id) AS tenant_id FROM ${store.runsTable}
          GROUP BY session_id HAVING COUNT(DISTINCT tenant_id) = 1
        ) identity
        WHERE steering_session.session_id = identity.session_id
          AND (steering_session.tenant_id IS NULL OR steering_session.tenant_session_id IS NULL)
      `);
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${store.messageSubmissionsTable}_tenant_uidx ON ${store.messageSubmissionsTable} (tenant_id, tenant_user_scope, tenant_client_message_id) WHERE tenant_id IS NOT NULL`);
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${store.steeringSessionsTable}_tenant_uidx ON ${store.steeringSessionsTable} (tenant_id, tenant_session_id) WHERE tenant_id IS NOT NULL`);
      await client.query(`ALTER TABLE ${store.steeringInputsTable} ADD COLUMN IF NOT EXISTS sequence BIGSERIAL`);
      await client.query(`ALTER TABLE ${store.steeringInputsTable} ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${store.steeringInputsTable}_target_sequence_idx ON ${store.steeringInputsTable} (target_run_id, state, sequence)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${store.steeringInputsTable}_source_idx ON ${store.steeringInputsTable} (source_run_id, state)`);
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
      await client.query(`DROP INDEX IF EXISTS ${store.runsTable}_session_idx`);
      await client.query(`DROP INDEX IF EXISTS ${store.runsTable}_session_enqueue_idx`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${store.runsTable}_tenant_session_idx ON ${store.runsTable} (tenant_id, session_id, updated_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${store.runsTable}_tenant_session_enqueue_idx ON ${store.runsTable} (tenant_id, session_id, enqueue_seq)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${store.runsTable}_background_parent_session_idx ON ${store.runsTable} ((metadata->>'parentSessionId'), requested_at DESC) WHERE metadata->>'backgroundTask' = 'true'`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${store.runsTable}_background_top_session_idx ON ${store.runsTable} ((metadata->>'topLevelSessionId'), requested_at DESC) WHERE metadata->>'backgroundTask' = 'true'`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${store.runsTable}_background_parent_run_idx ON ${store.runsTable} ((metadata->>'parentRunId'), status) WHERE metadata->>'backgroundTask' = 'true'`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${store.runsTable}_background_tenant_status_idx ON ${store.runsTable} (tenant_id, status, updated_at) WHERE metadata->>'backgroundTask' = 'true'`);
      // RFC v1 P0.4：按 sessionId 找最近完成 run 的 last_response_id（跨 run 接力查询路径）
      await client.query(`DROP INDEX IF EXISTS ${store.runsTable}_session_last_response_idx`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${store.runsTable}_tenant_session_last_response_idx ON ${store.runsTable} (tenant_id, session_id, updated_at DESC) WHERE last_response_id IS NOT NULL`);
      await client.query(`DROP INDEX IF EXISTS ${store.runsTable}_active_idempotency_idx`);
      await client.query(`DROP INDEX IF EXISTS ${store.runsTable}_active_idempotency_v2_idx`);
      // v3 accidentally made idempotency global across tenants. Drop it before installing the
      // tenant-native key so equal authenticated identities/client ids remain isolated.
      await client.query(`DROP INDEX IF EXISTS ${store.runsTable}_active_idempotency_v3_idx`);
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${store.runsTable}_active_idempotency_v4_idx ON ${store.runsTable} (tenant_id, (COALESCE(submitter_scope, user_id, '__anonymous__')), idempotency_key) WHERE idempotency_key IS NOT NULL AND status IN ('pending','running','waiting_approval','waiting_user','waiting_hand')`);
      await client.query(`DROP INDEX IF EXISTS ${store.runsTable}_idempotency_lookup_idx`);
      await client.query(`DROP INDEX IF EXISTS ${store.runsTable}_idempotency_lookup_v2_idx`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${store.runsTable}_idempotency_lookup_v3_idx ON ${store.runsTable} (tenant_id, (COALESCE(submitter_scope, user_id, '__anonymous__')), idempotency_key, updated_at DESC) WHERE idempotency_key IS NOT NULL`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${store.messageSubmissionsTable}_session_idx ON ${store.messageSubmissionsTable} (tenant_id, session_id, accepted_at)`);
      const tenantContract = await client.query<{ phase: string }>(`
        SELECT phase FROM ${store.runsTable}_schema_migrations
        WHERE module='tenant_auxiliary_identity'
      `);
      if (tenantContract.rows[0]?.phase === 'contract') {
        await client.query(`DROP TRIGGER IF EXISTS tenant_aux_catchup ON ${store.runsTable}`);
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
      client.release();
    }
  }

async function registerPgRunStoreWriterCapability(
  store: PgRunStoreSchemaTarget,
  dbRole: string,
  capability: 'tenant-native-v1' | 'legacy-single-tenant',
  tenantId: string | null,
): Promise<void> {
  if (!dbRole.trim() || (capability === 'legacy-single-tenant' && !tenantId?.trim())) {
    throw new Error('writer capability requires dbRole and a legacy tenant binding');
  }
  const client = await store.pool.connect();
  const lockKey = `${store.runsTable}:init`;
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
    const role = await client.query<{ rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolcanlogin,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=$1`, [dbRole]);
    if (!role.rows[0]?.rolcanlogin) throw new Error('writer capability requires an existing LOGIN role');
    if (role.rows[0].rolsuper || role.rows[0].rolbypassrls) {
      throw new Error('production writer role must not be SUPERUSER or BYPASSRLS');
    }
    if (capability === 'legacy-single-tenant') {
      const migration = await client.query<{ phase: string }>(`SELECT phase
        FROM ${store.runsTable}_schema_migrations WHERE module='tenant_auxiliary_identity'`);
      if (migration.rows[0]?.phase !== 'expand') {
        throw new Error('legacy writer capability requires expand phase');
      }
    }
    await client.query(`INSERT INTO ${store.runsTable}_writer_capabilities
      (db_role,capability,tenant_id,enabled,disabled_at) VALUES ($1,$2,$3,true,NULL)
      ON CONFLICT (db_role) DO NOTHING`, [dbRole, capability, tenantId]);
    const registered = await client.query<{ capability: string; tenant_id: string | null; enabled: boolean }>(
      `SELECT capability,tenant_id,enabled FROM ${store.runsTable}_writer_capabilities WHERE db_role=$1`, [dbRole]);
    const row = registered.rows[0];
    if (!row?.enabled || row.capability !== capability || row.tenant_id !== tenantId) {
      throw new Error('writer role has a conflicting, disabled, or immutable capability registration');
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
    client.release();
  }
}

export async function registerPgRunStoreTenantNativeWriterCapability(
  store: PgRunStoreSchemaTarget,
  dbRole: string,
): Promise<void> {
  await registerPgRunStoreWriterCapability(store, dbRole, RUN_STORE_TENANT_WRITER_CAPABILITY, null);
}

export async function registerPgRunStoreLegacyWriterCapability(
  store: PgRunStoreSchemaTarget,
  capability: PgRunStoreLegacyWriterCapability,
): Promise<void> {
  await registerPgRunStoreWriterCapability(
    store, capability.dbRole, 'legacy-single-tenant', capability.tenantId.trim());
}

export async function disablePgRunStoreLegacyWriterCapability(
  store: PgRunStoreSchemaTarget,
  dbRole: string,
): Promise<void> {
  if (!dbRole.trim()) throw new Error('legacy writer disable requires dbRole');
  const client = await store.pool.connect();
  const lockKey = `${store.runsTable}:init`;
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
    await client.query('BEGIN');
    const registry = await client.query(`SELECT 1 FROM ${store.runsTable}_writer_capabilities
      WHERE db_role=$1 AND capability='legacy-single-tenant' AND enabled FOR UPDATE`, [dbRole]);
    if (registry.rowCount !== 1) throw new Error('enabled legacy writer capability was not registered');
    const ddl = await client.query<{ sql: string }>(`SELECT format('ALTER ROLE %I NOLOGIN',$1::text) sql`, [dbRole]);
    await client.query(ddl.rows[0]!.sql);
    await client.query(`UPDATE ${store.runsTable}_writer_capabilities
      SET enabled=false,disabled_at=clock_timestamp() WHERE db_role=$1`, [dbRole]);
    await client.query(`SELECT pg_terminate_backend(pid,5000) FROM pg_stat_activity
      WHERE usename=$1 AND pid<>pg_backend_pid()`, [dbRole]);
    const active = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int count FROM pg_stat_activity WHERE usename=$1`, [dbRole]);
    if (active.rows[0]?.count !== 0) {
      throw new Error('legacy writer drain could not terminate every session_user activity');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
    client.release();
  }
}

export async function recordPgRunStoreDrainEvidence(
  store: PgRunStoreSchemaTarget,
  evidence: PgRunStoreDrainEvidence,
): Promise<void> {
  if (!evidence.evidenceId.trim() || !evidence.observer.trim()
    || evidence.capability !== RUN_STORE_TENANT_WRITER_CAPABILITY) {
    throw new Error('run-store tenant drain evidence rejected');
  }
  const client = await store.pool.connect();
  const lockKey = `${store.runsTable}:init`;
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
    const observation = await client.query<{
      enabled_count: number; active_count: number; login_count: number;
      roles: string[]; observed_at: string;
    }>(`SELECT COUNT(*) FILTER (WHERE registry.enabled)::int enabled_count,
             COUNT(activity.pid)::int active_count,
             COUNT(*) FILTER (WHERE role.rolcanlogin)::int login_count,
             COALESCE(array_agg(DISTINCT registry.db_role)
               FILTER (WHERE registry.db_role IS NOT NULL),ARRAY[]::text[]) roles,
             clock_timestamp()::text observed_at
      FROM ${store.runsTable}_writer_capabilities registry
      LEFT JOIN pg_roles role ON role.rolname=registry.db_role
      LEFT JOIN pg_stat_activity activity ON activity.usename=registry.db_role
      WHERE registry.capability='legacy-single-tenant'`);
    const observed = observation.rows[0]!;
    if (observed.enabled_count !== 0 || observed.active_count !== 0 || observed.login_count !== 0) {
      throw new Error('run-store tenant drain requires legacy roles NOLOGIN, disabled, and inactive');
    }
    const durableEvidence = { ...evidence, observedAt: observed.observed_at,
      oldWriterCount: observed.enabled_count, activeLegacySessionCount: observed.active_count,
      legacyRoles: observed.roles };
    const updated = await client.query(`UPDATE ${store.runsTable}_schema_migrations
      SET evidence=$1::jsonb,updated_at=clock_timestamp()
      WHERE module='tenant_auxiliary_identity' AND version=$2 AND phase='expand'`,
    [JSON.stringify(durableEvidence), RUN_STORE_TENANT_SCHEMA_VERSION]);
    if (updated.rowCount !== 1) throw new Error('run-store tenant drain evidence requires expand phase');
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
    client.release();
  }
}

/** Destructive tenant-key contract, opened only by database-observed drain evidence. */
export async function contractPgRunStoreTenantSchema(
  store: PgRunStoreSchemaTarget,
  gate: PgRunStoreContractGate,
): Promise<void> {
  if (gate.expectedExpandVersion !== RUN_STORE_TENANT_SCHEMA_VERSION || !gate.drainEvidenceId?.trim()) {
    throw new Error('run-store tenant contract gate rejected');
  }
  const client = await store.pool.connect();
  const lockKey = `${store.runsTable}:init`;
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
    await client.query('BEGIN');
    const migration = await client.query<{ version: number; phase: string; evidence: unknown }>(`
      SELECT version, phase, evidence FROM ${store.runsTable}_schema_migrations
      WHERE module='tenant_auxiliary_identity' FOR UPDATE
    `);
    const state = migration.rows[0];
    if (state?.version === gate.expectedExpandVersion && state.phase === 'contract') {
      await client.query('COMMIT');
      return;
    }
    if (state?.version !== gate.expectedExpandVersion || state.phase !== 'expand') {
      throw new Error('run-store tenant contract requires matching expand phase');
    }
    const evidence = state.evidence as (Partial<PgRunStoreDrainEvidence> & {
      observedAt?: string; oldWriterCount?: number; activeLegacySessionCount?: number;
    }) | null;
    if (!evidence || evidence.evidenceId !== gate.drainEvidenceId
      || evidence.capability !== RUN_STORE_TENANT_WRITER_CAPABILITY
      || evidence.oldWriterCount !== 0 || evidence.activeLegacySessionCount !== 0
      || !evidence.observer?.trim() || !Number.isFinite(Date.parse(evidence.observedAt ?? ''))) {
      throw new Error('run-store tenant contract requires matching durable drain evidence');
    }
    await client.query(`LOCK TABLE ${store.runsTable}_writer_capabilities IN SHARE ROW EXCLUSIVE MODE`);
    const liveLegacy = await client.query<{ unsafe_count: number }>(`
      SELECT ((SELECT COUNT(*) FROM ${store.runsTable}_writer_capabilities registry
                LEFT JOIN pg_roles role ON role.rolname=registry.db_role
               WHERE registry.capability='legacy-single-tenant'
                 AND (registry.enabled OR COALESCE(role.rolcanlogin,false)))
             +(SELECT COUNT(*) FROM pg_stat_activity activity
               WHERE activity.usename IN (SELECT db_role
                 FROM ${store.runsTable}_writer_capabilities
                 WHERE capability='legacy-single-tenant')))::int unsafe_count
    `);
    if (liveLegacy.rows[0]?.unsafe_count !== 0) {
      throw new Error('run-store tenant contract requires legacy capabilities disabled and drained');
    }
    // One final backfill after the old-writer drain observation, then quarantine only identities
    // that still cannot be proven from authoritative run rows.
    await client.query(`
      UPDATE ${store.messageSubmissionsTable} submission
      SET tenant_id=run.tenant_id,
          tenant_user_scope=COALESCE(submission.tenant_user_scope, submission.user_scope),
          tenant_client_message_id=COALESCE(submission.tenant_client_message_id, submission.client_message_id)
      FROM ${store.runsTable} run
      WHERE submission.run_id=run.run_id AND submission.session_id=run.session_id
        AND (submission.tenant_id IS NULL OR submission.tenant_user_scope IS NULL OR submission.tenant_client_message_id IS NULL)
    `);
    await client.query(`
      UPDATE ${store.steeringInputsTable} input SET tenant_id=source.tenant_id
      FROM ${store.runsTable} source, ${store.runsTable} target
      WHERE input.source_run_id=source.run_id AND input.target_run_id=target.run_id
        AND source.tenant_id=target.tenant_id AND source.session_id=target.session_id
        AND input.session_id=source.session_id AND input.tenant_id IS NULL
    `);
    await client.query(`
      UPDATE ${store.steeringSessionsTable} steering_session
      SET tenant_id=identity.tenant_id,
          tenant_session_id=COALESCE(steering_session.tenant_session_id, steering_session.session_id)
      FROM (SELECT session_id, MIN(tenant_id) tenant_id FROM ${store.runsTable}
            GROUP BY session_id HAVING COUNT(DISTINCT tenant_id)=1) identity
      WHERE steering_session.session_id=identity.session_id
        AND (steering_session.tenant_id IS NULL OR steering_session.tenant_session_id IS NULL)
    `);
    for (const [table, predicate] of [
      [store.messageSubmissionsTable, 'tenant_id IS NULL OR tenant_user_scope IS NULL OR tenant_client_message_id IS NULL'],
      [store.steeringInputsTable, 'tenant_id IS NULL'],
      [store.steeringSessionsTable, 'tenant_id IS NULL OR tenant_session_id IS NULL'],
    ] as const) {
      await client.query(`
        WITH moved AS (DELETE FROM ${table} WHERE ${predicate} RETURNING *)
        INSERT INTO ${table}_tenant_quarantine (fingerprint, reason, payload)
        SELECT md5(row_to_json(moved)::text), 'unprovable_tenant_identity', row_to_json(moved)::jsonb FROM moved
        ON CONFLICT (fingerprint) DO NOTHING
      `);
    }
    await client.query(`ALTER TABLE ${store.messageSubmissionsTable} ALTER COLUMN tenant_id SET NOT NULL`);
    await client.query(`ALTER TABLE ${store.messageSubmissionsTable} ALTER COLUMN tenant_user_scope SET NOT NULL`);
    await client.query(`ALTER TABLE ${store.messageSubmissionsTable} ALTER COLUMN tenant_client_message_id SET NOT NULL`);
    await client.query(`ALTER TABLE ${store.steeringInputsTable} ALTER COLUMN tenant_id SET NOT NULL`);
    await client.query(`ALTER TABLE ${store.steeringSessionsTable} ALTER COLUMN tenant_id SET NOT NULL`);
    await client.query(`ALTER TABLE ${store.steeringSessionsTable} ALTER COLUMN tenant_session_id SET NOT NULL`);
    await client.query(`ALTER TABLE ${store.messageSubmissionsTable} DROP CONSTRAINT IF EXISTS ${store.messageSubmissionsTable}_pkey`);
    await client.query(`ALTER TABLE ${store.messageSubmissionsTable} ADD CONSTRAINT ${store.messageSubmissionsTable}_pkey PRIMARY KEY (tenant_id, tenant_user_scope, tenant_client_message_id)`);
    await client.query(`ALTER TABLE ${store.steeringSessionsTable} DROP CONSTRAINT IF EXISTS ${store.steeringSessionsTable}_pkey`);
    await client.query(`ALTER TABLE ${store.steeringSessionsTable} ADD CONSTRAINT ${store.steeringSessionsTable}_pkey PRIMARY KEY (tenant_id, tenant_session_id)`);
    await client.query(`DROP TRIGGER IF EXISTS tenant_aux_catchup ON ${store.runsTable}`);
    await client.query(`
      UPDATE ${store.runsTable}_schema_migrations SET phase='contract', updated_at=now()
      WHERE module='tenant_auxiliary_identity' AND version=${RUN_STORE_TENANT_SCHEMA_VERSION}
    `);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
    client.release();
  }
}
