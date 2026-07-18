import { describe, expect, it, vi } from 'vitest';

import { PgBillingStore } from '../data/billing/pgBillingStore.js';
import { CREDIT_MICRO, type BillingUsageEvent, type TenantBillingPolicy } from '../data/billing/types.js';

/**
 * PgBillingStore 纯逻辑补测（cost-plus 定价 / 幂等 / 豁免守卫）。
 * 隔离 PG：spy 掉所有触库的私有方法（withAccountLock / getLedgerByIdempotencyKey /
 * insertLedgerAndUpdateAccount / listUsageEvents / listDebitedUsageEventIds）与
 * policy/pricing getter，仅验证 settleRunDebit / adjustAccount 自身的金额计算、
 * 版本落章与短路语义。SQL 层由集成环境覆盖。
 */

function basePolicy(overrides: Partial<TenantBillingPolicy> = {}): TenantBillingPolicy {
  return {
    tenantId: 'wain-test',
    policyVersion: 'pol-v1',
    billingEnabled: true,
    pricingVersion: 'price-v1',
    billingMode: 'prepaid',
    defaultTargetMarginBps: 6000, // 目标毛利 60%
    organizationMultiplierBps: 10000, // ×1.0
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
    ...overrides,
  };
}

function makeStore(input: {
  policy?: Partial<TenantBillingPolicy>;
  balanceCreditsMicro?: number;
  creditValueYuanMicro?: number;
} = {}) {
  const store = new PgBillingStore({ pool: {} as any });
  vi.spyOn(store, 'getTenantPolicy').mockResolvedValue(basePolicy(input.policy));
  vi.spyOn(store, 'getActivePricingVersion').mockResolvedValue({
    version: 'price-v1',
    creditValueYuanMicro: input.creditValueYuanMicro ?? 10_000, // 0.01 元/积分
  } as any);
  const getByKey = vi.spyOn(store as any, 'getLedgerByIdempotencyKey').mockResolvedValue(null);
  const insert = vi.spyOn(store as any, 'insertLedgerAndUpdateAccount')
    .mockImplementation(async (...args: unknown[]) => ({
      id: 'ledger-1',
      createdAt: '2026-07-15T00:00:00.000Z',
      ...(args[1] as Record<string, unknown>),
    }));
  vi.spyOn(store as any, 'withAccountLock').mockImplementation(async (...args: unknown[]) => {
    const fn = args[1] as (client: unknown, account: unknown) => Promise<unknown>;
    return fn({}, {
      tenantId: 'wain-test',
      balanceCreditsMicro: Math.trunc(input.balanceCreditsMicro ?? 1000 * CREDIT_MICRO),
      reservedCreditsMicro: 0,
      updatedAt: '2026-07-15T00:00:00.000Z',
    });
  });
  return { store, getByKey, insert };
}

function usageEvent(overrides: Partial<BillingUsageEvent> = {}): BillingUsageEvent {
  return {
    id: 'usage-1',
    idempotencyKey: 'usage:event:v1:e1',
    tenantId: 'wain-test',
    username: 'alice',
    sessionId: 'sess-1',
    runId: 'run-1',
    channel: 'web',
    billable: true,
    modelValue: 'glm-5.2',
    requestIndex: 1,
    inputTokens: 0,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    cacheStorageTokens: 0,
    cacheStorageHours: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    apiRequestCount: 1,
    inputSegment: '<=32k',
    usageAccounting: 'default',
    pricingVersion: 'price-v1',
    costCurrency: 'CNY',
    fxRateToCny: 7.2,
    actualCostYuanMicro: 3_000_000, // 3 元真实成本
    rawUsageJson: {},
    createdAt: '2026-07-15T00:00:00.000Z',
    ...overrides,
  };
}

