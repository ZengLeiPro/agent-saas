/** Run 追踪：单 run 详情（汇总头卡 + 事件时间线 + 工具/成本统计） */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, FileText, Loader2, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatTokens } from "@/components/UsageDashboard/format";
import { EntityLink } from "@/components/PlatformAdmin/common";
import { RUN_LABEL, WORKSPACE_LABEL, formatChannel, formatExecutionTarget } from "@/components/PlatformAdmin/displayText";

import { runTraceApi } from "./api";
import { formatMs, formatTime, formatYuan, runDurationMs } from "./format";
import { RunStatusBadge } from "./StatusBadge";
import {
  ApprovalPairItem,
  AssistantMessageItem,
  GenericEventNode,
  HandFailureItem,
  MemoryContextItem,
  OrphanToolEventItem,
  RunFinishedItem,
  RunStateChangedNode,
  ThinkingItem,
  ToolCallsItem,
  UserMessageItem,
} from "./TimelineItems";
import type { RunEventsResponse, TraceEvent } from "./types";

const FULL_CONTENT_LENGTH = 65536;

/** 工具聚合行（前端从 tool_audit 自聚合） */
interface ToolAggRow {
  toolName: string;
  calls: number;
  errors: number;
  totalDurationMs: number;
}

function aggregateToolAudits(events: TraceEvent[]): ToolAggRow[] {
  const map = new Map<string, ToolAggRow>();
  for (const e of events) {
    if (e.type !== "tool_audit") continue;
    const name = e.toolName ?? "（未知）";
    const row = map.get(name) ?? { toolName: name, calls: 0, errors: 0, totalDurationMs: 0 };
    row.calls += 1;
    if (e.status === "error") row.errors += 1;
    if (typeof e.durationMs === "number") row.totalDurationMs += e.durationMs;
    map.set(name, row);
  }
  return [...map.values()].sort((a, b) => b.calls - a.calls).slice(0, 10);
}

function StatItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-sm font-medium">{children}</div>
    </div>
  );
}

