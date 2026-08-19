import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type {
  TaskBoardIntegrationCandidateDetails,
  TaskBoardIntegrationCandidatePhase,
  TaskBoardIntegrationCandidateState,
  TaskBoardTask,
} from "@agent/shared/types/taskboard";
import { GitBranch, LoaderCircle, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import * as api from "./api";
import { IntegrationSourceDetails, useIntegrationSources } from "./IntegrationSources";

const PHASE_LABELS: Record<TaskBoardIntegrationCandidatePhase, string> = {
  freezing: "冻结来源",
  composing: "组合 Candidate",
  checks: "CI 检查",
  work: "Work",
  review: "Review",
  merging: "合入 main",
  cleanup: "cleanup",
  unknown: "unknown（等待对账）",
  blocked: "blocked（需处理）",
  merged: "已合入 main",
};

function phaseFromState(state: TaskBoardIntegrationCandidateState): TaskBoardIntegrationCandidatePhase {
  switch (state) {
    case "preparing": return "freezing";
    case "composing": return "composing";
    case "waiting_checks": return "checks";
    case "needs_work":
    case "working": return "work";
    case "in_review":
    case "approved": return "review";
    case "merging": return "merging";
    case "merged": return "cleanup";
    case "blocked":
    case "needs_human":
    case "canceled": return "blocked";
  }
}

function phaseFromDetails(details: TaskBoardIntegrationCandidateDetails): TaskBoardIntegrationCandidatePhase {
  if (details.phase) return details.phase;
  if (details.operations?.some((operation) => operation.state === "unknown")) return "unknown";
  if (details.worker?.error) return "blocked";
  return phaseFromState(details.candidate.state);
}

export function useIntegrationCandidate(taskId: string | null, active = true) {
  const [details, setDetails] = useState<TaskBoardIntegrationCandidateDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const loadedTaskIdRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current;
    if (!taskId || !active) {
      loadedTaskIdRef.current = taskId;
      setDetails(null);
      setError(null);
      setLoading(false);
      return;
    }
    if (loadedTaskIdRef.current !== taskId) {
      loadedTaskIdRef.current = taskId;
      setDetails(null);
    }
    setError(null);
    setLoading(true);
    try {
      const next = await api.fetchIntegrationCandidate(taskId);
      if (requestRef.current !== requestId || loadedTaskIdRef.current !== taskId) return;
      setDetails(next);
    } catch (caught) {
      if (requestRef.current !== requestId || loadedTaskIdRef.current !== taskId) return;
      // Deliberately retain the last successful projection. Candidate facts must not regress to empty/zero.
      setError(caught instanceof Error ? caught.message : "加载 Candidate 失败");
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [active, taskId]);

  useEffect(() => {
    void refresh();
    return () => { requestRef.current += 1; };
  }, [refresh]);

  return { details, loading, error, refresh };
}

export function IntegrationTaskDetails({
  task,
  active,
  sourceState,
  selectedSourceIds,
  setSelectedSourceIds,
  sourceSelectionEnabled,
  onNavigateTask,
}: {
  task: TaskBoardTask;
  active: boolean;
  sourceState: ReturnType<typeof useIntegrationSources>;
  selectedSourceIds: Set<string>;
  setSelectedSourceIds: Dispatch<SetStateAction<Set<string>>>;
  sourceSelectionEnabled: boolean;
  onNavigateTask?: (taskId: string) => void;
}) {
  const candidateState = useIntegrationCandidate(task.workflowVersion === 3 ? task.id : null, active);
  const onSourceSelectionChange = sourceSelectionEnabled ? (sourceId: string, selected: boolean) => {
    setSelectedSourceIds((previous) => {
      const next = new Set(previous);
      if (selected) next.add(sourceId); else next.delete(sourceId);
      return next;
    });
  } : undefined;

  return task.workflowVersion === 3 ? (
    <IntegrationCandidateDetails taskId={task.id} state={candidateState} />
  ) : (
    <IntegrationSourceDetails
      taskId={task.id}
      state={sourceState}
      selectedSourceIds={selectedSourceIds}
      onSourceSelectionChange={onSourceSelectionChange}
      onNavigateTask={onNavigateTask}
    />
  );
}

export function IntegrationCandidateCardSummary({ taskId }: { taskId: string }) {
  const { details, loading, error } = useIntegrationCandidate(taskId);
  const candidate = details?.candidate;
  const phase = details ? phaseFromDetails(details) : null;

  return (
    <div aria-label="Integration v3 Candidate 状态" className="mt-2 space-y-1.5 rounded-md border border-blue-300/50 bg-blue-50/50 p-2 text-xs dark:bg-blue-950/20">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-blue-800 dark:text-blue-200">Integration v3 · Candidate</span>
        {phase ? <Badge variant={phase === "blocked" || phase === "unknown" ? "destructive" : "outline"}>{PHASE_LABELS[phase]}</Badge> : null}
      </div>
      {candidate ? (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
          <span>revision {candidate.currentRevision}</span>
          <span>Work {candidate.workRound}</span>
          <span>Review {candidate.approvedRevision === candidate.currentRevision ? "已批准" : "待批准"}</span>
        </div>
      ) : loading ? <span className="inline-flex items-center gap-1 text-muted-foreground"><LoaderCircle className="size-3 animate-spin" />加载 Candidate...</span> : null}
      {error ? <p role="alert" className="text-destructive"><TriangleAlert className="mr-1 inline size-3" />刷新失败，保留上次数据：{error}</p> : null}
    </div>
  );
}

function shortOid(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}

export function IntegrationCandidateDetails({
  taskId,
  state,
}: {
  taskId: string;
  state?: ReturnType<typeof useIntegrationCandidate>;
}) {
  const internal = useIntegrationCandidate(taskId, !state);
  const { details, loading, error } = state ?? internal;
  const candidate = details?.candidate;
  const currentRevision = useMemo(() => details?.revisions.find(
    (revision) => revision.revision === candidate?.currentRevision,
  ), [candidate?.currentRevision, details?.revisions]);
  const phase = details ? phaseFromDetails(details) : null;

  return (
    <section aria-label="Integration v3 Candidate 详情" className="mb-6 space-y-3 rounded-lg border border-blue-300/50 bg-blue-50/30 p-4 dark:bg-blue-950/20">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Integration v3 Candidate</h3>
          <p className="mt-1 text-xs text-muted-foreground">Candidate、revision 与冻结 source-set 是 v3 的流程权威；不会按来源逐项宣称已合并。</p>
        </div>
        {phase ? <Badge variant={phase === "blocked" || phase === "unknown" ? "destructive" : "outline"}>{PHASE_LABELS[phase]}</Badge> : null}
      </div>
      {loading && !details ? <p className="inline-flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在加载 Candidate...</p> : null}
      {candidate ? (
        <>
          <dl className="grid gap-2 text-xs sm:grid-cols-2">
            <div><dt className="text-muted-foreground">branch</dt><dd className="break-all font-mono"><GitBranch className="mr-1 inline size-3" />{candidate.branch}</dd></div>
            <div><dt className="text-muted-foreground">Integration PR</dt><dd className="break-all font-mono">{candidate.providerPullRequestId ?? "尚未创建"}</dd></div>
            <div><dt className="text-muted-foreground">base</dt><dd className="break-all font-mono">{candidate.baseBranch}{currentRevision ? ` @ ${shortOid(currentRevision.baseOid)}` : ""}</dd></div>
            <div><dt className="text-muted-foreground">head / tree</dt><dd className="break-all font-mono">{currentRevision ? `${shortOid(currentRevision.headOid)} / ${shortOid(currentRevision.treeOid)}` : "尚未冻结 revision"}</dd></div>
            <div><dt className="text-muted-foreground">revision</dt><dd>{candidate.currentRevision} · Work round {candidate.workRound}</dd></div>
            <div><dt className="text-muted-foreground">source-set</dt><dd className="break-all font-mono">{currentRevision?.sourceSetDigest ?? candidate.sourceSetDigest ?? "尚未冻结"}</dd></div>
          </dl>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border bg-background/80 p-3">
              <h4 className="text-xs font-semibold">Work 历史</h4>
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {details?.revisions.filter((revision) => revision.workExecutionId).map((revision) => <li key={`work-${revision.revision}`}>R{revision.revision} · round {revision.workRound} · <span className="font-mono">{revision.workExecutionId}</span></li>)}
                {!details?.revisions.some((revision) => revision.workExecutionId) ? <li>暂无 Work 记录</li> : null}
              </ul>
            </div>
            <div className="rounded-md border bg-background/80 p-3">
              <h4 className="text-xs font-semibold">Review 历史</h4>
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {details?.revisions.filter((revision) => revision.reviewExecutionId).map((revision) => <li key={`review-${revision.revision}`}>R{revision.revision} · <span className="font-mono">{revision.reviewExecutionId}</span>{candidate.approvedRevision === revision.revision ? " · 已批准" : ""}</li>)}
                {!details?.revisions.some((revision) => revision.reviewExecutionId) ? <li>暂无 Review 记录</li> : null}
              </ul>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">last refreshed：<time dateTime={details?.lastRefreshedAt}>{details?.lastRefreshedAt ? new Date(details.lastRefreshedAt).toLocaleString("zh-CN") : "未知"}</time></p>
          {candidate.lastError ? <p className="whitespace-pre-wrap text-xs text-destructive"><TriangleAlert className="mr-1 inline size-3.5" />{candidate.lastError}</p> : null}
        </>
      ) : !loading ? <p className="text-sm text-muted-foreground">尚无 Candidate 投影。</p> : null}
      {error ? <p role="alert" className="text-sm text-destructive">刷新失败，当前显示 stale 数据：{error}</p> : null}
    </section>
  );
}
