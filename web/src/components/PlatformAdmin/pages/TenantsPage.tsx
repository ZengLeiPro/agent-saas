import { useCallback, useEffect, useMemo, useState } from "react";
import { ListX, Loader2, MessageSquareDashed, PackageOpen, RefreshCw, Settings, UserPlus } from "lucide-react";
import { EntityIcons } from "@/lib/icons";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { AdminEntityTable, AdminErrorAlert, EmptyState, EntityLink, MetricCard, StatusBadge } from "@/components/PlatformAdmin/common";
import { navigateAdminSettings, navigatePlatformAdmin } from "@/lib/urlSync";
import { cn } from "@/lib/utils";

import { platformAdminApi } from "../api";
import { RUN_LABEL, SESSION_LABEL, TENANT_LABEL, formatRole } from "../displayText";
import { formatCredits, formatNumber, formatTime, formatYuan } from "../format";
import type { PlatformRunRecord, PlatformSessionRecord, SandboxRecord, TenantOverviewItem } from "../types";

function openSettings() {
  navigateAdminSettings("platform", "tenants");
}

function go(section: "users" | "sessions" | "runs" | "sandboxes", search: Record<string, string>) {
  navigatePlatformAdmin({ section, search });
}

export function TenantsPage({ tenantId }: { tenantId: string | null }) {
  if (tenantId) return <TenantDetail tenantId={tenantId} />;
  return <TenantList />;
}

function TenantList() {
  const [items, setItems] = useState<TenantOverviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (mode: "initial" | "refresh" = "refresh") => {
    if (mode === "initial") setLoading(true);
    else setRefreshing(true);
    try {
      const data = await platformAdminApi.tenantOverview();
      setItems(data.items);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load("initial"); }, [load]);

  const activeCount = items.filter(item => !item.disabled).length;

  return (
    <div className="w-full space-y-5">
      <SettingsPanelHeader
        title={TENANT_LABEL}
        description="查看各组织的用户规模、近期使用、成本与异常，点击一行可继续排查。"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={openSettings}>
              <Settings className="size-3.5" />
              组织配置
            </Button>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={refreshing}>
              <RefreshCw className={cn("mr-1.5 size-3.5", refreshing && "animate-spin")} />
              刷新
            </Button>
          </>
        }
      />
      {error && <AdminErrorAlert error={error} />}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard title="组织总数" value={formatNumber(items.length)} description="含已禁用组织" />
        <MetricCard title="启用中" value={formatNumber(activeCount)} description="可登录与执行" tone="good" />
        <MetricCard title="正在执行" value={formatNumber(items.reduce((sum, item) => sum + item.activeRuns, 0))} description="按组织汇总" />
        <MetricCard title="近 30 天成本" value={formatYuan(items.reduce((sum, item) => sum + item.costYuan30d, 0))} description="模型实际成本" />
      </div>
      <AdminEntityTable
        title="组织列表"
        storageKey="tenants"
        rows={items}
        rowKey={(row) => row.id}
        loading={loading}
        onRefresh={() => void load()}
        // 服务端一次返回全部组织（无分页），排序等于全量排序
        sortScope="all"
        skeletonRows={6}
        emptyState={
          <EmptyState
            icon={EntityIcons.org}
            title="还没有任何组织"
            description="平台上还没有创建组织。在「平台管理 · 组织」里新建后，这里会显示各组织的用量与余额。"
            action={{ label: "去新建组织", onClick: openSettings }}
          />
        }
        onRowClick={(row) => {
          navigatePlatformAdmin({ section: "tenants", entityId: row.id });
        }}
        columns={[
          // 已禁用排前面（降序），运维要先看异常组织
          { key: "status", header: "状态", sortable: true, sortNumeric: true, sortValue: row => (row.disabled ? 1 : 0), cell: row => <Badge variant={row.disabled ? "destructive" : "secondary"}>{row.disabled ? "已禁用" : "启用中"}</Badge> },
          { key: "name", header: "名称", alwaysVisible: true, sortable: true, sortValue: row => row.name, cell: row => <div><div className="font-medium">{row.name}</div><EntityLink kind="tenant" id={row.id} /></div> },
          { key: "users", header: "用户", sortable: true, sortNumeric: true, sortValue: row => row.userCount, cell: row => <span className="tabular-nums">{row.userCount} / 管理员 {row.adminCount}</span> },
          { key: "activeRuns", header: "正在执行", sortable: true, sortNumeric: true, sortValue: row => row.activeRuns, cell: row => <span className="tabular-nums">{row.activeRuns}</span> },
          { key: "sessions", header: "近 7 天对话", sortable: true, sortNumeric: true, sortValue: row => row.sessions7d, cell: row => <span className="tabular-nums">{row.sessions7d}</span> },
          { key: "cost", header: "近 30 天成本", sortable: true, sortNumeric: true, sortValue: row => row.costYuan30d, cell: row => <span className="tabular-nums">{formatYuan(row.costYuan30d)}</span> },
          { key: "balance", header: "余额", sortable: true, sortNumeric: true, sortValue: row => row.balanceCredits ?? null, cell: row => <span className="tabular-nums">{formatCredits(row.balanceCredits)}</span> },
          { key: "last", header: "最后活跃", sortable: true, sortNumeric: true, sortValue: row => (row.lastActiveAt ? Date.parse(row.lastActiveAt) || null : null), cell: row => <span className="whitespace-nowrap text-xs text-muted-foreground">{formatTime(row.lastActiveAt)}</span> },
        ]}
      />
    </div>
  );
}

