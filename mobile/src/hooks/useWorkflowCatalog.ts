/**
 * AI 同事工作流目录 —— 对齐 Web `web/src/components/scenarios/useScenarioLibrary.ts`。
 *
 * 与既有 `useScenarioLibrary`（只读 legacy `GET /api/scenarios`，供空会话推荐位使用）
 * 的分工：本 hook 供能力中心「工作流」Tab 使用，按 `useRoleKitConfig().libraryVersion`
 * 决定读 v3 还是 legacy，v3 响应在客户端再过一次 shared schema，失败回落 legacy
 * 并暴露 `fallbackReason`（不把「旧目录仍能显示」误报成 V3 上线成功）。
 *
 * 版本判定与回落语义抽在 `lib/capabilities/scenarioLibraryMode.ts`（纯函数，有单测）。
 */
import { useCallback, useEffect, useState } from 'react';
import type { ScenarioLibraryResponse, WorkflowLibraryPublicV3 } from '@agent/shared';
import { authFetch, workflowLibraryPublicV3Schema } from '@agent/shared';
import { useRoleKitConfig } from './useRoleKitConfig';
import {
  resolveScenarioLibraryOutcome,
  scenarioLibraryEndpoint,
  wantsWorkflowLibraryV3,
  type ScenarioLibraryMode,
} from '../lib/capabilities/scenarioLibraryMode';

let cachedLegacy: ScenarioLibraryResponse | null = null;
let cachedV3: WorkflowLibraryPublicV3 | null = null;
let legacyInflight: Promise<ScenarioLibraryResponse> | null = null;
let v3Inflight: Promise<WorkflowLibraryPublicV3> | null = null;

async function fetchLegacy(force: boolean): Promise<ScenarioLibraryResponse> {
  if (force) cachedLegacy = null;
  if (!force && cachedLegacy) return cachedLegacy;
  if (!legacyInflight) {
    legacyInflight = (async () => {
      const res = await authFetch(scenarioLibraryEndpoint(false));
      if (!res.ok) throw new Error(`加载兼容任务模板失败 (${res.status})`);
      const data = (await res.json()) as ScenarioLibraryResponse;
      cachedLegacy = data;
      return data;
    })().finally(() => {
      legacyInflight = null;
    });
  }
  return legacyInflight;
}

async function fetchV3(force: boolean): Promise<WorkflowLibraryPublicV3> {
  if (force) cachedV3 = null;
  if (!force && cachedV3) return cachedV3;
  if (!v3Inflight) {
    v3Inflight = (async () => {
      const res = await authFetch(scenarioLibraryEndpoint(true));
      if (!res.ok) throw new Error(`加载 AI 同事工作流失败 (${res.status})`);
      const parsed = workflowLibraryPublicV3Schema.safeParse(await res.json());
      if (!parsed.success) throw new Error('AI 同事工作流响应未通过安全契约校验');
      cachedV3 = parsed.data;
      return parsed.data;
    })().finally(() => {
      v3Inflight = null;
    });
  }
  return v3Inflight;
}

/** 测试与登录切换用：清掉 module 级缓存。 */
export function invalidateWorkflowCatalog(): void {
  cachedLegacy = null;
  cachedV3 = null;
  legacyInflight = null;
  v3Inflight = null;
}

export interface UseWorkflowCatalogResult {
  workflowLibrary: WorkflowLibraryPublicV3 | null;
  library: ScenarioLibraryResponse | null;
  mode: ScenarioLibraryMode;
  fallbackReason: string | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useWorkflowCatalog(): UseWorkflowCatalogResult {
  const { config, loading: configLoading } = useRoleKitConfig();
  const wantsV3 = wantsWorkflowLibraryV3(config.libraryVersion);
  const [state, setState] = useState<Omit<UseWorkflowCatalogResult, 'reload'>>({
    workflowLibrary: null,
    library: null,
    mode: 'legacy',
    fallbackReason: null,
    loading: true,
    error: null,
  });

  const load = useCallback(
    (force: boolean) => {
      let cancelled = false;
      if (configLoading)
        return () => {
          cancelled = true;
        };
      setState((previous) => ({ ...previous, loading: true, error: null }));
      const request = wantsV3
        ? fetchV3(force)
            .then((workflowLibrary) => ({ workflowLibrary, library: null, v3Loaded: true }))
            .catch(async () => ({
              workflowLibrary: null,
              library: await fetchLegacy(force),
              v3Loaded: false,
            }))
        : fetchLegacy(force).then((library) => ({
            workflowLibrary: null,
            library,
            v3Loaded: false,
          }));

      request
        .then((next) => {
          if (cancelled) return;
          const outcome = resolveScenarioLibraryOutcome({ wantsV3, v3Loaded: next.v3Loaded });
          setState({
            workflowLibrary: next.workflowLibrary,
            library: next.library,
            ...outcome,
            loading: false,
            error: null,
          });
        })
        .catch(() => {
          if (cancelled) return;
          const outcome = resolveScenarioLibraryOutcome({ wantsV3, v3Loaded: false });
          setState({
            workflowLibrary: null,
            library: null,
            ...outcome,
            loading: false,
            error: '工作流目录暂时无法加载',
          });
        });
      return () => {
        cancelled = true;
      };
    },
    [configLoading, wantsV3],
  );

  useEffect(() => load(false), [load]);

  const reload = useCallback(() => {
    invalidateWorkflowCatalog();
    load(true);
  }, [load]);

  return { ...state, reload };
}
