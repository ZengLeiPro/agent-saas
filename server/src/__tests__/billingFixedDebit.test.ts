import { describe, expect, it, vi } from 'vitest';

import { PgBillingStore } from '../data/billing/pgBillingStore.js';
import { CREDIT_MICRO, type TenantBillingPolicy } from '../data/billing/types.js';

describe('PgBillingStore.chargeFixedDebit', () => {
  // 私有方法经 spy 隔离 PG：本组只验证 chargeFixedDebit 自身的守卫/幂等/落账语义，
  // SQL 层由集成环境覆盖。
  function fixedDebitStore(input: {
    policy?: Partial<TenantBillingPolicy>;
    balanceCreditsMicro?: number;
  } = {}) {
    const store = new PgBillingStore({ pool: {} as any });
    vi.spyOn(store, 'getTenantPolicy').mockResolvedValue({
      tenantId: 'wain-test',
      policyVersion: 'test',
      billingEnabled: true,
      pricingVersion: 'test',
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
      ...(input.policy ?? {}),
    } as any);
    vi.spyOn(store, 'getActivePricingVersion').mockResolvedValue({
      version: 'test-v1',
      creditValueYuanMicro: 10_000, // 0.01 元/积分
    } as any);
    const getByKey = vi.spyOn(store as any, 'getLedgerByIdempotencyKey').mockResolvedValue(null);
    const insert = vi.spyOn(store as any, 'insertLedgerAndUpdateAccount')
      .mockImplementation(async (...args: unknown[]) => ({
        id: 'ledger-fixed-1',
        createdAt: '2026-07-15T00:00:00.000Z',
        ...(args[1] as Record<string, unknown>),
      }));
    const lock = vi.spyOn(store as any, 'withAccountLock')
      .mockImplementation(async (...args: unknown[]) => {
        const fn = args[1] as (client: unknown, account: unknown) => Promise<unknown>;
        return fn({}, {
          tenantId: 'wain-test',
          balanceCreditsMicro: Math.trunc(input.balanceCreditsMicro ?? 1000 * CREDIT_MICRO),
          updatedAt: '2026-07-15T00:00:00.000Z',
        });
      });
    return { store, getByKey, insert, lock };
  }

  const baseInput = {
    tenantId: 'wain-test',
    idempotencyKey: 'debit:tool:v1:event-image',
    source: 'tool:image_gen',
    creditsMicro: 800 * CREDIT_MICRO, // 400 积分/张 × 2 张
    actualCostYuanMicro: 3_000_000,
    relatedUsageEventIds: ['usage-img'],
    note: 'GenerateImage image_gen:gpt-image-2 ×2',
  };

  it('exempts internal tenants: no ledger write at all', async () => {
    const { store, insert, lock } = fixedDebitStore({ policy: { billingMode: 'internal' } });
    await expect(store.chargeFixedDebit(baseInput)).resolves.toBeNull();
    expect(lock).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('exempts billing-disabled tenants: no ledger write at all', async () => {
    const { store, insert, lock } = fixedDebitStore({ policy: { billingEnabled: false } });
    await expect(store.chargeFixedDebit(baseInput)).resolves.toBeNull();
    expect(lock).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('writes a fixed-value debit with flat pricing (not cost-plus) on first charge', async () => {
    const { store, insert } = fixedDebitStore({ balanceCreditsMicro: 1000 * CREDIT_MICRO });
    const entry = await store.chargeFixedDebit(baseInput);
    expect(entry).toMatchObject({
      type: 'debit',
      source: 'tool:image_gen',
      idempotencyKey: 'debit:tool:v1:event-image',
      creditsDeltaMicro: -800 * CREDIT_MICRO,
      balanceBeforeMicro: 1000 * CREDIT_MICRO,
      balanceAfterMicro: 200 * CREDIT_MICRO,
      // 固定面值：revenue = 800 积分 × 0.01 元 = 8 元；毛利审计对生图同样生效
      revenueYuanMicro: 8_000_000,
      actualCostYuanMicro: 3_000_000,
      grossProfitYuanMicro: 5_000_000,
      relatedUsageEventIds: ['usage-img'],
      pricingVersion: 'test-v1',
    });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('is idempotent on replay: the anchored key returns the existing entry without a second insert', async () => {
    // 投影重跑 / runtime_events 归档重放（rebuildFromJsonl）场景：
    // 幂等键锚定 eventId → 第二次投影拿回首笔 ledger，绝不重复扣。
    const { store, getByKey, insert } = fixedDebitStore();
    const first = await store.chargeFixedDebit(baseInput);
    expect(first).not.toBeNull();
    expect(insert).toHaveBeenCalledTimes(1);

    getByKey.mockResolvedValue(first);
    const replay = await store.chargeFixedDebit(baseInput);
    expect(replay).toBe(first);
    expect(insert).toHaveBeenCalledTimes(1); // 无第二次落账
  });

  it('still charges into negative when generation already happened (warn, not throw)', async () => {
    // 并发穿透容忍度与 token 路径一致：外部成本已发生，不回滚，事后由 audit 暴露。
    const warn = vi.fn();
    const { store } = fixedDebitStore({ balanceCreditsMicro: 100 * CREDIT_MICRO });
    (store as any).options.logger = { warn };
    const entry = await store.chargeFixedDebit(baseInput);
    expect(entry).toMatchObject({ balanceAfterMicro: -700 * CREDIT_MICRO });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fixed debit makes tenant negative'));
  });
});
