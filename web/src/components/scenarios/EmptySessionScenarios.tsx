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
import { useAuth } from "@/contexts/AuthContext";
import { ScenarioCard } from "./ScenarioCard";
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
    const openCatalog = (scenario: CatalogScenarioPublic) => {
      onViewAll();
      const params = new URLSearchParams(window.location.search);
      params.delete("scenario");
      params.set("workflow", scenario.id);
      params.set("intent", scenario.launch.startMode === "connector" ? "connect" : "view");
      window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
    };
    return (
      <div className="mx-auto w-full max-w-2xl pt-[12vh]">
        <div className="mb-3 text-center text-sm text-muted-foreground">从业务结果开始：能直接体验的现在做，需要接入的先看清边界</div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {recommended.map((scenario) => (
            <button key={scenario.id} type="button" className="rounded-lg border bg-card p-4 text-left shadow-sm hover:border-brand-200" onClick={() => {
              if (scenario.launch.startMode === "chat" && onStartWorkflow) onStartWorkflow(scenario.launch.starterMessage, scenario);
              else openCatalog(scenario);
            }}>
              <div className="text-xs text-muted-foreground">{scenario.readiness === "D0_CURRENT" ? "当前即用" : scenario.readiness === "D1_CONNECTOR" ? "标准接入" : "项目集成"}</div>
              <div className="mt-2 text-sm font-semibold">{scenario.title}</div>
              <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">{scenario.value}</p>
              <div className="mt-3 text-xs text-brand-600">{scenario.cta.primary}</div>
            </button>
          ))}
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
