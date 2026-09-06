import { useCallback, useEffect, useId, useRef, useState } from "react";
import { authFetch } from "@/lib/authFetch";
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
const FOREGROUND_STALE_MS = 30_000;


function sortByNextRun(jobs: CronJob[]): CronJob[] {
  return [...jobs].sort((a, b) => (a.state.nextRunAtMs ?? Infinity) - (b.state.nextRunAtMs ?? Infinity));
}

async function fetchCronStatus(): Promise<CronServiceStatus> {
  const res = await authFetch(`${API_BASE}/status`);
  return parseJsonResponse<CronServiceStatus>(res, "定时任务");
}

async function fetchCronJobs(): Promise<CronJob[]> {
  const res = await authFetch(`${API_BASE}/jobs?includeDisabled=true`);
  const data = await parseJsonResponse<{ jobs?: CronJob[] }>(res, "定时任务");
  return sortByNextRun(data.jobs || []);
}

async function fetchDingtalkSessions(): Promise<DingtalkSessionSummary[]> {
  const res = await authFetch(`${DINGTALK_API_BASE}/sessions`);
  const data = await parseJsonResponse<{ sessions?: DingtalkSessionSummary[] }>(res, "钉钉会话");
  return data.sessions || [];
}

async function fetchModelList(): Promise<ModelList | null> {
  const res = await authFetch("/api/models");
  return res.ok ? await res.json() as ModelList : null;
}

/**
 * Cron 数据的实例级请求管理：挂载和页面重新激活时刷新，同一实例的并发刷新复用请求。
 * requestId 同时保证 StrictMode 重挂载等场景中的旧请求不能覆盖新结果。
 */
function useCronResource<T>(
  load: () => Promise<T>,
  initialValue: T,
  refreshKey: "cronStatus" | "cronJobs" | "cronDingtalkSessions" | "cronModels",
  active = true,
) {
  const [value, setValue] = useState<T>(initialValue);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const latestRequestIdRef = useRef(0);
  const instanceId = useId();
  const refreshBusKey = `${refreshKey}:${instanceId}`;

  const refresh = useCallback((): Promise<void> => {
    if (!mountedRef.current) return Promise.resolve();
    if (inFlightRef.current) return inFlightRef.current;

    const requestId = ++latestRequestIdRef.current;
    const request = (async () => {
      try {
        const data = await load();
        if (!mountedRef.current || requestId !== latestRequestIdRef.current) return;
        setValue(data);
        setError(null);
      } catch (err) {
        if (!mountedRef.current || requestId !== latestRequestIdRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (mountedRef.current && requestId === latestRequestIdRef.current) {
          setLoading(false);
        }
      }
    })();

    inFlightRef.current = request;
    const clearInFlight = () => {
      if (inFlightRef.current === request) inFlightRef.current = null;
    };
    void request.then(clearInFlight, clearInFlight);
    return request;
  }, [load]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      latestRequestIdRef.current += 1;
      inFlightRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    void refresh();
    let hiddenAt: number | null = null;
    const refreshWhenStale = () => {
      if (document.visibilityState !== "visible") {
        hiddenAt = Date.now();
        return;
      }
      if (hiddenAt !== null && Date.now() - hiddenAt >= FOREGROUND_STALE_MS) void refresh();
      hiddenAt = null;
    };
    document.addEventListener("visibilitychange", refreshWhenStale);
    return () => document.removeEventListener("visibilitychange", refreshWhenStale);
  }, [active, refresh]);

  useEffect(() => {
    if (!active) return;
    registerRefresh(refreshBusKey, refresh);
    return () => unregisterRefresh(refreshBusKey);
  }, [active, refresh, refreshBusKey]);

  const refreshLatest = useCallback(async (): Promise<void> => {
    const pending = inFlightRef.current;
    if (pending) await pending;
    await refresh();
  }, [refresh]);

  return { value, loading, error, refresh, refreshLatest };
}

export function useCronStatus(active = true) {
  const { value: status, loading, error, refresh, refreshLatest } = useCronResource<CronServiceStatus | null>(
    fetchCronStatus,
    null,
    "cronStatus",
    active,
  );
  return { status, loading, error, refresh, refreshLatest };
}

export function useCronJobs(active = true) {
  const { value: jobs, loading, error, refresh, refreshLatest } = useCronResource<CronJob[]>(
    fetchCronJobs,
    [],
    "cronJobs",
    active,
  );

  const addJob = async (create: CronJobCreate) => {
    const res = await authFetch(`${API_BASE}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(create),
    });
    await parseJsonResponse(res, "定时任务");
    await refreshLatest();
  };

  const updateJob = async (id: string, patch: CronJobPatch) => {
    const res = await authFetch(`${API_BASE}/jobs/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    await parseJsonResponse(res, "定时任务");
    await refreshLatest();
  };

  const deleteJob = async (id: string) => {
    const res = await authFetch(`${API_BASE}/jobs/${id}`, { method: "DELETE" });
    await parseJsonResponse(res, "定时任务");
    await refreshLatest();
  };

  const runJob = async (id: string) => {
    const requestId = crypto.randomUUID();
    const res = await authFetch(`${API_BASE}/jobs/${id}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": requestId },
      body: JSON.stringify({ requestId }),
    });
    await parseJsonResponse(res, "定时任务");
    await refreshLatest();
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

    let cancelled = false;
    setLoading(true);
    const limit = 200;
    authFetch(`${API_BASE}/jobs/${jobId}/runs?limit=${limit}`)
      .then((res) => parseJsonResponse<{ entries?: CronRunLogEntry[] }>(res, "定时任务"))
      .then((data) => {
        if (cancelled) return;
        setEntries(data.entries || []);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setEntries([]);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [jobId]);

  return { entries, loading, error };
}

export function useDingtalkSessions(active = true) {
  const { value: sessions, loading, error, refresh } = useCronResource<DingtalkSessionSummary[]>(
    fetchDingtalkSessions,
    [],
    "cronDingtalkSessions",
    active,
  );
  return { sessions, loading, error, refresh };
}

export function useModelList(active = true) {
  const { value: modelList } = useCronResource<ModelList | null>(
    fetchModelList,
    null,
    "cronModels",
    active,
  );
  return modelList;
}
