/**
 * AI 同事工作流目录 hook。
 *
 * V3 仅在服务端 config 明确切到 v3 时启用，并在浏览器端再次用 shared schema
 * 做 runtime parse。V3 响应不可用时回退 legacy，但会暴露 fallbackReason，避免
 * 把“旧目录仍能显示”误报为 V3 上线成功。
 */
import { useCallback, useEffect, useState } from "react";
import { authFetch } from "@/lib/authFetch";
import {
  workflowLibraryPublicV3Schema,
  type CatalogScenarioPublic,
  type ScenarioItem,
  type ScenarioLibraryResponse,
  type WorkflowLibraryPublicV3,
} from "@agent/shared";
import { useRoleKitConfig } from "./useRoleKitConfig";
import { sortWorkflowScenarios } from "./workflowUi";

let cachedLegacy: ScenarioLibraryResponse | null = null;
let cachedV3: WorkflowLibraryPublicV3 | null = null;
let legacyInflight: Promise<ScenarioLibraryResponse> | null = null;
let v3Inflight: Promise<WorkflowLibraryPublicV3> | null = null;

async function fetchLegacyLibrary(force = false): Promise<ScenarioLibraryResponse> {
  if (force) cachedLegacy = null;
  if (!force && cachedLegacy) return cachedLegacy;
  if (!legacyInflight) {
    legacyInflight = (async () => {
      const res = await authFetch("/api/scenarios");
      if (!res.ok) throw new Error(`加载兼容任务模板失败 (${res.status})`);
      const data = (await res.json()) as ScenarioLibraryResponse;
      cachedLegacy = data;
      return data;
    })().finally(() => { legacyInflight = null; });
  }
  return legacyInflight;
}

async function fetchV3Library(force = false): Promise<WorkflowLibraryPublicV3> {
  if (force) cachedV3 = null;
  if (!force && cachedV3) return cachedV3;
  if (!v3Inflight) {
    v3Inflight = (async () => {
      const res = await authFetch("/api/scenarios/v3");
      if (!res.ok) throw new Error(`加载 AI 同事工作流失败 (${res.status})`);
      const parsed = workflowLibraryPublicV3Schema.safeParse(await res.json());
      if (!parsed.success) throw new Error("AI 同事工作流响应未通过安全契约校验");
      cachedV3 = parsed.data;
      return parsed.data;
    })().finally(() => { v3Inflight = null; });
  }
  return v3Inflight;
}

export type ScenarioLibraryMode = "v3" | "legacy" | "legacy-fallback";

export interface UseScenarioLibraryResult {
  library: ScenarioLibraryResponse | null;
  workflowLibrary: WorkflowLibraryPublicV3 | null;
  mode: ScenarioLibraryMode;
  fallbackReason: string | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useScenarioLibrary(): UseScenarioLibraryResult {
  const { config, loading: configLoading } = useRoleKitConfig();
  const wantsV3 = config.libraryVersion === "v3";
  const [state, setState] = useState<Omit<UseScenarioLibraryResult, "reload">>({
    library: wantsV3 ? null : cachedLegacy,
    workflowLibrary: wantsV3 ? cachedV3 : null,
    mode: wantsV3 ? "v3" : "legacy",
    fallbackReason: null,
    loading: true,
    error: null,
  });

  const load = useCallback((force = false) => {
    let cancelled = false;
    if (configLoading) return () => { cancelled = true; };
    setState((previous) => ({ ...previous, loading: true, error: null, fallbackReason: null }));
    const request = wantsV3
      ? fetchV3Library(force)
          .then((workflowLibrary) => ({
            library: null,
            workflowLibrary,
            mode: "v3" as const,
            fallbackReason: null,
          }))
          .catch(async () => ({
            library: await fetchLegacyLibrary(force),
            workflowLibrary: null,
            mode: "legacy-fallback" as const,
            fallbackReason: "当前显示兼容目录",
          }))
      : fetchLegacyLibrary(force).then((library) => ({
          library,
          workflowLibrary: null,
          mode: "legacy" as const,
          fallbackReason: null,
        }));

    request
      .then((next) => {
        if (!cancelled) setState({ ...next, loading: false, error: null });
      })
      .catch(() => {
        if (!cancelled) {
          setState({
            library: null,
            workflowLibrary: null,
            mode: wantsV3 ? "legacy-fallback" : "legacy",
            fallbackReason: wantsV3 ? "当前显示兼容目录" : null,
            loading: false,
            error: "Agent 开小差了，请发送「继续」",
          });
        }
      });
    return () => { cancelled = true; };
  }, [configLoading, wantsV3]);

  useEffect(() => load(false), [load]);

  return {
    ...state,
    reload: () => {
      cachedLegacy = null;
      cachedV3 = null;
      load(true);
    },
  };
}

export function matchRoleIdByPosition(
  roles: readonly { id: string; name: string }[],
  position?: string | null,
): string | null {
  const p = position?.trim();
  if (!p) return null;
  for (const role of roles) {
    const segments = role.name.split("/").map((s) => s.trim()).filter(Boolean);
    if (segments.some((segment) => p.includes(segment) || (p.length >= 2 && segment.includes(p)))) {
      return role.id;
    }
  }
  return null;
}

const CURATED_RECOMMEND_IDS = [
  "boss-competitor-daily",
  "sales-customer-profile",
  "hr-meeting-minutes",
];

export function pickRecommendedScenarios(
  scenarios: ScenarioItem[],
  count = 3,
  preferredRoleId?: string | null,
): ScenarioItem[] {
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const picked: ScenarioItem[] = [];
  if (preferredRoleId) {
    for (const item of scenarios) {
      if (picked.length >= Math.min(2, count)) break;
      if (item.role === preferredRoleId) picked.push(item);
    }
  }
  for (const id of CURATED_RECOMMEND_IDS) {
    const item = byId.get(id);
    if (item && !picked.includes(item)) picked.push(item);
    if (picked.length >= count) return picked.slice(0, count);
  }
  const rest = [...scenarios].sort((left, right) => left.id.localeCompare(right.id));
  const usedRoles = new Set(picked.map((item) => item.role));
  for (const item of rest) {
    if (picked.length >= count) break;
    if (picked.includes(item) || usedRoles.has(item.role)) continue;
    picked.push(item);
    usedRoles.add(item.role);
  }
  for (const item of rest) {
    if (picked.length >= count) break;
    if (!picked.includes(item)) picked.push(item);
  }
  return picked;
}

/** V3 推荐顺序完全来自产品源声明顺序，不在 Web 写死旧 ID。 */
export function pickRecommendedWorkflowScenarios(
  scenarios: readonly CatalogScenarioPublic[],
  count = 3,
  preferredRoleId?: string | null,
): CatalogScenarioPublic[] {
  const sorted = sortWorkflowScenarios(scenarios);
  const preferred = preferredRoleId
    ? sorted.filter((scenario) => scenario.roleIds.includes(preferredRoleId)).slice(0, Math.min(2, count))
    : [];
  const picked = [...preferred];
  for (const scenario of sorted) {
    if (picked.length >= count) break;
    if (!picked.some((item) => item.id === scenario.id)) picked.push(scenario);
  }
  return picked;
}
