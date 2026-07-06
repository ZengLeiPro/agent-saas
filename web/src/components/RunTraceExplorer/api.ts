import { authFetch } from "@/lib/authFetch";
import type { EfficiencyReport, RecentRunsResponse, RunEventsResponse } from "./types";

const BASE = "/api/admin/runtime/trace";

async function getJson<T>(path: string): Promise<T> {
  const res = await authFetch(path);
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      // ignore
    }
    if (res.status === 404) throw new Error("运行记录不存在或已过期");
    throw new Error(`${path} → ${res.status} ${detail.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export interface RecentRunsQuery {
  /** 逗号分隔状态（白名单见 types.RUN_STATUSES）；undefined = 全部 */
  status?: string;
  hours?: number;
  limit?: number;
  tenantId?: string;
}

export const runTraceApi = {
  recentRuns: (q: RecentRunsQuery = {}): Promise<RecentRunsResponse> => {
    const sp = new URLSearchParams();
    if (q.status) sp.set("status", q.status);
    if (q.hours != null) sp.set("hours", String(q.hours));
    if (q.limit != null) sp.set("limit", String(q.limit));
    if (q.tenantId) sp.set("tenantId", q.tenantId);
    const s = sp.toString();
    return getJson<RecentRunsResponse>(`${BASE}/recent-runs${s ? `?${s}` : ""}`);
  },

  runEvents: (runId: string, opts: { maxContentLength?: number } = {}): Promise<RunEventsResponse> => {
    const sp = new URLSearchParams();
    if (opts.maxContentLength != null) sp.set("maxContentLength", String(opts.maxContentLength));
    const s = sp.toString();
    return getJson<RunEventsResponse>(`${BASE}/runs/${encodeURIComponent(runId)}/events${s ? `?${s}` : ""}`);
  },

  efficiency: (q: { days?: number; tenantId?: string } = {}): Promise<EfficiencyReport> => {
    const sp = new URLSearchParams();
    if (q.days != null) sp.set("days", String(q.days));
    if (q.tenantId) sp.set("tenantId", q.tenantId);
    const s = sp.toString();
    return getJson<EfficiencyReport>(`${BASE}/efficiency${s ? `?${s}` : ""}`);
  },
};