describe('PgBillingStore.settleRunDebit', () => {
  it('cost-plus：按目标毛利倒推 revenue 并换算积分扣费', async () => {
    const { store, insert } = makeStore({ balanceCreditsMicro: 1000 * CREDIT_MICRO });
    vi.spyOn(store, 'listUsageEvents').mockResolvedValue([usageEvent()]);
    vi.spyOn(store as any, 'listDebitedUsageEventIds').mockResolvedValue(new Set());

    const entry = await store.settleRunDebit('wain-test', 'run-1');
    // 成本 3 元、毛利目标 60% → revenue = ceil(3 / 0.4) = 7.5 元 = 7_500_000 micro
    // 积分 = 7_500_000 * 1e6 / 10_000 = 750_000_000 micro（已是 0.01 步长整数）
    expect(entry).toMatchObject({
      type: 'debit',
      source: 'usage_event',
      actualCostYuanMicro: 3_000_000,
      revenueYuanMicro: 7_500_000,
      creditsDeltaMicro: -750_000_000,
      balanceBeforeMicro: 1000 * CREDIT_MICRO,
      balanceAfterMicro: 1000 * CREDIT_MICRO - 750_000_000,
      grossProfitYuanMicro: 7_500_000 - 3_000_000,
      // 毛利率 = 4.5 / 7.5 = 6000 bps
      grossMarginBps: 6000,
      relatedUsageEventIds: ['usage-1'],
      runId: 'run-1',
    });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('organizationMultiplierBps 放大 revenue（大客户加价）', async () => {
    const { store } = makeStore({
      balanceCreditsMicro: 1000 * CREDIT_MICRO,
      policy: { organizationMultiplierBps: 20000 }, // ×2.0
    });
    vi.spyOn(store, 'listUsageEvents').mockResolvedValue([usageEvent()]);
    vi.spyOn(store as any, 'listDebitedUsageEventIds').mockResolvedValue(new Set());

    const entry = await store.settleRunDebit('wain-test', 'run-1');
    // base revenue 7.5 元 × 2.0 = 15 元
    expect(entry!.revenueYuanMicro).toBe(15_000_000);
  });

  it('internal / billing 关闭租户不结算，直接返回 null', async () => {
    const internal = makeStore({ policy: { billingMode: 'internal' } });
    await expect(internal.store.settleRunDebit('wain-test', 'run-1')).resolves.toBeNull();

    const disabled = makeStore({ policy: { billingEnabled: false } });
    await expect(disabled.store.settleRunDebit('wain-test', 'run-1')).resolves.toBeNull();
  });

  it('无 billable usage event 返回 null', async () => {
    const { store } = makeStore();
    vi.spyOn(store, 'listUsageEvents').mockResolvedValue([]);
    await expect(store.settleRunDebit('wain-test', 'run-1')).resolves.toBeNull();
  });

  it('本 run 的 usage 已全部结算过（无 pending）返回 null，不重复扣', async () => {
    const { store, insert } = makeStore();
    vi.spyOn(store, 'listUsageEvents').mockResolvedValue([usageEvent({ id: 'usage-charged' })]);
    vi.spyOn(store as any, 'listDebitedUsageEventIds').mockResolvedValue(new Set(['usage-charged']));

    await expect(store.settleRunDebit('wain-test', 'run-1')).resolves.toBeNull();
    expect(insert).not.toHaveBeenCalled();
  });

  it('幂等键已存在 ledger 时返回原条目，不二次落账', async () => {
    const { store, getByKey, insert } = makeStore();
    vi.spyOn(store, 'listUsageEvents').mockResolvedValue([usageEvent()]);
    vi.spyOn(store as any, 'listDebitedUsageEventIds').mockResolvedValue(new Set());
    const prior = { id: 'ledger-prior' } as any;
    getByKey.mockResolvedValue(prior);

    await expect(store.settleRunDebit('wain-test', 'run-1')).resolves.toBe(prior);
    expect(insert).not.toHaveBeenCalled();
  });

  it('余额穿透到负数时照扣并 warn（模型调用已发生不可回滚）', async () => {
    const warn = vi.fn();
    const { store } = makeStore({ balanceCreditsMicro: 1 * CREDIT_MICRO });
    (store as any).options.logger = { warn };
    vi.spyOn(store, 'listUsageEvents').mockResolvedValue([usageEvent()]);
    vi.spyOn(store as any, 'listDebitedUsageEventIds').mockResolvedValue(new Set());

    const entry = await store.settleRunDebit('wain-test', 'run-1');
    expect(entry!.balanceAfterMicro).toBeLessThan(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('makes tenant negative'));
  });
});

describe('PgBillingStore.adjustAccount', () => {
  it('正向充值：revenue = 面值×creditValue，成本/毛利为 0', async () => {
    const { store, insert } = makeStore({ balanceCreditsMicro: 100 * CREDIT_MICRO });
    const entry = await store.adjustAccount({
      tenantId: 'wain-test',
      type: 'recharge',
      creditsDeltaMicro: 500 * CREDIT_MICRO,
      actor: 'admin',
      note: '充值 500',
    });
    expect(entry).toMatchObject({
      type: 'recharge',
      source: 'manual',
      creditsDeltaMicro: 500 * CREDIT_MICRO,
      balanceBeforeMicro: 100 * CREDIT_MICRO,
      balanceAfterMicro: 600 * CREDIT_MICRO,
      // revenue = 500 积分 × 0.01 元 = 5 元
      revenueYuanMicro: 5_000_000,
      actualCostYuanMicro: 0,
      grossProfitYuanMicro: 0,
      createdBy: 'admin',
      note: '充值 500',
    });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('负向调整：扣减余额，负 delta 不计 revenue', async () => {
    const { store } = makeStore({ balanceCreditsMicro: 100 * CREDIT_MICRO });
    const entry = await store.adjustAccount({
      tenantId: 'wain-test',
      type: 'adjustment',
      creditsDeltaMicro: -30 * CREDIT_MICRO,
      actor: 'admin',
    });
    expect(entry.balanceAfterMicro).toBe(70 * CREDIT_MICRO);
    expect(entry.revenueYuanMicro).toBe(0); // max(0, 负值)=0
  });

  it('显式 idempotencyKey 命中已有条目时直接返回，不重复落账', async () => {
    const { store, getByKey, insert } = makeStore();
    const prior = { id: 'ledger-prior' } as any;
    getByKey.mockResolvedValue(prior);

    const entry = await store.adjustAccount({
      tenantId: 'wain-test',
      type: 'grant',
      creditsDeltaMicro: 10 * CREDIT_MICRO,
      actor: 'admin',
      idempotencyKey: 'grant:fixed:key',
    });
    expect(entry).toBe(prior);
    expect(insert).not.toHaveBeenCalled();
  });
});
