import { useMemo } from "react";
import { Activity, BarChart3, Building2, Cpu, DollarSign, FileWarning, ShieldCheck, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { useAuth } from "@/contexts/AuthContext";
import { useTenants } from "@/components/TenantManager/hooks";
import { useUsers } from "@/components/UserManager/hooks";
import { cn } from "@/lib/utils";
import { AuroraCard, ToneBadge, type Tone } from "./AuroraCard";
import { DonutChart, Sparkline } from "./charts";
import { useTenantUsageBundle } from "./hooks";
import { buildModelSlices, countActiveEnabledUsers } from "./metrics";

interface OverviewSectionProps {
  tenantId: string;
  onTenantChange?: (tenantId: string) => void;
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

function todayBeijing(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
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

export function OverviewSection({ tenantId, onTenantChange }: OverviewSectionProps) {
  const { isPlatformAdmin } = useAuth();
  const { users, loading: usersLoading } = useUsers();
  const { tenants } = useTenants();
  const usage = useTenantUsageBundle(tenantId);

  const currentTenant = tenants.find(tenant => tenant.id === tenantId);
  const tenantUsers = useMemo(() => users.filter(user => user.tenantId === tenantId), [tenantId, users]);
  const admins = tenantUsers.filter(user => user.role === "admin");
  const disabledUsers = tenantUsers.filter(user => user.disabled);
  const enabledUsers = tenantUsers.filter(user => !user.disabled);
  const activeEnabledUsers = countActiveEnabledUsers(
    enabledUsers.map(user => user.username),
    (usage.byUser?.users ?? []).map(user => user.username),
  );
  const activeCoverage = enabledUsers.length > 0
    ? `${Math.round((activeEnabledUsers / enabledUsers.length) * 100)}%`
    : "—";

  const trendPoints = usage.trend?.points ?? [];
  const todayTokens = trendPoints.find(point => point.date === todayBeijing())?.totalTokens ?? 0;
  const modelSlices = buildModelSlices(usage.byModel?.models ?? []);
  const totalModelTokens = modelSlices.reduce((sum, slice) => sum + slice.value, 0);

  return (
    <div className="w-full space-y-5">
      <SettingsPanelHeader
        title="组织分析"
        description="成员状态与近 7 天实际用量；详细用量、配额和审计保留在独立页面。"
        actions={isPlatformAdmin && tenants.length > 0 && onTenantChange ? (
          <select
            className="h-9 rounded-md border bg-background px-3 text-sm"
            value={tenantId}
            onChange={event => onTenantChange(event.target.value)}
            aria-label="切换组织分析目标"
          >
            {tenants.map(tenant => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}
          </select>
        ) : undefined}
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

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard tone="cyan" icon={Users} label="成员" value={tenantUsers.length} hint="当前组织用户总数" loading={usersLoading} />
        <KpiCard tone="emerald" icon={ShieldCheck} label="管理员" value={admins.length} hint="可管理组织能力的账号" loading={usersLoading} />
        <KpiCard tone="rose" icon={FileWarning} label="已禁用" value={disabledUsers.length} hint="当前不可登录账号" loading={usersLoading} />
        <KpiCard
          tone="slate"
          icon={Activity}
          label="近 7 天使用覆盖"
          value={activeCoverage}
          hint={`${activeEnabledUsers}/${enabledUsers.length} 个当前启用成员有用量记录`}
          loading={usage.loading || usersLoading}
        />
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <AuroraCard tone="indigo">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <div className="text-xs font-medium text-muted-foreground">Token · 近 7 天</div>
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
              <div className="text-xs font-medium text-muted-foreground">模型成本估算 · 近 7 天</div>
              <div className={cn("text-3xl font-semibold tracking-tight tabular-nums", usage.loading && "text-muted-foreground/40")}>
                {usage.loading ? "—" : formatCostUsd(usage.overview?.totalCostUsd ?? 0)}
              </div>
              {!usage.loading && (
                <div className="text-xs text-muted-foreground">
                  {formatNumber(usage.overview?.totalTurns ?? 0)} 个轮次 · 缓存命中 {formatPercent(usage.overview?.cacheHitRatio)}
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

        <AuroraCard tone="fuchsia" className="md:col-span-2 xl:col-span-1">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs font-medium text-muted-foreground">模型分布 · 近 7 天</div>
              <div className="mt-1 text-xs text-muted-foreground">按服务端返回的真实模型 ID 展示</div>
            </div>
            <ToneBadge tone="fuchsia" icon={Cpu} />
          </div>
          <div className="mt-3"><DonutChart slices={modelSlices} centerValue={formatNumber(totalModelTokens)} /></div>
        </AuroraCard>
      </div>

      {usage.error && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300">
          <span>组织用量加载失败：{usage.error}</span>
          <Button size="sm" variant="outline" onClick={() => { void usage.refresh(); }}>重试</Button>
        </div>
      )}
    </div>
  );
}
