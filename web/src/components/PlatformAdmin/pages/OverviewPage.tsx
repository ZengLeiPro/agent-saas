import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { AdminErrorAlert, AttentionQueue, MetricCard } from "@/components/PlatformAdmin/common";
import { buildPlatformAdminUrl, pushPlatformAdminUrl, type PlatformAdminSection } from "@/lib/urlSync";
import { cn } from "@/lib/utils";

import { platformAdminApi } from "../api";
import { formatAttentionKind, formatAttentionTitle, formatRunStatus } from "../displayText";
import { attentionSeverity, formatNumber, formatRate, formatTime, formatYuan } from "../format";
import type { BillingDailyPoint, OverviewAttentionEntityRef, OverviewSnapshot, PlatformTrendResponse } from "../types";

function navigate(section: PlatformAdminSection, search?: Record<string, string | number | boolean | null | undefined>) {
  pushPlatformAdminUrl({ section, search });
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function navigateRef(ref: OverviewAttentionEntityRef | undefined) {
  if (!ref) return;
  const section = ref.kind === "run"
    ? "runs"
    : ref.kind === "session"
      ? "sessions"
      : ref.kind === "sandbox"
        ? "sandboxes"
        : ref.kind === "user"
          ? "users"
          : "tenants";
  pushPlatformAdminUrl({ section, entityId: ref.id });
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function OverviewPage() {
  const [snapshot, setSnapshot] = useState<OverviewSnapshot | null>(null);
  const [costTrend, setCostTrend] = useState<BillingDailyPoint[]>([]);
  const [platformTrend, setPlatformTrend] = useState<PlatformTrendResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (mode: "initial" | "refresh" = "refresh") => {
    if (mode === "initial") setLoading(true);
    else setRefreshing(true);
    try {
      const [data, trend, usageTrend] = await Promise.all([
        platformAdminApi.overviewSnapshot(),
        platformAdminApi.billingTrend(14).catch(() => null),
        platformAdminApi.overviewTrends(14).catch(() => null),
      ]);
      setSnapshot(data);
      setCostTrend(trend?.audit.daily ?? []);
      setPlatformTrend(usageTrend);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load("initial");
    const timer = window.setInterval(() => void load("refresh"), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const attentionItems = useMemo(() => (snapshot?.attention ?? []).map((item, index) => ({
    id: `${item.kind}:${item.entityRef?.id ?? index}`,
    title: formatAttentionTitle(item),
    description: `${formatAttentionKind(item.kind)}${item.occurredAt ? ` · ${formatTime(item.occurredAt)}` : ""}`,
    severity: attentionSeverity(item.severity),
    actionLabel: item.entityRef ? "查看" : undefined,
    onAction: item.entityRef ? () => navigateRef(item.entityRef) : undefined,
  })), [snapshot?.attention]);

  if (loading && !snapshot) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border bg-card text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        加载平台总览...
      </div>
    );
  }

  const health = snapshot?.health;
  const dispatch = health?.dispatch as { dropped?: number; errors?: number; total?: number } | null | undefined;
  const projectionFailed = Number(health?.sessionMetaProjection?.failed ?? 0);
  const dispatchErrors = Number(dispatch?.errors ?? dispatch?.dropped ?? 0);
  const internalIssueCount = dispatchErrors + projectionFailed;
  const activeStatuses = Object.entries(health?.activeRuns.byStatus ?? {}).filter(([, count]) => count > 0);
  const trendValues = costTrend.map((point) => point.actualCostYuanMicro / 1_000_000);
  const trendMax = Math.max(...trendValues, 0.01);
  const latest7 = trendValues.slice(-7).reduce((sum, value) => sum + value, 0);
  const previous7 = trendValues.slice(-14, -7).reduce((sum, value) => sum + value, 0);
  const weekChange = previous7 > 0 ? (latest7 - previous7) / previous7 : null;
  const usageDaily = platformTrend?.daily ?? [];
  const recentUsage = usageDaily.slice(-7);
  const recentRuns = recentUsage.reduce((sum, point) => sum + point.runs, 0);
  const recentSessions = recentUsage.reduce((sum, point) => sum + point.sessions, 0);
  const recentActiveUsers = recentUsage.length > 0
    ? recentUsage.reduce((sum, point) => sum + point.activeUsers, 0) / recentUsage.length
    : 0;
  const recentTerminal = recentUsage.reduce((sum, point) => sum + point.completed + point.failed + point.cancelled, 0);
  const recentCompleted = recentUsage.reduce((sum, point) => sum + point.completed, 0);
  const recentCompletionRate = recentTerminal > 0 ? recentCompleted / recentTerminal : null;
  const usageMax = Math.max(...usageDaily.map((point) => point.runs), 1);

  return (
    <div className="w-full space-y-5">
      <SettingsPanelHeader
        title="平台总览"
        description="先看今天的平台使用与异常；需要排查时，可直接进入对应的组织、用户、对话或执行记录。"
        actions={
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={refreshing}>
            <RefreshCw className={cn("mr-1.5 size-3.5", refreshing && "animate-spin")} />
            刷新
          </Button>
        }
      />

      {error && <AdminErrorAlert error={error} />}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          title="正在执行"
          value={formatNumber(health?.activeRuns.total)}
          description="正常工作量，不代表异常"
          tone="default"
          onClick={() => navigate("runs", { status: "active" })}
        />
        <MetricCard
          title="执行环境"
          value={`${formatNumber(health?.sandboxes.running)} / ${formatNumber(health?.sandboxes.paused)}`}
          description={`运行 / 暂停 · 异常 ${formatNumber(health?.sandboxes.broken)}`}
          tone={(health?.sandboxes.broken ?? 0) > 0 ? "bad" : "default"}
          onClick={() => navigate("sandboxes")}
        />
        <MetricCard
          title="今日成本"
          value={formatYuan(health?.todayCostYuan)}
          description="按北京时间自然日统计"
          onClick={() => navigate("efficiency")}
        />
        <MetricCard
          title="今日执行"
          value={formatNumber(health?.todayRuns)}
          description={`今日完成率 ${formatRate(health?.completionRateToday)}`}
          onClick={() => navigate("runs", { hours: 24 })}
        />
        <MetricCard
          title="近 1 小时环境故障"
          value={formatNumber(health?.handFailures1h)}
          description="点击查看同期异常执行"
          tone={(health?.handFailures1h ?? 0) > 0 ? "bad" : "good"}
          onClick={() => navigate("runs", { status: "failed", hours: 1 })}
        />
        <MetricCard
          title="工具调用失败"
          value={formatNumber(health?.toolRouting24h?.failedCount)}
          description={`${formatNumber(health?.toolRouting24h?.total)} 次调用 / 24h`}
          tone={(health?.toolRouting24h?.failedCount ?? 0) > 0 ? "warn" : "good"}
          onClick={() => navigate("efficiency")}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-start justify-between gap-3 pb-2">
            <div>
              <CardTitle className="text-sm font-medium">近 14 天使用趋势</CardTitle>
              <div className="mt-1 text-xs text-muted-foreground">最近 7 天：执行 {formatNumber(recentRuns)} · 新对话 {formatNumber(recentSessions)} · 日均活跃用户 {recentActiveUsers.toFixed(1)} · 完成率 {formatRate(recentCompletionRate)}</div>
            </div>
            <Button variant="ghost" size="sm" onClick={() => navigate("runs", { hours: 168 })}>查看记录</Button>
          </CardHeader>
          <CardContent>
            {!platformTrend || platformTrend.daily.length === 0 ? (
              <div className="flex h-28 items-center justify-center text-sm text-muted-foreground">使用趋势暂不可用</div>
            ) : (
              <>
                {!platformTrend.available && <div className="mb-2 text-xs text-amber-700">部分数据源不可用：{platformTrend.missingSources.join("、")}</div>}
                <div className="flex h-32 items-end gap-1 border-b px-1 pt-2">
                  {platformTrend.daily.map((point) => {
                    const height = point.runs > 0 ? Math.max(4, (point.runs / usageMax) * 100) : 2;
                    return (
                      <div key={point.date} className="group flex min-w-0 flex-1 flex-col items-center justify-end gap-1" title={`${point.date} · 执行 ${point.runs} · 对话 ${point.sessions} · 活跃用户 ${point.activeUsers} · 完成率 ${formatRate(point.completionRate)}`}>
                        <div className="w-full max-w-9 rounded-t bg-blue-500/70 transition-colors group-hover:bg-blue-500" style={{ height: `${height}%` }} />
                        <span className="hidden text-[10px] text-muted-foreground sm:block">{point.date.slice(5)}</span>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-start justify-between gap-3 pb-2">
            <div>
              <CardTitle className="text-sm font-medium">近 14 天成本趋势</CardTitle>
              <div className="mt-1 text-xs text-muted-foreground">最近 7 天 {formatYuan(latest7)}{weekChange == null ? "" : ` · 较前 7 天${weekChange >= 0 ? "增加" : "下降"} ${Math.abs(weekChange * 100).toFixed(1)}%`}</div>
            </div>
            <Button variant="ghost" size="sm" onClick={() => navigate("efficiency")}>查看执行效率</Button>
          </CardHeader>
          <CardContent>
            {costTrend.length === 0 ? (
              <div className="flex h-28 items-center justify-center text-sm text-muted-foreground">成本趋势暂不可用</div>
            ) : (
              <div className="flex h-32 items-end gap-1 border-b px-1 pt-2">
                {costTrend.map((point) => {
                  const value = point.actualCostYuanMicro / 1_000_000;
                  const height = value > 0 ? Math.max(4, (value / trendMax) * 100) : 2;
                  return (
                    <div key={point.date} className="group flex min-w-0 flex-1 flex-col items-center justify-end gap-1" title={`${point.date} · ${formatYuan(value)}`}>
                      <div className="w-full max-w-9 rounded-t bg-primary/70 transition-colors group-hover:bg-primary" style={{ height: `${height}%` }} />
                      <span className="hidden text-[10px] text-muted-foreground sm:block">{point.date.slice(5)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <AttentionQueue items={attentionItems} />
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <TriangleAlert className="size-4" />
              当前执行情况
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">数据更新时间</span>
              <span className="tabular-nums">{formatTime(snapshot?.generatedAt)}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">正在执行</span>
              <a className="text-primary hover:underline" href={buildPlatformAdminUrl({ section: "runs", search: { status: "active" } })}>
                {formatNumber(health?.activeRuns.total)} 条执行记录
              </a>
            </div>
            <div className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
              {activeStatuses.length > 0
                ? activeStatuses.map(([status, count]) => `${formatRunStatus(status)} ${count}`).join(" · ")
                : "当前没有正在执行或等待中的任务"}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <details>
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4">
            <span className="flex items-center gap-2 text-sm font-medium">
              <TriangleAlert className="size-4" />
              系统内部健康
            </span>
            <span className={cn("text-xs", internalIssueCount > 0 ? "text-destructive" : "text-emerald-600")}>
              {internalIssueCount > 0 ? `${internalIssueCount} 项需关注` : "正常"}
            </span>
          </summary>
          <CardContent className="grid gap-3 border-t pt-4 sm:grid-cols-2">
            <div className="rounded-md bg-muted/40 p-3 text-sm">
              <div className="font-medium">任务派发</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {dispatchErrors > 0 ? `${dispatchErrors} 次派发异常；仅统计本次服务启动后。` : "未发现任务派发异常。"}
              </div>
            </div>
            <div className="rounded-md bg-muted/40 p-3 text-sm">
              <div className="font-medium">对话列表数据</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {projectionFailed > 0 ? `${projectionFailed} 个对话同步失败，列表可能显示不全。` : "对话列表数据同步正常。"}
              </div>
            </div>
          </CardContent>
        </details>
      </Card>
    </div>
  );
}
