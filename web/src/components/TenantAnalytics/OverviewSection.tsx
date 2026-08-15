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
import { useCallback, useMemo } from "react";
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

import { AdminSelect, type AdminSelectOption } from "@/components/ui/admin-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { useAuth } from "@/contexts/AuthContext";
import { useTenants } from "@/components/TenantManager/hooks";
import { useUsers } from "@/components/UserManager/hooks";
import { HISTORY_PUSH, useAdminUrlQuery } from "@/hooks/useAdminUrlQuery";
import { navigatePlatformAdmin } from "@/lib/urlSync";
import { cn } from "@/lib/utils";
import { RANGE_OPTIONS, RangeSelector, type CustomRange, type RangeValue } from "@/components/UsageDashboard/RangeSelector";
import { USAGE_USER_KEY } from "@/components/UsageDashboard";
import { formatDateRange } from "@/components/UsageDashboard/format";
import { formatCount, formatMs, formatRate } from "@/components/RunTraceExplorer/format";
import { RunStatusBadge } from "@/components/RunTraceExplorer/StatusBadge";
import { MetricCard } from "@/components/PlatformAdmin/common";

import { AuroraCard, ToneBadge, type Tone } from "./AuroraCard";
import { DonutChart, MiniBarTrend } from "./charts";
import {
  useModelDisplayMap,
  useTenantBillingDisplayPolicy,
  useTenantCredits,
  useTenantCreditTrend,
  useTenantHealth,
  useTenantUsageBundle,
  type UsageDateArgs,
} from "./hooks";
import { buildModelSlices, countActiveEnabledUsers, rangeToStatsWindow, todayBeijingDate, windowCaption } from "./metrics";
import { filterModelsForViewer } from "./modelVisibility";

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

