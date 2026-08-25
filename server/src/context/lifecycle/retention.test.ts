import { describe, expect, it, vi } from 'vitest';

import {
  ContextRetentionAuditConsumer,
  ContextRetentionWorker,
  type ContextRetentionAuditConsumerStore,
  type ContextRetentionReceipt,
  type ContextRetentionRequest,
  type ContextRetentionWorkerStore,
} from './retention.js';

const request = (tenantId: string): ContextRetentionRequest => ({
  tenantId, sourceOutboxWatermark: '10', derivedOutboxWatermark: '20',
  retainAfter: '2026-08-01T00:00:00.000Z', dryRun: true,
});

function receipt(tenantId: string): ContextRetentionReceipt {
  return { tenantId, receiptId: `receipt-${tenantId}` } as ContextRetentionReceipt;
}

function workerStore(collect: ContextRetentionWorkerStore['collect']): ContextRetentionWorkerStore {
  return {
    collect,
    claimAudit: vi.fn(async (_tenantId, receiptId) => ({
      receipt: { tenantId: receiptId.replace('receipt-', ''), receiptId } as ContextRetentionReceipt,
      delivered: false, leaseId: 'lease-a',
    })),
    completeAudit: vi.fn(async () => undefined),
    failAudit: vi.fn(async () => undefined),
  };
}

describe('ContextRetentionWorker durable audit delivery', () => {
  it('records a failed tenant and continues later tenants', async () => {
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
    expect(store.completeAudit).toHaveBeenCalledWith('tenant-b', 'receipt-tenant-b', 'lease-a');
  });

  it('persists retry state after audit failure and can redeliver by tenant and receipt id', async () => {
    const committed = receipt('tenant-a');
    const store = workerStore(vi.fn().mockResolvedValue(committed));
    const audit = vi.fn().mockRejectedValueOnce(new Error('audit sink unavailable')).mockResolvedValue(undefined);
    const worker = new ContextRetentionWorker(store, audit);

    const result = await worker.run([request('tenant-a')]);
    expect(result.receipts).toEqual([]);
    expect(result.failures).toEqual([{ tenantId: 'tenant-a', error: 'audit sink unavailable', receipt: committed }]);
    expect(store.failAudit).toHaveBeenCalledWith('tenant-a', 'receipt-tenant-a', 'audit sink unavailable', 'lease-a');

    await expect(worker.retryAudit('tenant-a', 'receipt-tenant-a')).resolves.toMatchObject({ receiptId: 'receipt-tenant-a' });
    expect(audit).toHaveBeenCalledTimes(2);
  });
});

describe('ContextRetentionAuditConsumer', () => {
  it('continues after tenant A failure so tenant B can be delivered', async () => {
    const claims = [
      { tenantId: 'tenant-a', receiptId: 'receipt-a', receipt: receipt('tenant-a'), leaseId: 'lease-a' },
      { tenantId: 'tenant-b', receiptId: 'receipt-b', receipt: receipt('tenant-b'), leaseId: 'lease-b' },
    ];
    const store: ContextRetentionAuditConsumerStore = {
      deadLetterExhaustedAudits: vi.fn().mockResolvedValue(0),
      claimNextAudits: vi.fn().mockResolvedValue(claims),
      completeAudit: vi.fn().mockResolvedValue(undefined),
      failAudit: vi.fn().mockResolvedValue(undefined),
    };
    const audit = vi.fn(async (item: ContextRetentionReceipt) => {
      if (item.tenantId === 'tenant-a') throw new Error('tenant A audit unavailable');
    });

    await expect(new ContextRetentionAuditConsumer(store, audit).runOnce()).resolves.toEqual({
      claimed: 2, delivered: 1, failed: 1, deadLettered: 0,
    });
    expect(store.failAudit).toHaveBeenCalledWith('tenant-a', 'receipt-a', 'tenant A audit unavailable', 'lease-a');
    expect(store.completeAudit).toHaveBeenCalledWith('tenant-b', 'receipt-b', 'lease-b');
  });
});
