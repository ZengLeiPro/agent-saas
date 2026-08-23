/**
 * 效率视图（admin tab：平台 admin 全量；组织 admin 锁本租户）
 *
 * 数据后端：GET /api/admin/runtime/trace/efficiency（见 server/src/runtime/efficiencyQuery.ts）
 * 布局分区：结果卡行 → 失败原因 → 成本 → 工具健康 → 长尾榜 → 审批摩擦 → 浪费探测。
 * 所有可空数值防 null 显示 "—"；成本只展示累计口径（¥）。
 *
 * 租户上下文（linkEntities=false）：
 * - 后端按 policy.showCost 脱敏 ¥ 字段（costRedacted）→ 成本区退化为 token 口径；
 * - EntityLink 走 plain 模式（不渲染 platform-admin 跳转），组织列隐藏。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Segmented, type SegmentedOption } from "@/components/ui/segmented";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { HISTORY_PUSH, useAdminUrlQuery } from "@/hooks/useAdminUrlQuery";
import { cn } from "@/lib/utils";
import { AdminErrorAlert, EntityLink, MetricCard } from "@/components/PlatformAdmin/common";
import { RUN_LABEL, formatToolName } from "@/components/PlatformAdmin/displayText";
import { classifyFailureReason } from "@/components/PlatformAdmin/errorText";
import { useModelDisplayMap } from "@/components/TenantAnalytics/hooks";
import { todayBeijingDate } from "@/components/TenantAnalytics/metrics";
import { ToolAnalysisPanel } from "@/components/PlatformAdmin/ToolAnalysisPanel";

import { runTraceApi } from "@/components/RunTraceExplorer/api";
import { formatCount, formatMs, formatRate, formatYuan } from "@/components/RunTraceExplorer/format";
import { RunStatusBadge } from "@/components/RunTraceExplorer/StatusBadge";
import type { EfficiencyReport } from "@/components/RunTraceExplorer/types";

import { usageApi } from "./api";
import { formatTokens } from "./format";
import { ModelTokenTrendCard } from "./ModelTokenTrendChart";
import type { ModelTrendResp } from "./types";

const DAYS_OPTIONS: SegmentedOption<number>[] = [
  { value: 7, label: "7 天" },
  { value: 14, label: "14 天" },
  { value: 30, label: "30 天" },
];

const DEFAULT_EFF_DAYS = 7;
const DAY_MS = 86_400_000;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const ALLOWED_EFF_DAYS = new Set(DAYS_OPTIONS.map((option) => option.value));

/**
 * URL 上的 effDays 只接受白名单值；非法/缺失时回落到 `fallback`，避免拼错参数拉一年数据。
 *
 * `fallback` 让本视图能继承宿主页已选的时间窗（见 `inheritedDays`）；未提供时才用 7 天。
 */
function parseEffDays(raw: string | null, fallback?: number): number {
  const value = Number(raw);
  if (Number.isFinite(value) && ALLOWED_EFF_DAYS.has(value)) return value;
  if (fallback !== undefined && ALLOWED_EFF_DAYS.has(fallback)) return fallback;
  return DEFAULT_EFF_DAYS;
}

/**
 * 宿主页时间窗（天）→ 本视图可选的最近档位。
 *
 * 只向下取，不向上：用户选「7 天」时给他 14 天的数据是多给了他没要的东西，
 * 而给 7 天最多是少给——在排障场景里，窗口偏小比偏大安全。
 */
export function nearestEffDays(days: number): number {
  const sorted = [...ALLOWED_EFF_DAYS].sort((a, b) => a - b);
  let hit = sorted[0];
  for (const option of sorted) {
    if (option <= days) hit = option;
  }
  return hit;
}

/**
 * 最近 N 个北京时间自然日（含今天）的统一请求窗口。
 *
 * usage trend 接口使用 inclusive 日期；efficiency 使用 ISO `[from,to)`。两组边界从同一对
 * 北京日期派生，避免 UTC 日切与北京时间日切混用而统计到不同事件集合。
 */
function recentBeijingWindow(days: number): {
  trendFrom: string;
  trendTo: string;
  efficiencyFrom: string;
  efficiencyTo: string;
} {
  const trendTo = todayBeijingDate();
  const trendToUtc = Date.parse(`${trendTo}T00:00:00Z`);
  const trendFrom = new Date(trendToUtc - (days - 1) * DAY_MS).toISOString().slice(0, 10);
  const nextDate = new Date(trendToUtc + DAY_MS).toISOString().slice(0, 10);
  return {
    trendFrom,
    trendTo,
    efficiencyFrom: new Date(`${trendFrom}T00:00:00+08:00`).toISOString(),
    efficiencyTo: new Date(`${nextDate}T00:00:00+08:00`).toISOString(),
  };
}