function formatDataAsOf(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

/**
 * 客户面 KPI 卡：外观与交互全部下沉到 `common/MetricCard` 的 aurora 变体（S3-7），
 * 这里只保留一层把客户面词汇（label / hint / tone）映射到统一 props 的适配。
 *
 * 保留 AuroraCard 外观而不并入 platform 的灰卡，是因为这一屏是给**客户**看的；
 * 「不显示原始 ID / 不显示 ¥$ 成本」的约束由本文件顶部注释列出的口径保证，
 * 调用点传什么就显示什么，MetricCard 不介入脱敏。
 */
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
    <MetricCard
      variant="aurora"
      auroraTone={tone}
      icon={icon}
      title={label}
      value={value}
      description={hint}
      loading={loading}
    />
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

/**
 * URL 参数契约（`org*` 命名空间前缀）。
 *
 * 这是**客户视图**：参数名取业务可读词，不出现内部字段名。
 * 时间窗默认 7 天（与改造前的 useState 初值一致），默认值不写进 URL 以保持链接短。
 */
const ORG_RANGE_KEY = "orgRange";
const ORG_FROM_KEY = "orgFrom";
const ORG_TO_KEY = "orgTo";
const DEFAULT_ORG_RANGE: RangeValue = "7d";
const ORG_RANGE_VALUES: ReadonlySet<string> = new Set([...RANGE_OPTIONS.map((option) => option.value), "custom"]);

function parseOrgRange(raw: string | null): RangeValue {
  return raw && ORG_RANGE_VALUES.has(raw) ? (raw as RangeValue) : DEFAULT_ORG_RANGE;
}

export function OverviewSection({ tenantId, onTenantChange, onNavigateUsage }: OverviewSectionProps) {
  const { isPlatformAdmin } = useAuth();
  const { users, loading: usersLoading } = useUsers();
  const { tenants } = useTenants();

  // 时间窗进 URL：客户筛到某个区间想把链接发给同事，改造前发出去对方看到的是默认 7 天
  const url = useAdminUrlQuery();
  const range = parseOrgRange(url.get(ORG_RANGE_KEY));
  const customFrom = url.get(ORG_FROM_KEY);
  const customTo = url.get(ORG_TO_KEY);
  const customRange = useMemo<CustomRange | null>(
    () => (customFrom && customTo ? { from: customFrom, to: customTo } : null),
    [customFrom, customTo],
  );

  const dateArgs = useMemo<UsageDateArgs>(() => {
    if (range === "custom" && customRange) {
      return { from: customRange.from, to: customRange.to };
    }
    return { range: range === "custom" ? "7d" : range };
  }, [range, customRange]);

  const healthWindow = useMemo(() => rangeToStatsWindow(range, customRange, 30, todayBeijingDate()), [range, customRange]);
  const creditWindow = useMemo(() => rangeToStatsWindow(range, customRange, 90, todayBeijingDate()), [range, customRange]);
  const healthDays = healthWindow.days;
  const creditDays = creditWindow.days;

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

  /**
   * 成员排行 → 该成员的用量明细。
   *
   * 只在宿主提供了页签切换能力时才可点——tenant-admin 的区块可能被嵌在没有
   * 「用量与配额」页签的位置，那时渲染成可点的行是骗人的。
   */
  const canDrillToUsage = Boolean(onNavigateUsage);
  const drillToUsage = useCallback((username: string) => {
    // 先把目标成员写进 URL，再切页签：UsageDashboard 挂载时直接读到 usageUser
    url.set(USAGE_USER_KEY, username, HISTORY_PUSH);
    onNavigateUsage?.();
  }, [onNavigateUsage, url]);

  const handleRangeChange = useCallback((value: RangeValue, custom?: CustomRange) => {
    url.patch({
      [ORG_RANGE_KEY]: value === DEFAULT_ORG_RANGE ? null : value,
      [ORG_FROM_KEY]: value === "custom" ? custom?.from ?? customFrom : null,
      [ORG_TO_KEY]: value === "custom" ? custom?.to ?? customTo : null,
    }, HISTORY_PUSH);
  }, [url, customFrom, customTo]);

  const currentTenant = tenants.find(tenant => tenant.id === tenantId);
  const tenantSelectOptions = useMemo<AdminSelectOption[]>(
    () => tenants.map(tenant => ({ value: tenant.id, label: tenant.name })),
    [tenants],
  );
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
  const todayTurns = trendPoints.find(point => point.date === todayBeijingDate())?.turns ?? 0;
  const periodTurns = usage.overview?.totalTurns ?? 0;
  const turnTrendPoints = useMemo(
    () => trendPoints.map(point => ({ date: point.date, value: point.turns })),
    [trendPoints],
  );

  // 模型占比：组织管理员隐藏内部高级/旗舰档位，其他模型仍走租户显示名。
  const modelSlices = useMemo(
    () => buildModelSlices(filterModelsForViewer(usage.byModel?.models ?? [], isPlatformAdmin), {
      getValue: model => model.totalTurns,
      getLabel: model => labelFor(model.model),
    }),
    [usage.byModel, isPlatformAdmin, labelFor],
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
              <AdminSelect
                ariaLabel="切换组织分析目标"
                size="md"
                options={tenantSelectOptions}
                value={tenantId}
                onValueChange={onTenantChange}
              />
            )}
          </div>
        }
      />

      <AuroraCard tone="neutral">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <ToneBadge tone="neutral" icon={EntityIcons.org} className="size-10" />
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
      <div className="space-y-3">
        <SectionTitle title="团队使用" caption={rangeLabel ? `统计区间 ${rangeLabel}` : undefined} loading={usage.loading} />
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          tone="neutral"
          icon={Users}
          label="成员"
          value={tenantUsers.length}
          hint={`管理员 ${admins.length}${disabledUsers.length > 0 ? ` · 已停用 ${disabledUsers.length}` : ""}（当前在册，不随区间变化）`}
          loading={usersLoading}
        />
        <KpiCard
          tone="good"
          icon={Activity}
          label="活跃成员 · 期间"
          value={usage.loading || usersLoading ? "—" : activeEnabledUsers}
          hint={`覆盖率 ${activeCoverage}（${activeEnabledUsers}/${enabledUsers.length} 名成员使用过 AI）`}
          loading={usage.loading || usersLoading}
        />
        <KpiCard
          tone="neutral"
          icon={MessageSquare}
          label="对话轮次 · 期间"
          value={formatNumber(periodTurns)}
          hint={`今日 ${formatNumber(todayTurns)} 轮`}
          loading={usage.loading}
        />
        <KpiCard
          tone={inactiveEnabledUsers > 0 ? "warn" : "good"}
          icon={UserPlus}
          label="待带动成员"
          value={usage.loading || usersLoading ? "—" : inactiveEnabledUsers}
          hint={inactiveEnabledUsers > 0 ? "期间未使用 AI 的成员，建议重点带动" : "全员都在使用，保持得很好"}
          loading={usage.loading || usersLoading}
        />
        </div>
      </div>

      {/* 2. 积分与费用（计费启用的组织才展示；显示项随平台配置自适应） */}
      {(showBalance || showUsageCredits) && (
        <div className="space-y-3">
          <SectionTitle
            title="积分与费用"
            caption={showUsageCredits ? `消耗趋势为${windowCaption(creditWindow)}` : "余额为实时值"}
            loading={credits.loading || creditTrend.loading}
          />
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {showBalance && (
              <KpiCard
                tone={credits.summary?.lowBalance ? "bad" : "neutral"}
                icon={Wallet}
                label="积分余额"
                value={credits.summary ? formatCredits(credits.summary.balanceCredits) : "—"}
                hint={credits.summary?.lowBalance ? "余额偏低，建议尽快充值以免影响使用" : "组织共享积分池"}
                loading={credits.loading}
              />
            )}
            {showUsageCredits && (
              <KpiCard
                tone="neutral"
                icon={EntityIcons.credits}
                label="本月已用积分"
                value={credits.summary ? formatCredits(credits.summary.currentMonthCreditsUsed) : "—"}
                hint="自然月累计（北京时间）"
                loading={credits.loading}
              />
            )}
            {showUsageCredits && (
              <AuroraCard tone="neutral">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="text-xs font-medium text-muted-foreground">积分消耗 · {windowCaption(creditWindow)}</div>
                    <div className={cn("text-3xl font-semibold tracking-tight tabular-nums", creditTrend.loading && "text-muted-foreground/40")}>
                      {creditTrend.loading ? "—" : formatCredits(creditTrend.periodCredits)}
                    </div>
                  </div>
                  <ToneBadge tone="neutral" icon={EntityIcons.analytics} />
                </div>
                {/* 原先这里还画一条 Sparkline，但它和下方「积分日消耗」柱图是同一份
                    creditTrend.points——重复展示且无坐标轴、无单位。删掉后本卡专管总量，
                    下方柱图专管分布，与「总量 + 分布成对」的呈现模式一致。 */}
              </AuroraCard>
            )}
          </div>
          {showUsageCredits && (
            <AuroraCard tone="neutral">
              <div className="mb-2 text-xs font-medium text-muted-foreground">积分日消耗</div>
              {creditTrend.loading && creditTrend.points.length === 0 ? (
                <div className="flex h-[160px] items-center justify-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 size-4 animate-spin" /> 加载中
                </div>
              ) : (
                <MiniBarTrend
                  points={creditTrend.points.map(point => ({ date: point.date, value: point.credits }))}
                  barClassName="bg-chart-1/80"
                  formatValue={value => formatCredits(value)}
                  unit="积分"
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
          <SectionTitle
            title="AI 任务健康"
            caption={report
              ? `${windowCaption(healthWindow)} · 数据截至 ${formatDataAsOf(report.statistics.dataAsOf)} · 口径 ${report.statistics.version}`
              : windowCaption(healthWindow)}
            loading={health.loading}
          />
          {health.error && (
            <div className="rounded-md border border-warning/30 bg-warning-subtle px-3 py-2 text-xs text-warning-ink">
              {health.error}
            </div>
          )}
          {report && (
            <>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <KpiCard
                  tone={report.outcome.completionRate !== null && report.outcome.completionRate < 0.85 ? "bad" : "good"}
                  icon={CircleCheck}
                  label="任务完成率"
                  value={formatRate(report.outcome.completionRate)}
                  hint={`成功 ${formatCount(report.outcome.success)} / 发起 ${formatCount(report.outcome.totalRuns)} · 未终态 ${formatCount(report.outcome.nonTerminal)}`}
                />
                <KpiCard
                  tone="neutral"
                  icon={Activity}
                  label="任务总数"
                  value={formatCount(report.outcome.totalRuns)}
                  hint="按唯一 runId 与 requestedAt 统计发起"
                />
                <KpiCard
                  tone={report.outcome.error > 0 ? "bad" : "neutral"}
                  icon={TriangleAlert}
                  label="失败任务"
                  value={formatCount(report.outcome.error)}
                  hint={[
                    report.outcome.interrupted > 0 ? `中断 ${formatCount(report.outcome.interrupted)}` : null,
                    report.tools.handFailures > 0 ? `系统原因 ${formatCount(report.tools.handFailures)} 次` : null,
                  ].filter(Boolean).join(" · ") || "无中断"}
                />
                <KpiCard
                  tone="neutral"
                  icon={Timer}
                  label="等待确认耗时"
                  value={formatMs(report.approvals.waitP50Ms)}
                  hint={`AI 请求人工确认 ${formatCount(report.approvals.count)} 次 · 90 分位 ${formatMs(report.approvals.waitP90Ms)}`}
                />
              </div>

              <div className="grid gap-3 lg:grid-cols-2">
                <AuroraCard tone="neutral">
                  <div className="mb-2 text-xs font-medium text-muted-foreground">失败原因 Top {report.outcome.errorReasons.length || ""}</div>
                  {report.outcome.errorReasons.length === 0 ? (
                    <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
                      <CircleCheck className="size-4 text-success" /> 期间没有失败的任务，团队用得很顺
                    </div>
                  ) : (
                    <ul className="space-y-1.5 text-xs">
                      {report.outcome.errorReasons.slice(0, 6).map(reason => {
                        const body = (
                          <>
                            <span className="min-w-0 truncate" title={reason.reason}>{reasonLabel(reason.reason)}</span>
                            <span className="shrink-0 font-mono tabular-nums text-muted-foreground">×{reason.count}</span>
                          </>
                        );
                        return (
                          <li key={reason.reason}>
                            {/* 平台管理员可以按这个原因筛出全部失败 run；客户面无 runs 列表页，保持只读 */}
                            {isPlatformAdmin ? (
                              <button
                                type="button"
                                className="flex w-full items-center justify-between gap-3 rounded px-1 py-0.5 text-left hover:bg-muted/50"
                                title={`查看该原因的失败执行：${reason.reason}`}
                                onClick={() => navigatePlatformAdmin({
                                  section: "runs",
                                  search: { status: "failed", reason: reason.reason, tenantId },
                                })}
                              >
                                {body}
                              </button>
                            ) : (
                              <span className="flex items-center justify-between gap-3 px-1 py-0.5">{body}</span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </AuroraCard>

                <AuroraCard tone="neutral">
                  <div className="mb-2 text-xs font-medium text-muted-foreground">最耗时已终态任务 Top {Math.min(5, report.longTail.slowestRuns.length) || ""}</div>
                  {report.longTail.slowestRuns.length === 0 ? (
                    <div className="py-4 text-xs text-muted-foreground">期间无已终态任务记录</div>
                  ) : (
                    <ul className="space-y-1.5 text-xs">
                      {/*
                        改造前这一列只有「状态徽章 + 模型 + 耗时」，runId 既不显示也不可点——
                        客户看到「有个任务很慢」却没有任何下一步。

                        现在按受众分流：
                        - 平台管理员：整行可点，进该 run 的执行详情排查
                        - 客户组织管理员：tenant-admin 没有执行详情页，造一个跳转是骗人的。
                          改为给出可复制的任务编号，客户报障时能精确指认是哪一次。
                      */}
                      {report.longTail.slowestRuns.slice(0, 5).map((run, index) => {
                        const modelLabel = run.model ? labelFor(run.model) : "—";
                        const body = (
                          <>
                            <span className="flex min-w-0 items-center gap-2">
                              <RunStatusBadge status={run.status} />
                              <span className="shrink-0 text-muted-foreground">任务 {index + 1}</span>
                              <span className="min-w-0 truncate text-muted-foreground" title={modelLabel}>
                                {modelLabel}
                              </span>
                            </span>
                            <span className="shrink-0 font-mono tabular-nums">{formatMs(run.durationMs)}</span>
                          </>
                        );
                        return (
                          <li key={run.runId}>
                            {isPlatformAdmin ? (
                              <button
                                type="button"
                                className="flex w-full items-center justify-between gap-3 rounded px-1 py-0.5 text-left hover:bg-muted/50"
                                title={`执行记录 ${run.runId}`}
                                onClick={() => navigatePlatformAdmin({ section: "runs", entityId: run.runId })}
                              >
                                {body}
                              </button>
                            ) : (
                              <span
                                className="flex items-center justify-between gap-3 px-1 py-0.5"
                                title={`任务编号 ${run.runId}（反馈问题时可提供此编号）`}
                              >
                                {body}
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}

                  {report.longTail.longRunningRuns.length > 0 && (
                    <div className="mt-3 border-t border-border/60 pt-3">
                      <div className="mb-2 text-xs font-medium text-warning-ink">
                        超 24 小时未终态 · {formatCount(report.longTail.longRunningRuns.length)}
                      </div>
                      <ul className="space-y-1.5 text-xs">
                        {report.longTail.longRunningRuns.slice(0, 5).map((run, index) => (
                          <li
                            key={run.runId}
                            className="flex items-center justify-between gap-3 px-1 py-0.5"
                            title={`任务编号 ${run.runId}（仍在执行或等待，不计作完成）`}
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              <RunStatusBadge status={run.status} />
                              <span className="shrink-0 text-muted-foreground">未终态 {index + 1}</span>
                            </span>
                            <span className="shrink-0 font-mono tabular-nums">已持续 {formatMs(run.durationMs)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </AuroraCard>
              </div>
            </>
          )}
        </div>
      )}

      {/* 4. 使用趋势 + 模型占比 */}
      <div className="grid gap-3 lg:grid-cols-2">
        <AuroraCard tone="neutral">
          <div className="mb-2 text-xs font-medium text-muted-foreground">对话轮次 · 日趋势</div>
          {usage.loading && turnTrendPoints.length === 0 ? (
            <div className="flex h-[160px] items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" /> 加载中
            </div>
          ) : (
            <MiniBarTrend
              points={turnTrendPoints}
              formatValue={value => formatNumber(value)}
              unit="轮"
              emptyText="区间内暂无使用记录"
            />
          )}
        </AuroraCard>

        <AuroraCard tone="neutral">
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
      <AuroraCard tone="neutral">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs font-medium text-muted-foreground">
            成员使用排行 Top {Math.min(8, topUsers.length) || ""}
            {inactiveEnabledUsers > 0 && !usage.loading && (
              <span className="ml-2 text-warning-ink">· {inactiveEnabledUsers} 名成员期间未使用</span>
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
              {topUsers.map(user => {
                const displayName = user.realName ?? user.username;
                return (
                  <TableRow
                    key={user.username}
                    // 排行是「看到谁用得多」，下一步必然是「他具体在用什么」。
                    // 改造前这一行完全不可点，客户只能自己切页签再翻一遍列表。
                    className={cn(canDrillToUsage && "cursor-pointer hover:bg-muted/40")}
                    tabIndex={canDrillToUsage ? 0 : undefined}
                    role={canDrillToUsage ? "button" : undefined}
                    aria-label={canDrillToUsage ? `查看 ${displayName} 的用量明细` : undefined}
                    onClick={canDrillToUsage ? () => drillToUsage(user.username) : undefined}
                    onKeyDown={canDrillToUsage
                      ? (event) => {
                          if (event.key !== "Enter" && event.key !== " ") return;
                          event.preventDefault();
                          drillToUsage(user.username);
                        }
                      : undefined}
                  >
                    <TableCell className="font-medium">
                      <span>{displayName}</span>
                      {user.realName && <span className="ml-1.5 text-2xs text-muted-foreground">({user.username})</span>}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">{user.totalTurns.toLocaleString()}</TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">{formatShare(user.totalTurns, periodTurns)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground tabular-nums">{user.lastActiveDate}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </AuroraCard>

      {usage.error && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger-subtle p-3 text-xs text-danger-ink">
          <span>组织用量加载失败：{usage.error}</span>
          <Button size="sm" variant="outline" onClick={() => { void usage.refresh(); }}>重试</Button>
        </div>
      )}
    </div>
  );
}
