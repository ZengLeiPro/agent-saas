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
import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { EntityLink } from "@/components/PlatformAdmin/common";
import { RUN_LABEL } from "@/components/PlatformAdmin/displayText";

import { runTraceApi } from "@/components/RunTraceExplorer/api";
import { formatCount, formatMs, formatRate, formatYuan } from "@/components/RunTraceExplorer/format";
import { RunStatusBadge } from "@/components/RunTraceExplorer/StatusBadge";
import type { EfficiencyReport } from "@/components/RunTraceExplorer/types";

import { formatTokens } from "./format";

const DAYS_OPTIONS = [7, 14, 30] as const;

/** 工具错误率红色高亮阈值 */
const ERROR_RATE_ALERT = 0.05;

function StatCard({ label, value, sub, tone = "default" }: {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "bad" | "warn";
}) {
  const toneClass = tone === "bad" ? "text-destructive" : tone === "warn" ? "text-amber-700 dark:text-amber-300" : "";
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className={cn("text-2xl font-semibold tabular-nums", toneClass)}>{value}</div>
        {sub && <div className="mt-1 truncate text-[11px] text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}

export function EfficiencyView({ tenantId, linkEntities = true }: {
  tenantId?: string;
  /** false = 租户上下文：EntityLink 纯文本、组织列隐藏 */
  linkEntities?: boolean;
}) {
  const [days, setDays] = useState<number>(7);
  const [data, setData] = useState<EfficiencyReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const plain = !linkEntities;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await runTraceApi.efficiency({ days, ...(tenantId ? { tenantId } : {}) });
      setData(resp);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [days, tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      {/* 天数选择 + 刷新 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center rounded-md border bg-card p-0.5">
          {DAYS_OPTIONS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={cn(
                "rounded px-3 py-1 text-xs font-medium transition-colors",
                days === d
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {d} 天
            </button>
          ))}
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn("mr-1 size-3.5", loading && "animate-spin")} />
          刷新
        </Button>
        {data && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {data.range.from.slice(0, 10)} → {data.range.to.slice(0, 10)}
          </span>
        )}
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">加载失败：{error}</div>
      )}

      {loading && !data ? (
        <div className="flex h-40 items-center justify-center rounded-2xl border bg-card text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" /> 加载效率数据...
        </div>
      ) : data ? (
        <>
          {/* 1. 结果卡行 */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <StatCard label="运行完成率" value={formatRate(data.outcome.completionRate)} sub={`成功 ${formatCount(data.outcome.success)}`} />
            <StatCard label="总运行数" value={formatCount(data.outcome.totalRuns)} />
            <StatCard
              label="失败数"
              value={formatCount(data.outcome.error)}
              tone={data.outcome.error > 0 ? "bad" : "default"}
            />
            <StatCard
              label="中断数"
              value={formatCount(data.outcome.interrupted)}
              tone={data.outcome.interrupted > 0 ? "warn" : "default"}
            />
            <StatCard
              label="执行环境失败"
              value={formatCount(data.tools.handFailures)}
              tone={data.tools.handFailures > 0 ? "bad" : "default"}
            />
          </div>

          {/* 2. 失败原因 TopN */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">失败原因前 {data.outcome.errorReasons.length || ""} 项</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {data.outcome.errorReasons.length === 0 ? (
                <div className="py-6 text-center text-xs text-muted-foreground">区间内无失败运行记录</div>
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
                    {data.outcome.errorReasons.map((r) => (
                      <TableRow key={r.reason}>
                        <TableCell className="max-w-md truncate text-xs" title={r.reason}>{r.reason}</TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">{r.count}</TableCell>
                        <TableCell><EntityLink kind="run" id={r.sampleRunId} plain={plain} /></TableCell>
                      </TableRow>
                    ))}
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
                    <StatCard label="缓存命中率" value={formatRate(data.cost.cacheHitRate)} />
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                    <StatCard label="总成本" value={formatYuan(data.cost.totalCostYuan ?? 0, 2)} />
                    <StatCard label="单次运行成本 P50" value={formatYuan(data.cost.perRun?.p50 ?? null)} />
                    <StatCard label="单次运行成本 P90" value={formatYuan(data.cost.perRun?.p90 ?? null)} />
                    <StatCard label="单次运行成本 P99" value={formatYuan(data.cost.perRun?.p99 ?? null)} />
                    <StatCard
                      label="失败运行沉没成本"
                      value={formatYuan(data.cost.failedRunsCostYuan ?? 0, 2)}
                      tone={(data.cost.failedRunsCostYuan ?? 0) > 0 ? "warn" : "default"}
                    />
                    <StatCard label="缓存命中率" value={formatRate(data.cost.cacheHitRate)} />
                  </div>
                )}

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium">{costRedacted ? "按模型用量" : "按模型成本"}</CardTitle>
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
                              <TableCell className="max-w-56 truncate font-mono text-xs" title={m.model}>{m.model}</TableCell>
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
              <CardTitle className="text-sm font-medium">
                工具健康 <span className="text-xs font-normal text-muted-foreground">· 错误率 &gt; 5% 红色高亮</span>
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
                          <TableCell className="max-w-56 truncate font-mono text-xs" title={t.toolName}>{t.toolName}</TableCell>
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
                <CardTitle className="text-sm font-medium">最慢运行记录</CardTitle>
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
                            <div className="mt-0.5 text-[10px] text-muted-foreground">
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
                          <TableCell className="max-w-32 truncate font-mono text-xs" title={r.model ?? undefined}>{r.model ?? "—"}</TableCell>
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
                <CardTitle className="text-sm font-medium">最多轮次运行记录</CardTitle>
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
              <CardTitle className="text-sm font-medium">审批摩擦</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div>
                  <div className="text-[11px] text-muted-foreground">审批请求数</div>
                  <div className="mt-0.5 text-lg font-semibold tabular-nums">{formatCount(data.approvals.count)}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">已裁决</div>
                  <div className="mt-0.5 text-lg font-semibold tabular-nums">{formatCount(data.approvals.resolvedCount)}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">等待 P50</div>
                  <div className="mt-0.5 text-lg font-semibold tabular-nums">{formatMs(data.approvals.waitP50Ms)}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">等待 P90</div>
                  <div className="mt-0.5 text-lg font-semibold tabular-nums">{formatMs(data.approvals.waitP90Ms)}</div>
                </div>
              </div>
              {data.approvals.byTool.length > 0 && (
                <div className="mt-3 space-y-1 border-t pt-3">
                  {data.approvals.byTool.map((t) => (
                    <div key={t.toolName} className="flex items-center justify-between text-xs">
                      <span className="truncate font-mono" title={t.toolName}>{t.toolName}</span>
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
                <CardTitle className="text-sm font-medium">重复工具调用</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">涉及运行记录</span>
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
                        <span className="truncate font-mono" title={o.toolName}>{o.toolName}</span>
                        <span className="shrink-0 text-muted-foreground tabular-nums">{o.duplicates}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">重复读文件</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">涉及运行记录</span>
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
                        <EntityLink kind="run" id={f.runId} className="text-[10px]" short={6} plain={plain} />
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">无修正重试</CardTitle>
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
                        <span className="truncate font-mono" title={t.toolName}>{t.toolName}</span>
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
