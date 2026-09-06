import type { ReactNode } from "react";
import { ArrowRight, ChevronRight } from "lucide-react";
import {
  RECOMMENDATION_COUNT,
  buildScenarioPrompt,
  pickRoleTopScenarios,
  resolveScenarioActionMeta,
  sanitizeScenario,
  type CatalogScenarioPublic,
  type ScenarioItem,
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
import { hasReplayScript } from "@agent/shared/scenarios/replay/availability";
import { isHookScenario } from "./workflowUi";
import { useWorkflowDisplayConfig } from "./useWorkflowDisplayConfig";

interface EmptyChatRecommendCardsProps {
  onTryScenario: (prompt: string, scenario: ScenarioItem) => void;
  onStartWorkflow?: (starterMessage: string, scenario: CatalogScenarioPublic) => void;
  onViewAll: () => void;
}

type SuggestionTone = "success" | "primary" | "warning" | "muted";

const toneClass: Record<SuggestionTone, string> = {
  success: "text-success-ink",
  primary: "text-primary",
  warning: "text-warning-ink",
  muted: "text-muted-foreground",
};

function safeScenario(scenario: ScenarioItem): ScenarioItem {
  return sanitizeScenario({ ...scenario }).scenario as ScenarioItem;
}

// v2 推荐卡的 aha 打分排序已下沉 shared，保留 pickRoleTop3 这个既有导出名。
export { pickRoleTopScenarios as pickRoleTop3 } from "@agent/shared";

function SuggestionCard({
  title,
  action,
  tone,
  onClick,
}: {
  title: string;
  action: string;
  tone: SuggestionTone;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex min-h-[56px] min-w-0 items-center gap-2.5 rounded-2xl border bg-card/70 px-3 py-2 text-left transition-[transform,border-color,background-color,box-shadow] hover:-translate-y-0.5 hover:border-brand-200 hover:bg-brand-50/35 hover:shadow-sm dark:hover:bg-brand-900/15"
      onClick={onClick}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold text-foreground sm:text-sm">{title}</span>
        <span className={cn("mt-0.5 block text-[11px] font-medium", toneClass[tone])}>{action}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground/45" />
    </button>
  );
}

function SuggestionGrid({
  children,
  onViewAll,
}: {
  children: ReactNode;
  onViewAll: () => void;
}) {
  return (
    <div className="content-container pt-4 sm:pt-5">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">{children}</div>
      <div className="mt-2 flex justify-center">
        <Button type="button" variant="ghost" size="sm" className="h-8 gap-1 text-xs text-muted-foreground" onClick={onViewAll}>
          查看全部能力
          <ArrowRight className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

function workflowActionMeta(scenario: CatalogScenarioPublic, canReplay: boolean): {
  label: string;
  tone: SuggestionTone;
} {
  if (canReplay) {
    return { label: "看回放", tone: "primary" };
  }
  if (scenario.launch.startMode === "chat" && scenario.readiness === "D0_CURRENT") {
    return { label: "直接试", tone: "success" };
  }
  if (scenario.launch.startMode === "connector" || scenario.readiness === "D1_CONNECTOR") {
    return { label: "需接入", tone: "warning" };
  }
  return { label: "了解方案", tone: "muted" };
}

export function EmptyChatRecommendCards({
  onTryScenario,
  onStartWorkflow,
  onViewAll,
}: EmptyChatRecommendCardsProps) {
  const { library, workflowLibrary, loading, error } = useScenarioLibrary();
  const { user } = useAuth();
  const { activeIndustry } = useIndustryFilter();
  const displayConfig = useWorkflowDisplayConfig();

  if (loading || error || displayConfig.loading) return null;

  if (workflowLibrary) {
    const configuredCount = displayConfig.config?.displayCount ?? 0;
    if (displayConfig.config?.source !== "platform") {
      const byId = new Map(workflowLibrary.scenarios.map((scenario) => [scenario.id, scenario]));
      const cards = (displayConfig.config?.workflowIds ?? [])
        .map((id) => byId.get(id))
        .filter((scenario): scenario is CatalogScenarioPublic => Boolean(scenario))
        .slice(0, configuredCount);
      return (
        <SuggestionGrid onViewAll={onViewAll}>
          {cards.map((scenario) => {
            const canReplay = hasReplayScript(scenario);
            const meta = workflowActionMeta(scenario, canReplay);
            const handleClick = () => {
              if (canReplay) {
                onViewAll();
                const params = new URLSearchParams(window.location.search);
                params.delete("scenario");
                params.set("workflow", scenario.id);
                params.set("intent", "presentation");
                window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
              } else if (scenario.launch.startMode === "chat" && onStartWorkflow) {
                onStartWorkflow(scenario.launch.starterMessage, scenario);
              } else {
                onViewAll();
                const params = new URLSearchParams(window.location.search);
                params.delete("scenario");
                params.set("workflow", scenario.id);
                params.set("intent", scenario.launch.startMode === "connector" ? "connect" : "view");
                window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
              }
            };
            return <SuggestionCard key={scenario.id} title={scenario.title} action={meta.label} tone={meta.tone} onClick={handleClick} />;
          })}
        </SuggestionGrid>
      );
    }
    const matchedRoleId = user?.preferences?.activeRoleId && workflowLibrary.roles.some((role) => role.id === user?.preferences?.activeRoleId)
      ? user.preferences.activeRoleId
      : matchRoleIdByPosition(workflowLibrary.roles, user?.position);
    const pickCards = (pool: readonly CatalogScenarioPublic[], count: number) => {
      const hooks = pool.filter(isHookScenario);
      const roleHooks = matchedRoleId
        ? hooks.filter((scenario) => scenario.roleIds.includes(matchedRoleId))
        : [];
      const hookCards = [...roleHooks, ...hooks.filter((scenario) => !roleHooks.includes(scenario))]
        .slice(0, count);
      const fallbackCards = pickRecommendedWorkflowScenarios(
        pool.filter((scenario) => !isHookScenario(scenario)),
        count,
        matchedRoleId,
      );
      return [...hookCards, ...fallbackCards].slice(0, count);
    };
    const industryFiltered = activeIndustry === "all"
      ? workflowLibrary.scenarios
      : workflowLibrary.scenarios.filter((scenario) => scenario.industryTags.includes(activeIndustry));
    const primaryPool = industryFiltered.length > 0 ? industryFiltered : workflowLibrary.scenarios;
    const primaryCards = pickCards(primaryPool, configuredCount);
    const primaryIds = new Set(primaryCards.map((scenario) => scenario.id));
    const fallbackCards = primaryCards.length < configuredCount
      ? pickCards(
        workflowLibrary.scenarios.filter((scenario) => !primaryIds.has(scenario.id)),
        configuredCount - primaryCards.length,
      )
      : [];
    const cards = [...primaryCards, ...fallbackCards];

    const openCatalog = (scenario: CatalogScenarioPublic, intent: "view" | "connect" | "presentation") => {
      onViewAll();
      const params = new URLSearchParams(window.location.search);
      params.delete("scenario");
      params.set("workflow", scenario.id);
      params.set("intent", intent);
      window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
    };

    return (
      <SuggestionGrid onViewAll={onViewAll}>
        {cards.map((scenario) => {
          const canReplay = hasReplayScript(scenario);
          const meta = workflowActionMeta(scenario, canReplay);
          const handleClick = () => {
            if (canReplay) {
              openCatalog(scenario, "presentation");
              return;
            }
            if (scenario.launch.startMode === "chat" && onStartWorkflow) {
              onStartWorkflow(scenario.launch.starterMessage, scenario);
              return;
            }
            openCatalog(scenario, scenario.launch.startMode === "connector" ? "connect" : "view");
          };
          return (
            <SuggestionCard
              key={scenario.id}
              title={scenario.title}
              action={meta.label}
              tone={meta.tone}
              onClick={handleClick}
            />
          );
        })}
      </SuggestionGrid>
    );
  }

  if (displayConfig.config?.source !== "platform") {
    return <SuggestionGrid onViewAll={onViewAll}>{null}</SuggestionGrid>;
  }

  if (!library || library.scenarios.length === 0) return null;

  const industryFiltered = library.scenarios.filter((scenario) =>
    matchIndustry(scenario.industryFocus, activeIndustry));
  const pool = industryFiltered.length > 0 ? industryFiltered : library.scenarios;
  const matchedRoleId = user?.preferences?.activeRoleId && library.roles.some((role) => role.id === user?.preferences?.activeRoleId)
    ? user.preferences.activeRoleId
    : matchRoleIdByPosition(library.roles, user?.position);
  const roleTopScenarios = pickRoleTopScenarios(pool, matchedRoleId);
  const recommended = roleTopScenarios.length > 0
    ? roleTopScenarios
    : pickRecommendedScenarios(pool, RECOMMENDATION_COUNT, matchedRoleId);
  const cards = recommended.slice(0, RECOMMENDATION_COUNT).map(safeScenario);

  return (
    <SuggestionGrid onViewAll={onViewAll}>
      {cards.map((scenario) => {
        const actionMeta = resolveScenarioActionMeta(scenario);
        return (
          <SuggestionCard
            key={scenario.id}
            title={scenario.title}
            action={actionMeta.label}
            tone={actionMeta.tone}
            onClick={() => onTryScenario(buildScenarioPrompt(scenario), scenario)}
          />
        );
      })}
    </SuggestionGrid>
  );
}
