import { describe, expect, it, vi } from 'vitest';

import { ContextRetentionWorker, type ContextRetentionReceipt, type ContextRetentionRequest } from './retention.js';

const request = (tenantId: string): ContextRetentionRequest => ({
  tenantId, sourceOutboxWatermark: '10', derivedOutboxWatermark: '20',
  retainAfter: '2026-08-01T00:00:00.000Z', dryRun: true,
});

describe('ContextRetentionWorker tenant isolation', () => {
  it('records a failed tenant and continues later tenants', async () => {
    const receipt = (tenantId: string) => ({ tenantId, receiptId: `receipt-${tenantId}` }) as ContextRetentionReceipt;
    const collect = vi.fn()
      .mockRejectedValueOnce(new Error('tenant A database unavailable'))
      .mockResolvedValueOnce(receipt('tenant-b'));
    const audit = vi.fn().mockResolvedValue(undefined);

    const result = await new ContextRetentionWorker({ collect }, audit).run([
      request('tenant-a'), request('tenant-b'),
    ]);

    expect(result.failures).toEqual([{ tenantId: 'tenant-a', error: 'tenant A database unavailable' }]);
    expect(result.receipts).toEqual([receipt('tenant-b')]);
    expect(collect).toHaveBeenCalledTimes(2);
    expect(audit).toHaveBeenCalledWith(receipt('tenant-b'));
  });

  it('does not report success when the audit receipt sink fails', async () => {
    const receipt = { tenantId: 'tenant-a', receiptId: 'receipt-a' } as ContextRetentionReceipt;
    const result = await new ContextRetentionWorker(
      { collect: vi.fn().mockResolvedValue(receipt) },
      vi.fn().mockRejectedValue(new Error('audit sink unavailable')),
    ).run([request('tenant-a')]);

    expect(result.receipts).toEqual([]);
    expect(result.failures).toEqual([{ tenantId: 'tenant-a', error: 'audit sink unavailable', receipt }]);
  });
});