/** 将 ISO `[from,to)` 按北京时间自然日显示为 inclusive 起止日期。 */
function formatBeijingRange(range: EfficiencyReport["range"]): string {
  const from = new Date(Date.parse(range.from) + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
  const to = new Date(Date.parse(range.to) - 1 + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
  return `${from} → ${to}`;
}

/** 工具错误率红色高亮阈值 */
const ERROR_RATE_ALERT = 0.05;

/* 本视图原有的 StatCard 已删除，12 处调用点统一走 `common/MetricCard`（S3-7）。 */

export function EfficiencyView({ tenantId, linkEntities = true, inheritedDays }: {
  tenantId?: string;
  /** false = 租户上下文：EntityLink 纯文本、组织列隐藏 */
  linkEntities?: boolean;
  /**
   * 宿主页当前时间窗折算出的天数（用量页签的 RangeSelector 选了什么）。
   *
   * 存在理由：本视图天数只有 7/14/30 三档，而 RangeSelector 有 today/7d/30d/本月/
   * 全部/自定义六种。两套控件值域不同，改造前切页签会**静默丢掉**用户刚选的区间、
   * 跳回 7 天——用户以为自己还在看 30 天的数据。现在 URL 未显式指定时跟随宿主窗口，
   * 只有用户在本视图手动改过才固定下来。
   */
  inheritedDays?: number;
}) {
  const { labelFor } = useModelDisplayMap();
  // URL 同步：`eff*` 命名空间前缀。改造前天数是本机 useState，切页签静默重置回 7 天，
  // 且排障时无法把「近 30 天的失败原因」链接发给同事（交互审计 §2）。
  const url = useAdminUrlQuery();
  const days = parseEffDays(url.get("effDays"), inheritedDays);
  const setDays = useCallback(
    (next: number) => url.set("effDays", next === DEFAULT_EFF_DAYS ? null : next, HISTORY_PUSH),
    [url],
  );
  const selectionKey = JSON.stringify([tenantId ?? null, days]);
  const initialWindow = recentBeijingWindow(days);
  const initialRequestKey = JSON.stringify([
    tenantId ?? null,
    days,
    initialWindow.efficiencyFrom,
    initialWindow.efficiencyTo,
  ]);
  const [efficiencyState, setEfficiencyState] = useState<{
    selectionKey: string;
    requestKey: string;
    data: EfficiencyReport | null;
    loading: boolean;
    error: string | null;
  }>(() => ({ selectionKey, requestKey: initialRequestKey, data: null, loading: true, error: null }));
  const [modelTrendState, setModelTrendState] = useState<{
    selectionKey: string;
    requestKey: string;
    data: ModelTrendResp | null;
    loading: boolean;
    error: string | null;
  }>(() => ({ selectionKey, requestKey: initialRequestKey, data: null, loading: true, error: null }));
  const loadSequence = useRef(0);
  const plain = !linkEntities;

  // 请求上下文变化后的首帧就隐藏旧数据，不能等 effect 清理后才切换。
  const { data, loading, error } = efficiencyState.selectionKey === selectionKey
    ? efficiencyState
    : { data: null, loading: true, error: null };
  const {
    data: modelTrend,
    loading: modelTrendLoading,
    error: modelTrendError,
  } = modelTrendState.selectionKey === selectionKey
    ? modelTrendState
    : { data: null, loading: true, error: null };

  const load = useCallback(() => {
    const sequence = ++loadSequence.current;
    const isLatest = () => sequence === loadSequence.current;
    const tenantArgs = tenantId ? { tenantId } : {};
    const window = recentBeijingWindow(days);
    const requestKey = JSON.stringify([
      tenantId ?? null,
      days,
      window.efficiencyFrom,
      window.efficiencyTo,
    ]);

    // 只有同一实际自然日窗口的手动刷新保留数据；租户、天数或北京时间日期变化均从空状态开始。
    setEfficiencyState((previous) => ({
      selectionKey,
      requestKey,
      data: previous.requestKey === requestKey ? previous.data : null,
      loading: true,
      error: null,
    }));
    setModelTrendState((previous) => ({
      selectionKey,
      requestKey,
      data: previous.requestKey === requestKey ? previous.data : null,
      loading: true,
      error: null,
    }));

    void runTraceApi.efficiency({
      days,
      ...tenantArgs,
      from: window.efficiencyFrom,
      to: window.efficiencyTo,
    }).then(
      (nextData) => {
        if (!isLatest()) return;
        setEfficiencyState({ selectionKey, requestKey, data: nextData, loading: false, error: null });
      },
      (reason) => {
        if (!isLatest()) return;
        setEfficiencyState((previous) => ({
          selectionKey,
          requestKey,
          data: previous.requestKey === requestKey ? previous.data : null,
          loading: false,
          error: reason instanceof Error ? reason.message : String(reason),
        }));
      },
    );

    void usageApi.trendByModel({
      from: window.trendFrom,
      to: window.trendTo,
      ...tenantArgs,
    }).then(
      (nextData) => {
        if (!isLatest()) return;
        setModelTrendState({ selectionKey, requestKey, data: nextData, loading: false, error: null });
      },
      (reason) => {
        if (!isLatest()) return;
        setModelTrendState((previous) => ({
          selectionKey,
          requestKey,
          data: previous.requestKey === requestKey ? previous.data : null,
          loading: false,
          error: reason instanceof Error ? reason.message : String(reason),
        }));
      },
    );
  }, [days, selectionKey, tenantId]);

  useEffect(() => {
    void load();
    return () => {
      loadSequence.current += 1;
    };
  }, [load]);

  return (
    <div className="space-y-4">
      {/* 天数选择 + 刷新 */}
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          ariaLabel="统计天数"
          options={DAYS_OPTIONS}
          value={days}
          onChange={setDays}
        />
        <Button variant="outline" size="sm" onClick={load} disabled={loading || modelTrendLoading}>
          <RefreshCw className={cn("mr-1 size-3.5", (loading || modelTrendLoading) && "animate-spin")} />
          刷新
        </Button>
        {data && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatBeijingRange(data.range)}
          </span>
        )}
      </div>

      {error && <AdminErrorAlert error={error} />}

      <ModelTokenTrendCard
        response={modelTrend}
        loading={modelTrendLoading}
        error={modelTrendError}
        labelFor={labelFor}
      />

      {loading && !data ? (
        <div className="flex h-40 items-center justify-center rounded-2xl border bg-card text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" /> 加载效率数据...
        </div>
      ) : data ? (
        <>
          {/* 1. 结果卡行 */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <MetricCard title="执行完成率" value={formatRate(data.outcome.completionRate)} description={`成功 ${formatCount(data.outcome.success)}`} descriptionClassName="truncate text-2xs" />
            <MetricCard title="执行总数" value={formatCount(data.outcome.totalRuns)} />
            <MetricCard
              title="失败数"
              value={formatCount(data.outcome.error)}
              tone={data.outcome.error > 0 ? "bad" : "default"}
            />
            <MetricCard
              title="中断数"
              value={formatCount(data.outcome.interrupted)}
              tone={data.outcome.interrupted > 0 ? "warn" : "default"}
            />
            <MetricCard
              title="执行环境失败"
              value={formatCount(data.tools.handFailures)}
              tone={data.tools.handFailures > 0 ? "bad" : "default"}
            />
          </div>

          <ToolAnalysisPanel tenantId={tenantId} linkEntities={linkEntities} />

          {/* 2. 失败原因 TopN */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle>失败原因前 {data.outcome.errorReasons.length || ""} 项</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {data.outcome.errorReasons.length === 0 ? (
                <div className="py-6 text-center text-xs text-muted-foreground">这段时间没有失败的执行记录</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>原因</TableHead>
                      <TableHead className="w-20 text-right">次数</TableHead>
                      <TableHead className="w-32">样本{RUN_LABEL}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.outcome.errorReasons.map((r) => {
                      const friendly = classifyFailureReason(r.reason);
                      return (
                      <TableRow key={r.reason}>
                        <TableCell className="max-w-md truncate text-xs" title={r.reason}>{friendly.summary}</TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">{r.count}</TableCell>
                        <TableCell><EntityLink kind="run" id={r.sampleRunId} plain={plain} /></TableCell>
                      </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* 3. 成本（后端脱敏时退化为 token 口径，隐藏 ¥ 卡） */}
          {(() => {
            const costRedacted = data.costRedacted === true || data.cost.totalCostYuan === undefined;
            return (
              <>
                {costRedacted ? (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                    <MetricCard title="缓存命中率" value={formatRate(data.cost.cacheHitRate)} />
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                    <MetricCard title="总成本" value={formatYuan(data.cost.totalCostYuan ?? 0, 2)} />
                    <MetricCard title="典型单次成本（中位）" value={formatYuan(data.cost.perRun?.p50 ?? null)} />
                    <MetricCard title="偏高单次成本（90 分位）" value={formatYuan(data.cost.perRun?.p90 ?? null)} />
                    <MetricCard title="极端单次成本（99 分位）" value={formatYuan(data.cost.perRun?.p99 ?? null)} />
                    <MetricCard
                      title="失败执行消耗的成本"
                      value={formatYuan(data.cost.failedRunsCostYuan ?? 0, 2)}
                      tone={(data.cost.failedRunsCostYuan ?? 0) > 0 ? "warn" : "default"}
                    />
                    <MetricCard title="缓存命中率" value={formatRate(data.cost.cacheHitRate)} />
                  </div>
                )}

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle>{costRedacted ? "按模型用量" : "按模型成本"}</CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    {data.cost.byModel.length === 0 ? (
                      <div className="py-6 text-center text-xs text-muted-foreground">区间内无计费数据</div>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>模型</TableHead>
                            {!costRedacted && <TableHead className="text-right">成本</TableHead>}
                            <TableHead className="text-right">请求数</TableHead>
                            <TableHead className="text-right">输入</TableHead>
                            <TableHead className="text-right">缓存输入</TableHead>
                            <TableHead className="text-right">输出</TableHead>
                            <TableHead className="text-right">缓存命中率</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {data.cost.byModel.map((m) => (
                            <TableRow key={m.model}>
                              <TableCell className="max-w-56 truncate text-xs" title={m.model}>{labelFor(m.model)}</TableCell>
                              {!costRedacted && (
                                <TableCell className="text-right font-mono text-xs tabular-nums">{formatYuan(m.costYuan ?? 0, 2)}</TableCell>
                              )}
                              <TableCell className="text-right font-mono text-xs tabular-nums">{formatCount(m.requests)}</TableCell>
                              <TableCell className="text-right font-mono text-xs tabular-nums">{formatTokens(m.inputTokens)}</TableCell>
                              <TableCell className="text-right font-mono text-xs tabular-nums">{formatTokens(m.cachedInputTokens)}</TableCell>
                              <TableCell className="text-right font-mono text-xs tabular-nums">{formatTokens(m.outputTokens)}</TableCell>
                              <TableCell className="text-right font-mono text-xs tabular-nums">{formatRate(m.cacheHitRate)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </CardContent>
                </Card>
              </>
            );
          })()}

          {/* 4. 工具健康 */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle>
                工具调用情况 <span className="text-xs font-normal text-muted-foreground">· 失败率超过 5% 会标红</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {data.tools.byTool.length === 0 ? (
                <div className="py-6 text-center text-xs text-muted-foreground">区间内无工具调用</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>工具</TableHead>
                      <TableHead className="text-right">调用数</TableHead>
                      <TableHead className="text-right">失败数</TableHead>
                      <TableHead className="text-right">错误率</TableHead>
                      <TableHead className="text-right">平均耗时</TableHead>
                      <TableHead className="text-right">总耗时</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.tools.byTool.map((t) => {
                      const alert = t.errorRate != null && t.errorRate > ERROR_RATE_ALERT;
                      return (
                        <TableRow key={t.toolName} className={cn(alert && "bg-destructive/5")}>
                          <TableCell className="max-w-56 truncate text-xs" title={t.toolName}>{formatToolName(t.toolName)}</TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">{formatCount(t.calls)}</TableCell>
                          <TableCell className={cn("text-right font-mono text-xs tabular-nums", t.errors > 0 && "text-destructive")}>
                            {formatCount(t.errors)}
                          </TableCell>
                          <TableCell className={cn("text-right font-mono text-xs tabular-nums", alert && "font-semibold text-destructive")}>
                            {formatRate(t.errorRate)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">{formatMs(t.avgDurationMs)}</TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">{formatMs(t.totalDurationMs)}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* 5. 长尾榜 */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle>耗时最长的执行</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {data.longTail.slowestRuns.length === 0 ? (
                  <div className="py-6 text-center text-xs text-muted-foreground">无数据</div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{RUN_LABEL}</TableHead>
                        <TableHead>状态</TableHead>
                        <TableHead>模型</TableHead>
                        <TableHead className="text-right">耗时</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.longTail.slowestRuns.map((r) => (
                        <TableRow key={r.runId}>
                          <TableCell>
                            <EntityLink kind="run" id={r.runId} plain={plain} />
                            <div className="mt-0.5 text-2xs text-muted-foreground">
                              {linkEntities && (
                                <>
                                  <EntityLink kind="tenant" id={r.tenantId} />
                                  <span className="mx-1">/</span>
                                </>
                              )}
                              <EntityLink kind="session" id={r.sessionId} short={6} plain={plain} />
                            </div>
                          </TableCell>
                          <TableCell><RunStatusBadge status={r.status} /></TableCell>
                          <TableCell className="max-w-32 truncate text-xs" title={r.model ?? undefined}>{r.model ? labelFor(r.model) : "—"}</TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">{formatMs(r.durationMs)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle>交互轮次最多的执行</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {data.longTail.mostTurns.length === 0 ? (
                  <div className="py-6 text-center text-xs text-muted-foreground">无数据</div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{RUN_LABEL}</TableHead>
                        {linkEntities && <TableHead>组织</TableHead>}
                        <TableHead className="text-right">轮次</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.longTail.mostTurns.map((r) => (
                        <TableRow key={r.runId}>
                          <TableCell><EntityLink kind="run" id={r.runId} plain={plain} /></TableCell>
                          {linkEntities && <TableCell className="text-xs"><EntityLink kind="tenant" id={r.tenantId} /></TableCell>}
                          <TableCell className="text-right font-mono text-xs tabular-nums">{r.turns}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>

          {/* 6. 审批摩擦 */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle>审批等待</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div>
                  <div className="text-2xs text-muted-foreground">审批请求数</div>
                  <div className="mt-0.5 text-lg font-semibold tabular-nums">{formatCount(data.approvals.count)}</div>
                </div>
                <div>
                  <div className="text-2xs text-muted-foreground">已裁决</div>
                  <div className="mt-0.5 text-lg font-semibold tabular-nums">{formatCount(data.approvals.resolvedCount)}</div>
                </div>
                <div>
                  <div className="text-2xs text-muted-foreground">典型等待时间（中位）</div>
                  <div className="mt-0.5 text-lg font-semibold tabular-nums">{formatMs(data.approvals.waitP50Ms)}</div>
                </div>
                <div>
                  <div className="text-2xs text-muted-foreground">偏高等待时间（90 分位）</div>
                  <div className="mt-0.5 text-lg font-semibold tabular-nums">{formatMs(data.approvals.waitP90Ms)}</div>
                </div>
              </div>
              {data.approvals.byTool.length > 0 && (
                <div className="mt-3 space-y-1 border-t pt-3">
                  {data.approvals.byTool.map((t) => (
                    <div key={t.toolName} className="flex items-center justify-between text-xs">
                      <span className="truncate" title={t.toolName}>{formatToolName(t.toolName)}</span>
                      <span className="shrink-0 text-muted-foreground tabular-nums">
                        {t.count} 次 · 平均等待 {formatMs(t.avgWaitMs)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* 7. 浪费探测 */}
          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle>重复工具调用</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">涉及执行记录</span>
                  <span className="font-mono tabular-nums">{formatCount(data.waste.duplicateToolCalls.affectedRuns)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">重复调用总数</span>
                  <span className="font-mono tabular-nums">{formatCount(data.waste.duplicateToolCalls.totalDuplicateCalls)}</span>
                </div>
                {data.waste.duplicateToolCalls.topOffenders.length > 0 && (
                  <div className="space-y-1 border-t pt-2">
                    {data.waste.duplicateToolCalls.topOffenders.map((o) => (
                      <div key={o.toolName} className="flex items-center justify-between">
                        <span className="truncate" title={o.toolName}>{formatToolName(o.toolName)}</span>
                        <span className="shrink-0 text-muted-foreground tabular-nums">{o.duplicates}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle>重复读文件</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">涉及执行记录</span>
                  <span className="font-mono tabular-nums">{formatCount(data.waste.repeatedFileReads.affectedRuns)}</span>
                </div>
                {data.waste.repeatedFileReads.topFiles.length > 0 && (
                  <div className="space-y-1.5 border-t pt-2">
                    {data.waste.repeatedFileReads.topFiles.map((f, i) => (
                      <div key={`${f.filePath}-${i}`}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-mono" title={f.filePath}>{f.filePath}</span>
                          <span className="shrink-0 text-muted-foreground tabular-nums">×{f.repeats}</span>
                        </div>
                        <EntityLink kind="run" id={f.runId} className="text-2xs" short={6} plain={plain} />
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle>无修正重试</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">总次数</span>
                  <span className="font-mono tabular-nums">{formatCount(data.waste.unmodifiedRetries.count)}</span>
                </div>
                {data.waste.unmodifiedRetries.byTool.length > 0 && (
                  <div className="space-y-1 border-t pt-2">
                    {data.waste.unmodifiedRetries.byTool.map((t) => (
                      <div key={t.toolName} className="flex items-center justify-between">
                        <span className="truncate" title={t.toolName}>{formatToolName(t.toolName)}</span>
                        <span className="shrink-0 text-muted-foreground tabular-nums">{t.count}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}
