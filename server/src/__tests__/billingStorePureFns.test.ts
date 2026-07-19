/**
 * PgBillingStore 尾部纯函数段补测（财务正确性方向，2026-07-19）
 *
 * 与现有 billing 测试的分工：
 *   - billingService.test.ts        : BillingService 投影/汇总业务逻辑
 *   - billingRouterRedact.test.ts   : /ledger、/audit 组织 admin 成本脱敏
 *   - billingStoreCoverage.test.ts  : settleRunDebit / adjustAccount 的 cost-plus 金额计算与幂等
 *   - billingConcurrency.test.ts    : 并发结算幂等
 *   本文件专测模块私有纯函数（未导出，经公开入口驱动）：
 *   1. inputSegment 三分界（32k/128k/256k，含恰好等于边界值）—— 经 insertUsageEvent 落库参数捕获
 *   2. inferProvider / inferModelTier 映射表 —— 同上
 *   3. normalizeUsage 清洗（负数/NaN/Infinity→0、小数下取整、apiRequestCount 下限 1）
 *      与 uncachedInputTokens 派生（input_includes_cache vs cache_tokens_separate）
 *   4. normalizePricingConflictError：pg 23505 → BillingPricingConflictError（消息/cause/回滚），
 *      其他错误原样透传 —— 经 create/updatePricingVersion 驱动
 *   5. updatePricingVersion「active 版本不能直接退役」守卫
 *
 * 隔离 PG：pool/client 全部为 vi.fn 假件，仅断言 SQL 参数与错误语义，SQL 层由集成环境覆盖。
 */
import { describe, expect, it, vi } from 'vitest';

import { BillingPricingConflictError, PgBillingStore } from '../data/billing/pgBillingStore.js';
import type { ProjectedRuntimeUsageInput, TenantBillingPolicy } from '../data/billing/types.js';

// ────────── insertUsageEvent 参数捕获 rig ──────────
// INSERT 参数位（0-based），与 pgBillingStore.insertUsageEvent 的 VALUES 顺序一一对应
const P = {
  billable: 8,
  modelValue: 9,
  provider: 11,
  modelTier: 12,
  inputTokens: 15,
  uncachedInputTokens: 16,
  cachedInputTokens: 17,
  cacheCreationTokens: 18,
  outputTokens: 19,
  reasoningTokens: 20,
  apiRequestCount: 21,
  inputSegment: 22,
  fxRateToCny: 25,
} as const;

function storePolicy(): TenantBillingPolicy {
  return {
    tenantId: 'wain-test',
    policyVersion: 'pol-v1',
    billingEnabled: true,
    pricingVersion: 'price-v1',
    billingMode: 'prepaid',
    defaultTargetMarginBps: 6000,
    organizationMultiplierBps: 10000,
    allowNegativeBalance: false,
    negativeLimitCreditsMicro: 0,
    lowBalanceThresholdCreditsMicro: 0,
    hardCapMode: 'stop_before_run',
    showBalance: true,
    showUsageCredits: true,
    showCost: false,
    showGrossMargin: false,
    updatedBy: 'test',
    updatedAt: '2026-07-15T00:00:00.000Z',
  };
}

async function captureInsertParams(
  overrides: Partial<ProjectedRuntimeUsageInput> = {},
  pricingOverrides: Record<string, unknown> = {},
): Promise<unknown[]> {
  const query = vi.fn(async (..._args: unknown[]) => ({ rows: [] }));
  const store = new PgBillingStore({ pool: { query } as any });
  vi.spyOn(store, 'getTenantPolicy').mockResolvedValue(storePolicy());
  vi.spyOn(store, 'getActivePricingVersion').mockResolvedValue({
    version: 'price-v1',
    creditValueYuanMicro: 10_000,
    defaultTargetMarginBps: 6000,
    fxRateToCny: 7.2,
    ...pricingOverrides,
  } as any);
  await store.insertUsageEvent({
    idempotencyKey: 'ue:1',
    tenantId: 'wain-test',
    username: 'alice',
    channel: 'web',
    modelValue: 'glm-5.2',
    requestIndex: 1,
    usage: {},
    rawUsageJson: {},
    occurredAt: '2026-07-15T00:00:00.000Z',
    // 固定成本旁路：绕过 computeCostMicro 的模型单价表，保持本测试与定价表解耦
    fixedCostYuanMicro: 0,
    ...overrides,
  });
  expect(query).toHaveBeenCalledTimes(1);
  return query.mock.calls[0]![1] as unknown[];
}