function TenantDetail({ tenantId }: { tenantId: string }) {
  const [tenant, setTenant] = useState<TenantOverviewItem | null>(null);
  const [users, setUsers] = useState<Array<{ id: string; username: string; realName?: string; role: string; disabled?: boolean; updatedAt: string }>>([]);
  const [sessions, setSessions] = useState<PlatformSessionRecord[]>([]);
  const [runs, setRuns] = useState<PlatformRunRecord[]>([]);
  const [sandboxes, setSandboxes] = useState<SandboxRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tenantData, userData, sessionData, runData, sandboxData] = await Promise.all([
        platformAdminApi.tenantOverview(tenantId),
        platformAdminApi.users({ tenantId, limit: 25 }),
        platformAdminApi.sessions({ tenantId, limit: 25, includeDeleted: false }),
        platformAdminApi.runs({ tenantId, hours: 168, limit: 25 }),
        platformAdminApi.sandboxes(),
      ]);
      setTenant(tenantData.items[0] ?? null);
      setUsers(userData.items);
      setSessions(sessionData.items);
      setRuns(runData.items);
      setSandboxes(sandboxData.sandboxes.filter(item => item.owner?.tenantId === tenantId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { void load(); }, [load]);

  const activeRuns = useMemo(() => runs.filter(run => ["pending", "running", "waiting_approval", "waiting_user", "waiting_hand"].includes(run.status)).length, [runs]);

  return (
    <div className="w-full space-y-5">
      <SettingsPanelHeader
        title={tenant?.name ?? tenantId}
        description={`组织详情 · ${tenantId}`}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => go("users", { tenantId })}>用户</Button>
            <Button variant="outline" size="sm" onClick={() => go("sessions", { tenantId })}>{SESSION_LABEL}</Button>
            <Button variant="outline" size="sm" onClick={() => go("runs", { tenantId })}>{RUN_LABEL}</Button>
            <Button variant="outline" size="sm" onClick={() => go("sandboxes", { tenantId })}>执行环境</Button>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              刷新
            </Button>
          </>
        }
      />
      {error && <AdminErrorAlert error={error} />}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard title="状态" value={tenant?.disabled ? "已禁用" : "启用中"} description={tenantId} tone={tenant?.disabled ? "bad" : "good"} />
        <MetricCard title="用户" value={formatNumber(tenant?.userCount)} description={`管理员 ${formatNumber(tenant?.adminCount)}`} />
        <MetricCard title="近 30 天成本" value={formatYuan(tenant?.costYuan30d)} description={formatCredits(tenant?.balanceCredits)} />
        <MetricCard title="正在执行" value={formatNumber(tenant?.activeRuns ?? activeRuns)} description={`最后活跃 ${formatTime(tenant?.lastActiveAt)}`} />
      </div>
      {loading && !tenant ? (
        <div className="flex h-40 items-center justify-center rounded-lg border bg-card text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" />
          正在加载组织详情…
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card density="compact">
            <CardHeader><CardTitle>用户</CardTitle></CardHeader>
            <CardContent className="space-y-1.5">
              {users.map(user => (
                <div key={user.id} className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{user.realName || user.username}</div>
                    <EntityLink kind="user" id={user.id} />
                  </div>
                  <Badge variant={user.disabled ? "destructive" : "secondary"}>{formatRole(user.role)}</Badge>
                </div>
              ))}
              {users.length === 0 && (
                <EmptyState
                  compact
                  icon={UserPlus}
                  title="这个组织还没有成员"
                  description="没有成员，组织就不会产生任何对话与成本。在「组织配置」里添加成员后即可使用。"
                  action={{ label: "去添加成员", onClick: openSettings }}
                />
              )}
            </CardContent>
          </Card>
          <Card density="compact">
            <CardHeader><CardTitle>最近对话</CardTitle></CardHeader>
            <CardContent className="space-y-1.5">
              {sessions.map(session => (
                <div key={session.sessionId} className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{session.title || session.sessionId}</div>
                    <EntityLink kind="session" id={session.sessionId} />
                  </div>
                  <span className="whitespace-nowrap text-xs text-muted-foreground">{formatTime(session.updatedAt)}</span>
                </div>
              ))}
              {sessions.length === 0 && (
                <EmptyState
                  compact
                  icon={MessageSquareDashed}
                  title="这个组织还没有对话"
                  description="这里默认不含已删除对话。成员发起第一条消息后即会出现。"
                  action={{ label: "包含已删除查看", onClick: () => go("sessions", { tenantId, includeDeleted: "true" }) }}
                />
              )}
            </CardContent>
          </Card>
          <Card density="compact">
            <CardHeader><CardTitle>最近执行</CardTitle></CardHeader>
            <CardContent className="space-y-1.5">
              {runs.map(run => (
                <div key={run.runId} className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm">
                  <div className="min-w-0">
                    <EntityLink kind="run" id={run.runId} />
                    <div className="mt-1 text-xs text-muted-foreground"><EntityLink kind="session" id={run.sessionId} /></div>
                  </div>
                  <StatusBadge kind="run" status={run.status} />
                </div>
              ))}
              {runs.length === 0 && (
                <EmptyState
                  compact
                  icon={ListX}
                  title="近 7 天没有执行记录"
                  description="这里只看近 7 天。放宽到 30 天可以确认是否更早有过执行。"
                  action={{ label: "放宽到近 30 天", onClick: () => go("runs", { tenantId, hours: "720" }) }}
                />
              )}
            </CardContent>
          </Card>
          <Card density="compact">
            <CardHeader><CardTitle>执行环境</CardTitle></CardHeader>
            <CardContent className="space-y-1.5">
              {sandboxes.map(sandbox => (
                <div key={sandbox.name} className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm">
                  <div className="min-w-0">
                    <EntityLink kind="sandbox" id={sandbox.name} />
                    <div className="truncate text-xs text-muted-foreground">{sandbox.workspaceId || "—"}</div>
                  </div>
                  <StatusBadge kind="sandbox" status={sandbox.phase ?? "Unknown"} />
                </div>
              ))}
              {sandboxes.length === 0 && (
                <EmptyState
                  compact
                  icon={PackageOpen}
                  title="当前没有执行环境"
                  description="环境空闲后会被自动回收，这不是故障；成员下次发起任务时自动重建。"
                  action={{ label: "查看全部执行环境", onClick: () => go("sandboxes", { tenantId }) }}
                />
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
