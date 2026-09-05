/**
 * 定时任务（Cron）HTTP 封装 —— Web `web/src/components/CronManager/hooks.ts` 与
 * mobile `src/hooks/useCronJobs.ts` 两份实现的唯一下沉点。
 *
 * 约定：
 * 1. 本模块只做「请求 + 解析 + 排序」，不含任何框架状态（useState / useEffect），
 *    刷新策略与生命周期留给各端的 hook；
 * 2. 端点常量集中在此，端侧不得再自行拼 `/api/cron/...`；
 * 3. 「立即运行」必须带幂等键（`Idempotency-Key` + body.requestId），
 *    避免网络重试把一次手动触发放大成多轮真实执行。
 */
import { authFetch } from './authFetch';
import { parseJsonResponse } from './parseJsonResponse';
import type {
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronRunLogEntry,
  CronServiceStatus,
  DingtalkSessionSummary,
} from '../types/cron';
import { sortCronJobsByNextRun } from './cronPresentation';

export const CRON_API_BASE = '/api/cron';
export const CRON_DINGTALK_API_BASE = '/api/dingtalk';

/** 运行历史默认拉取条数（与 Web CronManager 一致）。 */
export const CRON_RUN_HISTORY_LIMIT = 200;

const ERROR_SCOPE = '定时任务';

/** Cron 表达式服务端校验结果（`POST /api/cron/validate` 的响应体）。 */
export interface CronExprValidation {
  valid: boolean;
  error?: string;
}

/** 幂等键：优先用 crypto.randomUUID，Hermes 等缺失实现时回落时间戳+随机数。 */
export function newCronRequestId(): string {
  const globalCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof globalCrypto?.randomUUID === 'function') return globalCrypto.randomUUID();
  return `cron-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function fetchCronServiceStatus(): Promise<CronServiceStatus> {
  const res = await authFetch(`${CRON_API_BASE}/status`);
  return parseJsonResponse<CronServiceStatus>(res, ERROR_SCOPE);
}

/** 拉取全部任务（含已禁用），按「下次运行时间」升序返回。 */
export async function fetchCronJobs(): Promise<CronJob[]> {
  const res = await authFetch(`${CRON_API_BASE}/jobs?includeDisabled=true`);
  const data = await parseJsonResponse<{ jobs?: CronJob[] }>(res, ERROR_SCOPE);
  return sortCronJobsByNextRun(data.jobs ?? []);
}

export async function createCronJob(create: CronJobCreate): Promise<void> {
  const res = await authFetch(`${CRON_API_BASE}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(create),
  });
  await parseJsonResponse(res, ERROR_SCOPE);
}

export async function updateCronJob(id: string, patch: CronJobPatch): Promise<void> {
  const res = await authFetch(`${CRON_API_BASE}/jobs/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  await parseJsonResponse(res, ERROR_SCOPE);
}

export async function deleteCronJob(id: string): Promise<void> {
  const res = await authFetch(`${CRON_API_BASE}/jobs/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  await parseJsonResponse(res, ERROR_SCOPE);
}

/** 立即运行一次；带幂等键，重试不会放大成多轮执行。 */
export async function runCronJob(id: string): Promise<void> {
  const requestId = newCronRequestId();
  const res = await authFetch(`${CRON_API_BASE}/jobs/${encodeURIComponent(id)}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestId },
    body: JSON.stringify({ requestId }),
  });
  await parseJsonResponse(res, ERROR_SCOPE);
}

export async function fetchCronRunHistory(
  jobId: string,
  limit: number = CRON_RUN_HISTORY_LIMIT,
): Promise<CronRunLogEntry[]> {
  const res = await authFetch(
    `${CRON_API_BASE}/jobs/${encodeURIComponent(jobId)}/runs?limit=${limit}`,
  );
  const data = await parseJsonResponse<{ entries?: CronRunLogEntry[] }>(res, ERROR_SCOPE);
  return data.entries ?? [];
}

/**
 * 5 字段 Cron 表达式的服务端校验。
 * 服务端只回 `{ valid, error }`，不回下次运行时间（见回报的契约缺口）。
 * 网络失败不当作「表达式非法」，回 `valid: true` 让提交时由服务端兜底判定。
 */
export async function validateCronExpression(
  expr: string,
  tz?: string,
): Promise<CronExprValidation> {
  try {
    const res = await authFetch(`${CRON_API_BASE}/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expr, tz }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { valid: false, error: body.error || '无效的 Cron 表达式' };
    }
    return (await res.json()) as CronExprValidation;
  } catch {
    return { valid: true };
  }
}

/** 通知目标候选：已建立的钉钉会话列表。 */
export async function fetchCronDingtalkSessions(): Promise<DingtalkSessionSummary[]> {
  const res = await authFetch(`${CRON_DINGTALK_API_BASE}/sessions`);
  const data = await parseJsonResponse<{ sessions?: DingtalkSessionSummary[] }>(res, '钉钉会话');
  return data.sessions ?? [];
}
