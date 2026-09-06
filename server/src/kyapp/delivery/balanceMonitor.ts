import type { KyAppAlertSink } from '../worker.js';
import type { KyAppDeliveryMetrics } from './metrics.js';
import type { PgKyAppDeliveryStore } from './store.js';

/** WP5：预计三天内耗尽与已耗尽各通知一次；余额恢复后自动解除去重。 */
export class KyAppBalanceMonitor {
  constructor(
    private readonly options: {
      store: PgKyAppDeliveryStore;
      metrics: KyAppDeliveryMetrics;
      alerts: KyAppAlertSink;
    },
  ) {}

  async reconcile(): Promise<void> {
    const deliveries = await this.options.store.listDeliveries();
    const tenantIds = [
      ...new Set(
        deliveries
          .filter((item) => item.offboardingStatus === 'active')
          .map((item) => item.tenantId),
      ),
    ];
    for (const tenantId of tenantIds) {
      const usage = await this.options.metrics.tenantOverview(tenantId);
      const exhausted = usage.balanceCredits <= 0;
      const low =
        !exhausted && usage.estimatedDaysRemaining !== null && usage.estimatedDaysRemaining <= 3;
      const exhaustedClaimed = await this.options.store.setBalanceNotificationState({
        tenantId,
        kind: 'exhausted',
        active: exhausted,
      });
      const lowClaimed = await this.options.store.setBalanceNotificationState({
        tenantId,
        kind: 'low',
        active: low,
      });
      if (exhaustedClaimed) {
        this.options.alerts.notifyCredits(tenantId, 'exhausted', usage.balanceCredits, 0);
      } else if (lowClaimed) {
        this.options.alerts.notifyCredits(
          tenantId,
          'low',
          usage.balanceCredits,
          usage.estimatedDaysRemaining,
        );
      }
    }
  }
}
