/**
 * Token 用量管理面板（admin-only）
 *
 * 数据后端：/api/admin/usage/* (见 server/src/routes/usage.ts)
 *
 * 视图结构：
 *   [Header]    range 切换 + 数据完整性提示 + 重扫按钮
 *   [Overview]  4 张大数字卡片
 *   [Trend]     最大用户日趋势堆叠柱
 *   [Ranking]   用户排行表（行展开模型分布；点用户名进二级页）
 *   [Detail]    单用户详情（替换主区域）
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, ChevronDown, ChevronRight, CircleAlert, RotateCcw, Database, ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { useAuth } from "@/contexts/AuthContext";

import { useModelDisplayMap } from "@/components/TenantAnalytics/hooks";

import { usageApi } from "./api";
import type {
  OverviewStats,
  ByUserResp,
  ByModelResp,
  TrendResp,
  DataRangeResp,
  UserAggregate,
  ModelFamily,
} from "./types";
import { formatTokens, formatUsd, formatPercent, formatDateRange } from "./format";
import { TrendChart, type TrendBarDatum } from "./TrendChart";
import { UserDetailView } from "./UserDetailView";
import { RangeSelector, type RangeQuery, type RangeValue, type CustomRange } from "./RangeSelector";
import { FamilyFilter } from "./FamilyFilter";
import { EfficiencyView } from "./EfficiencyView";

// ────────── 子组件 ──────────

function OverviewCards({ data }: { data: OverviewStats }) {
  // "读写量" = input + output（不含缓存），用于看真实非缓存消耗
  const ioTokens = data.totalInputTokens + data.totalOutputTokens;
  // 客户简化视图（后端已按 policy.showCost 剥离成本）：不展示 USD 成本与缓存工程指标
  const simplified = data.costRedacted === true || data.totalCostUsd === undefined;
  const cards: { label: string; value: string; sub?: string }[] = [
    {
      label: "总 Token",
      value: formatTokens(data.totalTokens),
      sub: `含缓存 ${formatTokens(data.totalCacheReadTokens + data.totalCacheCreationTokens)}`,
    },
    {
      label: "读写量",
      value: formatTokens(ioTokens),
      sub: `输入 ${formatTokens(data.totalInputTokens)} · 输出 ${formatTokens(data.totalOutputTokens)}`,
    },
    ...(simplified
      ? [
          {
            label: "对话轮次",
            value: data.totalTurns.toLocaleString(),
          },
        ]
      : [
          {
            label: "总成本",
            value: formatUsd(data.totalCostUsd ?? 0),
            sub: (data.totalCostUsd ?? 0) === 0 ? "无数据" : `${data.totalTurns.toLocaleString()} 次轮次`,
          },
        ]),
    {
      label: "活跃用户",
      value: String(data.activeUsers),
      sub: `${data.totalTurns.toLocaleString()} 次轮次`,
    },
    ...(simplified
      ? []
      : [
          {
            label: "缓存命中",
            value: formatPercent(data.cacheHitRatio),
            sub: `${formatTokens(data.totalCacheReadTokens)} / ${formatTokens(data.totalInputTokens + data.totalCacheReadTokens + data.totalCacheCreationTokens)}`,
          },
        ]),
  ];
  return (
    <div className={cn("grid grid-cols-2 gap-3 sm:grid-cols-3", simplified ? "lg:grid-cols-4" : "lg:grid-cols-5")}>
      {cards.map((c) => (
        <Card key={c.label}>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">{c.label}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold tabular-nums">{c.value}</div>
            {c.sub && <div className="mt-1 truncate text-[11px] text-muted-foreground">{c.sub}</div>}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** 日期 + 家族 API 参数：preset 走 range，自定义走 from/to；family 始终透传 */
interface DateArgs {
  range?: RangeQuery;
  from?: string;
  to?: string;
  tenantId?: string;
  family?: ModelFamily;
}