describe('fx_rate_to_cny 落库审计一致性（2026-07-19 修复回归）', () => {
  // 历史缺陷：insertUsageEvent 成本折算用 pricing.fxRateToCny，落库却恒写
  // DEFAULT_FX_RATE_TO_CNY——定价版本携带非默认汇率时审计字段与实际折算不一致。
  it('定价版本汇率 6.8 时，落库 fx_rate_to_cny=6.8 而非默认 7.2', async () => {
    const params = await captureInsertParams({}, { fxRateToCny: 6.8 });
    expect(params[P.fxRateToCny]).toBe(6.8);
  });

  it('默认汇率场景不回归：落库 7.2', async () => {
    const params = await captureInsertParams();
    expect(params[P.fxRateToCny]).toBe(7.2);
  });
});

describe('inputSegment 三分界（经 insertUsageEvent 落库参数）', () => {
  it.each([
    [0, '<=32k'],
    [32_000, '<=32k'],        // 恰好 32k 归入低档
    [32_001, '32k-128k'],
    [128_000, '32k-128k'],    // 恰好 128k 归入中档
    [128_001, '128k-256k'],
    [256_000, '128k-256k'],   // 恰好 256k 归入高档
    [256_001, '>256k'],
  ])('inputTokens=%i → %s', async (inputTokens, segment) => {
    const params = await captureInsertParams({ usage: { inputTokens } });
    expect(params[P.inputTokens]).toBe(inputTokens);
    expect(params[P.inputSegment]).toBe(segment);
  });
});

describe('inferProvider 映射表', () => {
  it.each([
    ['claude-sonnet-4-5', 'anthropic'],
    ['gpt-5.2', 'openai'],
    ['doubao-seed-2.0', 'volcengine'],
    ['glm-5.2', 'volcengine'],
    ['deepseek-v4', 'volcengine'],
    ['kimi-k3', 'kimi'],
    ['MiniMax-M2.1', 'minimax'],
    ['llama-4-maverick', 'custom'],   // 未知前缀兜底 custom
  ])('%s → %s', async (modelValue, provider) => {
    const params = await captureInsertParams({ modelValue });
    expect(params[P.provider]).toBe(provider);
  });
});

describe('inferModelTier 映射表', () => {
  it.each([
    ['gpt-5.2-mini', 'economy'],
    ['doubao-lite-32k', 'economy'],
    ['claude-haiku-4', 'economy'],       // haiku 命中 economy，优先于 claude→premium
    ['claude-opus-4-5', 'premium'],
    ['claude-sonnet-4-5', 'premium'],
    ['gpt-5.2', 'premium'],
    ['glm-5.2', 'standard'],
    ['kimi-k3', 'standard'],
    // 2026-07-19 修复回归：'minimax' 含子串 'mini'，曾被误归 economy；现短路为 standard
    ['MiniMax-M2.1', 'standard'],
    ['minimax-m3', 'standard'],
  ])('%s → %s', async (modelValue, tier) => {
    const params = await captureInsertParams({ modelValue });
    expect(params[P.modelTier]).toBe(tier);
  });
});

describe('normalizeUsage 清洗', () => {
  it('负数/NaN/Infinity → 0，apiRequestCount=0 抬到下限 1', async () => {
    const params = await captureInsertParams({
      usage: {
        inputTokens: -5,
        outputTokens: Number.NaN,
        cacheReadInputTokens: 3.9,       // 下取整 3
        reasoningTokens: Number.POSITIVE_INFINITY,
        apiRequestCount: 0,
        // cacheCreationInputTokens 缺省 → 0
      },
    });
    expect(params[P.inputTokens]).toBe(0);
    expect(params[P.outputTokens]).toBe(0);
    expect(params[P.cachedInputTokens]).toBe(3);
    expect(params[P.cacheCreationTokens]).toBe(0);
    expect(params[P.reasoningTokens]).toBe(0);
    expect(params[P.apiRequestCount]).toBe(1);
    // uncached = max(0, 0 - 3 - 0) = 0（input_includes_cache 口径下不产生负数）
    expect(params[P.uncachedInputTokens]).toBe(0);
  });

  it('合法值下取整；input_includes_cache 口径 uncached = input - cached - cacheCreation', async () => {
    const params = await captureInsertParams({
      modelValue: 'glm-5.2', // 非 claude → input_includes_cache
      usage: {
        inputTokens: 1000,
        outputTokens: 250,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 100,
        reasoningTokens: 50,
        apiRequestCount: 2.9, // 下取整 2
      },
    });
    expect(params[P.inputTokens]).toBe(1000);
    expect(params[P.uncachedInputTokens]).toBe(700); // 1000 - 200 - 100
    expect(params[P.cachedInputTokens]).toBe(200);
    expect(params[P.cacheCreationTokens]).toBe(100);
    expect(params[P.outputTokens]).toBe(250);
    expect(params[P.reasoningTokens]).toBe(50);
    expect(params[P.apiRequestCount]).toBe(2);
    expect(params[P.inputSegment]).toBe('<=32k');
  });

  it('claude（cache_tokens_separate 口径）：uncached 即 inputTokens，不减缓存分量', async () => {
    const params = await captureInsertParams({
      modelValue: 'claude-sonnet-4-5',
      usage: { inputTokens: 1000, cacheReadInputTokens: 200, cacheCreationInputTokens: 100 },
    });
    expect(params[P.inputTokens]).toBe(1000);
    expect(params[P.uncachedInputTokens]).toBe(1000);
    expect(params[P.cachedInputTokens]).toBe(200);
    expect(params[P.cacheCreationTokens]).toBe(100);
  });
});

