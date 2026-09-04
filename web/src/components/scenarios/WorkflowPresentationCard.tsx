import { MousePointerClick } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CAPABILITY_SURFACE_HOVER } from "@/components/CapabilityCenter/CatalogUi";
import { cn } from "@/lib/utils";
import { getReplayScript } from "./replay/registry";
import { isHookScenario } from "./workflowUi";
import type { WorkflowScenarioCardProps } from "./WorkflowScenarioCard";

/** P0 引导演示入口：只讲业务结果和体验方式，不把完整 Workflow 规格塞回首屏。 */
export function WorkflowPresentationCard({
  scenario,
  onPrimaryAction,
}: Pick<WorkflowScenarioCardProps, "scenario" | "onPrimaryAction">) {
  // 会话式回放剧本优先：它的步数才是观众实际要按几次。
  const replayScript = getReplayScript(scenario.id, scenario);
  const chapterCount = replayScript?.steps.length ?? 0;
  return (
    <article
      className={cn(
        "flex flex-col overflow-hidden rounded-xl bg-brand-50/40 p-5 ring-1 ring-brand-100 dark:bg-brand-900/20 dark:ring-brand-800",
        CAPABILITY_SURFACE_HOVER,
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge className="gap-1 bg-brand-50 font-normal text-brand-700 hover:bg-brand-50">
          <MousePointerClick className="size-3" />
          {isHookScenario(scenario)
            ? scenario.triggerBadge
            : (!replayScript || replayScript.mode === "hero")
              ? "完整业务闭环"
              : "快速体验"}
        </Badge>
        <Badge variant="outline" className="font-normal">业务回放</Badge>
      </div>
      <h3 className="mt-4 text-lg font-semibold leading-snug text-foreground">{scenario.title}</h3>
      <p className="mt-2 line-clamp-3 text-sm leading-6 text-muted-foreground">{scenario.value}</p>
      <div className="mt-4 text-xs font-medium text-brand-700">
        {chapterCount > 0 ? `${chapterCount} 个业务步骤 · 右侧系统状态同步变化` : "一步一步看它怎么办完 · 右侧系统状态同步变化"}
      </div>
      <div className="mt-auto flex justify-end pt-5">
        <Button type="button" size="sm" onClick={() => onPrimaryAction("presentation", scenario)}>
          看演示
        </Button>
      </div>
    </article>
  );
}
