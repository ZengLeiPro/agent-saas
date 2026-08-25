import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type {
  TaskBoardIntegrationCandidateDetails,
  TaskBoardIntegrationCandidateState,
  TaskBoardTask,
} from "@agent/shared/types/taskboard";
import { GitBranch, LoaderCircle, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import * as api from "./api";
import { IntegrationSourceDetails, useIntegrationSources } from "./IntegrationSources";

type AgentProgress = {
  label: string;
  tone: "default" | "destructive";
  next: string;
  humanIssue?: string;
};

function agentProgress(details: TaskBoardIntegrationCandidateDetails): AgentProgress {
  if (details.worker?.error || details.cleanup?.outcome === "failed") {
    return {
      label: "需要人工处理",
      tone: "destructive",
      next: "等待维护者处理明确的失败原因后恢复。",
      humanIssue: details.worker?.error ?? details.cleanup?.reason ?? "清理失败",
    };
  }
  if (details.candidate.state === "merged") {
    return details.cleanup?.outcome === "completed" || details.cleanup?.outcome === "skipped"
      ? { label: "已完成", tone: "default", next: "GitHub 已确认合并，Agent 已完成收尾。" }
      : { label: "正在收尾", tone: "default", next: "GitHub 已合并，Agent 正在清理分支和来源任务。" };
  }
  const states: Partial<Record<TaskBoardIntegrationCandidateState, AgentProgress>> = {
    preparing: { label: "正在对账", tone: "default", next: "读取来源任务与 GitHub 当前事实。" },
    composing: { label: "正在组合代码", tone: "default", next: "组合来源分支并创建或复用 Integration PR。" },
    waiting_checks: { label: "正在检查 CI", tone: "default", next: "等待 GitHub 检查完成，失败时由 Agent 修复。" },
    needs_work: { label: "正在修复", tone: "default", next: "Agent 正在处理 CI、冲突或 Review 反馈。" },
    working: { label: "正在修复", tone: "default", next: "Agent 正在处理 CI、冲突或 Review 反馈。" },
    in_review: { label: "正在独立复核", tone: "default", next: "等待当前 PR head 的独立 Review 结论。" },
    approved: { label: "准备合并", tone: "default", next: "Merge Gateway 将重新核验 PR、CI 和 Review。" },
    merging: { label: "正在合并", tone: "default", next: "Merge Gateway 正在以 GitHub 当前事实完成合并。" },
    blocked: { label: "需要人工处理", tone: "destructive", next: "请查看下方明确的阻塞原因。", humanIssue: details.candidate.lastError },
    needs_human: { label: "需要人工处理", tone: "destructive", next: "请查看下方明确的阻塞原因。", humanIssue: details.candidate.lastError },
    canceled: { label: "已取消", tone: "destructive", next: "该集成已取消，不会继续自动执行。", humanIssue: details.candidate.lastError },
  };
  return states[details.candidate.state] ?? { label: "正在推进", tone: "default", next: "Agent 正在读取 GitHub 当前事实并继续执行。" };
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
      setError(caught instanceof Error ? caught.message : "加载集成进展失败");
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
  const progress = details ? agentProgress(details) : null;

  return (
    <div aria-label="Integration Agent 状态" className="mt-2 space-y-1.5 rounded-md border border-blue-300/50 bg-blue-50/50 p-2 text-xs dark:bg-blue-950/20">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-blue-800 dark:text-blue-200">Integration Agent</span>
        {progress ? <Badge variant={progress.tone}>{progress.label}</Badge> : null}
      </div>
      {progress ? <p className="text-muted-foreground">{progress.next}</p> : loading ? <span className="inline-flex items-center gap-1 text-muted-foreground"><LoaderCircle className="size-3 animate-spin" />加载进展...</span> : null}
      {error ? <p role="alert" className="text-destructive"><TriangleAlert className="mr-1 inline size-3" />刷新失败，保留上次数据：{error}</p> : null}
    </div>
  );
}

export function IntegrationCandidateDetails({
  taskId,
  state,
}: {
  taskId: string;
  state?: ReturnType<typeof useIntegrationCandidate>;
}) {
  const internal = useIntegrationCandidate(taskId, !state);
  const { details, loading, error, refresh } = state ?? internal;
  const [requeueing, setRequeueing] = useState(false);
  const [requeueError, setRequeueError] = useState<string | null>(null);
  const progress = useMemo(() => details ? agentProgress(details) : null, [details]);
  const requeue = async () => {
    const reason = window.prompt("请输入重新排队原因（至少 3 个字符，将写入审计日志）")?.trim();
    if (!reason) return;
    if (reason.length < 3) { setRequeueError("重新排队原因至少需要 3 个字符"); return; }
    if (!window.confirm(`确认重新排队该永久失败的 Integration Agent？\n原因：${reason}`)) return;
    setRequeueing(true);
    setRequeueError(null);
    try { await api.requeueIntegrationCandidate(taskId, reason); await refresh(); }
    catch (caught) { setRequeueError(caught instanceof Error ? caught.message : "重新排队失败"); }
    finally { setRequeueing(false); }
  };
  const canRequeue = details?.worker?.status === "failed" || details?.cleanup?.outcome === "failed";

  return (
    <section aria-label="Integration Agent 详情" className="mb-6 space-y-3 rounded-lg border border-blue-300/50 bg-blue-50/30 p-4 dark:bg-blue-950/20">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Integration Agent</h3>
          <p className="mt-1 text-xs text-muted-foreground">GitHub PR 是代码事实源；这里仅展示 Agent 当前进展与真正需要人工处理的问题。</p>
        </div>
        {progress ? <Badge variant={progress.tone}>{progress.label}</Badge> : null}
      </div>
      {loading && !details ? <p className="inline-flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在读取集成进展...</p> : null}
      {details && progress ? <>
        <dl className="grid gap-2 text-xs sm:grid-cols-2">
          <div><dt className="text-muted-foreground">集成分支</dt><dd className="break-all font-mono"><GitBranch className="mr-1 inline size-3" />{details.candidate.branch}</dd></div>
          <div><dt className="text-muted-foreground">Integration PR</dt><dd className="break-all font-mono">{details.candidate.providerPullRequestId ?? "Agent 正在创建或对账"}</dd></div>
          <div><dt className="text-muted-foreground">下一步</dt><dd>{progress.next}</dd></div>
          <div><dt className="text-muted-foreground">最后刷新</dt><dd><time dateTime={details.lastRefreshedAt}>{new Date(details.lastRefreshedAt).toLocaleString("zh-CN")}</time></dd></div>
        </dl>
        {progress.humanIssue ? <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive"><TriangleAlert className="mr-1 inline size-3.5" />需要人工：{progress.humanIssue}</div> : null}
        {canRequeue ? <Button type="button" variant="destructive" size="sm" disabled={requeueing} onClick={() => void requeue()}>{requeueing ? "重新排队中..." : "Maintainer 重新排队"}</Button> : null}
      </> : !loading ? <p className="text-sm text-muted-foreground">尚无 Integration Agent 进展。</p> : null}
      {requeueError ? <p role="alert" className="text-xs text-destructive">{requeueError}</p> : null}
      {error ? <p role="alert" className="text-sm text-destructive">刷新失败，当前显示上次数据：{error}</p> : null}
    </section>
  );
}
