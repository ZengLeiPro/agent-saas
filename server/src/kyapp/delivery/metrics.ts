import type { BillingService } from '../../data/billing/service.js';
import { CREDIT_MICRO } from '../../data/billing/types.js';
import { getLastActivePerUser } from '../../data/login-logs/store.js';
import type { TenantStore } from '../../data/tenants/store.js';
import type { UserStore } from '../../data/users/store.js';
import type { PgKyAppDeliveryStore } from './store.js';

export interface KyAppUsageOverview {
  tenantId: string;
  period: { timezone: 'Asia/Shanghai'; monthStart: string; generatedAt: string };
  currentMonthCreditsUsed: number;
  balanceCredits: number;
  estimatedDaysRemaining: number | null;
  topUsers: Array<{ userId: string; name: string; creditsUsed: number }>;
  topCapabilities: Array<{ capabilityId: string; calls: number }>;
  weeklyTrend: Array<{ date: string; creditsUsed: number }>;
  capabilityMetric: 'call_count';
}

export interface KyAppInstallationSignals {
  window: '24h';
  outcomeUnknown: number;
  rateLimited: number;
  upstreamUnavailable: number;
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function monthStartInShanghai(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  if (!year || !month) throw new Error('KY_APP_USAGE_TIMEZONE_FORMAT_FAILED');
  return `${year}-${month}-01`;
}

export class KyAppDeliveryMetrics {
  constructor(
    private readonly options: {
      billing: BillingService;
      eventsTable: string;
      deliveries: PgKyAppDeliveryStore;
      users: UserStore;
      tenants: TenantStore;
      loginLogPath: string;
    },
  ) {}

  async tenantOverview(tenantId: string, installationId?: string): Promise<KyAppUsageOverview> {
    const billing = this.options.billing;
    await billing.projectRuntimeEvents();
    const pool = billing.store.pool;
    const ledger = billing.store.creditLedgerTable;
    const [summary, topUsers, trend, recent, capabilities] = await Promise.all([
      billing.getSummaryForTenant(tenantId),
      pool.query(
        `SELECT COALESCE(user_id,'') AS user_id,COALESCE(MAX(username_snapshot),'') AS name,
                COALESCE(SUM(-credits_delta_micro),0) AS used
         FROM ${ledger}
         WHERE tenant_id=$1 AND type='debit' AND created_at >= date_trunc('month',NOW() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
         GROUP BY user_id ORDER BY used DESC LIMIT 5`,
        [tenantId],
      ),
      pool.query(
        `WITH local_day AS (SELECT (NOW() AT TIME ZONE 'Asia/Shanghai')::date AS today),
          days AS (SELECT generate_series((today-6)::date,today::date,'1 day')::date AS day FROM local_day),
          used AS (SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date AS day,SUM(-credits_delta_micro) AS credits
            FROM ${ledger} WHERE tenant_id=$1 AND type='debit' AND created_at >= NOW()-INTERVAL '7 days' GROUP BY 1)
         SELECT days.day,COALESCE(used.credits,0) AS used FROM days LEFT JOIN used USING(day) ORDER BY days.day`,
        [tenantId],
      ),
      pool.query(
        `SELECT COALESCE(SUM(-credits_delta_micro),0) AS used
         FROM ${ledger} WHERE tenant_id=$1 AND type='debit' AND created_at >= NOW()-INTERVAL '30 days'`,
        [tenantId],
      ),
      pool.query(
        `SELECT event_json->>'capabilityId' AS capability_id,COUNT(*)::int AS calls
         FROM ${this.options.eventsTable}
         WHERE tenant_id=$1 AND event_type='tool_audit'
           AND ($2::text IS NULL OR event_json->>'installationId'=$2)
           AND timestamp >= date_trunc('month',NOW() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
           AND COALESCE(event_json->>'capabilityId','')<>''
         GROUP BY 1 ORDER BY calls DESC,capability_id LIMIT 5`,
        [tenantId, installationId ?? null],
      ),
    ]);
    const dailyCredits = number(recent.rows[0]?.used) / CREDIT_MICRO / 30;
    return {
      tenantId,
      period: {
        timezone: 'Asia/Shanghai',
        monthStart: monthStartInShanghai(),
        generatedAt: new Date().toISOString(),
      },
      currentMonthCreditsUsed: summary.currentMonthCreditsUsed,
      balanceCredits: summary.balanceCredits,
      estimatedDaysRemaining:
        dailyCredits > 0 ? Math.max(0, Math.ceil(summary.balanceCredits / dailyCredits)) : null,
      topUsers: topUsers.rows.map((row) => ({
        userId: String(row.user_id || 'unattributed'),
        name: String(row.name || '未归属'),
        creditsUsed: number(row.used) / CREDIT_MICRO,
      })),
      topCapabilities: capabilities.rows.map((row) => ({
        capabilityId: String(row.capability_id),
        calls: number(row.calls),
      })),
      weeklyTrend: trend.rows.map((row) => ({
        date: new Date(String(row.day)).toISOString().slice(0, 10),
        creditsUsed: number(row.used) / CREDIT_MICRO,
      })),
      capabilityMetric: 'call_count',
    };
  }

