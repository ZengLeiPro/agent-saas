/**
 * 场景直达 deep link：消费 URL 上的 ?scenario=<id> 参数（官网场景页 CTA →
 * 注册成功落地 / 销售发的带场景注册链接），把该场景的起手指令预填进输入框。
 *
 * 约定：
 * - 参数只消费一次（module 级 flag + 消费即从 URL 清除，防刷新/StrictMode 重复预填）；
 * - id 匹配不到场景库时静默放弃（官网与产品库 id 同源，正常不会发生）；
 * - 挂在 Desktop/Mobile 两个 layout（互斥渲染），行为一致。
 */
import { useEffect, useRef } from "react";
import {
  buildScenarioPrompt,
  resolveScenarioSlug,
  sanitizeScenario,
  type ScenarioItem,
} from "@agent/shared";
import { useScenarioLibrary } from "./useScenarioLibrary";

let consumedThisPageLoad = false;

/** 测试用：重置 module 级消费标记 */
export function resetScenarioDeepLinkForTest(): void {
  consumedThisPageLoad = false;
}

export function useScenarioDeepLink(
  onPrefill: (prompt: string, scenario?: ScenarioItem) => void,
  onOpenWorkflow?: () => void,
): void {
  const { library, workflowLibrary } = useScenarioLibrary();
  const onPrefillRef = useRef(onPrefill);
  onPrefillRef.current = onPrefill;
  const onOpenWorkflowRef = useRef(onOpenWorkflow);
  onOpenWorkflowRef.current = onOpenWorkflow;

  useEffect(() => {
    if (consumedThisPageLoad || (!library && !workflowLibrary)) return;
    const params = new URLSearchParams(window.location.search);
    const id = params.get("workflow") ?? params.get("scenario");
    if (!id) {
      consumedThisPageLoad = true;
      return;
    }
    if (workflowLibrary) {
      const resolved = resolveScenarioSlug(workflowLibrary, id);
      if (!resolved) return;
      consumedThisPageLoad = true;
      const intent = params.get("intent") ?? "view";
      if (resolved.resolution === "deferred") {
        params.delete("scenario");
        params.set("workflow", resolved.resolvedFromLegacySlug);
        params.set("intent", "view");
        onOpenWorkflowRef.current?.();
        window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
        return;
      }
      if (intent === "run" && resolved.scenario.launch.startMode === "chat") {
        params.delete("workflow");
        params.delete("scenario");
        params.delete("intent");
        const qs = params.toString();
        window.history.replaceState(null, "", qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
        onPrefillRef.current(resolved.scenario.launch.starterMessage);
        return;
      }
      params.delete("scenario");
      params.set("workflow", resolved.scenario.id);
      params.set("intent", intent);
      if (resolved.skinId && !params.has("skinId")) params.set("skinId", resolved.skinId);
      if (resolved.roleViewId && !params.has("roleViewId")) params.set("roleViewId", resolved.roleViewId);
      if (resolved.roleId && !params.has("roleId")) params.set("roleId", resolved.roleId);
      // 布局切换会改 pathname 并清空 query，因此先切到能力中心，再写回 canonical 参数。
      onOpenWorkflowRef.current?.();
      window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
      return;
    }
    if (!library || params.has("workflow")) return;
    // Legacy：先清参数再预填，无论命中与否都只消费一次。
    consumedThisPageLoad = true;
    params.delete("scenario");
    const qs = params.toString();
    window.history.replaceState(
      null,
      "",
      qs ? `${window.location.pathname}?${qs}` : window.location.pathname,
    );
    const matched = library.scenarios.find((s) => s.id === id);
    if (!matched) return;
    const safe = sanitizeScenario({ ...matched }).scenario as ScenarioItem;
    onPrefillRef.current(buildScenarioPrompt(safe), safe);
  }, [library, workflowLibrary]);
}