// ────────── normalizePricingConflictError（经 create/updatePricingVersion）──────────

function makeTxClient(failWhen: (sql: string) => boolean, error: unknown) {
  const client = {
    query: vi.fn(async (sql: string) => {
      if (failWhen(sql)) throw error;
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return client;
}

const activeRowJson = {
  version: 'v2026.08',
  name: '2026Q3 定价',
  status: 'active',
  effective_from: '2026-07-01T00:00:00.000Z',
  credit_value_yuan_micro: 10_000,
  default_target_margin_bps: 6000,
  fx_rate_to_cny: 7.2,
  created_by: 'root',
  created_at: '2026-07-01T00:00:00.000Z',
};

describe('normalizePricingConflictError', () => {
  it('createPricingVersion 落库遇 pg 23505 → BillingPricingConflictError（含 cause），回滚并释放连接', async () => {
    const pgDup = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      constraint: 'runtime_billing_pricing_versions_one_active_idx',
    });
    const client = makeTxClient((sql) => sql.includes('INSERT'), pgDup);
    const store = new PgBillingStore({ pool: { connect: vi.fn(async () => client), query: vi.fn() } as any });

    const err = await store.createPricingVersion({
      version: 'v2026.09',
      name: '并发抢 active',
      status: 'active',
      creditValueYuanMicro: 10_000,
      defaultTargetMarginBps: 6000,
      createdBy: 'root',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BillingPricingConflictError);
    expect((err as BillingPricingConflictError).message).toBe('已有另一个 active 价格版本，请刷新后重试');
    expect((err as BillingPricingConflictError).cause).toBe(pgDup);
    expect(client.query.mock.calls.some((c) => String(c[0]).includes('ROLLBACK'))).toBe(true);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('非 23505 错误原样透传（同一实例，不被包装）', async () => {
    const boom = Object.assign(new Error('server closed the connection unexpectedly'), { code: '57P01' });
    const client = makeTxClient((sql) => sql.includes('INSERT'), boom);
    const store = new PgBillingStore({ pool: { connect: vi.fn(async () => client), query: vi.fn() } as any });

    const err = await store.createPricingVersion({
      version: 'v2026.09',
      name: 'x',
      creditValueYuanMicro: 10_000,
      defaultTargetMarginBps: 6000,
      createdBy: 'root',
    }).catch((e: unknown) => e);

    expect(err).toBe(boom);
    expect(err).not.toBeInstanceOf(BillingPricingConflictError);
  });

  it('updatePricingVersion 切 active 时并发唯一索引冲突（23505）→ BillingPricingConflictError', async () => {
    const pgDup = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'runtime_billing_pricing_versions_one_active_idx',
    });
    // 当前版本是 draft，patch 切 active → 先 retire 旧 active 的 UPDATE 触发 23505
    const client = makeTxClient((sql) => sql.includes("'retired'"), pgDup);
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async () => ({ rows: [{ row_json: { ...activeRowJson, status: 'draft' } }] })),
    };
    const store = new PgBillingStore({ pool: pool as any });

    const err = await store.updatePricingVersion('v2026.08', { status: 'active', updatedBy: 'root' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BillingPricingConflictError);
    expect((err as BillingPricingConflictError).cause).toBe(pgDup);
  });
});

describe('updatePricingVersion active 退役守卫', () => {
  it('当前 active 版本改成 retired → 拒绝（防止无 active 定价悬空），且不是 409 冲突语义', async () => {
    const client = makeTxClient(() => false, null);
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async () => ({ rows: [{ row_json: activeRowJson }] })),
    };
    const store = new PgBillingStore({ pool: pool as any });

    const err = await store.updatePricingVersion('v2026.08', { status: 'retired', updatedBy: 'root' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(BillingPricingConflictError);
    expect((err as Error).message).toContain('active 版本不能直接退役');
    expect(client.query.mock.calls.some((c) => String(c[0]).includes('ROLLBACK'))).toBe(true);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
