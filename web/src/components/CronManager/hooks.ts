import { useCallback, useEffect, useState } from "react";
import { authFetch } from "@/lib/authFetch";
import { cronJobsPreload, cronStatusPreload } from "@/lib/preload";
import { registerRefresh, unregisterRefresh } from "@/lib/refreshBus";
import { parseJsonResponse } from "@agent/shared";
import type { ModelList } from "@/types/models";
import type {
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronRunLogEntry,
  CronServiceStatus,
  DingtalkSessionSummary,
} from "./types";

const API_BASE = "/api/cron";
const DINGTALK_API_BASE = "/api/dingtalk";

// --- 模块级缓存 ---
let cachedStatus: CronServiceStatus | null = null;
let cachedJobs: CronJob[] | null = null;
let cachedDingtalkSessions: DingtalkSessionSummary[] | null = null;
let cachedModelList: ModelList | null = null;

// preload promise 只消费一次
let statusPreloadConsumed = false;
let jobsPreloadConsumed = false;

export function useCronStatus() {
  const [status, setStatus] = useState<CronServiceStatus | null>(cachedStatus);
  const [loading, setLoading] = useState(cachedStatus === null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await authFetch(`${API_BASE}/status`);
      const data = await parseJsonResponse<CronServiceStatus>(res, "定时任务");
      cachedStatus = data;
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 有缓存则直接使用
    if (cachedStatus) { setLoading(false); return; }

    // 消费 preload（一次性）
    if (!statusPreloadConsumed) {
      statusPreloadConsumed = true;
      cronStatusPreload.then((preloaded) => {
        if (preloaded) {
          cachedStatus = preloaded as CronServiceStatus;
          setStatus(cachedStatus);
          setLoading(false);
        } else {
          void refresh();
        }
      });
    } else {
      void refresh();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 注册 refreshBus
  useEffect(() => {
    registerRefresh("cronStatus", refresh);
    return () => unregisterRefresh("cronStatus");
  }, [refresh]);

  return { status, loading, error, refresh };
}

function sortByNextRun(jobs: CronJob[]): CronJob[] {
  return [...jobs].sort((a, b) => (a.state.nextRunAtMs ?? Infinity) - (b.state.nextRunAtMs ?? Infinity));
}

export function useCronJobs() {
  const [jobs, setJobs] = useState<CronJob[]>(cachedJobs ? sortByNextRun(cachedJobs) : []);
  const [loading, setLoading] = useState(cachedJobs === null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await authFetch(`${API_BASE}/jobs?includeDisabled=true`);
      const data = await parseJsonResponse<{ jobs?: CronJob[] }>(res, "定时任务");
      const list = data.jobs || [];
      cachedJobs = list;
      setJobs(sortByNextRun(list));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (cachedJobs) { setLoading(false); return; }

    if (!jobsPreloadConsumed) {
      jobsPreloadConsumed = true;
      cronJobsPreload.then((preloaded) => {
        if (preloaded) {
          cachedJobs = preloaded as CronJob[];
          setJobs(sortByNextRun(cachedJobs));
          setLoading(false);
        } else {
          void refresh();
        }
      });
    } else {
      void refresh();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 注册 refreshBus
  useEffect(() => {
    registerRefresh("cronJobs", refresh);
    return () => unregisterRefresh("cronJobs");
  }, [refresh]);

  const addJob = async (create: CronJobCreate) => {
    const res = await authFetch(`${API_BASE}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(create),
    });
    await parseJsonResponse(res, "定时任务");
    await refresh();
  };

  const updateJob = async (id: string, patch: CronJobPatch) => {
    const res = await authFetch(`${API_BASE}/jobs/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    await parseJsonResponse(res, "定时任务");
    await refresh();
  };

  const deleteJob = async (id: string) => {
    const res = await authFetch(`${API_BASE}/jobs/${id}`, { method: "DELETE" });
    await parseJsonResponse(res, "定时任务");
    await refresh();
  };

  const runJob = async (id: string) => {
    const res = await authFetch(`${API_BASE}/jobs/${id}/run`, { method: "POST" });
    await parseJsonResponse(res, "定时任务");
    await refresh();
  };

  return { jobs, loading, error, refresh, addJob, updateJob, deleteJob, runJob };
}

export function useRunHistory(jobId: string | null) {
  const [entries, setEntries] = useState<CronRunLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId) {
      setEntries([]);
      setError(null);
      return;
    }

    setLoading(true);
    const limit = 200;
    authFetch(`${API_BASE}/jobs/${jobId}/runs?limit=${limit}`)
      .then((res) => parseJsonResponse<{ entries?: CronRunLogEntry[] }>(res, "定时任务"))
      .then((data) => {
        setEntries(data.entries || []);
        setError(null);
      })
      .catch((err) => {
        setEntries([]);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }, [jobId]);

  return { entries, loading, error };
}

export function useDingtalkSessions() {
  const [sessions, setSessions] = useState<DingtalkSessionSummary[]>(cachedDingtalkSessions ?? []);
  const [loading, setLoading] = useState(cachedDingtalkSessions === null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await authFetch(`${DINGTALK_API_BASE}/sessions`);
      const data = await parseJsonResponse<{ sessions?: DingtalkSessionSummary[] }>(
        res,
        "钉钉会话",
      );
      const list = data.sessions || [];
      cachedDingtalkSessions = list;
      setSessions(list);
      setError(null);
    } catch (err) {
      setSessions([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (cachedDingtalkSessions) { setLoading(false); return; }
    void refresh();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { sessions, loading, error, refresh };
}

export function useModelList() {
  const [modelList, setModelList] = useState<ModelList | null>(cachedModelList);

  const refreshModels = useCallback(async () => {
    const res = await authFetch("/api/models");
    const data = res.ok ? await res.json() : null;
    if (data) {
      cachedModelList = data;
      setModelList(data);
    }
  }, []);

  useEffect(() => {
    if (!cachedModelList) void refreshModels();
  }, [refreshModels]);

  useEffect(() => {
    registerRefresh("cron-models", refreshModels);
    return () => unregisterRefresh("cron-models");
  }, [refreshModels]);

  return modelList;
}