function ModelBar({ user, dateArgs, labelFor }: { user: string; dateArgs: DateArgs; labelFor?: (modelId: string) => string }) {
  const [data, setData] = useState<ByModelResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 把 dateArgs 内联展开成稳定依赖键（避免 useEffect 反复触发）
  const { range: r, from: f, to: t, tenantId, family: fam } = dateArgs;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    usageApi
      .byModel({ range: r, from: f, to: t, username: user, tenantId, family: fam })
      .then((rs) => {
        if (!cancelled) setData(rs);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user, r, f, t, tenantId, fam]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> 加载模型分布...
      </div>
    );
  }
  if (error) return <div className="py-2 text-xs text-red-500">{error}</div>;
  if (!data || data.models.length === 0) {
    return <div className="py-2 text-xs text-muted-foreground">无模型数据</div>;
  }

  const maxTokens = Math.max(...data.models.map((m) => m.totalTokens), 1);
  const showCost = data.costRedacted !== true;

  return (
    <div className="space-y-1.5 pl-4">
      {data.models.map((m) => (
        <div key={m.model} className="flex items-center gap-3 text-xs">
          <div className={cn("w-48 truncate", showCost && "font-mono")} title={labelFor ? labelFor(m.model) : m.model}>
            {labelFor ? labelFor(m.model) : m.model}
          </div>
          <div className="flex h-4 flex-1 overflow-hidden rounded bg-muted">
            <div className="bg-emerald-500" style={{ width: `${(m.inputTokens / maxTokens) * 100}%` }} title={`输入 ${formatTokens(m.inputTokens)}`} />
            <div className="bg-amber-500" style={{ width: `${(m.outputTokens / maxTokens) * 100}%` }} title={`输出 ${formatTokens(m.outputTokens)}`} />
            <div className="bg-blue-400" style={{ width: `${(m.cacheReadTokens / maxTokens) * 100}%` }} title={`缓存读 ${formatTokens(m.cacheReadTokens)}`} />
            <div className="bg-purple-400" style={{ width: `${(m.cacheCreationTokens / maxTokens) * 100}%` }} title={`缓存写 ${formatTokens(m.cacheCreationTokens)}`} />
          </div>
          <div className="w-20 text-right font-mono tabular-nums">{formatTokens(m.totalTokens)}</div>
          {showCost && (
            <div className="w-16 text-right font-mono tabular-nums text-muted-foreground">{formatUsd(m.totalCostUsd ?? 0)}</div>
          )}
          <div className="w-12 text-right font-mono tabular-nums text-muted-foreground">{m.totalTurns}</div>
        </div>
      ))}
    </div>
  );
}

type SortField =
  | "username"
  | "totalTokens"
  | "ioTokens"
  | "totalInputTokens"
  | "totalOutputTokens"
  | "totalCacheReadTokens"
  | "totalCacheCreationTokens"
  | "cacheHitRatio"
  | "totalCostUsd"
  | "totalTurns"
  | "lastActiveDate";

type SortDir = "asc" | "desc";

/** 字符串字段（点击默认 asc）；其他都是数值，默认 desc */
const ASC_DEFAULT_FIELDS: ReadonlySet<SortField> = new Set(["username", "lastActiveDate"]);

function getSortValue(u: UserAggregate, f: SortField): number | string | null {
  switch (f) {
    case "username": return u.realName ?? u.username;
    case "totalTokens": return u.totalTokens;
    case "ioTokens": return u.totalInputTokens + u.totalOutputTokens;
    case "totalInputTokens": return u.totalInputTokens;
    case "totalOutputTokens": return u.totalOutputTokens;
    case "totalCacheReadTokens": return u.totalCacheReadTokens;
    case "totalCacheCreationTokens": return u.totalCacheCreationTokens;
    case "cacheHitRatio": return u.cacheHitRatio; // 可能 null
    case "totalCostUsd": return u.totalCostUsd ?? null; // 组织 admin 脱敏后为 undefined
    case "totalTurns": return u.totalTurns;
    case "lastActiveDate": return u.lastActiveDate;
  }
}

function sortUsers(users: UserAggregate[], field: SortField, dir: SortDir): UserAggregate[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...users].sort((a, b) => {
    const av = getSortValue(a, field);
    const bv = getSortValue(b, field);
    // null 永远沉底（无论 asc/desc）
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "number" && typeof bv === "number") {
      return (av - bv) * sign;
    }
    return String(av).localeCompare(String(bv), "zh-Hans-CN") * sign;
  });
}

interface SortHeaderProps {
  field: SortField;
  current: SortField;
  dir: SortDir;
  align?: "left" | "right";
  width?: string;
  onChange: (f: SortField) => void;
  children: React.ReactNode;
  title?: string;
}

function SortHeader({ field, current, dir, align = "right", width, onChange, children, title }: SortHeaderProps) {
  const active = current === field;
  const Icon = active ? (dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <TableHead className={cn(align === "right" ? "text-right" : "text-left", width)} title={title}>
      <button
        type="button"
        onClick={() => onChange(field)}
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground transition-colors",
          align === "right" && "ml-auto",
          active ? "text-foreground font-semibold" : "text-muted-foreground",
        )}
      >
        {align === "right" && <Icon className={cn("size-3", !active && "opacity-40")} />}
        <span>{children}</span>
        {align === "left" && <Icon className={cn("size-3", !active && "opacity-40")} />}
      </button>
    </TableHead>
  );
}

