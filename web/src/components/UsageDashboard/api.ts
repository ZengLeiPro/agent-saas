import { authFetch } from "@/lib/authFetch";
import type {
  OverviewStats,
  ByUserResp,
  ByModelResp,
  ByChannelResp,
  TrendResp,
  DataRangeResp,
  RangePreset,
  ModelFamily,
} from "./types";

const BASE = "/api/admin/usage";

interface RangeQuery {
  range?: Exclude<RangePreset, "custom">;
  from?: string;
  to?: string;
  username?: string;
  tenantId?: string;
  /** 模型家族筛选；undefined = 全部 */
  family?: ModelFamily;
}

function buildQuery(q: RangeQuery): string {
  const sp = new URLSearchParams();
  if (q.range) sp.set("range", q.range);
  if (q.from) sp.set("from", q.from);
  if (q.to) sp.set("to", q.to);
  if (q.username) sp.set("username", q.username);
  if (q.tenantId) sp.set("tenantId", q.tenantId);
  if (q.family) sp.set("family", q.family);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

async function getJson<T>(path: string): Promise<T> {
  const res = await authFetch(path);
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      // ignore
    }
    throw new Error(`${path} → ${res.status} ${detail.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export const usageApi = {
  overview: (q: RangeQuery) => getJson<OverviewStats>(`${BASE}/overview${buildQuery(q)}`),
  byUser: (q: RangeQuery) => getJson<ByUserResp>(`${BASE}/by-user${buildQuery(q)}`),
  byModel: (q: RangeQuery) => getJson<ByModelResp>(`${BASE}/by-model${buildQuery(q)}`),
  byChannel: (q: RangeQuery) => getJson<ByChannelResp>(`${BASE}/by-channel${buildQuery(q)}`),
  /** 不传 username → 全公司日合计；传 username → 该用户日序列 */
  trend: (q: RangeQuery) => getJson<TrendResp>(`${BASE}/trend${buildQuery(q)}`),
  dataRange: (q: Pick<RangeQuery, "tenantId"> = {}) => getJson<DataRangeResp>(`${BASE}/data-range${buildQuery(q)}`),
  /** 触发后台全量重扫（fire-and-forget，202 即刻返回） */
  rebuild: async (): Promise<{ started: boolean; conflict?: boolean }> => {
    const res = await authFetch(`${BASE}/rebuild`, { method: "POST" });
    if (res.status === 409) return { started: false, conflict: true };
    if (!res.ok) throw new Error(`POST /rebuild → ${res.status}`);
    return (await res.json()) as { started: boolean };
  },
};
