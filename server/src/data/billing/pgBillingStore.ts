import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  CREDIT_MICRO,
  DEFAULT_BILLING_POLICY_VERSION,
  DEFAULT_CREDIT_VALUE_YUAN_MICRO,
  DEFAULT_FX_RATE_TO_CNY,
  DEFAULT_PRICING_VERSION,
  DEFAULT_TARGET_MARGIN_BPS,
  type BillingAuditSummary,
  type BillingCreditAccount,
  type BillingLedgerEntry,
  type BillingMode,
  type BillingPricingVersion,
  type BillingUsageEvent,
  type FixedDebitInput,
  type HardCapMode,
  type LedgerType,
  type ProjectedRuntimeUsageInput,
  type TenantBillingPolicy,
} from './types.js';
import { computeCostMicro, getUsageAccountingMode, PRICING_VERSION } from '../usage/pricing.js';
import { isInternalTenantId } from '../tenants/types.js';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;
type PgClient = pg.PoolClient;

export interface BillingPolicyPatch {
  billingEnabled?: boolean;
  billingMode?: BillingMode;
  pricingVersion?: string;
  defaultTargetMarginBps?: number;
  organizationMultiplierBps?: number;
  allowNegativeBalance?: boolean;
  negativeLimitCreditsMicro?: number;
  lowBalanceThresholdCreditsMicro?: number;
  hardCapMode?: HardCapMode;
  showBalance?: boolean;
  showUsageCredits?: boolean;
  showCost?: boolean;
  showGrossMargin?: boolean;
}

export interface PgBillingStoreOptions {
  pool: PgPool;
  tablePrefix?: string;
  eventsTable?: string;
  runsTable?: string;
  logger?: {
    info?: (message: string, meta?: Record<string, unknown>) => void;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
  };
}

export interface RuntimeUsageEventRow {
  globalSequence: number;
  eventId: string;
  eventType: string;
  tenantId: string;
  timestamp: string;
  eventJson: Record<string, unknown>;
  runUserId?: string;
  runChannel?: string;
  runModel?: string;
  /** run.metadata.toolProfile（memory_poll 计费豁免判定，2026-07-14 批次） */
  runToolProfile?: string;
}

export class PgBillingStore {
  readonly pool: PgPool;
  readonly pricingVersionsTable: string;
  readonly tenantPoliciesTable: string;
  readonly usageEventsTable: string;
  readonly creditAccountsTable: string;
  readonly creditLedgerTable: string;
  readonly projectionStateTable: string;
  private readonly eventsTable?: string;
  private readonly runsTable?: string;

  constructor(private readonly options: PgBillingStoreOptions) {
    const prefix = sanitizeIdentifier(options.tablePrefix ?? 'runtime');
    this.pool = options.pool;
    this.eventsTable = options.eventsTable ? sanitizeQualifiedIdentifier(options.eventsTable) : undefined;
    this.runsTable = options.runsTable ? sanitizeQualifiedIdentifier(options.runsTable) : undefined;
    this.pricingVersionsTable = `${prefix}_billing_pricing_versions`;
    this.tenantPoliciesTable = `${prefix}_billing_tenant_policies`;
    this.usageEventsTable = `${prefix}_billing_usage_events`;
    this.creditAccountsTable = `${prefix}_billing_credit_accounts`;
    this.creditLedgerTable = `${prefix}_billing_credit_ledger`;
    this.projectionStateTable = `${prefix}_billing_projection_state`;
  }

