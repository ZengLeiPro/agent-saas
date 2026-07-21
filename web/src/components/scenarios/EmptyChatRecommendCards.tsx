import { useEffect, useState } from "react";
import { ArrowRight, Clock3, Layers3 } from "lucide-react";
import {
  buildScenarioPrompt,
  sanitizeScenario,
  type CatalogScenarioPublic,
  type ScenarioItem,
  type ScenarioRole,
} from "@agent/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import {
  matchRoleIdByPosition,
  pickRecommendedScenarios,
  pickRecommendedWorkflowScenarios,
  useScenarioLibrary,
} from "./useScenarioLibrary";
import { matchIndustry, useIndustryFilter } from "./useIndustryFilter";
import { friendlyDataDependency } from "./friendlyMappings";

interface EmptyChatRecommendCardsProps {
  onTryScenario: (prompt: string, scenario: ScenarioItem) => void;
  onStartWorkflow?: (starterMessage: string, scenario: CatalogScenarioPublic) => void;
  onViewAll: () => void;
  onOpenRoleDetail?: (roleId: string) => void;
}

const ahaScore: Record<NonNullable<ScenarioItem["firstAhaMode"]>, number> = {
  zero_input_example: 4,
  paste_then_result: 3,
  upload_then_result: 2,
  voice_then_result: 1,
};

const COMPACT_RECOMMENDATION_COUNT = 3;
const EXPANDED_RECOMMENDATION_COUNT = 6;
const TWO_ROW_RECOMMENDATION_MIN_HEIGHT = 820;

function safeScenario(scenario: ScenarioItem): ScenarioItem {
  return sanitizeScenario({ ...scenario }).scenario as ScenarioItem;
}

function getRecommendationCount(): number {
  if (typeof window === "undefined") return COMPACT_RECOMMENDATION_COUNT;
  return window.innerHeight >= TWO_ROW_RECOMMENDATION_MIN_HEIGHT
    ? EXPANDED_RECOMMENDATION_COUNT
    : COMPACT_RECOMMENDATION_COUNT;
}

