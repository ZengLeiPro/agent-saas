/**
 * 组织综合分析（租户管理员主页，2026-07-10 重做）
 *
 * 借鉴平台分析的信息结构，按租户管理员经营视角分四层：
 *   1. 团队采用与积分：成员 / 期间活跃成员 / 对话轮次 / 积分余额
 *   2. 用量：Token（今日 + Sparkline）/ 成本估算($) / 模型分布
 *   3. 运行健康（efficiency 聚合；后端锁本租户 + ¥ 成本按 policy 脱敏）：
 *      完成率 / 总运行 / 失败 / 审批等待 / 执行环境失败 + 失败原因 + 最慢运行
 *   4. 日趋势（TrendChart 堆叠柱）+ 成员排行 Top 8（含未使用成员提示）
 *
 * 全页统一时间范围（今日/7天/30天/本月/全部/自定义，复用 RangeSelector）；
 * 运行健康区仅支持天数窗口（1..30），由 range 换算并在区头标注实际窗口。
 * efficiency 后端未挂载（file backend / billing 未启用）时健康区整体隐藏。
 */
import { useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Building2,
  CheckCircle2,
  Coins,
  Cpu,
  DollarSign,
  Loader2,
  RefreshCw,
  Timer,
  Users,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { useAuth } from "@/contexts/AuthContext";
import { useTenants } from "@/components/TenantManager/hooks";
import { useUsers } from "@/components/UserManager/hooks";
import { cn } from "@/lib/utils";
import { TrendChart, type TrendBarDatum } from "@/components/UsageDashboard/TrendChart";
import { RangeSelector, type CustomRange, type RangeValue } from "@/components/UsageDashboard/RangeSelector";
import { formatDateRange } from "@/components/UsageDashboard/format";
import { formatCount, formatMs, formatRate } from "@/components/RunTraceExplorer/format";
import { RunStatusBadge } from "@/components/RunTraceExplorer/StatusBadge";
import { AuroraCard, ToneBadge, type Tone } from "./AuroraCard";
import { DonutChart, Sparkline } from "./charts";
import { useTenantCredits, useTenantHealth, useTenantUsageBundle, type UsageDateArgs } from "./hooks";
import { buildModelSlices, countActiveEnabledUsers } from "./metrics";

interface OverviewSectionProps {
  tenantId: string;
  onTenantChange?: (tenantId: string) => void;
  /** 「查看完整排行」→ 切到用量与配额 tab */
  onNavigateUsage?: () => void;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

function formatCostUsd(value: number): string {
  if (!Number.isFinite(value)) return "$0.00";
  return `$${value.toFixed(2)}`;
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function formatCredits(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(2);
}

function todayBeijing(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** RangeSelector 的选择 → efficiency 天数窗口（后端仅支持 1..30 天） */
function rangeToDays(range: RangeValue, custom: CustomRange | null): number {
  switch (range) {
    case "today":
      return 1;
    case "7d":
      return 7;
    case "30d":
    case "all":
      return 30;
    case "mtd": {
      const day = Number(todayBeijing().slice(8, 10));
      return Math.min(30, Math.max(1, day));
    }
    case "custom": {
      if (!custom) return 7;
      const fromMs = Date.parse(custom.from);
      const toMs = Date.parse(custom.to);
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return 7;
      return Math.min(30, Math.max(1, Math.ceil((toMs - fromMs) / 86_400_000)));
    }
  }
}

function KpiCard({
  tone,
  icon,
  label,
  value,
  hint,
  loading,
}: {
  tone: Tone;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  hint: string;
  loading?: boolean;
}) {
  return (
    <AuroraCard tone={tone}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="text-xs font-medium text-muted-foreground">{label}</div>
          <div className={cn("text-3xl font-semibold tracking-tight tabular-nums", loading && "text-muted-foreground/40")}>
            {loading ? "—" : value}
          </div>
        </div>
        <ToneBadge tone={tone} icon={icon} />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{hint}</p>
    </AuroraCard>
  );
}

export function OverviewSection({ tenantId, onTenantChange, onNavigateUsage }: OverviewSectionProps) {
  const { isPlatformAdmin } = useAuth();
  const { users, loading: usersLoading } = useUsers();
  const { tenants } = useTenants();

  const [range, setRange] = useState<RangeValue>("7d");
  const [customRange, setCustomRange] = useState<CustomRange | null>(null);

  const dateArgs = useMemo<UsageDateArgs>(() => {
    if (range === "custom" && customRange) {
      return { from: customRange.from, to: customRange.to };
    }
    return { range: range === "custom" ? "7d" : range };
  }, [range, customRange]);

  const healthDays = useMemo(() => rangeToDays(range, customRange), [range, customRange]);

  const usage = useTenantUsageBundle(tenantId, dateArgs);
  const health = useTenantHealth(tenantId, healthDays);
  const credits = useTenantCredits(tenantId);

  const handleRangeChange = (value: RangeValue, custom?: CustomRange) => {
    setRange(value);
    if (value === "custom" && custom) setCustomRange(custom);
  };

  const currentTenant = tenants.find(tenant => tenant.id === tenantId);
  const tenantUsers = useMemo(() => users.filter(user => user.tenantId === tenantId), [tenantId, users]);
  const admins = tenantUsers.filter(user => user.role === "admin");
  const disabledUsers = tenantUsers.filter(user => user.disabled);
  const enabledUsers = tenantUsers.filter(user => !user.disabled);
  const rankedUsers = usage.byUser?.users ?? [];
  const activeEnabledUsers = countActiveEnabledUsers(
    enabledUsers.map(user => user.username),
    rankedUsers.map(user => user.username),
  );
  const inactiveEnabledUsers = Math.max(0, enabledUsers.length - activeEnabledUsers);
  const activeCoverage = enabledUsers.length > 0
    ? `${Math.round((activeEnabledUsers / enabledUsers.length) * 100)}%`
    : "—";

  const trendPoints = usage.trend?.points ?? [];
  const todayTokens = trendPoints.find(point => point.date === todayBeijing())?.totalTokens ?? 0;
  const modelSlices = buildModelSlices(usage.byModel?.models ?? []);
  const totalModelTokens = modelSlices.reduce((sum, slice) => sum + slice.value, 0);
  const trendData = useMemo<TrendBarDatum[]>(
    () => trendPoints.map(point => ({
      date: point.date,
      input: point.inputTokens,
      output: point.outputTokens,
      cacheRead: point.cacheReadTokens,
      cacheCreation: point.cacheCreationTokens,
      total: point.totalTokens,
    })),
    [trendPoints],
  );

  const topUsers = useMemo(
    () => [...rankedUsers].sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 8),
    [rankedUsers],
  );

  const report = health.report;
  const rangeLabel = usage.overview ? formatDateRange(usage.overview.fromDate, usage.overview.toDate) : undefined;

  const refreshAll = () => {
    void usage.refresh();
    void health.refresh();
    void credits.refresh();
  };

  return (
    <div className="w-full space-y-5">
      <SettingsPanelHeader
        title="组织综合分析"
        description="团队采用、用量、积分与运行健康一页看全；成员明细与配额在「用量与配额」。"
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <RangeSelector value={range} customRange={customRange} onChange={handleRangeChange} dateRangeLabel={rangeLabel} />
            <Button variant="outline" size="sm" onClick={refreshAll} disabled={usage.loading}>
              <RefreshCw className={cn("mr-1 h-3.5 w-3.5", usage.loading && "animate-spin")} />
              刷新
            </Button>
            {isPlatformAdmin && tenants.length > 0 && onTenantChange && (
              <select
                className="h-9 rounded-md border bg-background px-3 text-sm"
                value={tenantId}
                onChange={event => onTenantChange(event.target.value)}
                aria-label="切换组织分析目标"
              >
                {tenants.map(tenant => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}
              </select>
            )}
          </div>
        }
      />

      <AuroraCard tone="indigo">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <ToneBadge tone="indigo" icon={Building2} className="h-10 w-10" />
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">当前组织</div>
              <div className="mt-0.5 truncate text-xl font-semibold">{currentTenant?.name || tenantId || "当前组织"}</div>
              <div className="text-xs text-muted-foreground">组织标识：{tenantId || "-"}</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={currentTenant?.disabled ? "destructive" : "secondary"}>
              {currentTenant ? (currentTenant.disabled ? "已禁用" : "启用中") : "状态未知"}
            </Badge>
            <Badge variant="outline">{isPlatformAdmin ? "跨组织视角" : "本组织视角"}</Badge>
          </div>
        </div>
      </AuroraCard>

      {/* 1. 团队采用与积分 */}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          tone="cyan"
          icon={Users}
          label="成员"
          value={tenantUsers.length}
          hint={`管理员 ${admins.length} · 已禁用 ${disabledUsers.length}`}
          loading={usersLoading}
        />
        <KpiCard
          tone="emerald"
          icon={Activity}
          label="活跃成员 · 期间"
          value={usage.loading || usersLoading ? "—" : activeEnabledUsers}
          hint={`覆盖率 ${activeCoverage}（${activeEnabledUsers}/${enabledUsers.length} 个启用成员有用量）`}
          loading={usage.loading || usersLoading}
        />
        <KpiCard
          tone="fuchsia"
          icon={BarChart3}
          label="对话轮次 · 期间"
          value={formatNumber(usage.overview?.totalTurns ?? 0)}
          hint="模型请求轮次合计"
          loading={usage.loading}
        />
        <KpiCard
          tone={credits.summary?.lowBalance ? "rose" : "amber"}
          icon={Coins}
          label="积分余额"
          value={credits.summary ? formatCredits(credits.summary.balanceCredits) : "—"}
          hint={
            credits.unavailable || !credits.summary
              ? "计费未启用"
              : credits.summary.billingEnabled
                ? `本月已用 ${formatCredits(credits.summary.currentMonthCreditsUsed)}${credits.summary.lowBalance ? " · 余额偏低" : ""}`
                : "计费未启用 · 余额仅供参考"
          }
          loading={credits.loading}
        />
      </div>

      {/* 2. 用量三卡（Token / 成本估算 / 模型分布） */}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <AuroraCard tone="indigo">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <div className="text-xs font-medium text-muted-foreground">Token · 期间</div>
              <div className={cn("text-3xl font-semibold tracking-tight tabular-nums", usage.loading && "text-muted-foreground/40")}>
                {usage.loading ? "—" : formatNumber(usage.overview?.totalTokens ?? 0)}
              </div>
              {!usage.loading && <div className="text-xs text-muted-foreground">今日 {formatNumber(todayTokens)}</div>}
            </div>
            <ToneBadge tone="indigo" icon={BarChart3} />
          </div>
          <div className="mt-3"><Sparkline data={trendPoints.map(point => point.totalTokens)} /></div>
        </AuroraCard>

        <AuroraCard tone="amber">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <div className="text-xs font-medium text-muted-foreground">模型成本估算 · 期间</div>
              <div className={cn("text-3xl font-semibold tracking-tight tabular-nums", usage.loading && "text-muted-foreground/40")}>
                {usage.loading ? "—" : formatCostUsd(usage.overview?.totalCostUsd ?? 0)}
              </div>
              {!usage.loading && (
                <div className="text-xs text-muted-foreground">
                  缓存命中 {formatPercent(usage.overview?.cacheHitRatio)}
                </div>
              )}
            </div>
            <ToneBadge tone="amber" icon={DollarSign} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-md bg-muted/40 px-2 py-1.5">
              <div className="text-muted-foreground">输入 Token</div>
              <div className="font-medium text-foreground">{formatNumber(usage.overview?.totalInputTokens ?? 0)}</div>
            </div>
            <div className="rounded-md bg-muted/40 px-2 py-1.5">
              <div className="text-muted-foreground">输出 Token</div>
              <div className="font-medium text-foreground">{formatNumber(usage.overview?.totalOutputTokens ?? 0)}</div>
            </div>
          </div>
        </AuroraCard>

        <AuroraCard tone="fuchsia">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs font-medium text-muted-foreground">模型分布 · 期间</div>
              <div className="mt-1 text-xs text-muted-foreground">按服务端返回的真实模型 ID 展示</div>
            </div>
            <ToneBadge tone="fuchsia" icon={Cpu} />
          </div>
          <div className="mt-3"><DonutChart slices={modelSlices} centerValue={formatNumber(totalModelTokens)} /></div>
        </AuroraCard>
      </div>

      {/* 3. 运行健康（efficiency 后端可用时；窗口为近 N 天） */}
      {!health.unavailable && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">运行健康</h3>
            <span className="text-xs text-muted-foreground">· 近 {healthDays} 天窗口</span>
            {health.loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          </div>
          {health.error && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
              {health.error}
            </div>
          )}
          {report && (
            <>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                <KpiCard
                  tone={report.outcome.completionRate !== null && report.outcome.completionRate < 0.85 ? "rose" : "emerald"}
                  icon={CheckCircle2}
                  label="运行完成率"
                  value={formatRate(report.outcome.completionRate)}
                  hint={`成功 ${formatCount(report.outcome.success)} / 共 ${formatCount(report.outcome.totalRuns)}`}
                />
                <KpiCard tone="cyan" icon={Activity} label="总运行数" value={formatCount(report.outcome.totalRuns)} hint="期间发起的 AI 运行" />
                <KpiCard
                  tone={report.outcome.error > 0 ? "rose" : "slate"}
                  icon={AlertTriangle}
                  label="失败数"
                  value={formatCount(report.outcome.error)}
                  hint={report.outcome.interrupted > 0 ? `另有中断 ${formatCount(report.outcome.interrupted)}` : "无中断"}
                />
                <KpiCard
                  tone="slate"
                  icon={Timer}
                  label="审批等待 P50"
                  value={formatMs(report.approvals.waitP50Ms)}
                  hint={`审批请求 ${formatCount(report.approvals.count)} · P90 ${formatMs(report.approvals.waitP90Ms)}`}
                />
                <KpiCard
                  tone={report.tools.handFailures > 0 ? "rose" : "slate"}
                  icon={Cpu}
                  label="执行环境失败"
                  value={formatCount(report.tools.handFailures)}
                  hint="沙箱/执行环境异常次数"
                />
              </div>

              <div className="grid gap-3 lg:grid-cols-2">
                <AuroraCard tone="slate">
                  <div className="mb-2 text-xs font-medium text-muted-foreground">失败原因 Top {report.outcome.errorReasons.length || ""}</div>
                  {report.outcome.errorReasons.length === 0 ? (
                    <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
                      <CheckCircle2 className="h-4 w-4 text-emerald-500" /> 区间内没有失败的运行，团队用得很顺
                    </div>
                  ) : (
                    <ul className="space-y-1.5 text-xs">
                      {report.outcome.errorReasons.slice(0, 6).map(reason => (
                        <li key={reason.reason} className="flex items-center justify-between gap-3">
                          <span className="min-w-0 truncate" title={reason.reason}>{reason.reason}</span>
                          <span className="shrink-0 font-mono tabular-nums text-muted-foreground">×{reason.count}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </AuroraCard>

                <AuroraCard tone="slate">
                  <div className="mb-2 text-xs font-medium text-muted-foreground">最慢运行 Top {Math.min(5, report.longTail.slowestRuns.length) || ""}</div>
                  {report.longTail.slowestRuns.length === 0 ? (
                    <div className="py-4 text-xs text-muted-foreground">区间内无运行记录</div>
                  ) : (
                    <ul className="space-y-1.5 text-xs">
                      {report.longTail.slowestRuns.slice(0, 5).map(run => (
                        <li key={run.runId} className="flex items-center justify-between gap-3">
                          <span className="flex min-w-0 items-center gap-2">
                            <RunStatusBadge status={run.status} />
                            <span className="min-w-0 truncate font-mono text-muted-foreground" title={run.model ?? undefined}>{run.model ?? "—"}</span>
                          </span>
                          <span className="shrink-0 font-mono tabular-nums">{formatMs(run.durationMs)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </AuroraCard>
              </div>
            </>
          )}
        </div>
      )}

      {/* 4. 日趋势 + 成员排行 */}
      <AuroraCard tone="slate">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="text-xs font-medium text-muted-foreground">Token 日趋势 · 组织合计</div>
        </div>
        {usage.loading && trendData.length === 0 ? (
          <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载中
          </div>
        ) : (
          <TrendChart data={trendData} />
        )}
      </AuroraCard>

      <AuroraCard tone="slate">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs font-medium text-muted-foreground">
            成员用量排行 Top {Math.min(8, topUsers.length) || ""}
            {inactiveEnabledUsers > 0 && !usage.loading && (
              <span className="ml-2 text-amber-600 dark:text-amber-400">· {inactiveEnabledUsers} 个启用成员期间未使用</span>
            )}
          </div>
          {onNavigateUsage && (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onNavigateUsage}>
              查看完整排行 →
            </Button>
          )}
        </div>
        {topUsers.length === 0 ? (
          <div className="py-6 text-center text-xs text-muted-foreground">
            {usage.loading ? "加载中…" : "区间内暂无成员用量"}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>成员</TableHead>
                <TableHead className="text-right">总 Token</TableHead>
                <TableHead className="text-right">轮次</TableHead>
                <TableHead className="text-right">缓存命中</TableHead>
                <TableHead className="w-[110px]">最后活跃</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {topUsers.map(user => (
                <TableRow key={user.username}>
                  <TableCell className="font-medium">
                    <span>{user.realName ?? user.username}</span>
                    {user.realName && <span className="ml-1.5 text-[11px] text-muted-foreground">({user.username})</span>}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">{formatNumber(user.totalTokens)}</TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">{user.totalTurns.toLocaleString()}</TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">{formatPercent(user.cacheHitRatio)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground tabular-nums">{user.lastActiveDate}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </AuroraCard>

      {usage.error && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300">
          <span>组织用量加载失败：{usage.error}</span>
          <Button size="sm" variant="outline" onClick={() => { void usage.refresh(); }}>重试</Button>
        </div>
      )}
    </div>
  );
}