export function RunDetailView({ runId, onBack }: { runId: string; onBack: () => void }) {
  const [data, setData] = useState<RunEventsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 是否已用 maxContentLength=65536 重拉过全文 */
  const [fullLoaded, setFullLoaded] = useState(false);
  const [loadingFull, setLoadingFull] = useState(false);

  const load = useCallback(
    async (mode: "default" | "full" = "default") => {
      if (mode === "full") setLoadingFull(true);
      else setLoading(true);
      setError(null);
      try {
        const resp = await runTraceApi.runEvents(
          runId,
          mode === "full" ? { maxContentLength: FULL_CONTENT_LENGTH } : {},
        );
        setData(resp);
        if (mode === "full") setFullLoaded(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
        setLoadingFull(false);
      }
    },
    [runId],
  );

  useEffect(() => {
    setData(null);
    setFullLoaded(false);
    void load();
  }, [load]);

  // ── 事件关联：toolCallId → result/audit；approvalId → resolved；被吸收的事件不再单独渲染 ──
  const { resultByCallId, auditByCallId, resolvedByApprovalId, consumedIds } = useMemo(() => {
    const resultByCallId = new Map<string, TraceEvent>();
    const auditByCallId = new Map<string, TraceEvent>();
    const resolvedByApprovalId = new Map<string, TraceEvent>();
    const consumedIds = new Set<string>();
    const events = data?.events ?? [];
    for (const e of events) {
      if (e.type === "tool_result" && e.toolCallId) resultByCallId.set(e.toolCallId, e);
      else if (e.type === "tool_audit" && e.toolCallId) auditByCallId.set(e.toolCallId, e);
      else if (e.type === "approval_resolved" && e.approvalId) resolvedByApprovalId.set(e.approvalId, e);
    }
    for (const e of events) {
      if (e.type === "assistant_tool_calls") {
        for (const call of e.toolCalls ?? []) {
          const r = resultByCallId.get(call.id);
          if (r) consumedIds.add(r.id);
          const a = auditByCallId.get(call.id);
          if (a) consumedIds.add(a.id);
        }
      } else if (e.type === "approval_requested" && e.approvalId) {
        const resolved = resolvedByApprovalId.get(e.approvalId);
        if (resolved) consumedIds.add(resolved.id);
      }
    }
    return { resultByCallId, auditByCallId, resolvedByApprovalId, consumedIds };
  }, [data?.events]);

  const runFinished = useMemo(
    () => data?.events.find((e) => e.type === "run_finished"),
    [data?.events],
  );
  const toolAgg = useMemo(() => aggregateToolAudits(data?.events ?? []), [data?.events]);
  const hasTruncated = useMemo(
    () => (data?.events ?? []).some((e) => e.truncated === true),
    [data?.events],
  );

  const backButton = (
    <Button variant="outline" size="sm" onClick={onBack}>
      <ArrowLeft className="size-3.5" />
      返回列表
    </Button>
  );

  if (loading && !data) {
    return (
      <div className="space-y-4">
        {backButton}
        <div className="flex h-40 items-center justify-center rounded-2xl border bg-card text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" /> 加载运行详情...
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="space-y-4">
        {backButton}
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          加载失败：{error}
        </div>
      </div>
    );
  }

  if (!data) return null;

  const { run, billing } = data;
  const duration = runDurationMs(run);
  const failureReason = run.statusReason ?? runFinished?.error ?? null;
  const maxToolDuration = Math.max(...toolAgg.map((t) => t.totalDurationMs), 1);

  return (
    <div className="space-y-4">
      {/* 顶部操作条 */}
      <div className="flex flex-wrap items-center gap-2">
        {backButton}
        <Button variant="outline" size="sm" onClick={() => void load(fullLoaded ? "full" : "default")} disabled={loading || loadingFull}>
          <RefreshCw className={cn("mr-1 size-3.5", (loading || loadingFull) && "animate-spin")} />
          刷新
        </Button>
        {hasTruncated && !fullLoaded && (
          <Button variant="outline" size="sm" onClick={() => void load("full")} disabled={loadingFull}>
            {loadingFull ? <Loader2 className="size-3.5 animate-spin" /> : <FileText className="size-3.5" />}
            加载全文
          </Button>
        )}
        {hasTruncated && !fullLoaded && (
          <span className="text-xs text-muted-foreground">部分长文本已被截断，点「加载全文」查看完整内容</span>
        )}
        {error && <span className="text-xs text-destructive">刷新失败：{error}</span>}
      </div>

      {/* 汇总头卡 */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-2">
            <RunStatusBadge status={run.status} />
            <span className="text-xs text-muted-foreground">{RUN_LABEL}</span>
            <EntityLink kind="run" id={data.runId} short={12} />
            <span className="text-xs text-muted-foreground">会话</span>
            <EntityLink kind="session" id={data.sessionId} short={12} />
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {formatTime(run.startedAt ?? run.requestedAt)} → {formatTime(run.completedAt ?? run.failedAt ?? run.cancelledAt)}
            </span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatItem label="耗时">{formatMs(duration)}</StatItem>
            <StatItem label="轮次">{runFinished?.numTurns != null ? runFinished.numTurns : "—"}</StatItem>
            <StatItem label="模型">
              <span className="font-mono text-xs" title={billing.models.join(", ") || (run.model ?? "")}>
                {billing.models.length > 0 ? billing.models.join(", ") : run.model ?? "—"}
              </span>
            </StatItem>
            <StatItem label="本次运行成本">
              <span className="tabular-nums">{formatYuan(billing.totalCostYuan)}</span>
            </StatItem>
            <StatItem label="Token（输入/缓存/输出/推理）">
              <span className="font-mono text-xs tabular-nums">
                {formatTokens(billing.inputTokens)} / {formatTokens(billing.cachedInputTokens)} / {formatTokens(billing.outputTokens)} / {formatTokens(billing.reasoningTokens)}
              </span>
            </StatItem>
            <StatItem label="执行目标">{run.executionTarget ? formatExecutionTarget(run.executionTarget) : "—"}</StatItem>
            <StatItem label="组织 / 用户">
              <EntityLink kind="tenant" id={run.tenantId} /> / <EntityLink kind="user" id={run.userId} />
            </StatItem>
            <StatItem label="渠道">{run.channel ? formatChannel(run.channel) : "—"}</StatItem>
            <StatItem label="模型请求数">{billing.requestCount}</StatItem>
            <StatItem label={WORKSPACE_LABEL}>
              <span className="font-mono text-xs" title={run.workspaceId ?? undefined}>{run.workspaceId ?? "—"}</span>
            </StatItem>
            <StatItem label="累计输入 Token">{formatTokens(run.cumulativeInputTokens)}</StatItem>
          </div>
          {failureReason && (
            <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              失败原因：{failureReason}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(300px,0.9fr)]">
        {/* 时间线 */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">
              事件时间线 <span className="text-xs font-normal text-muted-foreground">· {data.events.length} 条事件</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data.events.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">没有事件记录</div>
            ) : (
              <div>
                {data.events.map((event) => {
                  if (consumedIds.has(event.id)) return null;
                  switch (event.type) {
                    case "user_message":
                      return <UserMessageItem key={event.id} event={event} />;
                    case "memory_context":
                      return <MemoryContextItem key={event.id} event={event} />;
                    case "assistant_thinking":
                      return <ThinkingItem key={event.id} event={event} />;
                    case "assistant_message":
                      return <AssistantMessageItem key={event.id} event={event} />;
                    case "assistant_tool_calls":
                      return (
                        <ToolCallsItem
                          key={event.id}
                          event={event}
                          resultByCallId={resultByCallId}
                          auditByCallId={auditByCallId}
                        />
                      );
                    case "tool_result":
                    case "tool_audit":
                      return <OrphanToolEventItem key={event.id} event={event} />;
                    case "approval_requested":
                      return (
                        <ApprovalPairItem
                          key={event.id}
                          event={event}
                          resolved={event.approvalId ? resolvedByApprovalId.get(event.approvalId) : undefined}
                        />
                      );
                    case "approval_resolved":
                      // 未被 approval_requested 吸收的孤儿 resolved
                      return (
                        <GenericEventNode key={event.id} event={event} />
                      );
                    case "hand_failure":
                      return <HandFailureItem key={event.id} event={event} />;
                    case "run_state_changed":
                      return <RunStateChangedNode key={event.id} event={event} />;
                    case "run_finished":
                      return <RunFinishedItem key={event.id} event={event} />;
                    default:
                      return <GenericEventNode key={event.id} event={event} />;
                  }
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 侧栏统计 */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">工具调用前 10</CardTitle>
            </CardHeader>
            <CardContent>
              {toolAgg.length === 0 ? (
                <div className="py-4 text-center text-xs text-muted-foreground">本次运行无工具调用</div>
              ) : (
                <div className="space-y-1.5">
                  {toolAgg.map((t) => (
                    <div key={t.toolName} className="text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-mono" title={t.toolName}>{t.toolName}</span>
                        <span className="shrink-0 text-muted-foreground tabular-nums">
                          {t.calls} 次 · {formatMs(t.totalDurationMs)}
                          {t.errors > 0 && <span className="ml-1 text-destructive">{t.errors} 失败</span>}
                        </span>
                      </div>
                      <div className="mt-0.5 h-1.5 overflow-hidden rounded bg-muted">
                        <div
                          className={cn("h-full rounded", t.errors > 0 ? "bg-destructive/70" : "bg-primary/60")}
                          style={{ width: `${(t.totalDurationMs / maxToolDuration) * 100}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">
                逐请求成本 <span className="text-xs font-normal text-muted-foreground">· 共 {formatYuan(billing.totalCostYuan)}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {billing.requests.length === 0 ? (
                <div className="py-4 text-center text-xs text-muted-foreground">无计费记录</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8">#</TableHead>
                      <TableHead>模型</TableHead>
                      <TableHead className="text-right">输入/缓存/输出</TableHead>
                      <TableHead className="text-right">成本</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {billing.requests.map((req) => (
                      <TableRow key={`${req.requestIndex}-${req.createdAt}`}>
                        <TableCell className="text-xs tabular-nums">{req.requestIndex}</TableCell>
                        <TableCell className="max-w-32 truncate font-mono text-xs" title={req.actualModel}>
                          {req.actualModel}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right font-mono text-xs tabular-nums">
                          {formatTokens(req.inputTokens)}/{formatTokens(req.cachedInputTokens)}/{formatTokens(req.outputTokens)}
                          {req.reasoningTokens > 0 && (
                            <Badge variant="outline" className="ml-1 text-[9px]">推理 {formatTokens(req.reasoningTokens)}</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">{formatYuan(req.costYuan)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
