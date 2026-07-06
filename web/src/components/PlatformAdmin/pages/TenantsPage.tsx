import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Settings } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { AdminEntityTable, EntityLink, MetricCard, StatusBadge } from "@/components/PlatformAdmin/common";
import { pushAdminSettingsUrl, pushPlatformAdminUrl } from "@/lib/urlSync";
import { cn } from "@/lib/utils";

import { platformAdminApi } from "../api";
import { RUN_LABEL, formatRole } from "../displayText";
import { formatCredits, formatNumber, formatTime, formatYuan } from "../format";
import type { PlatformRunRecord, PlatformSessionRecord, SandboxRecord, TenantOverviewItem } from "../types";

function openSettings() {
  pushAdminSettingsUrl("platform", "tenants");
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function go(section: "users" | "sessions" | "runs" | "sandboxes", search: Record<string, string>) {
  pushPlatformAdminUrl({ section, search });
  window.dispatchEvent(new PopStateEvent("popstate"));
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
        title="租户"
        description="跨组织运行状态、用户、会话和成本入口。"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={openSettings}>
              <Settings className="mr-1.5 h-3.5 w-3.5" />
              组织配置
            </Button>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={refreshing}>
              <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", refreshing && "animate-spin")} />
              刷新
            </Button>
          </>
        }
      />
      {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">加载失败：{error}</div>}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard title="租户总数" value={formatNumber(items.length)} description="含已禁用组织" />
        <MetricCard title="启用中" value={formatNumber(activeCount)} description="可登录与执行" tone="good" />
        <MetricCard title="活跃运行" value={formatNumber(items.reduce((sum, item) => sum + item.activeRuns, 0))} description="按租户聚合" />
        <MetricCard title="30d 成本" value={formatYuan(items.reduce((sum, item) => sum + item.costYuan30d, 0))} description="模型实际成本" />
      </div>
      <AdminEntityTable
        title="租户列表"
        rows={items}
        rowKey={(row) => row.id}
        loading={loading}
        onRefresh={() => void load()}
        onRowClick={(row) => {
          pushPlatformAdminUrl({ section: "tenants", entityId: row.id });
          window.dispatchEvent(new PopStateEvent("popstate"));
        }}
        columns={[
          { key: "status", header: "状态", cell: row => <Badge variant={row.disabled ? "destructive" : "secondary"}>{row.disabled ? "已禁用" : "启用中"}</Badge> },
          { key: "name", header: "名称", cell: row => <div><div className="font-medium">{row.name}</div><EntityLink kind="tenant" id={row.id} /></div> },
          { key: "users", header: "用户", cell: row => <span className="tabular-nums">{row.userCount} / 管理员 {row.adminCount}</span> },
          { key: "activeRuns", header: "活跃运行", cell: row => <span className="tabular-nums">{row.activeRuns}</span> },
          { key: "sessions", header: "7d 会话", cell: row => <span className="tabular-nums">{row.sessions7d}</span> },
          { key: "cost", header: "30d 成本", cell: row => <span className="tabular-nums">{formatYuan(row.costYuan30d)}</span> },
          { key: "balance", header: "余额", cell: row => <span className="tabular-nums">{formatCredits(row.balanceCredits)}</span> },
          { key: "last", header: "最后活跃", cell: row => <span className="whitespace-nowrap text-xs text-muted-foreground">{formatTime(row.lastActiveAt)}</span> },
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
        description={`租户详情 · ${tenantId}`}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => go("users", { tenantId })}>用户</Button>
            <Button variant="outline" size="sm" onClick={() => go("sessions", { tenantId })}>会话</Button>
            <Button variant="outline" size="sm" onClick={() => go("runs", { tenantId })}>{RUN_LABEL}</Button>
            <Button variant="outline" size="sm" onClick={() => go("sandboxes", { tenantId })}>执行环境</Button>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
              刷新
            </Button>
          </>
        }
      />
      {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">加载失败：{error}</div>}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard title="状态" value={tenant?.disabled ? "已禁用" : "启用中"} description={tenantId} tone={tenant?.disabled ? "bad" : "good"} />
        <MetricCard title="用户" value={formatNumber(tenant?.userCount)} description={`管理员 ${formatNumber(tenant?.adminCount)}`} />
        <MetricCard title="30d 成本" value={formatYuan(tenant?.costYuan30d)} description={formatCredits(tenant?.balanceCredits)} />
        <MetricCard title="活跃运行" value={formatNumber(tenant?.activeRuns ?? activeRuns)} description={`最后活跃 ${formatTime(tenant?.lastActiveAt)}`} />
      </div>
      {loading && !tenant ? (
        <div className="flex h-40 items-center justify-center rounded-lg border bg-card text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          加载租户详情...
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader><CardTitle className="text-base">用户</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {users.map(user => (
                <div key={user.id} className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{user.realName || user.username}</div>
                    <EntityLink kind="user" id={user.id} />
                  </div>
	                  <Badge variant={user.disabled ? "destructive" : "secondary"}>{formatRole(user.role)}</Badge>
                </div>
              ))}
              {users.length === 0 && <div className="py-6 text-center text-sm text-muted-foreground">暂无用户</div>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">最近会话</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {sessions.map(session => (
                <div key={session.sessionId} className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{session.title || session.sessionId}</div>
                    <EntityLink kind="session" id={session.sessionId} />
                  </div>
                  <span className="whitespace-nowrap text-xs text-muted-foreground">{formatTime(session.updatedAt)}</span>
                </div>
              ))}
              {sessions.length === 0 && <div className="py-6 text-center text-sm text-muted-foreground">暂无会话</div>}
            </CardContent>
          </Card>
          <Card>
	            <CardHeader><CardTitle className="text-base">最近运行</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {runs.map(run => (
                <div key={run.runId} className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm">
                  <div className="min-w-0">
                    <EntityLink kind="run" id={run.runId} />
                    <div className="mt-1 text-xs text-muted-foreground"><EntityLink kind="session" id={run.sessionId} /></div>
                  </div>
                  <StatusBadge kind="run" status={run.status} />
                </div>
              ))}
	              {runs.length === 0 && <div className="py-6 text-center text-sm text-muted-foreground">暂无运行记录</div>}
            </CardContent>
          </Card>
          <Card>
	            <CardHeader><CardTitle className="text-base">执行环境</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {sandboxes.map(sandbox => (
                <div key={sandbox.name} className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm">
                  <div className="min-w-0">
                    <EntityLink kind="sandbox" id={sandbox.name} />
                    <div className="truncate text-xs text-muted-foreground">{sandbox.workspaceId || "—"}</div>
                  </div>
                  <StatusBadge kind="sandbox" status={sandbox.phase ?? "Unknown"} />
                </div>
              ))}
	              {sandboxes.length === 0 && <div className="py-6 text-center text-sm text-muted-foreground">暂无执行环境</div>}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
