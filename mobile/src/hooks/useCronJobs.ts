import { useCallback, useEffect, useState } from 'react';
import type { CronJob, CronJobCreate, CronJobPatch, CronRunLogEntry, CronServiceStatus } from '@agent/shared';
import { authFetch, parseJsonResponse } from '@agent/shared';
import { scheduleIdle } from '../lib/ric';

const API = '/api/cron';

export function useCronStatus() {
  const [status, setStatus] = useState<CronServiceStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await authFetch(`${API}/status`);
      const data = await parseJsonResponse<CronServiceStatus>(res, '定时任务');
      setStatus(data);
    } catch {} finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => scheduleIdle(() => void refresh()), [refresh]);

  return { status, loading, refresh };
}

function sortByNextRun(jobs: CronJob[]): CronJob[] {
  return [...jobs].sort((a, b) => (a.state.nextRunAtMs ?? Infinity) - (b.state.nextRunAtMs ?? Infinity));
}

export function useCronJobs() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await authFetch(`${API}/jobs?includeDisabled=true`);
      const data = await parseJsonResponse<{ jobs?: CronJob[] }>(res, '定时任务');
      setJobs(sortByNextRun(data.jobs || []));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Defer initial fetch until JS thread is idle (after navigation transition)
  useEffect(() => scheduleIdle(() => void refresh()), [refresh]);

  const addJob = async (create: CronJobCreate) => {
    const res = await authFetch(`${API}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(create),
    });
    await parseJsonResponse(res, '定时任务');
    await refresh();
  };

  const updateJob = async (id: string, patch: CronJobPatch) => {
    const res = await authFetch(`${API}/jobs/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    await parseJsonResponse(res, '定时任务');
    await refresh();
  };

  const deleteJob = async (id: string) => {
    const res = await authFetch(`${API}/jobs/${id}`, { method: 'DELETE' });
    await parseJsonResponse(res, '定时任务');
    await refresh();
  };

  const runJob = async (id: string) => {
    const res = await authFetch(`${API}/jobs/${id}/run`, { method: 'POST' });
    await parseJsonResponse(res, '定时任务');
    await refresh();
  };

  const toggleJob = async (job: CronJob) => {
    await updateJob(job.id, { enabled: !job.enabled });
  };

  return { jobs, loading, error, refresh, addJob, updateJob, deleteJob, runJob, toggleJob };
}

export function useRunHistory(jobId: string | null) {
  const [entries, setEntries] = useState<CronRunLogEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!jobId) { setEntries([]); return; }
    setLoading(true);
    return scheduleIdle(() => {
      authFetch(`${API}/jobs/${jobId}/runs?limit=50`)
        .then((res) => parseJsonResponse<{ entries?: CronRunLogEntry[] }>(res, '定时任务'))
        .then((data) => setEntries(data.entries || []))
        .catch(() => setEntries([]))
        .finally(() => setLoading(false));
    });
  }, [jobId]);

  return { entries, loading };
}
