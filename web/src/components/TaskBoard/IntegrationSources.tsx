import { useCallback, useEffect, useMemo, useState } from "react";
import type { TaskBoardIntegrationSource } from "@agent/shared/types/taskboard";
import { CircleCheck, GitCommitHorizontal, LoaderCircle, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import * as api from "./api";
import { INTEGRATION_SOURCE_STATE_LABELS } from "./constants";

export function useIntegrationSources(taskId: string | null, active = true) {
  const [sources, setSources] = useState<TaskBoardIntegrationSource[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!taskId || !active) {
      setSources([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setSources(await api.fetchIntegrationSources(taskId));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "加载集成来源失败");
    } finally {
      setLoading(false);
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
  const problem = sources.find((source) => source.lastError);
  const activeStates = useMemo(() => Array.from(new Set(
    sources.filter((source) => source.state !== "merged").map((source) => source.state),
  )), [sources]);

  return (
    <div className="mt-2 space-y-1.5 rounded-md border border-violet-300/40 bg-violet-50/50 p-2 text-xs dark:bg-violet-950/20">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-violet-800 dark:text-violet-200">来源进度</span>
        <span>{loading ? "加载中" : `${merged}/${sources.length} 已合并`}</span>
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

export function IntegrationSourceDetails({ taskId }: { taskId: string }) {
  const { sources, loading, error } = useIntegrationSources(taskId);
  const merged = sources.filter((source) => source.state === "merged").length;

  return (
    <section aria-label="集成来源" className="mb-6 space-y-3 rounded-lg border border-violet-300/40 bg-violet-50/30 p-4 dark:bg-violet-950/20">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">集成来源</h3>
          <p className="mt-1 text-xs text-muted-foreground">按已复核的 PR 身份逐项校验、合并；失败来源不会掩盖其他来源进度。</p>
        </div>
        <Badge variant="outline">{merged}/{sources.length} 已合并</Badge>
      </div>
      {loading && sources.length === 0 ? <p className="inline-flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在加载来源...</p> : null}
      {sources.map((source) => (
        <article key={source.id} className="space-y-2 rounded-md border bg-background/80 p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">#{source.order + 1} · 交付任务 {source.deliveryTaskId}</span>
            <Badge variant={source.state === "merged" ? "secondary" : "outline"}>{INTEGRATION_SOURCE_STATE_LABELS[source.state]}</Badge>
          </div>
          <dl className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
            <div><dt className="inline">PR：</dt><dd className="inline font-mono">{source.providerPullRequestId}</dd></div>
            <div><dt className="inline">尝试：</dt><dd className="inline">{source.attemptCount} 次</dd></div>
            <div className="sm:col-span-2"><dt className="inline">复核对象：</dt><dd className="inline break-all font-mono">{source.reviewedSubjectDigest}</dd></div>
          </dl>
          {source.mergedCommitOid ? (
            <p className="flex items-center gap-1 break-all text-xs text-emerald-700 dark:text-emerald-400"><GitCommitHorizontal className="size-3.5 shrink-0" />merged commit {source.mergedCommitOid}</p>
          ) : null}
          {source.lastError ? <p className="whitespace-pre-wrap text-xs text-destructive"><TriangleAlert className="mr-1 inline size-3.5" />{source.lastError}</p> : null}
          {source.state === "merged" && !source.lastError ? <p className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400"><CircleCheck className="size-3.5" />来源已完成</p> : null}
        </article>
      ))}
      {!loading && sources.length === 0 ? <p className="text-sm text-muted-foreground">暂无集成来源。</p> : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </section>
  );
}
