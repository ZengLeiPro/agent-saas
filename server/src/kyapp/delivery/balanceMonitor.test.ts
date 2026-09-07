import { describe, expect, it, vi } from 'vitest';

import { KyAppBalanceMonitor } from './balanceMonitor.js';

describe('KyAppBalanceMonitor', () => {
  it('三天预警与耗尽各只在持久去重成功后通知', async () => {
    const setState = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const notifyCredits = vi.fn();
    const monitor = new KyAppBalanceMonitor({
      store: {
        listDeliveries: async () => [{ tenantId: 't1', offboardingStatus: 'active' }],
        setBalanceNotificationState: setState,
      } as never,
      metrics: {
        tenantOverview: async () => ({ balanceCredits: 20, estimatedDaysRemaining: 2 }),
      } as never,
      alerts: { notifyCredits } as never,
    });
    await monitor.reconcile();
    expect(notifyCredits).toHaveBeenCalledWith('t1', 'low', 20, 2);
  });

  it('同一组织多安装实例只计算一次', async () => {
    const overview = vi.fn().mockResolvedValue({ balanceCredits: 0, estimatedDaysRemaining: 0 });
    const notifyCredits = vi.fn();
    const monitor = new KyAppBalanceMonitor({
      store: {
        listDeliveries: async () => [
          { tenantId: 't1', offboardingStatus: 'active' },
          { tenantId: 't1', offboardingStatus: 'active' },
        ],
        setBalanceNotificationState: vi
          .fn()
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(false),
      } as never,
      metrics: { tenantOverview: overview } as never,
      alerts: { notifyCredits } as never,
    });
    await monitor.reconcile();
    expect(overview).toHaveBeenCalledTimes(1);
    expect(notifyCredits).toHaveBeenCalledWith('t1', 'exhausted', 0, 0);
  });
});
