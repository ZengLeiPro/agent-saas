import type { PgRunStore } from '../runtime/runStore.js';
import { ACTIVE_RUN_STATUSES } from '../runtime/attention.js';

const RUN_HEALTH_SCOPE = {
  source: 'runtime_runs' as const,
  identity: 'run_id' as const,
  initiatedAt: 'requested_at' as const,
  timezone: 'Asia/Shanghai' as const,
  completionDenominator: 'terminal_runs_requested_today' as const,
};

export interface PlatformRunHealth {
  activeRuns: { total: number; byStatus: Record<string, number> };
  todayRuns: number;
  completionRateToday: number | null;
  scope: typeof RUN_HEALTH_SCOPE;
}

export async function queryPlatformRunHealth(runStore?: PgRunStore): Promise<PlatformRunHealth> {
  if (!runStore) {
    return { activeRuns: { total: 0, byStatus: {} }, todayRuns: 0, completionRateToday: null, scope: RUN_HEALTH_SCOPE };
  }
  const [active, today, terminalToday] = await Promise.all([
    runStore.pool.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count
       FROM ${runStore.runsTable}
       WHERE status = ANY($1::text[])
       GROUP BY status`,
      [ACTIVE_RUN_STATUSES],
    ),
    runStore.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM ${runStore.runsTable}
       WHERE requested_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')`,
    ),
    runStore.pool.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count
       FROM ${runStore.runsTable}
       WHERE requested_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')
         AND status IN ('completed','failed','cancelled','orphaned')
       GROUP BY status`,
    ),
  ]);
  const byStatus: Record<string, number> = {};
  for (const row of active.rows) byStatus[row.status] = Number(row.count);
  const completed = Number(terminalToday.rows.find((row) => row.status === 'completed')?.count ?? 0);
  const terminalTotal = terminalToday.rows.reduce((sum, row) => sum + Number(row.count), 0);
  return {
    activeRuns: { total: Object.values(byStatus).reduce((sum, value) => sum + value, 0), byStatus },
    todayRuns: Number(today.rows[0]?.count ?? 0),
    completionRateToday: terminalTotal > 0 ? completed / terminalTotal : null,
    scope: RUN_HEALTH_SCOPE,
  };
}
