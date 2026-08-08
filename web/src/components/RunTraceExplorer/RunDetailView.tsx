/** Run 追踪：单 run 详情（汇总头卡 + 事件时间线 + 工具/成本统计） */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, FileText, Inbox, ListFilter, Loader2, RefreshCw, SearchX, Wrench } from "lucide-react";
import { EntityIcons } from "@/lib/icons";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { navigatePlatformAdmin } from "@/lib/urlSync";
import { formatTokens } from "@/components/UsageDashboard/format";
import { AdminErrorAlert, EmptyState, EntityLink, MetricStat } from "@/components/PlatformAdmin/common";
import { RUN_LABEL, SESSION_LABEL, WORKSPACE_LABEL, formatChannel, formatExecutionTarget, formatToolName } from "@/components/PlatformAdmin/displayText";
import { classifyFailureReason } from "@/components/PlatformAdmin/errorText";
import { useModelDisplayMap } from "@/components/TenantAnalytics/hooks";

import { runTraceApi } from "./api";
import { formatMs, formatTime, formatYuan, runDurationMs } from "./format";
import { failureQueryKeyword, resolveRunCancellationReason, resolveRunFailureReason } from "./runStatus";
import { spanKindOf } from "./spanKind";
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
  SpanKindLegend,
  SubagentPairItem,
  ThinkingItem,
  TimelineFrameProvider,
  ToolCallsItem,
  UserMessageItem,
  type SubagentDrillTarget,
  type TimelineFrame,
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

/* 本视图原有的 StatItem 已删除，改用 `common/MetricStat`（S3-7）：
   它是「标签 + 数值」的密集网格形态，与 MetricCard 同一模块、不同外观——
   这 11 项放在一张卡的 6 列网格里，换成 11 张卡会把一屏拉成三屏。 */