  async installationSignals(
    tenantId: string,
    installationId: string,
  ): Promise<KyAppInstallationSignals> {
    const result = await this.options.billing.store.pool.query(
      `SELECT event_json->>'errorCode' AS error_code,COUNT(*)::int AS total
       FROM ${this.options.eventsTable}
       WHERE tenant_id=$1 AND event_type='tool_audit'
         AND event_json->>'installationId'=$2
         AND timestamp >= NOW()-INTERVAL '24 hours'
         AND event_json->>'errorCode' IN ('outcome_unknown','rate_limited','upstream_unavailable')
       GROUP BY 1`,
      [tenantId, installationId],
    );
    const counts = new Map(
      result.rows.map((row) => [String(row.error_code), number(row.total)] as const),
    );
    return {
      window: '24h',
      outcomeUnknown: counts.get('outcome_unknown') ?? 0,
      rateLimited: counts.get('rate_limited') ?? 0,
      upstreamUnavailable: counts.get('upstream_unavailable') ?? 0,
    };
  }

  async platformHealth(): Promise<
    Array<{
      installationId: string;
      tenantId: string;
      tenantName: string;
      systemId: string;
      deliveredAt: string | null;
      loginPenetration: number;
      weeklyActiveAskers: number;
      consumptionRate: number;
      estimatedDaysRemaining: number | null;
      lastUsageAt: string | null;
      offboardingStatus: string;
    }>
  > {
    const [deliveries, activeByUsername] = await Promise.all([
      this.options.deliveries.listDeliveries(),
      getLastActivePerUser(this.options.loginLogPath),
    ]);
    const rows = [];
    for (const delivery of deliveries) {
      const users = this.options.users
        .listAll()
        .filter((user) => user.tenantId === delivery.tenantId && !user.disabled);
      const active = users.filter((user) => activeByUsername.has(user.username)).length;
      const overview = await this.tenantOverview(delivery.tenantId, delivery.installationId);
      const activity = await this.options.billing.store.pool.query(
        `SELECT COUNT(DISTINCT user_id)::int AS active,MAX(created_at) AS last_used_at
         FROM ${this.options.billing.store.creditLedgerTable}
         WHERE tenant_id=$1 AND type='debit' AND created_at>=NOW()-INTERVAL '7 days'`,
        [delivery.tenantId],
      );
      const denominator = overview.balanceCredits + overview.currentMonthCreditsUsed;
      rows.push({
        installationId: delivery.installationId,
        tenantId: delivery.tenantId,
        tenantName:
          this.options.tenants.findByIdStrict(delivery.tenantId)?.name ?? delivery.tenantId,
        systemId: delivery.systemId,
        deliveredAt: delivery.deliveredAt,
        loginPenetration: users.length > 0 ? active / users.length : 0,
        weeklyActiveAskers: number(activity.rows[0]?.active),
        consumptionRate: denominator > 0 ? overview.currentMonthCreditsUsed / denominator : 0,
        estimatedDaysRemaining: overview.estimatedDaysRemaining,
        lastUsageAt: activity.rows[0]?.last_used_at
          ? new Date(String(activity.rows[0].last_used_at)).toISOString()
          : null,
        offboardingStatus: delivery.offboardingStatus,
      });
    }
    return rows;
  }
}