  async init(): Promise<void> {
    const lockKey = `${this.creditLedgerTable}:init`;
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.pricingVersionsTable} (
          version TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          effective_from TIMESTAMPTZ NOT NULL,
          effective_to TIMESTAMPTZ,
          credit_value_yuan_micro BIGINT NOT NULL,
          default_target_margin_bps INTEGER NOT NULL,
          currency TEXT NOT NULL DEFAULT 'CNY',
          created_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL
        )
      `);
      // 2026-06-28 增量迁移：fx_rate_to_cny + updated_by/updated_at
      await client.query(`
        ALTER TABLE ${this.pricingVersionsTable}
          ADD COLUMN IF NOT EXISTS fx_rate_to_cny NUMERIC NOT NULL DEFAULT ${DEFAULT_FX_RATE_TO_CNY},
          ADD COLUMN IF NOT EXISTS updated_by TEXT,
          ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ
      `);
      // 同一时刻最多一个 active：partial unique index
      // 探活：若历史已有 >1 active 行，索引创建会失败，由人工清洗后重试
      const activeCount = await client.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM ${this.pricingVersionsTable} WHERE status = 'active'`,
      );
      if (Number(activeCount.rows[0]?.cnt ?? 0) > 1) {
        this.options.logger?.warn?.(
          `${this.pricingVersionsTable} has ${activeCount.rows[0]?.cnt} active rows; partial unique index NOT created. Manually retire stale rows then restart server.`,
        );
      } else {
        await client.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS ${this.pricingVersionsTable}_one_active_idx
            ON ${this.pricingVersionsTable} ((1))
            WHERE status = 'active'
        `);
      }
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.tenantPoliciesTable} (
          tenant_id TEXT PRIMARY KEY,
          policy_version TEXT NOT NULL,
          billing_enabled BOOLEAN NOT NULL DEFAULT false,
          pricing_version TEXT NOT NULL,
          billing_mode TEXT NOT NULL DEFAULT 'prepaid',
          default_target_margin_bps INTEGER NOT NULL,
          organization_multiplier_bps INTEGER NOT NULL DEFAULT 10000,
          allow_negative_balance BOOLEAN NOT NULL DEFAULT false,
          negative_limit_credits_micro BIGINT NOT NULL DEFAULT 0,
          low_balance_threshold_credits_micro BIGINT NOT NULL DEFAULT 0,
          hard_cap_mode TEXT NOT NULL DEFAULT 'none',
          show_balance BOOLEAN NOT NULL DEFAULT true,
          show_usage_credits BOOLEAN NOT NULL DEFAULT true,
          show_cost BOOLEAN NOT NULL DEFAULT false,
          show_gross_margin BOOLEAN NOT NULL DEFAULT false,
          updated_by TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.usageEventsTable} (
          id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          tenant_id TEXT NOT NULL,
          user_id TEXT,
          username TEXT NOT NULL,
          session_id TEXT,
          run_id TEXT,
          message_id TEXT,
          channel TEXT NOT NULL,
          billable BOOLEAN NOT NULL,
          model_ref TEXT,
          model_value TEXT NOT NULL,
          actual_model TEXT,
          provider TEXT,
          model_tier TEXT,
          request_index INTEGER NOT NULL,
          response_id TEXT,
          input_tokens BIGINT NOT NULL DEFAULT 0,
          uncached_input_tokens BIGINT NOT NULL DEFAULT 0,
          cached_input_tokens BIGINT NOT NULL DEFAULT 0,
          cache_creation_tokens BIGINT NOT NULL DEFAULT 0,
          cache_storage_tokens BIGINT NOT NULL DEFAULT 0,
          cache_storage_hours NUMERIC NOT NULL DEFAULT 0,
          output_tokens BIGINT NOT NULL DEFAULT 0,
          reasoning_tokens BIGINT NOT NULL DEFAULT 0,
          api_request_count INTEGER NOT NULL DEFAULT 1,
          input_segment TEXT NOT NULL,
          usage_accounting TEXT NOT NULL,
          pricing_version TEXT NOT NULL,
          cost_currency TEXT NOT NULL DEFAULT 'CNY',
          fx_rate_to_cny NUMERIC NOT NULL DEFAULT ${DEFAULT_FX_RATE_TO_CNY},
          actual_cost_yuan_micro BIGINT NOT NULL DEFAULT 0,
          raw_usage_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.creditAccountsTable} (
          tenant_id TEXT PRIMARY KEY,
          balance_micro BIGINT NOT NULL DEFAULT 0,
          reserved_micro BIGINT NOT NULL DEFAULT 0,
          updated_at TIMESTAMPTZ NOT NULL
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.creditLedgerTable} (
          id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          tenant_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          type TEXT NOT NULL,
          source TEXT NOT NULL,
          related_usage_event_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          session_id TEXT,
          run_id TEXT,
          message_id TEXT,
          credits_delta_micro BIGINT NOT NULL,
          balance_before_micro BIGINT NOT NULL,
          balance_after_micro BIGINT NOT NULL,
          credit_value_yuan_micro BIGINT NOT NULL,
          revenue_yuan_micro BIGINT NOT NULL,
          actual_cost_yuan_micro BIGINT NOT NULL DEFAULT 0,
          gross_profit_yuan_micro BIGINT NOT NULL DEFAULT 0,
          gross_margin_bps INTEGER,
          pricing_version TEXT NOT NULL,
          billing_policy_version TEXT NOT NULL,
          note TEXT,
          created_by TEXT,
          created_at TIMESTAMPTZ NOT NULL
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.projectionStateTable} (
          key TEXT PRIMARY KEY,
          last_global_sequence BIGINT NOT NULL DEFAULT 0,
          updated_at TIMESTAMPTZ NOT NULL
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.usageEventsTable}_tenant_created_idx ON ${this.usageEventsTable} (tenant_id, created_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.usageEventsTable}_run_idx ON ${this.usageEventsTable} (run_id) WHERE run_id IS NOT NULL`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.usageEventsTable}_session_idx ON ${this.usageEventsTable} (session_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.usageEventsTable}_user_idx ON ${this.usageEventsTable} (tenant_id, user_id, created_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.creditLedgerTable}_tenant_created_idx ON ${this.creditLedgerTable} (tenant_id, created_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.creditLedgerTable}_run_idx ON ${this.creditLedgerTable} (run_id) WHERE run_id IS NOT NULL`);
      await this.ensureDefaultPricingVersion(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
      client.release();
    }
  }

  async getActivePricingVersion(): Promise<BillingPricingVersion> {
    const result = await this.pool.query<{ row_json: Record<string, unknown> }>(
      `SELECT row_to_json(t.*) AS row_json
       FROM ${this.pricingVersionsTable} t
       WHERE status = 'active'
       ORDER BY effective_from DESC
       LIMIT 1`,
    );
    if (result.rows[0]) return normalizePricingVersion(result.rows[0].row_json);
    return {
      version: DEFAULT_PRICING_VERSION,
      name: 'Legacy usage pricing v1',
      status: 'active',
      effectiveFrom: new Date(0).toISOString(),
      creditValueYuanMicro: DEFAULT_CREDIT_VALUE_YUAN_MICRO,
      defaultTargetMarginBps: DEFAULT_TARGET_MARGIN_BPS,
      fxRateToCny: DEFAULT_FX_RATE_TO_CNY,
      currency: 'CNY',
      createdBy: 'system',
      createdAt: new Date().toISOString(),
    };
  }

  async listPricingVersions(): Promise<BillingPricingVersion[]> {
    const result = await this.pool.query<{ row_json: Record<string, unknown> }>(
      `SELECT row_to_json(t.*) AS row_json FROM ${this.pricingVersionsTable} t ORDER BY effective_from DESC`,
    );
    return result.rows.map((row) => normalizePricingVersion(row.row_json));
  }

  async createPricingVersion(input: {
    version: string;
    name: string;
    status?: 'draft' | 'active';
    effectiveFrom?: string;
    creditValueYuanMicro: number;
    defaultTargetMarginBps: number;
    fxRateToCny?: number;
    createdBy: string;
  }): Promise<BillingPricingVersion> {
    const status = input.status ?? 'draft';
    const now = new Date().toISOString();
    const effectiveFrom = input.effectiveFrom ?? now;
    const fxRate = input.fxRateToCny ?? DEFAULT_FX_RATE_TO_CNY;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (status === 'active') {
        await client.query(
          `UPDATE ${this.pricingVersionsTable}
           SET status = 'retired', effective_to = COALESCE(effective_to, $1), updated_by = $2, updated_at = $1
           WHERE status = 'active'`,
          [effectiveFrom, input.createdBy],
        );
      }
      await client.query(
        `INSERT INTO ${this.pricingVersionsTable}
          (version, name, status, effective_from, credit_value_yuan_micro, default_target_margin_bps,
           fx_rate_to_cny, currency, created_by, created_at, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'CNY', $8, $9, $8, $9)`,
        [
          input.version,
          input.name,
          status,
          effectiveFrom,
          Math.round(input.creditValueYuanMicro),
          Math.round(input.defaultTargetMarginBps),
          fxRate,
          input.createdBy,
          now,
        ],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw normalizePricingConflictError(err);
    } finally {
      client.release();
    }
    const row = await this.pool.query<{ row_json: Record<string, unknown> }>(
      `SELECT row_to_json(t.*) AS row_json FROM ${this.pricingVersionsTable} t WHERE version = $1`,
      [input.version],
    );
    return normalizePricingVersion(row.rows[0]!.row_json);
  }

  async updatePricingVersion(version: string, patch: {
    name?: string;
    status?: 'draft' | 'active' | 'retired';
    effectiveFrom?: string;
    effectiveTo?: string | null;
    creditValueYuanMicro?: number;
    defaultTargetMarginBps?: number;
    fxRateToCny?: number;
    updatedBy: string;
  }): Promise<BillingPricingVersion> {
    const current = await this.pool.query<{ row_json: Record<string, unknown> }>(
      `SELECT row_to_json(t.*) AS row_json FROM ${this.pricingVersionsTable} t WHERE version = $1`,
      [version],
    );
    if (!current.rows[0]) throw new Error(`Pricing version not found: ${version}`);
    const currentRow = normalizePricingVersion(current.rows[0].row_json);
    const now = new Date().toISOString();
    const activatesVersion = patch.status === 'active' && currentRow.status !== 'active';
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // 切 active：先把旧 active retire 掉（partial unique index 兜底并发）
      if (activatesVersion) {
        await client.query(
          `UPDATE ${this.pricingVersionsTable}
           SET status = 'retired', effective_to = COALESCE(effective_to, $1), updated_by = $2, updated_at = $1
           WHERE status = 'active' AND version <> $3`,
          [now, patch.updatedBy, version],
        );
      }
      // 切回 retire/draft：不允许把唯一 active 改成非 active（避免悬空）
      if (currentRow.status === 'active' && patch.status && patch.status !== 'active') {
        throw new Error('当前 active 版本不能直接退役或改成 draft，请先激活另一个版本。');
      }
      // 字段 PATCH
      const sets: string[] = [];
      const params: unknown[] = [];
      const push = (col: string, value: unknown) => {
        params.push(value);
        sets.push(`${col} = $${params.length}`);
      };
      if (patch.name !== undefined) push('name', patch.name);
      if (patch.status !== undefined) push('status', patch.status);
      if (patch.effectiveFrom !== undefined) push('effective_from', patch.effectiveFrom);
      if (patch.effectiveTo !== undefined && !activatesVersion) push('effective_to', patch.effectiveTo);
      if (patch.creditValueYuanMicro !== undefined) push('credit_value_yuan_micro', Math.round(patch.creditValueYuanMicro));
      if (patch.defaultTargetMarginBps !== undefined) push('default_target_margin_bps', Math.round(patch.defaultTargetMarginBps));
      if (patch.fxRateToCny !== undefined) push('fx_rate_to_cny', patch.fxRateToCny);
      push('updated_by', patch.updatedBy);
      push('updated_at', now);
      // 如果切到 active：清掉 effective_to
      if (activatesVersion) {
        sets.push('effective_to = NULL');
      }
      params.push(version);
      await client.query(
        `UPDATE ${this.pricingVersionsTable} SET ${sets.join(', ')} WHERE version = $${params.length}`,
        params,
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw normalizePricingConflictError(err);
    } finally {
      client.release();
    }
    const next = await this.pool.query<{ row_json: Record<string, unknown> }>(
      `SELECT row_to_json(t.*) AS row_json FROM ${this.pricingVersionsTable} t WHERE version = $1`,
      [version],
    );
    return normalizePricingVersion(next.rows[0]!.row_json);
  }

  async getDailyAuditBreakdown(query: { tenantId?: string; days: number }): Promise<import('./types.js').BillingAuditDailyPoint[]> {
    const days = Math.max(1, Math.min(90, Math.round(query.days)));
    const result = await this.pool.query<{
      day: string;
      actual_cost_yuan_micro: string | null;
      revenue_yuan_micro: string | null;
      credits_charged_micro: string | null;
      gross_profit_yuan_micro: string | null;
    }>(`
      SELECT
        to_char((created_at AT TIME ZONE 'Asia/Shanghai')::date, 'YYYY-MM-DD') AS day,
        COALESCE(SUM(CASE WHEN type='debit' THEN actual_cost_yuan_micro ELSE 0 END), 0) AS actual_cost_yuan_micro,
        COALESCE(SUM(CASE WHEN type='debit' THEN revenue_yuan_micro ELSE 0 END), 0) AS revenue_yuan_micro,
        COALESCE(SUM(CASE WHEN type='debit' THEN -credits_delta_micro ELSE 0 END), 0) AS credits_charged_micro,
        COALESCE(SUM(CASE WHEN type='debit' THEN gross_profit_yuan_micro ELSE 0 END), 0) AS gross_profit_yuan_micro
      FROM ${this.creditLedgerTable}
      WHERE ($1::text IS NULL OR tenant_id = $1)
        AND created_at >= (NOW() - ($2::int * INTERVAL '1 day'))
      GROUP BY day
      ORDER BY day DESC
    `, [query.tenantId ?? null, days]);
    return result.rows.map((row) => ({
      date: row.day,
      actualCostYuanMicro: Number(row.actual_cost_yuan_micro ?? 0),
      revenueYuanMicro: Number(row.revenue_yuan_micro ?? 0),
      creditsChargedMicro: Number(row.credits_charged_micro ?? 0),
      grossProfitYuanMicro: Number(row.gross_profit_yuan_micro ?? 0),
    }));
  }

  async getTenantPolicy(tenantId: string): Promise<TenantBillingPolicy> {
    await this.ensureTenantPolicy(tenantId, 'system');
    const result = await this.pool.query<{ row_json: Record<string, unknown> }>(
      `SELECT row_to_json(t.*) AS row_json FROM ${this.tenantPoliciesTable} t WHERE tenant_id = $1`,
      [tenantId],
    );
    return normalizeTenantPolicy(result.rows[0]!.row_json);
  }

  async updateTenantPolicy(tenantId: string, patch: BillingPolicyPatch, actor: string): Promise<TenantBillingPolicy> {
    await this.ensureTenantPolicy(tenantId, actor);
    const current = await this.getTenantPolicy(tenantId);
    const next = {
      ...current,
      ...patch,
      policyVersion: `${DEFAULT_BILLING_POLICY_VERSION}-${Date.now()}`,
      updatedBy: actor,
      updatedAt: new Date().toISOString(),
    };
    await this.pool.query(`
      UPDATE ${this.tenantPoliciesTable}
      SET policy_version = $2,
          billing_enabled = $3,
          pricing_version = $4,
          billing_mode = $5,
          default_target_margin_bps = $6,
          organization_multiplier_bps = $7,
          allow_negative_balance = $8,
          negative_limit_credits_micro = $9,
          low_balance_threshold_credits_micro = $10,
          hard_cap_mode = $11,
          show_balance = $12,
          show_usage_credits = $13,
          show_cost = $14,
          show_gross_margin = $15,
          updated_by = $16,
          updated_at = $17
      WHERE tenant_id = $1
    `, [
      tenantId,
      next.policyVersion,
      next.billingEnabled,
      next.pricingVersion,
      next.billingMode,
      next.defaultTargetMarginBps,
      next.organizationMultiplierBps,
      next.allowNegativeBalance,
      next.negativeLimitCreditsMicro,
      next.lowBalanceThresholdCreditsMicro,
      next.hardCapMode,
      next.showBalance,
      next.showUsageCredits,
      next.showCost,
      next.showGrossMargin,
      next.updatedBy,
      next.updatedAt,
    ]);
    return await this.getTenantPolicy(tenantId);
  }

  async getAccount(tenantId: string): Promise<BillingCreditAccount> {
    await this.ensureAccount(tenantId);
    const result = await this.pool.query<{ row_json: Record<string, unknown> }>(
      `SELECT row_to_json(a.*) AS row_json FROM ${this.creditAccountsTable} a WHERE tenant_id = $1`,
      [tenantId],
    );
    return normalizeAccount(result.rows[0]!.row_json);
  }

  async adjustAccount(input: {
    tenantId: string;
    type: Extract<LedgerType, 'recharge' | 'grant' | 'refund' | 'adjustment' | 'expire' | 'reversal'>;
    creditsDeltaMicro: number;
    note?: string;
    actor: string;
    idempotencyKey?: string;
  }): Promise<BillingLedgerEntry> {
    const pricing = await this.getActivePricingVersion();
    const policy = await this.getTenantPolicy(input.tenantId);
    return await this.withAccountLock(input.tenantId, async (client, account) => {
      const idempotencyKey = input.idempotencyKey ?? `manual:${input.type}:${input.tenantId}:${randomUUID()}`;
      const existing = await this.getLedgerByIdempotencyKey(client, idempotencyKey);
      if (existing) return existing;
      const before = account.balanceCreditsMicro;
      const after = before + Math.trunc(input.creditsDeltaMicro);
      return await this.insertLedgerAndUpdateAccount(client, {
        idempotencyKey,
        tenantId: input.tenantId,
        accountId: input.tenantId,
        type: input.type,
        source: 'manual',
        relatedUsageEventIds: [],
        creditsDeltaMicro: Math.trunc(input.creditsDeltaMicro),
        balanceBeforeMicro: before,
        balanceAfterMicro: after,
        creditValueYuanMicro: pricing.creditValueYuanMicro,
        revenueYuanMicro: Math.trunc(Math.max(0, Math.trunc(input.creditsDeltaMicro)) * pricing.creditValueYuanMicro / CREDIT_MICRO),
        actualCostYuanMicro: 0,
        grossProfitYuanMicro: 0,
        pricingVersion: pricing.version,
        billingPolicyVersion: policy.policyVersion,
        note: input.note,
        createdBy: input.actor,
      });
    });
  }

  async findLedgerByIdempotencyKey(idempotencyKey: string): Promise<BillingLedgerEntry | null> {
    const result = await this.pool.query<{ row_json: Record<string, unknown> }>(
      `SELECT row_to_json(l.*) AS row_json FROM ${this.creditLedgerTable} l WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    return result.rows[0] ? normalizeLedgerEntry(result.rows[0].row_json) : null;
  }

  async sumManualPositiveCreditsByActorSince(actor: string, since: string): Promise<number> {
    const result = await this.pool.query<{ total_micro: string | null }>(
      `SELECT COALESCE(SUM(GREATEST(credits_delta_micro, 0)), 0) AS total_micro
       FROM ${this.creditLedgerTable}
       WHERE source = 'manual' AND created_by = $1 AND created_at >= $2::timestamptz`,
      [actor, since],
    );
    return Number(result.rows[0]?.total_micro ?? 0) / CREDIT_MICRO;
  }

  async insertUsageEvent(input: ProjectedRuntimeUsageInput): Promise<BillingUsageEvent | null> {
    const policy = await this.getTenantPolicy(input.tenantId);
    const pricing = await this.getActivePricingVersion();
    const fxRate = pricing.fxRateToCny || DEFAULT_FX_RATE_TO_CNY;
    const usage = normalizeUsage(input.usage);
    const usageAccounting = getUsageAccountingMode(input.modelValue);
    const cachedInputTokens = usage.cacheReadInputTokens;
    const cacheCreationTokens = usage.cacheCreationInputTokens;
    const uncachedInputTokens = usageAccounting === 'cache_tokens_separate'
      ? usage.inputTokens
      : Math.max(0, usage.inputTokens - cachedInputTokens - cacheCreationTokens);
    // 固定成本旁路（metered_tool_usage 批次）：非 token 计价项直接携带真实成本，
    // 不进 computeCostMicro（token 全 0 会得 0 成本 + 未知模型告警）。
    const hasFixedCost = typeof input.fixedCostYuanMicro === 'number' && Number.isFinite(input.fixedCostYuanMicro);
    const costUsdMicro = hasFixedCost ? 0 : computeCostMicro(input.modelValue, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadInputTokens,
      cacheCreationTokens: usage.cacheCreationInputTokens,
    }, (msg) => this.options.logger?.warn?.(msg));
    const actualCostYuanMicro = hasFixedCost
      ? Math.max(0, Math.trunc(input.fixedCostYuanMicro!))
      : Math.round(costUsdMicro * fxRate);
    const now = input.occurredAt || new Date().toISOString();
    const result = await this.pool.query<{ row_json: Record<string, unknown> }>(`
      INSERT INTO ${this.usageEventsTable}
        (id, idempotency_key, tenant_id, user_id, username, session_id, run_id, channel, billable,
         model_value, actual_model, provider, model_tier, request_index, response_id,
         input_tokens, uncached_input_tokens, cached_input_tokens, cache_creation_tokens,
         cache_storage_tokens, cache_storage_hours, output_tokens, reasoning_tokens, api_request_count,
         input_segment, usage_accounting, pricing_version, cost_currency, fx_rate_to_cny,
         actual_cost_yuan_micro, raw_usage_json, created_at)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,
         $10,$11,$12,$13,$14,$15,
         $16,$17,$18,$19,
         0,0,$20,$21,$22,
         $23,$24,$25,'CNY',$26,
         $27,$28::jsonb,$29)
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING row_to_json(${this.usageEventsTable}.*) AS row_json
    `, [
      randomUUID(),
      input.idempotencyKey,
      input.tenantId,
      input.userId ?? null,
      input.username,
      input.sessionId ?? null,
      input.runId ?? null,
      input.channel,
      // billable=false 的强制豁免（memory_poll 默认不扣积分，2026-07-14 批次）：
      // usage 照记（内部成本统计可见），settleRunDebit 只结算 billable=true
      input.billable === false ? false : (policy.billingEnabled && policy.billingMode !== 'internal'),
      input.modelValue,
      input.actualModel ?? null,
      inferProvider(input.modelValue),
      inferModelTier(input.modelValue),
      input.requestIndex,
      null,
      usage.inputTokens,
      uncachedInputTokens,
      cachedInputTokens,
      cacheCreationTokens,
      usage.outputTokens,
      usage.reasoningTokens,
      Math.max(1, usage.apiRequestCount),
      inputSegment(usage.inputTokens),
      usageAccounting,
      pricing.version || PRICING_VERSION,
      // 审计一致性：落库汇率必须与本次成本折算实际使用的 fxRate 一致，
      // 定价版本自带非默认汇率时不得恒写 DEFAULT（2026-07-19 修复）
      fxRate,
      actualCostYuanMicro,
      JSON.stringify(input.rawUsageJson ?? input.usage),
      now,
    ]);
    return result.rows[0] ? normalizeUsageEvent(result.rows[0].row_json) : null;
  }

  async settleRunDebit(tenantId: string, runId: string): Promise<BillingLedgerEntry | null> {
    const policy = await this.getTenantPolicy(tenantId);
    if (!policy.billingEnabled || policy.billingMode === 'internal') return null;
    const pricing = await this.getActivePricingVersion();
    const usageEvents = await this.listUsageEvents({ tenantId, runId, billable: true, limit: 500 });
    if (usageEvents.length === 0) return null;
    return await this.withAccountLock(tenantId, async (client, account) => {
      const chargedUsageEventIds = await this.listDebitedUsageEventIds(client, tenantId, runId);
      const pendingUsageEvents = usageEvents.filter((item) => !chargedUsageEventIds.has(item.id));
      if (pendingUsageEvents.length === 0) return null;
      const idempotencyKey = `debit:usage:v1:${runId}:${usageEventIdHash(pendingUsageEvents.map((item) => item.id))}`;
      const existing = await this.getLedgerByIdempotencyKey(client, idempotencyKey);
      if (existing) return existing;
      const actualCostYuanMicro = pendingUsageEvents.reduce((sum, item) => sum + item.actualCostYuanMicro, 0);
      const revenueYuanMicro = computeRevenueYuanMicro(actualCostYuanMicro, policy);
      const creditsToChargeMicro = roundUpCreditsMicro(
        Math.ceil((revenueYuanMicro * CREDIT_MICRO) / Math.max(1, pricing.creditValueYuanMicro)),
      );
      const before = account.balanceCreditsMicro;
      const after = before - creditsToChargeMicro;
      if (!policy.allowNegativeBalance && after < -policy.negativeLimitCreditsMicro) {
        // 已发生的模型调用不能回滚；仍落账为负数，并在 audit 中暴露。preflight 才负责拦截新任务。
        this.options.logger?.warn?.(`billing debit makes tenant negative: tenant=${tenantId} run=${runId} before=${before} debit=${creditsToChargeMicro}`);
      }
      const grossProfitYuanMicro = revenueYuanMicro - actualCostYuanMicro;
      return await this.insertLedgerAndUpdateAccount(client, {
        idempotencyKey,
        tenantId,
        accountId: tenantId,
        type: 'debit',
        source: 'usage_event',
        relatedUsageEventIds: pendingUsageEvents.map((item) => item.id),
        sessionId: pendingUsageEvents[0]?.sessionId,
        runId,
        creditsDeltaMicro: -creditsToChargeMicro,
        balanceBeforeMicro: before,
        balanceAfterMicro: after,
        creditValueYuanMicro: pricing.creditValueYuanMicro,
        revenueYuanMicro,
        actualCostYuanMicro,
        grossProfitYuanMicro,
        grossMarginBps: revenueYuanMicro > 0 ? Math.round((grossProfitYuanMicro / revenueYuanMicro) * 10_000) : undefined,
        pricingVersion: pricing.version,
        billingPolicyVersion: policy.policyVersion,
        note: `run usage debit (${pendingUsageEvents.length} usage event${pendingUsageEvents.length === 1 ? '' : 's'})`,
        createdBy: 'system',
      });
    });
  }

  /**
   * 按次固定扣费（2026-07-15 GenerateImage 批次）：billing 投影消费
   * metered_tool_usage 事件时调用，是 settleRunDebit 之外第二个 debit 生产者。
   *
   * 与 settleRunDebit 的关系（防双重扣费）：
   *   - 关联 usage 行必须 billable=false → 不进 settleRunDebit 的 cost-plus 结算；
   *   - source（如 'tool:image_gen'）≠ 'usage_event' → listDebitedUsageEventIds
   *     的去重集互不污染；
   *   - internal / 未开计费租户与 settleRunDebit 同款 guard 跳过（返回 null）；
   *   - 负余额沿用同一容忍度：照扣为负 + warn + audit 暴露，preflight 负责拦新请求。
   */
  async chargeFixedDebit(input: FixedDebitInput): Promise<BillingLedgerEntry | null> {
    const policy = await this.getTenantPolicy(input.tenantId);
    if (!policy.billingEnabled || policy.billingMode === 'internal') return null;
    const creditsToChargeMicro = roundUpCreditsMicro(Math.max(0, Math.trunc(input.creditsMicro)));
    if (creditsToChargeMicro <= 0) return null;
    const pricing = await this.getActivePricingVersion();
    return await this.withAccountLock(input.tenantId, async (client, account) => {
      const existing = await this.getLedgerByIdempotencyKey(client, input.idempotencyKey);
      if (existing) return existing;
      const before = account.balanceCreditsMicro;
      const after = before - creditsToChargeMicro;
      if (!policy.allowNegativeBalance && after < -policy.negativeLimitCreditsMicro) {
        // 生成已发生、外部成本已产生，不能回滚；仍落账为负数并在 audit 中暴露。
        this.options.logger?.warn?.(
          `billing fixed debit makes tenant negative: tenant=${input.tenantId} source=${input.source} before=${before} debit=${creditsToChargeMicro}`,
        );
      }
      // 固定面值定价，不走 computeRevenueYuanMicro 的 cost-plus 公式。
      const revenueYuanMicro = Math.trunc((creditsToChargeMicro * pricing.creditValueYuanMicro) / CREDIT_MICRO);
      const actualCostYuanMicro = Math.max(0, Math.trunc(input.actualCostYuanMicro));
      const grossProfitYuanMicro = revenueYuanMicro - actualCostYuanMicro;
      return await this.insertLedgerAndUpdateAccount(client, {
        idempotencyKey: input.idempotencyKey,
        tenantId: input.tenantId,
        accountId: input.tenantId,
        type: 'debit',
        source: input.source,
        relatedUsageEventIds: input.relatedUsageEventIds ?? [],
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        creditsDeltaMicro: -creditsToChargeMicro,
        balanceBeforeMicro: before,
        balanceAfterMicro: after,
        creditValueYuanMicro: pricing.creditValueYuanMicro,
        revenueYuanMicro,
        actualCostYuanMicro,
        grossProfitYuanMicro,
        ...(revenueYuanMicro > 0
          ? { grossMarginBps: Math.round((grossProfitYuanMicro / revenueYuanMicro) * 10_000) }
          : {}),
        pricingVersion: pricing.version,
        billingPolicyVersion: policy.policyVersion,
        ...(input.note ? { note: input.note } : {}),
        createdBy: 'system',
      });
    });
  }

  async listLedger(query: {
    tenantId?: string;
    sessionId?: string;
    runId?: string;
    type?: LedgerType;
    cursor?: { createdAt: string; id: string };
    limit?: number;
    from?: string;
    to?: string;
  }): Promise<{ entries: BillingLedgerEntry[]; nextCursor?: { createdAt: string; id: string } }> {
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
    const params: unknown[] = [
      query.tenantId ?? null,
      query.sessionId ?? null,
      query.runId ?? null,
      query.from ?? null,
      query.to ?? null,
      query.type ?? null,
    ];
    let cursorClause = '';
    if (query.cursor) {
      params.push(query.cursor.createdAt, query.cursor.id);
      cursorClause = `AND (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length})`;
    }
    params.push(limit + 1);
    const result = await this.pool.query<{ row_json: Record<string, unknown> }>(`
      SELECT row_to_json(l.*) AS row_json
      FROM ${this.creditLedgerTable} l
      WHERE ($1::text IS NULL OR tenant_id = $1)
        AND ($2::text IS NULL OR session_id = $2)
        AND ($3::text IS NULL OR run_id = $3)
        AND ($4::timestamptz IS NULL OR created_at >= $4::timestamptz)
        AND ($5::timestamptz IS NULL OR created_at <= $5::timestamptz)
        AND ($6::text IS NULL OR type = $6)
        ${cursorClause}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}
    `, params);
    const rows = result.rows.map((row) => normalizeLedgerEntry(row.row_json));
    const hasMore = rows.length > limit;
    const entries = rows.slice(0, limit);
    if (!hasMore || entries.length === 0) return { entries };
    const last = entries[entries.length - 1]!;
    return { entries, nextCursor: { createdAt: last.createdAt, id: last.id } };
  }

  async listUsageEvents(query: {
    tenantId?: string;
    runId?: string;
    sessionId?: string;
    billable?: boolean;
    unpricedOnly?: boolean;
    limit?: number;
    from?: string;
    to?: string;
  }): Promise<BillingUsageEvent[]> {
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 1000);
    const unpricedClause = query.unpricedOnly
      ? `AND actual_cost_yuan_micro = 0 AND (input_tokens > 0 OR output_tokens > 0)`
      : '';
    const result = await this.pool.query<{ row_json: Record<string, unknown> }>(`
      SELECT row_to_json(u.*) AS row_json
      FROM ${this.usageEventsTable} u
      WHERE ($1::text IS NULL OR tenant_id = $1)
        AND ($2::text IS NULL OR run_id = $2)
        AND ($3::text IS NULL OR session_id = $3)
        AND ($4::boolean IS NULL OR billable = $4)
        AND ($5::timestamptz IS NULL OR created_at >= $5::timestamptz)
        AND ($6::timestamptz IS NULL OR created_at <= $6::timestamptz)
        ${unpricedClause}
      ORDER BY created_at DESC
      LIMIT $7
    `, [query.tenantId ?? null, query.runId ?? null, query.sessionId ?? null, query.billable ?? null, query.from ?? null, query.to ?? null, limit]);
    return result.rows.map((row) => normalizeUsageEvent(row.row_json));
  }

  async listUnprojectedRuntimeEvents(limit = 500): Promise<RuntimeUsageEventRow[]> {
    if (!this.eventsTable) return [];
    const state = await this.getProjectionState('runtime_events');
    const runFields = this.runsTable
      ? "r.user_id AS run_user_id, r.channel AS run_channel, r.model AS run_model, r.metadata->>'toolProfile' AS run_tool_profile"
      : "NULL::text AS run_user_id, NULL::text AS run_channel, NULL::text AS run_model, NULL::text AS run_tool_profile";
    const runJoin = this.runsTable ? `LEFT JOIN ${this.runsTable} r ON r.run_id = e.run_id` : '';
    const result = await this.pool.query<{
      global_sequence: string;
      event_id: string;
      event_type: string;
      tenant_id: string;
      timestamp: Date | string;
      event_json: Record<string, unknown>;
      run_user_id?: string | null;
      run_channel?: string | null;
      run_model?: string | null;
      run_tool_profile?: string | null;
    }>(`
      SELECT e.global_sequence, e.event_id, e.event_type, e.tenant_id, e.timestamp, e.event_json,
             ${runFields}
      FROM ${this.eventsTable} e
      ${runJoin}
      WHERE e.global_sequence > $1
      ORDER BY e.global_sequence ASC
      LIMIT $2
    `, [state, limit]);
    return result.rows.map((row) => ({
      globalSequence: Number(row.global_sequence),
      eventId: row.event_id,
      eventType: row.event_type,
      tenantId: row.tenant_id,
      timestamp: new Date(row.timestamp).toISOString(),
      eventJson: row.event_json,
      ...(row.run_user_id ? { runUserId: row.run_user_id } : {}),
      ...(row.run_channel ? { runChannel: row.run_channel } : {}),
      ...(row.run_model ? { runModel: row.run_model } : {}),
      ...(row.run_tool_profile ? { runToolProfile: row.run_tool_profile } : {}),
    }));
  }

  async setProjectionState(key: string, lastGlobalSequence: number): Promise<void> {
    await this.pool.query(`
      INSERT INTO ${this.projectionStateTable} (key, last_global_sequence, updated_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (key) DO UPDATE SET
        last_global_sequence = GREATEST(${this.projectionStateTable}.last_global_sequence, EXCLUDED.last_global_sequence),
        updated_at = EXCLUDED.updated_at
    `, [key, lastGlobalSequence, new Date().toISOString()]);
  }

  async getProjectionState(key: string): Promise<number> {
    const result = await this.pool.query<{ last_global_sequence: string }>(
      `SELECT last_global_sequence FROM ${this.projectionStateTable} WHERE key = $1`,
      [key],
    );
    return Number(result.rows[0]?.last_global_sequence ?? 0);
  }

  async getMonthlyLedgerSummary(tenantId: string, from: string): Promise<{ creditsUsedMicro: number; revenueYuanMicro: number; actualCostYuanMicro: number; grossProfitYuanMicro: number; grossMarginBps: number | null }> {
    const result = await this.pool.query<{
      credits_used_micro: string | null;
      revenue_yuan_micro: string | null;
      actual_cost_yuan_micro: string | null;
      gross_profit_yuan_micro: string | null;
    }>(`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'debit' THEN -credits_delta_micro ELSE 0 END), 0) AS credits_used_micro,
        COALESCE(SUM(CASE WHEN type = 'debit' THEN revenue_yuan_micro ELSE 0 END), 0) AS revenue_yuan_micro,
        COALESCE(SUM(CASE WHEN type = 'debit' THEN actual_cost_yuan_micro ELSE 0 END), 0) AS actual_cost_yuan_micro,
        COALESCE(SUM(CASE WHEN type = 'debit' THEN gross_profit_yuan_micro ELSE 0 END), 0) AS gross_profit_yuan_micro
      FROM ${this.creditLedgerTable}
      WHERE tenant_id = $1 AND created_at >= $2::timestamptz
    `, [tenantId, from]);
    const row = result.rows[0]!;
    const revenue = Number(row.revenue_yuan_micro ?? 0);
    const profit = Number(row.gross_profit_yuan_micro ?? 0);
    return {
      creditsUsedMicro: Number(row.credits_used_micro ?? 0),
      revenueYuanMicro: revenue,
      actualCostYuanMicro: Number(row.actual_cost_yuan_micro ?? 0),
      grossProfitYuanMicro: profit,
      grossMarginBps: revenue > 0 ? Math.round((profit / revenue) * 10_000) : null,
    };
  }

  async getSessionTreeLedgerSummary(tenantId: string, rootSessionId: string): Promise<{
    creditsUsedMicro: number;
    revenueYuanMicro: number;
    actualCostYuanMicro: number;
    childSessionCount: number;
  }> {
    const sessionTreeCte = this.eventsTable
      ? `
        WITH RECURSIVE session_tree(session_id) AS (
          SELECT $2::text
          UNION
          SELECT e.event_json->>'childSessionId'
          FROM ${this.eventsTable} e
          JOIN session_tree parent ON e.session_id = parent.session_id
          WHERE e.tenant_id = $1
            AND e.event_type IN ('subagent_started', 'subagent_finished')
            AND COALESCE(e.event_json->>'childSessionId', '') <> ''
        )
      `
      : `WITH session_tree(session_id) AS (SELECT $2::text)`;
    const result = await this.pool.query<{
      credits_used_micro: string;
      revenue_yuan_micro: string;
      actual_cost_yuan_micro: string;
      child_session_count: string;
    }>(`
      ${sessionTreeCte}
      SELECT
        COALESCE(SUM(CASE WHEN l.type = 'debit' THEN GREATEST(-l.credits_delta_micro, 0) ELSE 0 END), 0)::text AS credits_used_micro,
        COALESCE(SUM(CASE WHEN l.type = 'debit' THEN l.revenue_yuan_micro ELSE 0 END), 0)::text AS revenue_yuan_micro,
        COALESCE(SUM(CASE WHEN l.type = 'debit' THEN l.actual_cost_yuan_micro ELSE 0 END), 0)::text AS actual_cost_yuan_micro,
        (SELECT GREATEST(COUNT(*) - 1, 0)::text FROM session_tree) AS child_session_count
      FROM ${this.creditLedgerTable} l
      WHERE l.tenant_id = $1
        AND l.session_id IN (SELECT session_id FROM session_tree)
    `, [tenantId, rootSessionId]);
    const row = result.rows[0];
    return {
      creditsUsedMicro: Number(row?.credits_used_micro ?? 0),
      revenueYuanMicro: Number(row?.revenue_yuan_micro ?? 0),
      actualCostYuanMicro: Number(row?.actual_cost_yuan_micro ?? 0),
      childSessionCount: Number(row?.child_session_count ?? 0),
    };
  }

  async deleteTenantData(tenantId: string): Promise<{ usageEvents: number; creditLedger: number; creditAccounts: number; tenantPolicies: number }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const creditLedger = await client.query(`DELETE FROM ${this.creditLedgerTable} WHERE tenant_id = $1`, [tenantId]);
      const usageEvents = await client.query(`DELETE FROM ${this.usageEventsTable} WHERE tenant_id = $1`, [tenantId]);
      const creditAccounts = await client.query(`DELETE FROM ${this.creditAccountsTable} WHERE tenant_id = $1`, [tenantId]);
      const tenantPolicies = await client.query(`DELETE FROM ${this.tenantPoliciesTable} WHERE tenant_id = $1`, [tenantId]);
      await client.query('COMMIT');
      return {
        usageEvents: usageEvents.rowCount ?? 0,
        creditLedger: creditLedger.rowCount ?? 0,
        creditAccounts: creditAccounts.rowCount ?? 0,
        tenantPolicies: tenantPolicies.rowCount ?? 0,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async getAuditSummary(query: { tenantId?: string; days?: number }): Promise<BillingAuditSummary> {
    const days = Math.max(1, Math.min(query.days ?? 7, 90));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const ledger = await this.pool.query<{
      actual_cost_yuan_micro: string | null;
      revenue_yuan_micro: string | null;
      credits_charged_micro: string | null;
      gross_profit_yuan_micro: string | null;
    }>(`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'debit' THEN actual_cost_yuan_micro ELSE 0 END), 0) AS actual_cost_yuan_micro,
        COALESCE(SUM(CASE WHEN type = 'debit' THEN revenue_yuan_micro ELSE 0 END), 0) AS revenue_yuan_micro,
        COALESCE(SUM(CASE WHEN type = 'debit' THEN -credits_delta_micro ELSE 0 END), 0) AS credits_charged_micro,
        COALESCE(SUM(CASE WHEN type = 'debit' THEN gross_profit_yuan_micro ELSE 0 END), 0) AS gross_profit_yuan_micro
      FROM ${this.creditLedgerTable}
      WHERE ($1::text IS NULL OR tenant_id = $1)
        AND created_at >= $2::timestamptz
    `, [query.tenantId ?? null, since]);
    const unpriced = await this.pool.query<{ count: string }>(`
      SELECT COUNT(*) AS count
      FROM ${this.usageEventsTable}
      WHERE ($1::text IS NULL OR tenant_id = $1)
        AND created_at >= $2::timestamptz
        AND actual_cost_yuan_micro = 0
        AND (input_tokens > 0 OR output_tokens > 0)
    `, [query.tenantId ?? null, since]);
    const lowBalance = await this.pool.query<{ tenant_id: string; balance_micro: string; low_balance_threshold_credits_micro: string }>(`
      SELECT a.tenant_id, a.balance_micro, p.low_balance_threshold_credits_micro
      FROM ${this.creditAccountsTable} a
      JOIN ${this.tenantPoliciesTable} p ON p.tenant_id = a.tenant_id
      WHERE ($1::text IS NULL OR a.tenant_id = $1)
        AND p.low_balance_threshold_credits_micro > 0
        AND a.balance_micro <= p.low_balance_threshold_credits_micro
    `, [query.tenantId ?? null]);
    const row = ledger.rows[0]!;
    const revenue = Number(row.revenue_yuan_micro ?? 0);
    const profit = Number(row.gross_profit_yuan_micro ?? 0);
    const margin = revenue > 0 ? Math.round((profit / revenue) * 10_000) : null;
    const alerts: string[] = [];
    if (margin !== null && margin < 4500) alerts.push(`最近 ${days} 天平台/筛选范围毛利率低于 45%：${(margin / 100).toFixed(2)}%`);
    const unpricedCount = Number(unpriced.rows[0]?.count ?? 0);
    if (unpricedCount > 0) alerts.push(`最近 ${days} 天出现 ${unpricedCount} 条 cost=0 usage event`);
    for (const item of lowBalance.rows) {
      alerts.push(`租户 ${item.tenant_id} 余额低于阈值`);
    }
    return {
      ...(query.tenantId ? { tenantId: query.tenantId } : {}),
      days,
      actualCostYuanMicro: Number(row.actual_cost_yuan_micro ?? 0),
      revenueYuanMicro: revenue,
      creditsChargedMicro: Number(row.credits_charged_micro ?? 0),
      grossProfitYuanMicro: profit,
      grossMarginBps: margin,
      unpricedUsageEvents: unpricedCount,
      lowBalanceTenants: lowBalance.rows.map((item) => ({
        tenantId: item.tenant_id,
        balanceCreditsMicro: Number(item.balance_micro),
        thresholdCreditsMicro: Number(item.low_balance_threshold_credits_micro),
      })),
      alerts,
    };
  }

  private async ensureDefaultPricingVersion(client: PgClient): Promise<void> {
    await client.query(`
      INSERT INTO ${this.pricingVersionsTable}
        (version, name, status, effective_from, credit_value_yuan_micro, default_target_margin_bps, currency, created_by, created_at)
      VALUES ($1, $2, 'active', $3, $4, $5, 'CNY', 'system', $3)
      ON CONFLICT (version) DO NOTHING
    `, [
      DEFAULT_PRICING_VERSION,
      'Legacy usage pricing v1 (credit value configurable)',
      new Date().toISOString(),
      DEFAULT_CREDIT_VALUE_YUAN_MICRO,
      DEFAULT_TARGET_MARGIN_BPS,
    ]);
  }

  private async ensureTenantPolicy(tenantId: string, actor: string): Promise<void> {
    const pricing = await this.getActivePricingVersion();
    const billingMode: BillingMode = isInternalTenantId(tenantId) ? 'internal' : 'prepaid';
    await this.pool.query(`
      INSERT INTO ${this.tenantPoliciesTable}
        (tenant_id, policy_version, billing_enabled, pricing_version, billing_mode,
         default_target_margin_bps, organization_multiplier_bps, allow_negative_balance,
         negative_limit_credits_micro, low_balance_threshold_credits_micro, hard_cap_mode,
         show_balance, show_usage_credits, show_cost, show_gross_margin, updated_by, updated_at)
      VALUES ($1,$2,false,$3,$4,$5,10000,false,0,0,'none',true,true,false,false,$6,$7)
      ON CONFLICT (tenant_id) DO NOTHING
    `, [
      tenantId,
      DEFAULT_BILLING_POLICY_VERSION,
      pricing.version,
      billingMode,
      pricing.defaultTargetMarginBps,
      actor,
      new Date().toISOString(),
    ]);
    await this.ensureAccount(tenantId);
  }

  private async ensureAccount(tenantId: string): Promise<void> {
    await this.pool.query(`
      INSERT INTO ${this.creditAccountsTable} (tenant_id, balance_micro, reserved_micro, updated_at)
      VALUES ($1, 0, 0, $2)
      ON CONFLICT (tenant_id) DO NOTHING
    `, [tenantId, new Date().toISOString()]);
  }

  private async withAccountLock<T>(tenantId: string, fn: (client: PgClient, account: BillingCreditAccount) => Promise<T>): Promise<T> {
    await this.ensureAccount(tenantId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ row_json: Record<string, unknown> }>(
        `SELECT row_to_json(a.*) AS row_json FROM ${this.creditAccountsTable} a WHERE tenant_id = $1 FOR UPDATE`,
        [tenantId],
      );
      const account = normalizeAccount(result.rows[0]!.row_json);
      const output = await fn(client, account);
      await client.query('COMMIT');
      return output;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async getLedgerByIdempotencyKey(client: PgClient, idempotencyKey: string): Promise<BillingLedgerEntry | null> {
    const result = await client.query<{ row_json: Record<string, unknown> }>(
      `SELECT row_to_json(l.*) AS row_json FROM ${this.creditLedgerTable} l WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    return result.rows[0] ? normalizeLedgerEntry(result.rows[0].row_json) : null;
  }

  private async listDebitedUsageEventIds(client: PgClient, tenantId: string, runId: string): Promise<Set<string>> {
    const result = await client.query<{ usage_event_id: string }>(`
      SELECT DISTINCT unnest(related_usage_event_ids) AS usage_event_id
      FROM ${this.creditLedgerTable}
      WHERE tenant_id = $1
        AND run_id = $2
        AND type = 'debit'
        AND source = 'usage_event'
    `, [tenantId, runId]);
    return new Set(result.rows.map((row) => row.usage_event_id));
  }

  private async insertLedgerAndUpdateAccount(client: PgClient, input: Omit<BillingLedgerEntry, 'id' | 'createdAt'>): Promise<BillingLedgerEntry> {
    const now = new Date().toISOString();
    const result = await client.query<{ row_json: Record<string, unknown> }>(`
      INSERT INTO ${this.creditLedgerTable}
        (id, idempotency_key, tenant_id, account_id, type, source, related_usage_event_ids,
         session_id, run_id, message_id, credits_delta_micro, balance_before_micro, balance_after_micro,
         credit_value_yuan_micro, revenue_yuan_micro, actual_cost_yuan_micro, gross_profit_yuan_micro,
         gross_margin_bps, pricing_version, billing_policy_version, note, created_by, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
      RETURNING row_to_json(${this.creditLedgerTable}.*) AS row_json
    `, [
      randomUUID(),
      input.idempotencyKey,
      input.tenantId,
      input.accountId,
      input.type,
      input.source,
      input.relatedUsageEventIds,
      input.sessionId ?? null,
      input.runId ?? null,
      input.messageId ?? null,
      Math.trunc(input.creditsDeltaMicro),
      Math.trunc(input.balanceBeforeMicro),
      Math.trunc(input.balanceAfterMicro),
      Math.trunc(input.creditValueYuanMicro),
      Math.trunc(input.revenueYuanMicro),
      Math.trunc(input.actualCostYuanMicro),
      Math.trunc(input.grossProfitYuanMicro),
      input.grossMarginBps ?? null,
      input.pricingVersion,
      input.billingPolicyVersion,
      input.note ?? null,
      input.createdBy ?? null,
      now,
    ]);
    await client.query(
      `UPDATE ${this.creditAccountsTable}
       SET balance_micro = $2, updated_at = $3
       WHERE tenant_id = $1`,
      [input.tenantId, Math.trunc(input.balanceAfterMicro), now],
    );
    return normalizeLedgerEntry(result.rows[0]!.row_json);
  }
}

function computeRevenueYuanMicro(actualCostYuanMicro: number, policy: TenantBillingPolicy): number {
  if (actualCostYuanMicro <= 0) return 0;
  const margin = Math.max(0, Math.min(policy.defaultTargetMarginBps, 9500)) / 10_000;
  const required = Math.ceil(actualCostYuanMicro / Math.max(0.01, 1 - margin));
  return Math.ceil(required * (policy.organizationMultiplierBps / 10_000));
}

function roundUpCreditsMicro(value: number): number {
  const step = 10_000; // 0.01 credit
  return Math.ceil(value / step) * step;
}

function usageEventIdHash(ids: string[]): string {
  return createHash('sha1').update([...ids].sort().join('\n')).digest('hex').slice(0, 16);
}

export class BillingPricingConflictError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'BillingPricingConflictError';
  }
}

function normalizePricingConflictError(err: unknown): unknown {
  if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
    const constraint = (err as { constraint?: string }).constraint ?? '';
    if (constraint.endsWith('_pkey')) {
      return new BillingPricingConflictError('定价版本号已存在，请修改版本号后重试', err);
    }
    if (constraint.endsWith('_one_active_idx')) {
      return new BillingPricingConflictError('已有另一个 active 价格版本，请刷新后重试', err);
    }
    return new BillingPricingConflictError('定价版本冲突，请刷新后重试', err);
  }
  return err;
}

function normalizeUsage(usage: ProjectedRuntimeUsageInput['usage']) {
  return {
    inputTokens: nonNegativeInt(usage.inputTokens),
    outputTokens: nonNegativeInt(usage.outputTokens),
    cacheReadInputTokens: nonNegativeInt(usage.cacheReadInputTokens),
    cacheCreationInputTokens: nonNegativeInt(usage.cacheCreationInputTokens),
    reasoningTokens: nonNegativeInt(usage.reasoningTokens),
    apiRequestCount: Math.max(1, nonNegativeInt(usage.apiRequestCount) || 1),
  };
}

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function inputSegment(inputTokens: number): string {
  if (inputTokens <= 32_000) return '<=32k';
  if (inputTokens <= 128_000) return '32k-128k';
  if (inputTokens <= 256_000) return '128k-256k';
  return '>256k';
}

function inferProvider(model: string): string {
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gpt-')) return 'openai';
  if (model.startsWith('doubao-') || model.startsWith('glm-') || model.startsWith('deepseek-')) return 'volcengine';
  if (model.startsWith('kimi-')) return 'kimi';
  if (model.toLowerCase().includes('minimax')) return 'minimax';
  return 'custom';
}

function inferModelTier(model: string): string {
  const lower = model.toLowerCase();
  // 'minimax' 含子串 'mini'，必须先于 economy 判定短路，否则 MiniMax 全系被错归 economy 档
  if (lower.includes('minimax')) return 'standard';
  if (lower.includes('mini') || lower.includes('lite') || lower.includes('haiku')) return 'economy';
  if (lower.includes('opus') || lower.includes('claude') || lower.includes('gpt')) return 'premium';
  return 'standard';
}

function sanitizeIdentifier(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_]/g, '_');
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sanitized)) {
    throw new Error(`Invalid SQL identifier: ${value}`);
  }
  return sanitized;
}

function sanitizeQualifiedIdentifier(value: string): string {
  return value.split('.').map(sanitizeIdentifier).join('.');
}

function normalizePricingVersion(row: Record<string, unknown>): BillingPricingVersion {
  return {
    version: String(row.version),
    name: String(row.name),
    status: row.status as BillingPricingVersion['status'],
    effectiveFrom: toIso(row.effective_from),
    ...(row.effective_to ? { effectiveTo: toIso(row.effective_to) } : {}),
    creditValueYuanMicro: Number(row.credit_value_yuan_micro),
    defaultTargetMarginBps: Number(row.default_target_margin_bps),
    fxRateToCny: Number(row.fx_rate_to_cny ?? DEFAULT_FX_RATE_TO_CNY),
    currency: 'CNY',
    createdBy: String(row.created_by),
    createdAt: toIso(row.created_at),
    ...(row.updated_by ? { updatedBy: String(row.updated_by) } : {}),
    ...(row.updated_at ? { updatedAt: toIso(row.updated_at) } : {}),
  };
}

function normalizeTenantPolicy(row: Record<string, unknown>): TenantBillingPolicy {
  // 兼容历史 reserve_then_run（2026-06-28 摘除）→ stop_before_run
  const rawHardCap = String(row.hard_cap_mode ?? 'none');
  const hardCapMode: HardCapMode = rawHardCap === 'reserve_then_run' ? 'stop_before_run' : (rawHardCap as HardCapMode);
  return {
    tenantId: String(row.tenant_id),
    policyVersion: String(row.policy_version),
    billingEnabled: Boolean(row.billing_enabled),
    pricingVersion: String(row.pricing_version),
    billingMode: row.billing_mode as BillingMode,
    defaultTargetMarginBps: Number(row.default_target_margin_bps),
    organizationMultiplierBps: Number(row.organization_multiplier_bps),
    allowNegativeBalance: Boolean(row.allow_negative_balance),
    negativeLimitCreditsMicro: Number(row.negative_limit_credits_micro),
    lowBalanceThresholdCreditsMicro: Number(row.low_balance_threshold_credits_micro),
    hardCapMode,
    showBalance: Boolean(row.show_balance),
    showUsageCredits: Boolean(row.show_usage_credits),
    showCost: Boolean(row.show_cost),
    showGrossMargin: Boolean(row.show_gross_margin),
    updatedBy: String(row.updated_by),
    updatedAt: toIso(row.updated_at),
  };
}

function normalizeAccount(row: Record<string, unknown>): BillingCreditAccount {
  return {
    tenantId: String(row.tenant_id),
    balanceCreditsMicro: Number(row.balance_micro),
    reservedCreditsMicro: Number(row.reserved_micro),
    updatedAt: toIso(row.updated_at),
  };
}

function normalizeUsageEvent(row: Record<string, unknown>): BillingUsageEvent {
  return {
    id: String(row.id),
    idempotencyKey: String(row.idempotency_key),
    tenantId: String(row.tenant_id),
    ...(row.user_id ? { userId: String(row.user_id) } : {}),
    username: String(row.username),
    ...(row.session_id ? { sessionId: String(row.session_id) } : {}),
    ...(row.run_id ? { runId: String(row.run_id) } : {}),
    ...(row.message_id ? { messageId: String(row.message_id) } : {}),
    channel: String(row.channel),
    billable: Boolean(row.billable),
    ...(row.model_ref ? { modelRef: String(row.model_ref) } : {}),
    modelValue: String(row.model_value),
    ...(row.actual_model ? { actualModel: String(row.actual_model) } : {}),
    ...(row.provider ? { provider: String(row.provider) } : {}),
    ...(row.model_tier ? { modelTier: String(row.model_tier) } : {}),
    requestIndex: Number(row.request_index),
    ...(row.response_id ? { responseId: String(row.response_id) } : {}),
    inputTokens: Number(row.input_tokens),
    uncachedInputTokens: Number(row.uncached_input_tokens),
    cachedInputTokens: Number(row.cached_input_tokens),
    cacheCreationTokens: Number(row.cache_creation_tokens),
    cacheStorageTokens: Number(row.cache_storage_tokens),
    cacheStorageHours: Number(row.cache_storage_hours),
    outputTokens: Number(row.output_tokens),
    reasoningTokens: Number(row.reasoning_tokens),
    apiRequestCount: Number(row.api_request_count),
    inputSegment: String(row.input_segment),
    usageAccounting: String(row.usage_accounting),
    pricingVersion: String(row.pricing_version),
    costCurrency: 'CNY',
    fxRateToCny: Number(row.fx_rate_to_cny),
    actualCostYuanMicro: Number(row.actual_cost_yuan_micro),
    rawUsageJson: row.raw_usage_json,
    createdAt: toIso(row.created_at),
  };
}

function normalizeLedgerEntry(row: Record<string, unknown>): BillingLedgerEntry {
  return {
    id: String(row.id),
    idempotencyKey: String(row.idempotency_key),
    tenantId: String(row.tenant_id),
    accountId: String(row.account_id),
    type: row.type as LedgerType,
    source: String(row.source),
    relatedUsageEventIds: Array.isArray(row.related_usage_event_ids) ? row.related_usage_event_ids.map(String) : [],
    ...(row.session_id ? { sessionId: String(row.session_id) } : {}),
    ...(row.run_id ? { runId: String(row.run_id) } : {}),
    ...(row.message_id ? { messageId: String(row.message_id) } : {}),
    creditsDeltaMicro: Number(row.credits_delta_micro),
    balanceBeforeMicro: Number(row.balance_before_micro),
    balanceAfterMicro: Number(row.balance_after_micro),
    creditValueYuanMicro: Number(row.credit_value_yuan_micro),
    revenueYuanMicro: Number(row.revenue_yuan_micro),
    actualCostYuanMicro: Number(row.actual_cost_yuan_micro),
    grossProfitYuanMicro: Number(row.gross_profit_yuan_micro),
    ...(row.gross_margin_bps !== null && row.gross_margin_bps !== undefined ? { grossMarginBps: Number(row.gross_margin_bps) } : {}),
    pricingVersion: String(row.pricing_version),
    billingPolicyVersion: String(row.billing_policy_version),
    ...(row.note ? { note: String(row.note) } : {}),
    ...(row.created_by ? { createdBy: String(row.created_by) } : {}),
    createdAt: toIso(row.created_at),
  };
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return new Date(value).toISOString();
  return new Date(String(value)).toISOString();
}
