/** Run 追踪：列表视图（筛选 + run 表格） */
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { EntityLink } from "@/components/PlatformAdmin/common";
import { RUN_LABEL, formatChannel } from "@/components/PlatformAdmin/displayText";

import { runTraceApi } from "./api";
import { formatMs, formatTime, runDurationMs } from "./format";
import { RunStatusBadge } from "./StatusBadge";
import type { RecentRunSummary } from "./types";

/** 时间窗快捷选项 */
const HOURS_OPTIONS: { value: number; label: string }[] = [
  { value: 24, label: "24 小时" },
  { value: 72, label: "72 小时" },
  { value: 168, label: "7 天" },
];

/** 状态分组快捷筛选 */
type StatusGroup = "all" | "failed" | "active";

const STATUS_GROUP_OPTIONS: { value: StatusGroup; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "failed", label: "失败" },
  { value: "active", label: "进行中" },
];

const STATUS_GROUP_QUERY: Record<StatusGroup, string | undefined> = {
  all: undefined,
  failed: "failed,cancelled",
  active: "pending,running,waiting_approval,waiting_user,waiting_hand",
};

export function RunListView({ onSelectRun }: { onSelectRun: (runId: string) => void }) {
  const [hours, setHours] = useState(24);
  const [statusGroup, setStatusGroup] = useState<StatusGroup>("all");
  const [runs, setRuns] = useState<RecentRunSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [jumpId, setJumpId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await runTraceApi.recentRuns({
        hours,
        limit: 100,
        status: STATUS_GROUP_QUERY[statusGroup],
      });
      setRuns(resp.runs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [hours, statusGroup]);

  useEffect(() => {
    void load();
  }, [load]);

  /** runId / sessionId 直接跳转：先在已加载列表按 sessionId 匹配，否则按 runId 打开详情 */
  const onJump = useCallback(() => {
    const id = jumpId.trim();
    if (!id) return;
    const bySession = runs?.find((r) => r.sessionId === id);
    onSelectRun(bySession ? bySession.runId : id);
  }, [jumpId, onSelectRun, runs]);

  return (
    <div className="space-y-4">
      {/* 筛选条 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center rounded-md border bg-card p-0.5">
          {HOURS_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setHours(opt.value)}
              className={cn(
                "rounded px-3 py-1 text-xs font-medium transition-colors",
                hours === opt.value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="inline-flex items-center rounded-md border bg-card p-0.5">
          {STATUS_GROUP_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setStatusGroup(opt.value)}
              className={cn(
                "rounded px-3 py-1 text-xs font-medium transition-colors",
                statusGroup === opt.value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn("mr-1 h-3.5 w-3.5", loading && "animate-spin")} />
          刷新
        </Button>
        <div className="ml-auto flex items-center gap-1.5">
          <Input
            value={jumpId}
            onChange={(e) => setJumpId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onJump();
            }}
            placeholder="运行 ID / 会话 ID 直达"
            className="h-8 w-56 font-mono text-xs"
          />
          <Button variant="outline" size="sm" onClick={onJump} disabled={!jumpId.trim()}>
            <ArrowRight className="h-3.5 w-3.5" />
            跳转
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">加载失败：{error}</div>
      )}

      <Card>
        <CardContent className="p-0">
          {loading && !runs ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载运行列表...
            </div>
          ) : !runs || runs.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">时间窗内没有匹配的运行记录</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>状态</TableHead>
	                  <TableHead>{RUN_LABEL}</TableHead>
                  <TableHead>会话</TableHead>
                  <TableHead>组织 / 用户</TableHead>
                  <TableHead>模型</TableHead>
                  <TableHead>渠道</TableHead>
                  <TableHead className="text-right">耗时</TableHead>
                  <TableHead>开始</TableHead>
                  <TableHead>结束</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => {
                  const endAt = run.completedAt ?? run.failedAt ?? run.cancelledAt;
                  const duration = run.durationMs ?? runDurationMs(run);
                  return (
                    <TableRow
                      key={run.runId}
                      className="cursor-pointer hover:bg-muted/30"
                      onClick={() => onSelectRun(run.runId)}
                    >
                      <TableCell>
                        <div className="space-y-1">
                          <RunStatusBadge status={run.status} />
                          {run.statusReason && (
                            <div className="max-w-44 truncate text-[11px] text-muted-foreground" title={run.statusReason}>
                              {run.statusReason}
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <EntityLink kind="run" id={run.runId} />
                      </TableCell>
                      <TableCell>
                        <EntityLink kind="session" id={run.sessionId} />
                      </TableCell>
                      <TableCell>
                        <div><EntityLink kind="tenant" id={run.tenantId} /></div>
                        <div className="text-xs text-muted-foreground"><EntityLink kind="user" id={run.userId} /></div>
                      </TableCell>
                      <TableCell className="max-w-44 truncate font-mono text-xs" title={run.model ?? undefined}>
                        {run.model ?? "—"}
                      </TableCell>
                      <TableCell className="text-xs">{run.channel ? formatChannel(run.channel) : "—"}</TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">{formatMs(duration)}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">
                        {formatTime(run.startedAt ?? run.requestedAt)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">
                        {formatTime(endAt)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {runs && runs.length > 0 && (
        <div className="text-xs text-muted-foreground">
          共 {runs.length} 条（上限 100，按最近更新排序）· 点击行查看事件时间线
        </div>
      )}
    </div>
  );
}
