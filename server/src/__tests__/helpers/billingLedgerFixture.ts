import type { BillingLedgerEntry } from '../../data/billing/types.js';

export function fullLedgerEntry(): BillingLedgerEntry {
  return {
    id: 'led-1',
    idempotencyKey: 'idem-1',
    tenantId: 'wain',
    accountId: 'acc-wain',
    type: 'debit',
    source: 'usage_event',
    relatedUsageEventIds: ['ue-1'],
    sessionId: 'sess-1',
    runId: 'run-1',
    creditsDeltaMicro: -12_345_000,
    balanceBeforeMicro: 500_000_000,
    balanceAfterMicro: 487_655_000,
    creditValueYuanMicro: 10_000,
    revenueYuanMicro: 123_450,
    actualCostYuanMicro: 49_380,
    grossProfitYuanMicro: 74_070,
    grossMarginBps: 6000,
    pricingVersion: 'price-v1',
    billingPolicyVersion: 'pol-v7',
    note: '扣费',
    createdAt: '2026-07-13T10:00:00.000Z',
  };
}