function UserRankTable({
  users,
  dateArgs,
  onSelectUser,
  simplified = false,
  labelFor,
}: {
  users: UserAggregate[];
  dateArgs: DateArgs;
  onSelectUser: (user: UserAggregate) => void;
  /** 客户简化视图：隐藏成本与缓存工程列（后端已剥离成本字段） */
  simplified?: boolean;
  labelFor?: (modelId: string) => string;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField>("totalTokens");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const handleSort = useCallback((f: SortField) => {
    if (f === sortField) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(f);
      setSortDir(ASC_DEFAULT_FIELDS.has(f) ? "asc" : "desc");
    }
  }, [sortField]);

  const sortedUsers = useMemo(
    () => sortUsers(users, sortField, sortDir),
    [users, sortField, sortDir],
  );

  if (users.length === 0) {
    return <div className="py-8 text-center text-sm text-muted-foreground">区间内无数据</div>;
  }

  const headerProps = { current: sortField, dir: sortDir, onChange: handleSort };

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortHeader {...headerProps} field="username" align="left" width="w-[220px]">用户</SortHeader>
          <SortHeader {...headerProps} field="totalTokens">总 Token</SortHeader>
          <SortHeader {...headerProps} field="ioTokens" title="输入 + 输出，不含缓存">读写量</SortHeader>
          <SortHeader {...headerProps} field="totalInputTokens">输入</SortHeader>
          <SortHeader {...headerProps} field="totalOutputTokens">输出</SortHeader>
          {!simplified && <SortHeader {...headerProps} field="totalCacheReadTokens">缓存读</SortHeader>}
          {!simplified && <SortHeader {...headerProps} field="totalCacheCreationTokens">缓存写</SortHeader>}
          {!simplified && <SortHeader {...headerProps} field="cacheHitRatio">命中率</SortHeader>}
          {!simplified && <SortHeader {...headerProps} field="totalCostUsd">成本</SortHeader>}
          <SortHeader {...headerProps} field="totalTurns">轮次</SortHeader>
          <SortHeader {...headerProps} field="lastActiveDate" align="left" width="w-[110px]">最后活跃</SortHeader>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sortedUsers.map((u) => {
          const isOpen = expanded === u.username;
          return (
            <Fragment key={u.username}>
              <TableRow className="hover:bg-muted/30">
                <TableCell className="font-medium">
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setExpanded(isOpen ? null : u.username)}
                      className="flex size-5 items-center justify-center rounded hover:bg-accent"
                      title={isOpen ? "收起" : "展开模型分布"}
                    >
                      {isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => onSelectUser(u)}
                      className="truncate text-left hover:underline"
                      title="查看详细数据"
                    >
                      <span>{u.realName ?? u.username}</span>
                      {u.realName && (
                        <span className="ml-1.5 text-[11px] text-muted-foreground">({u.username})</span>
                      )}
                    </button>
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">{formatTokens(u.totalTokens)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{formatTokens(u.totalInputTokens + u.totalOutputTokens)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums text-muted-foreground">{formatTokens(u.totalInputTokens)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums text-muted-foreground">{formatTokens(u.totalOutputTokens)}</TableCell>
                {!simplified && <TableCell className="text-right font-mono tabular-nums text-muted-foreground">{formatTokens(u.totalCacheReadTokens)}</TableCell>}
                {!simplified && <TableCell className="text-right font-mono tabular-nums text-muted-foreground">{formatTokens(u.totalCacheCreationTokens)}</TableCell>}
                {!simplified && <TableCell className="text-right font-mono tabular-nums">{formatPercent(u.cacheHitRatio)}</TableCell>}
                {!simplified && <TableCell className="text-right font-mono tabular-nums">{formatUsd(u.totalCostUsd ?? 0)}</TableCell>}
                <TableCell className="text-right font-mono tabular-nums">{u.totalTurns.toLocaleString()}</TableCell>
                <TableCell className="text-xs text-muted-foreground tabular-nums">{u.lastActiveDate}</TableCell>
              </TableRow>
              {isOpen && (
                <TableRow>
                  <TableCell colSpan={simplified ? 7 : 11} className="bg-muted/30">
                    <ModelBar user={u.username} dateArgs={dateArgs} labelFor={labelFor} />
                  </TableCell>
                </TableRow>
              )}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}

// ────────── 主组件 ──────────

interface UsageDashboardProps {
  tenantId?: string;
  scope?: "platform" | "tenant";
  fullWidth?: boolean;
}

export function UsageDashboard({ tenantId, scope = tenantId ? "tenant" : "platform", fullWidth = false }: UsageDashboardProps = {}) {
  // platformReadOnly：只读平台 admin，重扫 usage 数据 disabled
  const { isPlatformAdmin, canPlatform } = useAuth();
  /** 顶部 tab：用量（现有内容）/ 效率（仅平台 admin 可见） */
  const [viewTab, setViewTab] = useState<"usage" | "efficiency">("usage");
  const [range, setRange] = useState<RangeValue>("30d");
  const [customRange, setCustomRange] = useState<CustomRange | null>(null);
  /** 家族筛选；'all' = 全部（请求时不带 family 参数） */
  const [family, setFamily] = useState<ModelFamily | "all">("all");
  const [overview, setOverview] = useState<OverviewStats | null>(null);
  const [byUser, setByUser] = useState<ByUserResp | null>(null);
  const [trend, setTrend] = useState<TrendResp | null>(null);
  const [dataRange, setDataRange] = useState<DataRangeResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState<UserAggregate | null>(null);

  // Rebuild 状态
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildMsg, setRebuildMsg] = useState<string | null>(null);
  const scopeLabel = scope === "tenant" ? "当前组织" : "全公司";
  // 客户简化视图信号：后端按 policy.showCost 剥离成本时同步隐藏工程列；模型名走租户显示名映射
  const simplified = overview?.costRedacted === true;
  const { labelFor } = useModelDisplayMap();

  // 把 range / customRange / family 折算成统一的 API 参数
  const dateArgs = useMemo<DateArgs>(() => {
    const familyArg = family === "all" ? undefined : family;
    if (range === "custom" && customRange) {
      return { from: customRange.from, to: customRange.to, tenantId, family: familyArg };
    }
    return { range: range as RangeQuery, tenantId, family: familyArg };
  }, [range, customRange, family, tenantId]);

  const handleRangeChange = useCallback((v: RangeValue, c?: CustomRange) => {
    setRange(v);
    if (v === "custom" && c) setCustomRange(c);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ov, bu, dr, tr] = await Promise.all([
        usageApi.overview(dateArgs),
        usageApi.byUser(dateArgs),
        usageApi.dataRange({ tenantId }),
        usageApi.trend(dateArgs), // 不传 username → 全公司日合计
      ]);
      setOverview(ov);
      setByUser(bu);
      setDataRange(dr);
      setTrend(tr);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [dateArgs, tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 触发重扫 + 轮询 data-range 等完成
  const onRebuild = useCallback(async () => {
    if (!isPlatformAdmin) return;
    setRebuildMsg(null);
    setRebuilding(true);
    try {
      const r = await usageApi.rebuild();
      if (r.conflict) {
        setRebuildMsg("已有重扫任务在跑");
        setRebuilding(false);
        return;
      }
      setRebuildMsg("后台扫描中…");
      // 轮询：每 1.5s 拉一次 data-range，rebuild.lastRebuildAtMs 变化即视为完成
      const before = dataRange?.rebuild?.lastRebuildAtMs ?? 0;
      const start = Date.now();
      const tick = async () => {
        if (Date.now() - start > 60_000) {
          setRebuildMsg("超时（60s 未完成），可手动刷新");
          setRebuilding(false);
          return;
        }
        try {
          const dr = await usageApi.dataRange({ tenantId });
          if (dr.rebuild && dr.rebuild.lastRebuildAtMs > before) {
            setDataRange(dr);
            setRebuildMsg(`重扫完成：${dr.rebuild.totalFilesScanned} 文件 / ${dr.rebuild.totalRowsBuilt} 行`);
            setRebuilding(false);
            void load();
            return;
          }
        } catch {
          // ignore
        }
        setTimeout(() => void tick(), 1500);
      };
      setTimeout(() => void tick(), 1500);
    } catch (e) {
      setRebuildMsg(e instanceof Error ? e.message : String(e));
      setRebuilding(false);
    }
  }, [dataRange, isPlatformAdmin, load, tenantId]);

  const trendData = useMemo<TrendBarDatum[]>(() => {
    if (!trend) return [];
    return trend.points.map((p) => ({
      date: p.date,
      input: p.inputTokens,
      output: p.outputTokens,
      cacheRead: p.cacheReadTokens,
      cacheCreation: p.cacheCreationTokens,
      total: p.totalTokens,
    }));
  }, [trend]);

  // 详情视图
  if (selectedUser) {
    return (
      <div className={cn("w-full", !fullWidth && "mx-auto max-w-5xl")}>
        <UserDetailView
          username={selectedUser.username}
          realName={selectedUser.realName}
          tenantId={tenantId}
          range={range}
          customRange={customRange}
          family={family}
          onRangeChange={handleRangeChange}
          onFamilyChange={setFamily}
          onBack={() => setSelectedUser(null)}
        />
      </div>
    );
  }

  return (
    <div className={cn("w-full space-y-4", !fullWidth && "mx-auto max-w-5xl")}>
      {/* 用量 / 效率 tab。效率视图是工程排查口径（工具健康/浪费探测/真实模型 ID），
          2026-07-14 起收回平台管理员专属；组织 admin 的健康信息由综合分析页以客户口径承载 */}
      {isPlatformAdmin && (
        <div className="inline-flex items-center self-start rounded-md border bg-card p-0.5">
          {([["usage", "用量"], ["efficiency", "效率"]] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setViewTab(key)}
              className={cn(
                "rounded px-4 py-1 text-xs font-medium transition-colors",
                viewTab === key
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {viewTab === "efficiency" && isPlatformAdmin ? (
        <EfficiencyView tenantId={tenantId} linkEntities={isPlatformAdmin} />
      ) : (
        <>
      {/* Header */}
      <SettingsPanelHeader
        title="Token 用量"
        description={scope === "tenant" ? "按当前组织用户、模型和时间维度查看 Token 消耗趋势。" : "按用户、模型和时间维度查看 Token 消耗趋势。"}
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <RangeSelector
              value={range}
              customRange={customRange}
              onChange={handleRangeChange}
              dateRangeLabel={overview ? formatDateRange(overview.fromDate, overview.toDate) : undefined}
            />
            <FamilyFilter value={family} onChange={setFamily} />
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={cn("mr-1 size-3.5", loading && "animate-spin")} />
              刷新
            </Button>
          </div>
        }
      />

      {/* 数据完整性 + Rebuild 状态条 */}
      <div className="space-y-2">
        {dataRange?.firstCostDate && dataRange.earliestDate && dataRange.firstCostDate !== dataRange.earliestDate && (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Token 数据自 <span className="font-mono">{dataRange.earliestDate}</span> 起记录；
              成本数据自 <span className="font-mono">{dataRange.firstCostDate}</span> 起完整
              （此日之前为 jsonl 历史回填，SDK 未持久化成本字段）
            </span>
          </div>
        )}
        {dataRange?.rebuild && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-card px-3 py-2 text-xs">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Database className="size-3.5" />
              <span>
                上次回填：
                <span className="ml-1 font-mono">{new Date(dataRange.rebuild.lastRebuildAtMs).toLocaleString()}</span>
                <span className="mx-2">·</span>
                {dataRange.rebuild.totalFilesScanned.toLocaleString()} 个 jsonl
                <span className="mx-2">·</span>
                {dataRange.rebuild.totalRowsBuilt.toLocaleString()} 行
              </span>
              {rebuildMsg && <span className="ml-2 text-foreground">{rebuildMsg}</span>}
            </div>
            {isPlatformAdmin && (
              <Button variant="outline" size="sm" onClick={() => void onRebuild()} disabled={!canPlatform("runtime.operate") || rebuilding}>
                <RotateCcw className={cn("mr-1 size-3.5", rebuilding && "animate-spin")} />
                {rebuilding ? "扫描中…" : "重新扫描"}
              </Button>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
          加载失败：{error}
        </div>
      )}

      {overview && <OverviewCards data={overview} />}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">
            日趋势 <span className="text-xs font-normal text-muted-foreground">· {scopeLabel}合计</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading && !trend ? (
            <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" /> 加载中
            </div>
          ) : (
            <TrendChart data={trendData} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">用户排行 <span className="ml-1 text-[11px] font-normal text-muted-foreground">（点用户名查看详情；点 <ChevronRight className="inline size-3 align-[-1.5px]" aria-hidden="true" /> 展开模型分布）</span></CardTitle>
        </CardHeader>
        <CardContent>
          {byUser ? (
            <UserRankTable
              users={byUser.users}
              dateArgs={dateArgs}
              onSelectUser={setSelectedUser}
              simplified={simplified}
              labelFor={labelFor}
            />
          ) : loading ? (
            <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" /> 加载中
            </div>
          ) : null}
        </CardContent>
      </Card>
        </>
      )}
    </div>
  );
}