export function RunDetailView({
  runId,
  onBack,
  backLabel = "返回列表",
  breadcrumb,
  onDrillSubagent,
}: {
  runId: string;
  onBack: () => void;
  /** 下钻到子 agent 后，返回按钮语义变成「回上一层」而不是「回列表」 */
  backLabel?: string;
  /** 子 agent 下钻路径（由 RunTraceExplorer 维护，详情视图只负责展示） */
  breadcrumb?: ReactNode;
  onDrillSubagent?: (target: SubagentDrillTarget) => void;
}) {
  const { labelFor } = useModelDisplayMap();
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
  const { resultByCallId, auditByCallId, resolvedByApprovalId, subagentByCallId, subagentFinishedByKey, consumedIds } = useMemo(() => {
    const resultByCallId = new Map<string, TraceEvent>();
    const auditByCallId = new Map<string, TraceEvent>();
    const resolvedByApprovalId = new Map<string, TraceEvent>();
    /** Agent 工具调用 id → subagent_started（让工具调用行直接给出子 agent 下钻入口） */
    const subagentByCallId = new Map<string, TraceEvent>();
    /** toolCallId（缺失时退回 childRunId）→ subagent_finished */
    const subagentFinishedByKey = new Map<string, TraceEvent>();
    const consumedIds = new Set<string>();
    const events = data?.events ?? [];
    /** 子 agent 成对匹配键：优先 toolCallId（父 run 内唯一），存量事件缺失时退回 childRunId */
    const subagentKey = (e: TraceEvent): string | null => e.toolCallId ?? (typeof e.childRunId === "string" ? e.childRunId : null);
    for (const e of events) {
      if (e.type === "tool_result" && e.toolCallId) resultByCallId.set(e.toolCallId, e);
      else if (e.type === "tool_audit" && e.toolCallId) auditByCallId.set(e.toolCallId, e);
      else if (e.type === "approval_resolved" && e.approvalId) resolvedByApprovalId.set(e.approvalId, e);
      else if (e.type === "subagent_started") {
        if (e.toolCallId) subagentByCallId.set(e.toolCallId, e);
      } else if (e.type === "subagent_finished") {
        const key = subagentKey(e);
        if (key) subagentFinishedByKey.set(key, e);
      }
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
      } else if (e.type === "subagent_started") {
        const key = subagentKey(e);
        const finished = key ? subagentFinishedByKey.get(key) : undefined;
        if (finished) consumedIds.add(finished.id);
      }
    }
    return { resultByCallId, auditByCallId, resolvedByApprovalId, subagentByCallId, subagentFinishedByKey, consumedIds };
  }, [data?.events]);

  /** 折叠掉被吸收事件后的可见序列——轴线要知道谁是最后一个节点，否则尾部拖一条没有终点的线 */
  const visibleEvents = useMemo(
    () => (data?.events ?? []).filter((event) => !consumedIds.has(event.id)),
    [consumedIds, data?.events],
  );

  /** 本次运行出现过的事件类型（图例只列实际出现的，不摆一排用不上的颜色） */
  const presentKinds = useMemo(() => new Set(visibleEvents.map((event) => spanKindOf(event.type))), [visibleEvents]);

  /**
   * 时间线坐标系：
   *   - 相对时间 0 点取「run 起点 / 入队时刻 / 最早事件」三者最小值，保证没有负偏移；
   *   - 耗时条基准优先用本次运行总耗时（每条的宽度=占整个 run 的比例，口径最直观），
   *     运行未结束拿不到总耗时时退回「最长单步耗时」，并在 title 里写明用的是哪把尺子。
   */
  const timelineFrame = useMemo<TimelineFrame>(() => {
    const events = data?.events ?? [];
    const run = data?.run;
    const stamps = [run?.startedAt, run?.requestedAt, ...events.map((event) => event.timestamp)]
      .map((value) => (value ? new Date(value).getTime() : Number.NaN))
      .filter((value) => Number.isFinite(value));
    const origin = stamps.length > 0 ? new Date(Math.min(...stamps)).toISOString() : null;
    const runMs = run ? runDurationMs(run) : null;
    const stepMs = events
      .map((event) => (typeof event.durationMs === "number" ? event.durationMs : 0))
      .reduce((max, value) => Math.max(max, value), 0);
    if (runMs != null && runMs > 0) return { origin, basisMs: runMs, basisLabel: "本次运行总耗时", onDrillSubagent };
    return { origin, basisMs: stepMs > 0 ? stepMs : null, basisLabel: "最长单步耗时", onDrillSubagent };
  }, [data?.events, data?.run, onDrillSubagent]);

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
      {backLabel}
    </Button>
  );

  if (loading && !data) {
    return (
      <div className="space-y-4">
        {backButton}
        {breadcrumb}
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
        {breadcrumb}
        <AdminErrorAlert error={error} />
      </div>
    );
  }

  // 既没在加载、也没有错误、还是拿不到数据（后端返回空体 / 记录已过保留期）：
  // 改造前这里 `return null` 直接渲染整片白屏，连返回按钮都没有，用户只能按浏览器后退。
  if (!data) {
    return (
      <div className="space-y-4">
        {backButton}
        {breadcrumb}
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={SearchX}
              title="没有取到这次执行的详情"
              description="记录可能已超出保留期，或编号不属于当前可见范围。可重新拉取，或回到列表按时间窗重新定位。"
              action={{ label: "重新加载", onClick: () => void load() }}
              secondaryAction={{ label: backLabel, onClick: onBack }}
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  const { run, billing } = data;
  const duration = runDurationMs(run);
  const failureReason = resolveRunFailureReason(run.status, run.statusReason, runFinished?.error);
  const cancellationReason = resolveRunCancellationReason(run.status, run.statusReason);
  const friendlyFailure = failureReason ? classifyFailureReason(failureReason) : null;
  const failureKeyword = failureReason ? failureQueryKeyword(failureReason) : null;
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
      {breadcrumb}
      {data.contentRedacted && (
        <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          当前为脱敏诊断视图：保留状态、耗时、Token、工具名称和错误骨架，原始内容未返回。
        </div>
      )}

      {/* 汇总头卡 */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-2">
            <RunStatusBadge status={run.status} />
            <span className="text-xs text-muted-foreground">{RUN_LABEL}</span>
            <EntityLink kind="run" id={data.runId} short={12} />
            <span className="text-xs text-muted-foreground">{SESSION_LABEL}</span>
            <EntityLink kind="session" id={data.sessionId} short={12} />
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {formatTime(run.startedAt ?? run.requestedAt)} → {formatTime(run.completedAt ?? run.failedAt ?? run.cancelledAt)}
            </span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
            <MetricStat label="耗时">{formatMs(duration)}</MetricStat>
            <MetricStat label="轮次">{runFinished?.numTurns != null ? runFinished.numTurns : "—"}</MetricStat>
            <MetricStat label="模型">
              <span className="text-xs" title={billing.models.join(", ") || (run.model ?? "")}>
                {billing.models.length > 0 ? billing.models.map(labelFor).join("、") : run.model ? labelFor(run.model) : "—"}
              </span>
            </MetricStat>
            <MetricStat label="本次运行成本">
              <span className="tabular-nums">{formatYuan(billing.totalCostYuan)}</span>
            </MetricStat>
            <MetricStat label="Token（输入/缓存/输出/推理）">
              <span className="font-mono text-xs tabular-nums">
                {formatTokens(billing.inputTokens)} / {formatTokens(billing.cachedInputTokens)} / {formatTokens(billing.outputTokens)} / {formatTokens(billing.reasoningTokens)}
              </span>
            </MetricStat>
            <MetricStat label="执行目标">{run.executionTarget ? formatExecutionTarget(run.executionTarget) : "—"}</MetricStat>
            <MetricStat label="组织 / 用户">
              <EntityLink kind="tenant" id={run.tenantId} /> / <EntityLink kind="user" id={run.userId} />
            </MetricStat>
            <MetricStat label="渠道">{run.channel ? formatChannel(run.channel) : "—"}</MetricStat>
            <MetricStat label="模型请求数">{billing.requestCount}</MetricStat>
            <MetricStat label={WORKSPACE_LABEL}>
              {/* workspace kind 的首个调用点：点它跳执行环境列表并按该文件目录预置筛选 */}
              <EntityLink kind="workspace" id={run.workspaceId} short={10} />
            </MetricStat>
            <MetricStat label="累计输入 Token">{formatTokens(run.cumulativeInputTokens)}</MetricStat>
          </div>
          {friendlyFailure && (
            <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <div className="font-medium">失败原因：{friendlyFailure.summary}</div>
              {friendlyFailure.suggestion && <div className="mt-1 text-destructive/80">{friendlyFailure.suggestion}</div>}
              {friendlyFailure.technicalDetail && (
                <details className="mt-2">
                  <summary className="cursor-pointer select-none">技术详情</summary>
                  <div className="mt-1 whitespace-pre-wrap break-all rounded bg-background/70 p-2 font-mono text-foreground">
                    {friendlyFailure.technicalDetail}
                  </div>
                </details>
              )}
              {/* 从一条失败反查同类失败：排障的下一个动作几乎总是「这是个例还是普遍问题」。
                  关键词由原始 statusReason 提炼（去掉每次都不同的 id / 毫秒数），
                  落到执行记录列表已有的 reason 子串筛选上（RunListView 的 reason 参数）。 */}
              {failureKeyword && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    title={`在最近 7 天的失败与取消记录里检索包含「${failureKeyword}」的执行`}
                    onClick={() => navigatePlatformAdmin({
                      section: "runs",
                      search: { status: "failed", reason: failureKeyword, hours: 168 },
                    })}
                  >
                    <ListFilter className="mr-1 size-3.5" />
                    查看同类失败
                  </Button>
                  <span className="text-2xs text-destructive/80">检索关键词：{failureKeyword}</span>
                </div>
              )}
            </div>
          )}
          {cancellationReason && (
            <div className="mt-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-ink">
              <div className="font-medium">执行已取消</div>
              <details className="mt-2">
                <summary className="cursor-pointer select-none">取消详情</summary>
                <div className="mt-1 whitespace-pre-wrap break-all rounded bg-background/70 p-2 font-mono text-foreground">
                  {cancellationReason}
                </div>
              </details>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(300px,0.9fr)]">
        {/* 时间线（TimelineFrameProvider 提供相对时间 0 点、耗时条基准与子 agent 下钻回调） */}
        <TimelineFrameProvider value={timelineFrame}>
        <Card>
          <CardHeader className="space-y-1.5 pb-2">
            <CardTitle>
              事件时间线 <span className="text-xs font-normal text-muted-foreground">· {data.events.length} 条事件</span>
            </CardTitle>
            {/* 口径写在标题下：时间是相对偏移不是绝对时刻、耗时条按什么归一化，都不该让人自己猜 */}
            <div className="text-2xs text-muted-foreground">
              时间为相对起点偏移（悬停看绝对时刻）· 耗时条按{timelineFrame.basisLabel}归一化
            </div>
            <SpanKindLegend kinds={presentKinds} />
          </CardHeader>
          <CardContent>
            {visibleEvents.length === 0 ? (
              <EmptyState
                compact
                icon={Inbox}
                title="没有事件记录"
                description="这次执行没有留下事件，通常是刚入队还没开始，或事件已超出保留期。"
                action={{ label: "重新加载", onClick: () => void load(fullLoaded ? "full" : "default") }}
              />
            ) : (
              /* relative：时间轴（含轻量节点自己画的那段）的定位上下文 */
              <div className="relative">
                {visibleEvents.map((event, index) => {
                  const isLast = index === visibleEvents.length - 1;
                  switch (event.type) {
                    case "user_message":
                      return <UserMessageItem key={event.id} event={event} isLast={isLast} />;
                    case "memory_context":
                      return <MemoryContextItem key={event.id} event={event} isLast={isLast} />;
                    case "assistant_thinking":
                      return <ThinkingItem key={event.id} event={event} isLast={isLast} />;
                    case "assistant_message":
                      return <AssistantMessageItem key={event.id} event={event} isLast={isLast} />;
                    case "assistant_tool_calls":
                      return (
                        <ToolCallsItem
                          key={event.id}
                          event={event}
                          resultByCallId={resultByCallId}
                          auditByCallId={auditByCallId}
                          subagentByCallId={subagentByCallId}
                          isLast={isLast}
                        />
                      );
                    case "tool_result":
                    case "tool_audit":
                      return <OrphanToolEventItem key={event.id} event={event} isLast={isLast} />;
                    case "approval_requested":
                      return (
                        <ApprovalPairItem
                          key={event.id}
                          event={event}
                          resolved={event.approvalId ? resolvedByApprovalId.get(event.approvalId) : undefined}
                          isLast={isLast}
                        />
                      );
                    case "approval_resolved":
                      // 未被 approval_requested 吸收的孤儿 resolved
                      return (
                        <GenericEventNode key={event.id} event={event} isLast={isLast} />
                      );
                    case "subagent_started":
                      return (
                        <SubagentPairItem
                          key={event.id}
                          event={event}
                          finished={subagentFinishedByKey.get(event.toolCallId ?? String(event.childRunId ?? ""))}
                          isLast={isLast}
                        />
                      );
                    case "subagent_finished":
                      // 未被 subagent_started 吸收的孤儿 finished（起跑事件缺失）：终态事件自带全部身份字段
                      return <SubagentPairItem key={event.id} event={event} finished={event} isLast={isLast} />;
                    case "hand_failure":
                      return <HandFailureItem key={event.id} event={event} isLast={isLast} />;
                    case "run_state_changed":
                      return <RunStateChangedNode key={event.id} event={event} isLast={isLast} />;
                    case "run_finished":
                      return <RunFinishedItem key={event.id} event={event} isLast={isLast} />;
                    default:
                      return <GenericEventNode key={event.id} event={event} isLast={isLast} />;
                  }
                })}
              </div>
            )}
          </CardContent>
        </Card>
        </TimelineFrameProvider>

        {/* 侧栏统计 */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle>工具调用前 10</CardTitle>
            </CardHeader>
            <CardContent>
              {toolAgg.length === 0 ? (
                <EmptyState compact icon={Wrench} title="本次运行没有工具调用" description="模型只做了文本回复，没有触发任何工具。" />
              ) : (
                <div className="space-y-1.5">
                  {toolAgg.map((t) => (
                    <div key={t.toolName} className="text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate" title={t.toolName}>{formatToolName(t.toolName)}</span>
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
              <CardTitle>
                逐请求成本 <span className="text-xs font-normal text-muted-foreground">· 共 {formatYuan(billing.totalCostYuan)}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {billing.requests.length === 0 ? (
                <EmptyState
                  compact
                  icon={EntityIcons.credits}
                  title="没有计费记录"
                  description={billing.costRedacted
                    ? "当前账号看不到成本明细（缺 finance.read 能力），Token 口径仍在头卡里。"
                    : "这次执行没有产生模型请求，或用量事件还没落库。"}
                />
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
                        <TableCell className="max-w-32 truncate text-xs" title={req.actualModel}>
                          {labelFor(req.actualModel)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right font-mono text-xs tabular-nums">
                          {formatTokens(req.inputTokens)}/{formatTokens(req.cachedInputTokens)}/{formatTokens(req.outputTokens)}
                          {req.reasoningTokens > 0 && (
                            <Badge variant="outline" className="ml-1 text-2xs">推理 {formatTokens(req.reasoningTokens)}</Badge>
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