function useRecommendationCount(): number {
  const [count, setCount] = useState(getRecommendationCount);

  useEffect(() => {
    const sync = () => setCount(getRecommendationCount());
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  return count;
}

export function pickRoleTop3(
  scenarios: readonly ScenarioItem[],
  roleId: string | null,
  count = COMPACT_RECOMMENDATION_COUNT,
): ScenarioItem[] {
  const candidates = roleId
    ? scenarios.filter((scenario) => scenario.role === roleId)
    : scenarios;
  const sorted = [...candidates].sort((a, b) => {
    const ahaDelta = (ahaScore[b.firstAhaMode ?? "zero_input_example"] ?? 0) - (ahaScore[a.firstAhaMode ?? "zero_input_example"] ?? 0);
    if (ahaDelta !== 0) return ahaDelta;
    if (a.mode !== b.mode) return a.mode === "recurring" ? -1 : 1;
    const depA = a.dataDependencyLevel === "zero" ? 0 : 1;
    const depB = b.dataDependencyLevel === "zero" ? 0 : 1;
    if (depA !== depB) return depA - depB;
    return a.id.localeCompare(b.id);
  });
  return sorted.slice(0, count);
}

function roleName(roles: ScenarioRole[], roleId: string | null): string {
  if (!roleId) return "推荐";
  return roles.find((role) => role.id === roleId)?.name ?? "推荐";
}

export function EmptyChatRecommendCards({
  onTryScenario,
  onStartWorkflow,
  onViewAll,
  onOpenRoleDetail,
}: EmptyChatRecommendCardsProps) {
  const { library, workflowLibrary, loading, error } = useScenarioLibrary();
  const { user } = useAuth();
  const { activeIndustry } = useIndustryFilter();
  const recommendationCount = useRecommendationCount();

  if (loading || error) return null;

  if (workflowLibrary) {
    const matchedRoleId = user?.preferences?.activeRoleId && workflowLibrary.roles.some((role) => role.id === user.preferences?.activeRoleId)
      ? user.preferences.activeRoleId
      : matchRoleIdByPosition(workflowLibrary.roles, user?.position);
    const industryFiltered = activeIndustry === "all"
      ? workflowLibrary.scenarios
      : workflowLibrary.scenarios.filter((scenario) => scenario.industryTags.includes(activeIndustry));
    const pool = industryFiltered.length > 0 ? industryFiltered : workflowLibrary.scenarios;
    const cards = pickRecommendedWorkflowScenarios(pool, recommendationCount, matchedRoleId);
    const openCatalog = (scenario: CatalogScenarioPublic, intent: "view" | "run" | "connect") => {
      onViewAll();
      const params = new URLSearchParams(window.location.search);
      params.delete("scenario");
      params.set("workflow", scenario.id);
      params.set("intent", intent);
      window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
    };
    return (
      <div className="mx-auto w-full max-w-3xl pt-[10vh]">
        <div className="mb-4 flex items-end justify-between gap-3">
          <div><div className="text-sm font-medium text-foreground">{roleName(workflowLibrary.roles, matchedRoleId)}工作流</div><div className="mt-1 text-sm text-muted-foreground">从真实业务事件开始，看到行动与完成证明。</div></div>
          <Button type="button" variant="ghost" size="sm" className="h-8 shrink-0 gap-1 text-xs" onClick={onViewAll}>查看目录<ArrowRight className="size-3.5" /></Button>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {cards.map((scenario) => (
            <button
              key={scenario.id}
              type="button"
              className={cn("flex min-h-[172px] flex-col rounded-lg border bg-card p-4 text-left shadow-sm transition-all", "hover:-translate-y-0.5 hover:border-brand-200")}
              onClick={() => {
                if (scenario.launch.startMode === "chat" && onStartWorkflow) onStartWorkflow(scenario.launch.starterMessage, scenario);
                else openCatalog(scenario, scenario.launch.startMode === "connector" ? "connect" : "view");
              }}
            >
              <div className="text-[11px] font-medium text-muted-foreground">{scenario.primaryType === "CREATE" ? "产出成果" : scenario.primaryType === "WATCH" ? "持续巡检" : scenario.primaryType === "ACT" ? "会动系统" : "持续闭环"} · {scenario.readiness === "D0_CURRENT" ? "当前即用" : scenario.readiness === "D1_CONNECTOR" ? "标准接入" : "项目集成"}</div>
              <div className="mt-2 line-clamp-2 text-sm font-semibold leading-snug">{scenario.title}</div>
              <p className="mt-2 line-clamp-3 text-sm leading-5 text-muted-foreground">{scenario.value}</p>
              <div className="mt-auto pt-3 text-xs text-brand-600">{scenario.cta.primary}</div>
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
  // 兜底：如果行业过滤后为空（客户选了冷门行业），fallback 回全量避免推荐位消失
  const pool = industryFiltered.length > 0 ? industryFiltered : library.scenarios;

  const matchedRoleId =
    user?.preferences?.activeRoleId && library.roles.some((role) => role.id === user.preferences?.activeRoleId)
      ? user.preferences.activeRoleId
      : matchRoleIdByPosition(library.roles, user?.position);
  const roleTopScenarios = pickRoleTop3(pool, matchedRoleId, recommendationCount);
  const recommended = roleTopScenarios.length > 0
    ? roleTopScenarios
    : pickRecommendedScenarios(pool, recommendationCount, matchedRoleId);
  const cards = recommended.map(safeScenario);

  return (
    <div className="mx-auto w-full max-w-3xl pt-[10vh]">
      <div className="mb-4 flex items-end justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-foreground">
            {roleName(library.roles, matchedRoleId)}开箱任务
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            点一张卡片，把起手指令放进输入框。
          </div>
        </div>
        {matchedRoleId && onOpenRoleDetail && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 shrink-0 gap-1 text-xs"
            onClick={() => onOpenRoleDetail(matchedRoleId)}
          >
            岗位详情
            <ArrowRight className="size-3.5" />
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {cards.map((scenario) => (
          <button
            key={scenario.id}
            type="button"
            className={cn(
              "flex min-h-[172px] flex-col rounded-lg border bg-card p-4 text-left shadow-sm transition-all",
              "hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-[0_8px_24px_-20px_rgba(15,23,42,0.7)]",
            )}
            onClick={() => onTryScenario(buildScenarioPrompt(scenario), scenario)}
          >
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              {scenario.mode === "recurring" ? (
                <>
                  <Clock3 className="size-3.5" />
                  常驻监测
                </>
              ) : (
                <>
                  <Layers3 className="size-3.5" />
                  一次性任务
                </>
              )}
            </div>
            <div className="mt-2 line-clamp-2 text-sm font-semibold leading-snug">
              {scenario.title}
            </div>
            <p className="mt-2 line-clamp-3 text-sm leading-5 text-muted-foreground">
              {scenario.pitch}
            </p>
            <div className="mt-auto pt-3 text-xs text-muted-foreground">
              {scenario.dataDependencyLevel
                ? friendlyDataDependency[scenario.dataDependencyLevel]
                : "可直接试跑"}
            </div>
          </button>
        ))}
      </div>

      <div className="mt-3 flex justify-center">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 gap-1 text-sm"
          onClick={onViewAll}
        >
          查看全部模板
          <ArrowRight className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
