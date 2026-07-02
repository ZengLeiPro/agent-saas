/**
 * 场景库数据 hook
 *
 * 通过 GET /api/scenarios 拉取预置场景卡片库，带模块级缓存：
 * 场景库是静态数据，页面生命周期内拉一次即可（整页视图与空会话推荐位共用同一份缓存）。
 */
import { useCallback, useEffect, useState } from "react";
import { authFetch } from "@/lib/authFetch";
import type { ScenarioItem, ScenarioLibraryResponse } from "@agent/shared";

// 模块级缓存：多处消费（场景库整页 / 空会话推荐位）共享，避免重复请求
let cachedLibrary: ScenarioLibraryResponse | null = null;
let inflight: Promise<ScenarioLibraryResponse> | null = null;

async function fetchScenarioLibrary(): Promise<ScenarioLibraryResponse> {
  if (cachedLibrary) return cachedLibrary;
  if (!inflight) {
    inflight = (async () => {
      const res = await authFetch("/api/scenarios");
      if (!res.ok) {
        throw new Error(`加载场景库失败 (${res.status})`);
      }
      const data = (await res.json()) as ScenarioLibraryResponse;
      cachedLibrary = data;
      return data;
    })().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

export interface UseScenarioLibraryResult {
  library: ScenarioLibraryResponse | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useScenarioLibrary(): UseScenarioLibraryResult {
  const [library, setLibrary] = useState<ScenarioLibraryResponse | null>(cachedLibrary);
  const [loading, setLoading] = useState(!cachedLibrary);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchScenarioLibrary()
      .then((data) => {
        if (cancelled) return;
        setLibrary(data);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err instanceof Error ? err.message : err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => load(), [load]);

  return { library, loading, error, reload: load };
}

/**
 * 空会话推荐位精选场景 id（跨岗位、依赖轻、卖点直白）。
 * 固定精选保证每次渲染稳定不跳变；若某 id 未上架则按 id 字典序跨岗位稳定补齐。
 */
const CURATED_RECOMMEND_IDS = [
  "boss-competitor-daily", // 老板：竞品动态晨报
  "sales-customer-profile", // 销售：客户背景调查建档
  "hr-meeting-minutes", // 人事行政：会议纪要与待办分发
];

/** 从已上架场景中稳定选取 count 张推荐卡（禁止随机，避免渲染间跳变） */
export function pickRecommendedScenarios(
  scenarios: ScenarioItem[],
  count = 3,
): ScenarioItem[] {
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const picked: ScenarioItem[] = [];
  for (const id of CURATED_RECOMMEND_IDS) {
    const item = byId.get(id);
    if (item) picked.push(item);
    if (picked.length >= count) return picked.slice(0, count);
  }
  // 兜底：按 id 字典序稳定遍历，优先补齐未覆盖岗位
  const rest = [...scenarios].sort((a, b) => a.id.localeCompare(b.id));
  const usedRoles = new Set(picked.map((s) => s.role));
  for (const item of rest) {
    if (picked.length >= count) break;
    if (picked.includes(item) || usedRoles.has(item.role)) continue;
    picked.push(item);
    usedRoles.add(item.role);
  }
  // 岗位数不足时放宽岗位去重继续补齐
  for (const item of rest) {
    if (picked.length >= count) break;
    if (!picked.includes(item)) picked.push(item);
  }
  return picked;
}
