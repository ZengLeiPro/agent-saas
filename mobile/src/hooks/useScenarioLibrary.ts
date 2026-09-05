/**
 * 场景库（legacy v1/v2）—— 对齐 Web `useScenarioLibrary` 的 legacy 分支。
 *
 * 契约同源：`GET /api/scenarios` → `ScenarioLibraryResponse`。
 *
 * 与 Web 的差异（有意）：原生端暂无能力中心，v3 工作流目录（`/api/scenarios/v3`）
 * 的 `intent=view/connect/presentation` 在原生端没有落地页，因此这里只读 legacy
 * 目录；`libraryVersion === 'v3'` 的租户在原生端等价于 Web 的 legacy 回退分支。
 *
 * 缓存：module 级缓存 + inflight 去重，多个空态组件同时挂载只打一次接口。
 */
import { useCallback, useEffect, useState } from 'react';
import type { ScenarioLibraryResponse } from '@agent/shared';
import { authFetch } from '@agent/shared';

let cachedLibrary: ScenarioLibraryResponse | null = null;
let inflight: Promise<ScenarioLibraryResponse> | null = null;

async function fetchScenarioLibrary(force = false): Promise<ScenarioLibraryResponse> {
  if (force) cachedLibrary = null;
  if (!force && cachedLibrary) return cachedLibrary;
  if (!inflight) {
    inflight = (async () => {
      const res = await authFetch('/api/scenarios');
      if (!res.ok) throw new Error(`加载任务模板失败 (${res.status})`);
      const data = (await res.json()) as ScenarioLibraryResponse;
      cachedLibrary = data;
      return data;
    })().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/** 测试与登录切换用：清掉 module 级缓存。 */
export function invalidateScenarioLibrary(): void {
  cachedLibrary = null;
  inflight = null;
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

  const load = useCallback((force: boolean) => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchScenarioLibrary(force)
      .then((next) => {
        if (!cancelled) setLibrary(next);
      })
      .catch(() => {
        if (!cancelled) {
          setLibrary(null);
          setError('任务模板暂时无法加载');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => load(false), [load]);

  const reload = useCallback(() => {
    invalidateScenarioLibrary();
    load(true);
  }, [load]);

  return { library, loading, error, reload };
}
