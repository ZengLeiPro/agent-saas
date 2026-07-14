/**
 * 组织综合分析（租户管理员主页，2026-07-14 按客户管理员视角重做）
 *
 * 设计原则：这是给「客户组织管理员」看的经营页面，只呈现他能理解、能行动的信息：
 *   1. 团队使用：成员 / 活跃成员（覆盖率）/ 对话轮次 / 待激活成员
 *   2. 积分与费用（计费自适应）：billingEnabled 才渲染；
 *      showBalance → 余额（低额警示）；showUsageCredits → 本月已用 + 期间消耗 + 日消耗趋势
 *   3. AI 任务健康：完成率 / 任务数 / 失败 / 人工确认等待 + 失败原因 + 最慢任务
 *   4. 使用趋势：对话轮次日趋势 + 模型使用占比（按轮次、显示名）
 *   5. 成员排行（轮次口径）
 *
 * 明确不出现在本页的底层口径（2026-07-14 曾磊拍板「站在客户角度决定给他看什么」）：
 *   - USD 模型成本（内部供应商成本，后端已按 policy.showCost fail-closed 剥离）
 *   - 真实模型 ID（统一走租户模型显示名映射）
 *   - 缓存命中率 / 输入输出 Token 分解 / 沙箱等工程概念
 * 平台管理员需要工程视图时走平台管理（用量 / 效率 / Run Trace）。
 */
import { useMemo, useState } from "react";
import {
  Activity,
  TriangleAlert,
  CircleCheck,
  Loader2,
  MessageSquare,
  RefreshCw,
  Timer,
  UserPlus,
  Users,
  Wallet,
} from "lucide-react";
import { EntityIcons } from "@/lib/icons";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { useAuth } from "@/contexts/AuthContext";
import { useTenants } from "@/components/TenantManager/hooks";
import { useUsers } from "@/components/UserManager/hooks";
import { cn } from "@/lib/utils";
import { RangeSelector, type CustomRange, type RangeValue } from "@/components/UsageDashboard/RangeSelector";
import { formatDateRange } from "@/components/UsageDashboard/format";
import { formatCount, formatMs, formatRate } from "@/components/RunTraceExplorer/format";
import { RunStatusBadge } from "@/components/RunTraceExplorer/StatusBadge";
import { AuroraCard, ToneBadge, type Tone } from "./AuroraCard";
import { DonutChart, MiniBarTrend, Sparkline } from "./charts";
import {
  useModelDisplayMap,
  useTenantBillingDisplayPolicy,
  useTenantCredits,
  useTenantCreditTrend,
  useTenantHealth,
  useTenantUsageBundle,
  type UsageDateArgs,
} from "./hooks";
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

function formatCredits(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(2);
}

function formatShare(value: number, total: number): string {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return "—";
  return `${((value / total) * 100).toFixed(1)}%`;
}

