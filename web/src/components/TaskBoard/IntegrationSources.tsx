import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TaskBoardIntegrationSource } from "@agent/shared/types/taskboard";
import { CircleCheck, GitCommitHorizontal, LoaderCircle, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import * as api from "./api";
import { INTEGRATION_SOURCE_STATE_LABELS } from "./constants";

export function useIntegrationSources(taskId: string | null, active = true) {
  const [sources, setSources] = useState<TaskBoardIntegrationSource[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const loadedTaskIdRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current;
    setError(null);
    if (!taskId || !active) {
      loadedTaskIdRef.current = taskId;
      setSources([]);
      setLoading(false);
      return;
    }
    if (loadedTaskIdRef.current !== taskId) {
      loadedTaskIdRef.current = taskId;
      setSources([]);
    }
    setLoading(true);
    try {
      const next = await api.fetchIntegrationSources(taskId);
      if (requestRef.current !== requestId) return;
      setSources(next);
    } catch (caught) {
      if (requestRef.current !== requestId) return;
      // Keep the last successful projection visible; a refresh failure must not regress progress to 0/0.
      setError(caught instanceof Error ? caught.message : "加载集成来源失败");
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [active, taskId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { sources, loading, error, refresh };
}

export function IntegrationCardSummary({ taskId }: { taskId: string }) {
  const { sources, loading, error } = useIntegrationSources(taskId);
  const merged = sources.filter((source) => source.state === "merged").length;
  const problem = sources.find((source) => source.state === "needs_human" && source.lastError);
  const activeStates = useMemo(() => Array.from(new Set(
    sources.filter((source) => source.state !== "merged").map((source) => source.state),
  )), [sources]);

  return (
    <div className="mt-2 space-y-1.5 rounded-md border border-violet-300/40 bg-violet-50/50 p-2 text-xs dark:bg-violet-950/20">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-violet-800 dark:text-violet-200">来源进度</span>
        <span>{loading && sources.length === 0 ? "加载中" : `${merged}/${sources.length} 已合并`}</span>
      </div>
      {activeStates.length ? (
        <div className="flex flex-wrap gap-1">
          {activeStates.map((state) => <Badge key={state} variant="outline" className="font-normal">{INTEGRATION_SOURCE_STATE_LABELS[state]}</Badge>)}
        </div>
      ) : null}
      {problem ? <p className="line-clamp-2 text-destructive" title={problem.lastError}><TriangleAlert className="mr-1 inline size-3" />{problem.lastError}</p> : null}
      {error ? <p className="text-destructive">{error}</p> : null}
    </div>
  );
}

export function IntegrationSourceDetails({
  taskId,
  state,
  onNavigateTask,
}: {
  taskId: string;
  state?: ReturnType<typeof useIntegrationSources>;
  onNavigateTask?: (taskId: string) => void;
}) {
  const internal = useIntegrationSources(taskId, !state);
  const { sources, loading, error } = state ?? internal;
  const merged = sources.filter((source) => source.state === "merged").length;

  return (
    <section aria-label="集成来源" className="mb-6 space-y-3 rounded-lg border border-violet-300/40 bg-violet-50/30 p-4 dark:bg-violet-950/20">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">集成来源</h3>
          <p className="mt-1 text-xs text-muted-foreground">本批次输入摘要；具体组合、修复和合并由同一个 Integration Agent 自主处理。</p>
        </div>
        <Badge variant="outline">{merged}/{sources.length} 已合并</Badge>
      </div>
      {loading && sources.length === 0 ? <p className="inline-flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在加载来源...</p> : null}
      {sources.map((source) => (
        <article key={source.id} className="space-y-2 rounded-md border bg-background/80 p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                className="min-w-0 truncate text-left font-medium text-primary hover:underline"
                onClick={() => onNavigateTask?.(source.deliveryTaskId)}
                disabled={!onNavigateTask}
              >
                #{source.order + 1} · {source.deliveryTaskIdentifier ?? `交付任务 ${source.deliveryTaskId}`}
                {source.deliveryTaskTitle ? ` · ${source.deliveryTaskTitle}` : ""}
              </button>
            </div>
            <Badge variant={source.state === "merged" ? "secondary" : "outline"}>{INTEGRATION_SOURCE_STATE_LABELS[source.state]}</Badge>
          </div>
          {source.providerPullRequestId ? (
            <dl className="text-xs text-muted-foreground">
              <div><dt className="inline">PR：</dt><dd className="inline font-mono">{source.providerPullRequestId}</dd></div>
            </dl>
          ) : null}
          {source.mergedCommitOid ? (
            <p className="flex items-center gap-1 break-all text-xs text-emerald-700 dark:text-emerald-400"><GitCommitHorizontal className="size-3.5 shrink-0" />merged commit {source.mergedCommitOid}</p>
          ) : null}
          {source.state === "needs_human" && source.lastError ? <p className="whitespace-pre-wrap text-xs text-destructive"><TriangleAlert className="mr-1 inline size-3.5" />{source.lastError}</p> : null}
          {source.state === "merged" && !source.lastError ? <p className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400"><CircleCheck className="size-3.5" />来源已完成</p> : null}
        </article>
      ))}
      {!loading && sources.length === 0 ? <p className="text-sm text-muted-foreground">暂无集成来源。</p> : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </section>
  );
}
