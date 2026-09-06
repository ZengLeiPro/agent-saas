import type { PgRunStore } from './runStore.js';
import type { AttentionItem } from './attention.js';

const FAILURE_WINDOW_MINUTES = 10;
const FAILURE_MIN_COUNT = 5;
const FAILURE_MIN_USERS = 2;
const FAILURE_RATE_THRESHOLD = 0.5;
const QUEUE_STALL_MINUTES = 10;
const QUEUE_STALL_MIN_COUNT = 3;
const QUEUE_STALL_MIN_USERS = 2;

export const RECOVERABLE_PLATFORM_INCIDENT_KINDS = [
  'platform_run_failure_spike',
  'platform_run_queue_stalled',
] as const;

interface RunSystemHealthRow {
  recent_total: string | number;
  recent_failed: string | number;
  failed_users: string | number;
  stalled_pending: string | number;
  stalled_users: string | number;
}

export interface RunSystemHealthSnapshot {
  recentTotal: number;
  recentFailed: number;
  failedUsers: number;
  stalledPending: number;
  stalledUsers: number;
}

/** 钉钉只接收会持续影响平台可用性的基础设施事故。 */
export function selectAttentionSystemIncidents(items: AttentionItem[]): AttentionItem[] {
  return items.filter((item) => item.kind === 'disk_root_high' && item.severity === 'critical');
}

/** 外部事件同样走事故白名单；计费与日常运维事件只保留在平台分析页。 */
export function selectExternalSystemIncidents(source: string, items: AttentionItem[]): AttentionItem[] {
  if (source === 'memory_consolidation') {
    return items.filter((item) => (
      item.kind === 'memory_consolidation_scanner_lag'
      && (item.severity === 'high' || item.severity === 'critical')
    ));
  }
  // WP2a：定制项目安装实例的 live 连续失败与恢复，同样只放行到「持续影响可用性」这一档。
  if (source === 'ky_app_installation') {
    return items.filter((item) => (
      (item.kind === 'ky_app_installation_unhealthy'
        || item.kind === 'ky_app_installation_recovered'
        || item.kind === 'ky_app_credits_low'
        || item.kind === 'ky_app_credits_exhausted')
      && (item.severity === 'high' || item.severity === 'critical')
    ));
  }
  if (source !== 'agent-saas-acs-orchestrator') return [];
  return items.filter((item) => (
    (item.kind === 'acs_sandbox_lifecycle_failed'
      || item.kind === 'acs_sandbox_running_near_quota'
      || item.kind === 'acs_sandbox_allocated_near_quota')
    && (item.severity === 'high' || item.severity === 'critical')
  ));
}

export async function buildRunSystemIncidents(runStore?: PgRunStore): Promise<AttentionItem[]> {
  if (!runStore) return [];
  const result = await runStore.pool.query<RunSystemHealthRow>(
    `WITH recent_terminal AS (
       SELECT status, user_id
       FROM ${runStore.runsTable}
       WHERE (status = 'completed' AND completed_at >= now() - interval '${FAILURE_WINDOW_MINUTES} minutes')
          OR (status = 'failed' AND failed_at >= now() - interval '${FAILURE_WINDOW_MINUTES} minutes')
     ), stalled_pending AS (
       SELECT user_id
       FROM ${runStore.runsTable}
       WHERE status = 'pending'
         AND CASE WHEN started_at IS NULL THEN requested_at ELSE updated_at END
             < now() - interval '${QUEUE_STALL_MINUTES} minutes'
     )
     SELECT
       (SELECT count(*) FROM recent_terminal) AS recent_total,
       (SELECT count(*) FROM recent_terminal WHERE status = 'failed') AS recent_failed,
       (SELECT count(DISTINCT user_id) FROM recent_terminal WHERE status = 'failed') AS failed_users,
       (SELECT count(*) FROM stalled_pending) AS stalled_pending,
       (SELECT count(DISTINCT user_id) FROM stalled_pending) AS stalled_users`,
  );
  return buildRunSystemIncidentsFromSnapshot(mapSnapshot(result.rows[0]));
}

export function buildRunSystemIncidentsFromSnapshot(snapshot: RunSystemHealthSnapshot): AttentionItem[] {
  const incidents: AttentionItem[] = [];
  const failureRate = snapshot.recentTotal > 0 ? snapshot.recentFailed / snapshot.recentTotal : 0;
  if (
    snapshot.recentFailed >= FAILURE_MIN_COUNT
    && snapshot.failedUsers >= FAILURE_MIN_USERS
    && failureRate >= FAILURE_RATE_THRESHOLD
  ) {
    incidents.push({
      kind: 'platform_run_failure_spike',
      severity: 'high',
      title: `平台近 ${FAILURE_WINDOW_MINUTES} 分钟 Run 失败率 ${(failureRate * 100).toFixed(0)}%（${snapshot.recentFailed}/${snapshot.recentTotal}，影响 ${snapshot.failedUsers} 名用户）`,
      actions: ['检查模型网关、数据库与调度链路', '查看失败 Run 聚合'],
    });
  }
  if (snapshot.stalledPending >= QUEUE_STALL_MIN_COUNT && snapshot.stalledUsers >= QUEUE_STALL_MIN_USERS) {
    incidents.push({
      kind: 'platform_run_queue_stalled',
      severity: 'high',
      title: `平台 Run 队列阻塞超过 ${QUEUE_STALL_MINUTES} 分钟（${snapshot.stalledPending} 个任务，影响 ${snapshot.stalledUsers} 名用户）`,
      actions: ['检查调度器、Worker 与全局并发容量', '查看 Pending Run'],
    });
  }
  return incidents;
}

export function platformRecoveryItem(kind: typeof RECOVERABLE_PLATFORM_INCIDENT_KINDS[number]): AttentionItem {
  if (kind === 'platform_run_failure_spike') {
    return {
      kind: `${kind}_recovered`,
      severity: 'info',
      title: '平台 Run 失败率已恢复到事故阈值以下',
      actions: ['复盘事故时间段与失败原因'],
    };
  }
  return {
    kind: `${kind}_recovered`,
    severity: 'info',
    title: '平台 Run 队列已恢复，未再检测到跨用户持续阻塞',
    actions: ['确认积压任务已正常消费'],
  };
}

function mapSnapshot(row: RunSystemHealthRow | undefined): RunSystemHealthSnapshot {
  return {
    recentTotal: Number(row?.recent_total ?? 0),
    recentFailed: Number(row?.recent_failed ?? 0),
    failedUsers: Number(row?.failed_users ?? 0),
    stalledPending: Number(row?.stalled_pending ?? 0),
    stalledUsers: Number(row?.stalled_users ?? 0),
  };
}