function todayBeijing(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** RangeSelector 的选择 → 后端天数窗口（cap = 各后端上限：efficiency 30 / billing audit 90） */
function rangeToDays(range: RangeValue, custom: CustomRange | null, cap: number): number {
  switch (range) {
    case "today":
      return 1;
    case "7d":
      return 7;
    case "30d":
      return Math.min(cap, 30);
    case "all":
      return cap;
    case "mtd": {
      const day = Number(todayBeijing().slice(8, 10));
      return Math.min(cap, Math.max(1, day));
    }
    case "custom": {
      if (!custom) return 7;
      const fromMs = Date.parse(custom.from);
      const toMs = Date.parse(custom.to);
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return 7;
      return Math.min(cap, Math.max(1, Math.ceil((toMs - fromMs) / 86_400_000)));
    }
  }
}

/** 失败原因 → 客户可读文案（未识别的保留原文） */
const REASON_LABELS: Record<string, string> = {
  error: "执行出错",
  timeout: "执行超时",
  canceled: "已取消",
  cancelled: "已取消",
  interrupted: "已中断",
  aborted: "已中止",
};

function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? reason;
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

function SectionTitle({ title, caption, loading }: { title: string; caption?: string; loading?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {caption && <span className="text-xs text-muted-foreground">· {caption}</span>}
      {loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
    </div>
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

  const healthDays = useMemo(() => rangeToDays(range, customRange, 30), [range, customRange]);
  const creditDays = useMemo(() => rangeToDays(range, customRange, 90), [range, customRange]);

  const usage = useTenantUsageBundle(tenantId, dateArgs);
  const health = useTenantHealth(tenantId, healthDays);
  const credits = useTenantCredits(tenantId);
  const displayPolicy = useTenantBillingDisplayPolicy(tenantId);
  const { labelFor } = useModelDisplayMap();

  // 计费自适应：billingEnabled 的租户才展示积分区；再按显示偏好细分
  const billingActive = !credits.unavailable && credits.summary?.billingEnabled === true;
  const showBalance = billingActive && displayPolicy.showBalance;
  const showUsageCredits = billingActive && displayPolicy.showUsageCredits;
  const creditTrend = useTenantCreditTrend(tenantId, creditDays, showUsageCredits);

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
  const todayTurns = trendPoints.find(point => point.date === todayBeijing())?.turns ?? 0;
  const periodTurns = usage.overview?.totalTurns ?? 0;
  const turnTrendPoints = useMemo(
    () => trendPoints.map(point => ({ date: point.date, value: point.turns })),
    [trendPoints],
  );

  // 模型占比：按对话轮次 + 租户显示名（不暴露底层模型 ID）
  const modelSlices = useMemo(
    () => buildModelSlices(usage.byModel?.models ?? [], {
      getValue: model => model.totalTurns,
      getLabel: model => labelFor(model.model),
    }),
    [usage.byModel, labelFor],
  );

  const topUsers = useMemo(
    () => [...rankedUsers].sort((a, b) => b.totalTurns - a.totalTurns).slice(0, 8),
    [rankedUsers],
  );

  const report = health.report;
  const rangeLabel = usage.overview ? formatDateRange(usage.overview.fromDate, usage.overview.toDate) : undefined;

  const refreshAll = () => {
    void usage.refresh();
    void health.refresh();
    void credits.refresh();
    void creditTrend.refresh();
  };

  return (
    <div className="w-full space-y-5">
      <SettingsPanelHeader
        title="组织综合分析"
        description="团队使用、积分与 AI 任务健康一页看全；成员用量明细在「用量与配额」。"
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <RangeSelector value={range} customRange={customRange} onChange={handleRangeChange} dateRangeLabel={rangeLabel} />
            <Button variant="outline" size="sm" onClick={refreshAll} disabled={usage.loading}>
              <RefreshCw className={cn("mr-1 size-3.5", usage.loading && "animate-spin")} />
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
            <ToneBadge tone="indigo" icon={EntityIcons.org} className="size-10" />
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">当前组织</div>
              <div className="mt-0.5 truncate text-xl font-semibold">{currentTenant?.name || tenantId || "当前组织"}</div>
              {isPlatformAdmin && <div className="text-xs text-muted-foreground">组织标识：{tenantId || "-"}</div>}
            </div>
          </div>
          <Badge variant={currentTenant?.disabled ? "destructive" : "secondary"}>
            {currentTenant ? (currentTenant.disabled ? "已停用" : "服务中") : "状态未知"}
          </Badge>
        </div>
      </AuroraCard>

      {/* 1. 团队使用 */}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          tone="cyan"
          icon={Users}
          label="成员"
          value={tenantUsers.length}
          hint={`管理员 ${admins.length}${disabledUsers.length > 0 ? ` · 已停用 ${disabledUsers.length}` : ""}`}
          loading={usersLoading}
        />
        <KpiCard
          tone="emerald"
          icon={Activity}
          label="活跃成员 · 期间"
          value={usage.loading || usersLoading ? "—" : activeEnabledUsers}
          hint={`覆盖率 ${activeCoverage}（${activeEnabledUsers}/${enabledUsers.length} 名成员使用过 AI）`}
          loading={usage.loading || usersLoading}
        />
        <KpiCard
          tone="fuchsia"
          icon={MessageSquare}
          label="对话轮次 · 期间"
          value={formatNumber(periodTurns)}
          hint={`今日 ${formatNumber(todayTurns)} 轮`}
          loading={usage.loading}
        />
        <KpiCard
          tone={inactiveEnabledUsers > 0 ? "amber" : "emerald"}
          icon={UserPlus}
          label="待带动成员"
          value={usage.loading || usersLoading ? "—" : inactiveEnabledUsers}
          hint={inactiveEnabledUsers > 0 ? "期间未使用 AI 的成员，建议重点带动" : "全员都在使用，保持得很好"}
          loading={usage.loading || usersLoading}
        />
      </div>

      {/* 2. 积分与费用（计费启用的组织才展示；显示项随平台配置自适应） */}
      {(showBalance || showUsageCredits) && (
        <div className="space-y-3">
          <SectionTitle title="积分与费用" caption={showUsageCredits ? `消耗趋势为近 ${creditDays} 天` : undefined} loading={credits.loading || creditTrend.loading} />
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {showBalance && (
              <KpiCard
                tone={credits.summary?.lowBalance ? "rose" : "amber"}
                icon={Wallet}
                label="积分余额"
                value={credits.summary ? formatCredits(credits.summary.balanceCredits) : "—"}
                hint={credits.summary?.lowBalance ? "余额偏低，建议尽快充值以免影响使用" : "组织共享积分池"}
                loading={credits.loading}
              />
            )}
            {showUsageCredits && (
              <KpiCard
                tone="indigo"
                icon={EntityIcons.credits}
                label="本月已用积分"
                value={credits.summary ? formatCredits(credits.summary.currentMonthCreditsUsed) : "—"}
                hint="自然月累计（北京时间）"
                loading={credits.loading}
              />
            )}
            {showUsageCredits && (
              <AuroraCard tone="slate">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="text-xs font-medium text-muted-foreground">积分消耗 · 近 {creditDays} 天</div>
                    <div className={cn("text-3xl font-semibold tracking-tight tabular-nums", creditTrend.loading && "text-muted-foreground/40")}>
                      {creditTrend.loading ? "—" : formatCredits(creditTrend.periodCredits)}
                    </div>
                  </div>
                  <ToneBadge tone="slate" icon={EntityIcons.analytics} />
                </div>
                <div className="mt-3">
                  <Sparkline data={creditTrend.points.map(point => point.credits)} />
                </div>
              </AuroraCard>
            )}
          </div>
          {showUsageCredits && (
            <AuroraCard tone="slate">
              <div className="mb-2 text-xs font-medium text-muted-foreground">积分日消耗</div>
              {creditTrend.loading && creditTrend.points.length === 0 ? (
                <div className="flex h-[160px] items-center justify-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 size-4 animate-spin" /> 加载中
                </div>
              ) : (
                <MiniBarTrend
                  points={creditTrend.points.map(point => ({ date: point.date, value: point.credits }))}
                  barClassName="bg-amber-400/80 dark:bg-amber-500/70"
                  formatValue={value => `${formatCredits(value)} 积分`}
                  emptyText="近期暂无积分消耗"
                />
              )}
            </AuroraCard>
          )}
        </div>
      )}

      {/* 3. AI 任务健康 */}
      {!health.unavailable && (
        <div className="space-y-3">
          <SectionTitle title="AI 任务健康" caption={`近 ${healthDays} 天`} loading={health.loading} />
          {health.error && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
              {health.error}
            </div>
          )}
          {report && (
            <>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <KpiCard
                  tone={report.outcome.completionRate !== null && report.outcome.completionRate < 0.85 ? "rose" : "emerald"}
                  icon={CircleCheck}
                  label="任务完成率"
                  value={formatRate(report.outcome.completionRate)}
                  hint={`成功 ${formatCount(report.outcome.success)} / 共 ${formatCount(report.outcome.totalRuns)} 个任务`}
                />
                <KpiCard
                  tone="cyan"
                  icon={Activity}
                  label="任务总数"
                  value={formatCount(report.outcome.totalRuns)}
                  hint="期间团队发起的 AI 任务"
                />
                <KpiCard
                  tone={report.outcome.error > 0 ? "rose" : "slate"}
                  icon={TriangleAlert}
                  label="失败任务"
                  value={formatCount(report.outcome.error)}
                  hint={[
                    report.outcome.interrupted > 0 ? `中断 ${formatCount(report.outcome.interrupted)}` : null,
                    report.tools.handFailures > 0 ? `系统原因 ${formatCount(report.tools.handFailures)} 次` : null,
                  ].filter(Boolean).join(" · ") || "无中断"}
                />
                <KpiCard
                  tone="slate"
                  icon={Timer}
                  label="等待确认耗时"
                  value={formatMs(report.approvals.waitP50Ms)}
                  hint={`AI 请求人工确认 ${formatCount(report.approvals.count)} 次 · 90 分位 ${formatMs(report.approvals.waitP90Ms)}`}
                />
              </div>

              <div className="grid gap-3 lg:grid-cols-2">
                <AuroraCard tone="slate">
                  <div className="mb-2 text-xs font-medium text-muted-foreground">失败原因 Top {report.outcome.errorReasons.length || ""}</div>
                  {report.outcome.errorReasons.length === 0 ? (
                    <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
                      <CircleCheck className="size-4 text-emerald-500" /> 期间没有失败的任务，团队用得很顺
                    </div>
                  ) : (
                    <ul className="space-y-1.5 text-xs">
                      {report.outcome.errorReasons.slice(0, 6).map(reason => (
                        <li key={reason.reason} className="flex items-center justify-between gap-3">
                          <span className="min-w-0 truncate" title={reason.reason}>{reasonLabel(reason.reason)}</span>
                          <span className="shrink-0 font-mono tabular-nums text-muted-foreground">×{reason.count}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </AuroraCard>

                <AuroraCard tone="slate">
                  <div className="mb-2 text-xs font-medium text-muted-foreground">最耗时任务 Top {Math.min(5, report.longTail.slowestRuns.length) || ""}</div>
                  {report.longTail.slowestRuns.length === 0 ? (
                    <div className="py-4 text-xs text-muted-foreground">期间无任务记录</div>
                  ) : (
                    <ul className="space-y-1.5 text-xs">
                      {report.longTail.slowestRuns.slice(0, 5).map(run => (
                        <li key={run.runId} className="flex items-center justify-between gap-3">
                          <span className="flex min-w-0 items-center gap-2">
                            <RunStatusBadge status={run.status} />
                            <span className="min-w-0 truncate text-muted-foreground" title={run.model ? labelFor(run.model) : undefined}>
                              {run.model ? labelFor(run.model) : "—"}
                            </span>
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

      {/* 4. 使用趋势 + 模型占比 */}
      <div className="grid gap-3 lg:grid-cols-2">
        <AuroraCard tone="slate">
          <div className="mb-2 text-xs font-medium text-muted-foreground">对话轮次 · 日趋势</div>
          {usage.loading && turnTrendPoints.length === 0 ? (
            <div className="flex h-[160px] items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" /> 加载中
            </div>
          ) : (
            <MiniBarTrend
              points={turnTrendPoints}
              formatValue={value => `${formatNumber(value)} 轮`}
              emptyText="区间内暂无使用记录"
            />
          )}
        </AuroraCard>

        <AuroraCard tone="fuchsia">
          <div className="mb-2 text-xs font-medium text-muted-foreground">模型使用占比 · 按对话轮次</div>
          <DonutChart
            slices={modelSlices}
            centerValue={formatNumber(modelSlices.reduce((sum, slice) => sum + slice.value, 0))}
            centerCaption="轮次"
            ariaLabel="模型使用占比"
          />
        </AuroraCard>
      </div>

      {/* 5. 成员排行 */}
      <AuroraCard tone="slate">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs font-medium text-muted-foreground">
            成员使用排行 Top {Math.min(8, topUsers.length) || ""}
            {inactiveEnabledUsers > 0 && !usage.loading && (
              <span className="ml-2 text-amber-600 dark:text-amber-400">· {inactiveEnabledUsers} 名成员期间未使用</span>
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
                <TableHead className="text-right">对话轮次</TableHead>
                <TableHead className="text-right">占比</TableHead>
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
                  <TableCell className="text-right font-mono text-xs tabular-nums">{user.totalTurns.toLocaleString()}</TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">{formatShare(user.totalTurns, periodTurns)}</TableCell>
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
