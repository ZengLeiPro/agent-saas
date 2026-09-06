import { ArrowRight, ChevronRight } from "lucide-react";
import { buildScenarioPrompt } from "@agent/shared";
import type { CatalogScenarioPublic, ScenarioItem } from "@agent/shared";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { hasReplayScript } from "@agent/shared/scenarios/replay/availability";
import {
  matchRoleIdByPosition,
  pickRecommendedScenarios,
  pickRecommendedWorkflowScenarios,
  useScenarioLibrary,
} from "./useScenarioLibrary";
import { matchIndustry, useIndustryFilter } from "./useIndustryFilter";

interface EmptySessionScenariosProps {
  onTryScenario: (prompt: string, scenario: ScenarioItem) => void;
  onStartWorkflow?: (starterMessage: string, scenario: CatalogScenarioPublic) => void;
  onViewAll: () => void;
}

function StarterRow({
  title,
  action,
  onClick,
}: {
  title: string;
  action: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex min-h-[56px] min-w-0 items-center gap-2.5 rounded-2xl border bg-card/70 px-3 py-2 text-left transition-[transform,border-color,background-color,box-shadow] hover:-translate-y-0.5 hover:border-brand-200 hover:bg-brand-50/35 hover:shadow-sm dark:hover:bg-brand-900/15"
      onClick={onClick}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold sm:text-sm">{title}</span>
        <span className="mt-0.5 block text-[11px] font-medium text-muted-foreground">{action}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground/45" />
    </button>
  );
}

function StarterGrid({ children, onViewAll }: { children: React.ReactNode; onViewAll: () => void }) {
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

export function EmptySessionScenarios({ onTryScenario, onStartWorkflow, onViewAll }: EmptySessionScenariosProps) {
  const { library, workflowLibrary, loading, error } = useScenarioLibrary();
  const { user } = useAuth();
  const { activeIndustry } = useIndustryFilter();

  if (loading || error) return null;

  if (workflowLibrary) {
    const pool = activeIndustry === "all"
      ? workflowLibrary.scenarios
      : workflowLibrary.scenarios.filter((scenario) => scenario.industryTags.includes(activeIndustry));
    const preferredRoleId = matchRoleIdByPosition(workflowLibrary.roles, user?.position);
    const recommended = pickRecommendedWorkflowScenarios(
      pool.length > 0 ? pool : workflowLibrary.scenarios,
      3,
      preferredRoleId,
    ).slice(0, 3);
    const openCatalog = (scenario: CatalogScenarioPublic, intent: "view" | "connect" | "presentation") => {
      onViewAll();
      const params = new URLSearchParams(window.location.search);
      params.delete("scenario");
      params.set("workflow", scenario.id);
      params.set("intent", intent);
      window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
    };

    return (
      <StarterGrid onViewAll={onViewAll}>
        {recommended.map((scenario) => {
          const canReplay = hasReplayScript(scenario);
          const isDirect = !canReplay && scenario.launch.startMode === "chat" && scenario.readiness === "D0_CURRENT";
          const needsConnector = !canReplay && (scenario.launch.startMode === "connector" || scenario.readiness === "D1_CONNECTOR");
          const action = canReplay ? "看回放" : isDirect ? "直接试" : needsConnector ? "需接入" : "了解方案";
          return (
            <StarterRow
              key={scenario.id}
              title={scenario.title}
              action={action}
              onClick={() => {
                if (canReplay) {
                  openCatalog(scenario, "presentation");
                } else if (scenario.launch.startMode === "chat" && onStartWorkflow) {
                  onStartWorkflow(scenario.launch.starterMessage, scenario);
                } else {
                  openCatalog(scenario, scenario.launch.startMode === "connector" ? "connect" : "view");
                }
              }}
            />
          );
        })}
      </StarterGrid>
    );
  }

  if (!library || library.scenarios.length === 0) return null;

  const industryFiltered = library.scenarios.filter((scenario) =>
    matchIndustry(scenario.industryFocus, activeIndustry));
  const pool = industryFiltered.length > 0 ? industryFiltered : library.scenarios;
  const preferredRoleId = matchRoleIdByPosition(library.roles, user?.position);
  const recommended = pickRecommendedScenarios(pool, 3, preferredRoleId).slice(0, 3);

  return (
    <StarterGrid onViewAll={onViewAll}>
      {recommended.map((scenario) => (
        <StarterRow
          key={scenario.id}
          title={scenario.title}
          action="预填任务"
          onClick={() => onTryScenario(buildScenarioPrompt(scenario), scenario)}
        />
      ))}
    </StarterGrid>
  );
}
