/**
 * 定时任务的移动端状态层。
 *
 * 请求、排序、幂等键等纯逻辑全部在 `@agent/shared` 的 `cronApi` 里
 * （Web `CronManager/hooks.ts` 与本文件共用同一份），这里只保留 React 状态、
 * 首屏延迟到 JS 线程空闲后再拉取（避免和导航转场抢帧）这类端侧策略。
 */
import { useCallback, useEffect, useState } from 'react';
import type {
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronRunLogEntry,
  CronServiceStatus,
  DingtalkSessionSummary,
} from '@agent/shared';
import {
  createCronJob,
  deleteCronJob as deleteCronJobApi,
  fetchCronDingtalkSessions,
  fetchCronJobs,
  fetchCronRunHistory,
  fetchCronServiceStatus,
  runCronJob as runCronJobApi,
  updateCronJob as updateCronJobApi,
} from '@agent/shared';
import { scheduleIdle } from '../lib/ric';

export function useCronStatus() {
  const [status, setStatus] = useState<CronServiceStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setStatus(await fetchCronServiceStatus());
    } catch {
      // 状态条是附属信息，拉失败时静默降级为「未知」
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => scheduleIdle(() => void refresh()), [refresh]);

  return { status, loading, refresh };
}

export function useCronJobs() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setJobs(await fetchCronJobs());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // 首屏拉取推迟到 JS 线程空闲（导航转场结束后）
  useEffect(() => scheduleIdle(() => void refresh()), [refresh]);

  const addJob = useCallback(
    async (create: CronJobCreate) => {
      await createCronJob(create);
      await refresh();
    },
    [refresh],
  );

  const updateJob = useCallback(
    async (id: string, patch: CronJobPatch) => {
      await updateCronJobApi(id, patch);
      await refresh();
    },
    [refresh],
  );

  const deleteJob = useCallback(
    async (id: string) => {
      await deleteCronJobApi(id);
      await refresh();
    },
    [refresh],
  );

  const runJob = useCallback(
    async (id: string) => {
      await runCronJobApi(id);
      await refresh();
    },
    [refresh],
  );

  const toggleJob = useCallback(
    async (job: CronJob) => {
      await updateJob(job.id, { enabled: !job.enabled });
    },
    [updateJob],
  );

  return { jobs, loading, error, refresh, addJob, updateJob, deleteJob, runJob, toggleJob };
}

export function useRunHistory(jobId: string | null) {
  const [entries, setEntries] = useState<CronRunLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    if (!jobId) {
      setEntries([]);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const cancelIdle = scheduleIdle(() => {
      fetchCronRunHistory(jobId)
        .then((next) => {
          if (cancelled) return;
          setEntries(next);
          setError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setEntries([]);
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    });
    return () => {
      cancelled = true;
      cancelIdle();
    };
  }, [jobId, reloadToken]);

  return { entries, loading, error, reload };
}

/** 通知目标候选：已建立的钉钉会话（表单里只在需要钉钉通知时才用得上）。 */
export function useCronDingtalkSessions(enabled: boolean) {
  const [sessions, setSessions] = useState<DingtalkSessionSummary[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const cancelIdle = scheduleIdle(() => {
      fetchCronDingtalkSessions()
        .then((next) => {
          if (!cancelled) setSessions(next);
        })
        .catch(() => {
          if (!cancelled) setSessions([]);
        });
    });
    return () => {
      cancelled = true;
      cancelIdle();
    };
  }, [enabled]);

  return sessions;
}
