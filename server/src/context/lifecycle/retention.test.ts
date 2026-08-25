import { describe, expect, it, vi } from 'vitest';

import {
  ContextRetentionWorker,
  type ContextRetentionReceipt,
  type ContextRetentionRequest,
  type ContextRetentionWorkerStore,
} from './retention.js';

const request = (tenantId: string): ContextRetentionRequest => ({
  tenantId, sourceOutboxWatermark: '10', derivedOutboxWatermark: '20',
  retainAfter: '2026-08-01T00:00:00.000Z', dryRun: true,
});

function workerStore(collect: ContextRetentionWorkerStore['collect']): ContextRetentionWorkerStore {
  return {
    collect,
    claimAudit: vi.fn(async (_tenantId, receiptId) => ({
      receipt: { tenantId: receiptId.replace('receipt-', ''), receiptId } as ContextRetentionReceipt,
      delivered: false,
    })),
    completeAudit: vi.fn(async () => undefined),
    failAudit: vi.fn(async () => undefined),
  };
}

describe('ContextRetentionWorker durable audit delivery', () => {
  it('records a failed tenant and continues later tenants', async () => {
    const receipt = (tenantId: string) => ({ tenantId, receiptId: `receipt-${tenantId}` }) as ContextRetentionReceipt;
    const collect = vi.fn()
      .mockRejectedValueOnce(new Error('tenant A database unavailable'))
      .mockResolvedValueOnce(receipt('tenant-b'));
    const store = workerStore(collect);
    const audit = vi.fn().mockResolvedValue(undefined);

    const result = await new ContextRetentionWorker(store, audit).run([
      request('tenant-a'), request('tenant-b'),
    ]);

    expect(result.failures).toEqual([{ tenantId: 'tenant-a', error: 'tenant A database unavailable' }]);
    expect(result.receipts).toEqual([receipt('tenant-b')]);
    expect(store.completeAudit).toHaveBeenCalledWith('tenant-b', 'receipt-tenant-b');
  });

  it('persists retry state after audit failure and can redeliver by tenant and receipt id', async () => {
    const receipt = { tenantId: 'tenant-a', receiptId: 'receipt-tenant-a' } as ContextRetentionReceipt;
    const store = workerStore(vi.fn().mockResolvedValue(receipt));
    const audit = vi.fn().mockRejectedValueOnce(new Error('audit sink unavailable')).mockResolvedValue(undefined);
    const worker = new ContextRetentionWorker(store, audit);

    const result = await worker.run([request('tenant-a')]);
    expect(result.receipts).toEqual([]);
    expect(result.failures).toEqual([{ tenantId: 'tenant-a', error: 'audit sink unavailable', receipt }]);
    expect(store.failAudit).toHaveBeenCalledWith('tenant-a', 'receipt-tenant-a', 'audit sink unavailable');

    await expect(worker.retryAudit('tenant-a', 'receipt-tenant-a')).resolves.toMatchObject({ receiptId: 'receipt-tenant-a' });
    expect(audit).toHaveBeenCalledTimes(2);
  });
});
