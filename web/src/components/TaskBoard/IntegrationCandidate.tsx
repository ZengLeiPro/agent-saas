import type { Dispatch, SetStateAction } from "react";
import type { TaskBoardTask } from "@agent/shared/types/taskboard";
import { Badge } from "@/components/ui/badge";
import { IntegrationSourceDetails, useIntegrationSources } from "./IntegrationSources";

/**
 * Compatibility module name only. Candidate/revision details are retired from
 * the UI; live execution context projects the durable Integration Agent.
 */
export function IntegrationTaskDetails({
  task, sourceState, selectedSourceIds, setSelectedSourceIds, sourceSelectionEnabled, onNavigateTask,
}: {
  task: TaskBoardTask;
  active: boolean;
  sourceState: ReturnType<typeof useIntegrationSources>;
  selectedSourceIds: Set<string>;
  setSelectedSourceIds: Dispatch<SetStateAction<Set<string>>>;
  sourceSelectionEnabled: boolean;
  onNavigateTask?: (taskId: string) => void;
}) {
  const onSourceSelectionChange = sourceSelectionEnabled ? (sourceId: string, selected: boolean) => {
    setSelectedSourceIds((previous) => {
      const next = new Set(previous);
      if (selected) next.add(sourceId); else next.delete(sourceId);
      return next;
    });
  } : undefined;
  return <IntegrationSourceDetails taskId={task.id} state={sourceState} selectedSourceIds={selectedSourceIds}
    onSourceSelectionChange={onSourceSelectionChange} onNavigateTask={onNavigateTask} />;
}

export function IntegrationCandidateCardSummary({ taskId }: { taskId: string }) {
  return <div aria-label="Integration Agent 状态" className="mt-2 rounded-md border border-blue-300/50 bg-blue-50/50 p-2 text-xs dark:bg-blue-950/20">
    <div className="flex items-center justify-between gap-2"><span className="font-medium text-blue-800 dark:text-blue-200">Integration Agent</span><Badge>按执行上下文推进</Badge></div>
    <p className="mt-1 text-muted-foreground">GitHub PR 与当前 Agent 执行记录是权威事实。</p>
    <span className="sr-only">{taskId}</span>
  </div>;
}

/** @deprecated Compatibility export; Candidate data is intentionally not read. */
export function IntegrationCandidateDetails({ taskId }: { taskId: string }) {
  return <IntegrationCandidateCardSummary taskId={taskId} />;
}
