/**
 * 空会话推荐位
 *
 * 新会话空白态（当前会话没有任何消息）时，在消息区展示 3 张跨岗位精选场景卡
 * + 「查看全部场景」入口。点击卡片 = 把起手 prompt 预填进当前输入框
 * （当前会话本来就是空的，无需再新建会话），用户可编辑后自行发送。
 *
 * 仅桌面端接入（由 DesktopLayout 传入 MessageList 的 emptySlot），移动端不挂。
 */
import { ArrowRight } from "lucide-react";
import { buildScenarioPrompt } from "@agent/shared";
import type { CatalogScenarioPublic, ScenarioItem } from "@agent/shared";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { ScenarioCard } from "./ScenarioCard";
import { hasReplayScript } from "./replay/registry";
import {
  matchRoleIdByPosition,
  pickRecommendedScenarios,
  pickRecommendedWorkflowScenarios,
  useScenarioLibrary,
} from "./useScenarioLibrary";
import { matchIndustry, useIndustryFilter } from "./useIndustryFilter";

interface EmptySessionScenariosProps {
  /** 点推荐卡：入参为填充好槽位示例值的起手 prompt（上层直接预填当前输入框） */
  onTryScenario: (prompt: string, scenario: ScenarioItem) => void;
  onStartWorkflow?: (starterMessage: string, scenario: CatalogScenarioPublic) => void;
  /** 「查看全部场景」：跳转到场景库整页 */
  onViewAll: () => void;
}

export function EmptySessionScenarios({ onTryScenario, onStartWorkflow, onViewAll }: EmptySessionScenariosProps) {
  const { library, workflowLibrary, loading, error } = useScenarioLibrary();
  const { user } = useAuth();
  const { activeIndustry } = useIndustryFilter();

  // 加载中/失败时保持空白态安静，不打扰用户（推荐位是锦上添花，不是硬依赖）
  if (loading || error) return null;

  if (workflowLibrary) {
    const pool = activeIndustry === "all"
      ? workflowLibrary.scenarios
      : workflowLibrary.scenarios.filter((scenario) => scenario.industryTags.includes(activeIndustry));
    const preferredRoleId = matchRoleIdByPosition(workflowLibrary.roles, user?.position);
    const recommended = pickRecommendedWorkflowScenarios(pool.length > 0 ? pool : workflowLibrary.scenarios, 3, preferredRoleId);
    const openCatalog = (scenario: CatalogScenarioPublic, intent?: "presentation") => {
      onViewAll();
      const params = new URLSearchParams(window.location.search);
      params.delete("scenario");
      params.set("workflow", scenario.id);
      params.set("intent", intent ?? (scenario.launch.startMode === "connector" ? "connect" : "view"));
      window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
    };
    return (
      <div className="mx-auto w-full max-w-2xl pt-[12vh]">
        <div className="mb-3 text-center text-sm text-muted-foreground">从业务结果开始：能直接体验的现在做，需要接入的先看清边界</div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {recommended.map((scenario) => {
            const canReplay = hasReplayScript(scenario);
            const openOperational = () => {
              if (scenario.launch.startMode === "chat" && onStartWorkflow) onStartWorkflow(scenario.launch.starterMessage, scenario);
              else openCatalog(scenario);
            };
            return (
              <div key={scenario.id} className="flex flex-col rounded-lg border bg-card p-4 text-left shadow-sm transition-colors hover:border-brand-200">
                <div className="text-xs text-muted-foreground">{scenario.readiness === "D0_CURRENT" ? "当前即用" : scenario.readiness === "D1_CONNECTOR" ? "标准接入" : "项目集成"}</div>
                <div className="mt-2 text-sm font-semibold">{scenario.title}</div>
                <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">{scenario.value}</p>
                {/* 空会话首屏是客户第一眼看到的东西：能演的场景先给「看它如何完成」，
                    接入退为次选。否则第一次点击落到连接器配置页，客户还没看见价值就先被要求配系统。 */}
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  {canReplay ? (
                    <>
                      <Button type="button" size="sm" className="h-7 px-2.5 text-xs" onClick={() => openCatalog(scenario, "presentation")}>
                        看它如何完成
                      </Button>
                      <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={openOperational}>
                        {scenario.cta.primary}
                      </Button>
                    </>
                  ) : (
                    <Button type="button" size="sm" className="h-7 px-2.5 text-xs" onClick={openOperational}>
                      {scenario.cta.primary}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (!library || library.scenarios.length === 0) return null;

  const industryFiltered = library.scenarios.filter((s) =>
    matchIndustry(s.industryFocus, activeIndustry),
  );
  const pool = industryFiltered.length > 0 ? industryFiltered : library.scenarios;

  // 用户配置了岗位且命中场景库岗位时，本岗位场景优先（至多 2 张 + 1 张跨岗位精选）
  const preferredRoleId = matchRoleIdByPosition(library.roles, user?.position);
  const recommended = pickRecommendedScenarios(pool, 3, preferredRoleId);

  return (
    <div className="mx-auto w-full max-w-2xl pt-[12vh]">
      <div className="mb-3 text-center text-sm text-muted-foreground">
        不知道从哪开始？试试这些任务模板——点一下就把起手话术填进输入框
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {recommended.map((scenario) => (
          <ScenarioCard
            key={scenario.id}
            scenario={scenario}
            compact
            onTry={(s) => onTryScenario(buildScenarioPrompt(s), s)}
          />
        ))}
      </div>
      <div className="mt-3 flex justify-center">
        <button
          type="button"
          onClick={onViewAll}
          className="inline-flex items-center gap-1 text-sm text-link hover:underline"
        >
          查看全部模板
          <ArrowRight className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
