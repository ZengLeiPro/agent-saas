import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { AdminEntityTable, EntityLink, MetricCard, StatusBadge } from "@/components/PlatformAdmin/common";
import { useTenants } from "@/components/TenantManager/hooks";
import type { UserInfo } from "@/components/UserManager/types";
import { useAdminUrlQuery } from "@/hooks/useAdminUrlQuery";
import { pushPlatformAdminUrl } from "@/lib/urlSync";

import { platformAdminApi } from "../api";
import { formatNumber, formatTime, formatYuan } from "../format";
import type { PlatformRunRecord, PlatformSessionRecord, UserSummaryResponse } from "../types";

export function UsersPage({ userId }: { userId: string | null }) {
  if (userId) return <UserDetail userId={userId} />;
  return <UserList />;
}

function UserList() {
  const adminQuery = useAdminUrlQuery();
  const { tenants } = useTenants();
  const [rows, setRows] = useState<UserInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<string[]>([]);

  const q = adminQuery.get("q") ?? "";
  const tenantId = adminQuery.get("tenantId") ?? "";
  const cursor = adminQuery.get("cursor") ?? "";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await platformAdminApi.users({ q, tenantId, cursor, limit: 50 });
      setRows(data.items);
      setNextCursor(data.nextCursor ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [cursor, q, tenantId]);

  useEffect(() => { void load(); }, [load]);

  const tenantName = useMemo(() => new Map(tenants.map(tenant => [tenant.id, tenant.name])), [tenants]);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5">
      <SettingsPanelHeader
        title="用户"
        description="跨租户用户定位、会话与运行入口。"
        actions={
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
            刷新
          </Button>
        }
      />
      {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">加载失败：{error}</div>}
      <AdminEntityTable
        title="用户列表"
        rows={rows}
        rowKey={(row) => row.id}
        loading={loading}
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={q}
                onChange={(event) => adminQuery.patch({ q: event.target.value, cursor: null })}
                placeholder="用户名 / 姓名 / userId"
                className="h-8 w-56 pl-7 text-xs"
              />
            </div>
            <select
              className="h-8 rounded-md border bg-background px-2 text-xs"
              value={tenantId}
              onChange={(event) => adminQuery.patch({ tenantId: event.target.value, cursor: null })}
            >
              <option value="">全部租户</option>
              {tenants.map(tenant => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}
            </select>
          </div>
        }
        onRowClick={(row) => {
          pushPlatformAdminUrl({ section: "users", entityId: row.id });
          window.dispatchEvent(new PopStateEvent("popstate"));
        }}
        hasPrev={cursorStack.length > 0}
        hasNext={!!nextCursor}
        onPrev={() => {
          const prev = [...cursorStack];
          const next = prev.pop() ?? "";
          setCursorStack(prev);
          adminQuery.patch({ cursor: next || null });
        }}
        onNext={() => {
          if (!nextCursor) return;
          setCursorStack(prev => [...prev, cursor]);
          adminQuery.patch({ cursor: nextCursor });
        }}
        columns={[
          { key: "user", header: "用户", cell: row => <div><div className="font-medium">{row.realName || row.username}</div><EntityLink kind="user" id={row.id} /></div> },
          { key: "tenant", header: "租户", cell: row => <EntityLink kind="tenant" id={row.tenantId} label={tenantName.get(row.tenantId) ?? row.tenantId} /> },
          { key: "role", header: "角色", cell: row => <Badge variant={row.role === "admin" ? "default" : "secondary"}>{row.role}</Badge> },
          { key: "position", header: "岗位", cell: row => row.position || "—" },
          { key: "status", header: "状态", cell: row => <Badge variant={row.disabled ? "destructive" : "secondary"}>{row.disabled ? "已禁用" : "启用中"}</Badge> },
          { key: "updated", header: "最后更新", cell: row => <span className="whitespace-nowrap text-xs text-muted-foreground">{formatTime(row.updatedAt)}</span> },
        ]}
      />
    </div>
  );
}

function UserDetail({ userId }: { userId: string }) {
  const [summary, setSummary] = useState<UserSummaryResponse | null>(null);
  const [sessions, setSessions] = useState<PlatformSessionRecord[]>([]);
  const [runs, setRuns] = useState<PlatformRunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const detail = await platformAdminApi.userSummary(userId);
      const [sessionData, runData] = await Promise.all([
        platformAdminApi.sessions({ tenantId: detail.user.tenantId, userId: detail.user.id, limit: 25 }),
        platformAdminApi.runs({ tenantId: detail.user.tenantId, userId: detail.user.id, hours: 720, limit: 25 }),
      ]);
      setSummary(detail);
      setSessions(sessionData.items);
      setRuns(runData.items);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { void load(); }, [load]);

  const user = summary?.user;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5">
      <SettingsPanelHeader
        title={user?.realName || user?.username || userId}
        description={`用户详情 · ${userId}`}
        actions={
          <>
            {user && <Button variant="outline" size="sm" onClick={() => {
              pushPlatformAdminUrl({ section: "sessions", search: { tenantId: user.tenantId, userId: user.id } });
              window.dispatchEvent(new PopStateEvent("popstate"));
            }}>会话</Button>}
            {user && <Button variant="outline" size="sm" onClick={() => {
              pushPlatformAdminUrl({ section: "runs", search: { tenantId: user.tenantId, userId: user.id } });
              window.dispatchEvent(new PopStateEvent("popstate"));
            }}>Run</Button>}
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
              刷新
            </Button>
          </>
        }
      />
      {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">加载失败：{error}</div>}
      {loading && !summary ? (
        <div className="flex h-40 items-center justify-center rounded-lg border bg-card text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          加载用户详情...
        </div>
      ) : summary && user ? (
        <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard title="角色" value={user.role} description={<EntityLink kind="tenant" id={user.tenantId} />} />
            <MetricCard title="30d 会话" value={formatNumber(summary.sessions30d)} description={`最后活跃 ${formatTime(summary.lastActiveAt)}`} />
            <MetricCard title="30d Run" value={formatNumber(summary.runs30d.total)} description={Object.entries(summary.runs30d.byStatus).map(([k, v]) => `${k}:${v}`).join(" · ") || "—"} />
            <MetricCard title="成本" value={formatYuan(summary.costYuan30d)} description={`累计 ${formatYuan(summary.costYuanTotal)}`} />
          </div>
          <div className="grid gap-4 xl:grid-cols-3">
            <Card>
              <CardHeader><CardTitle className="text-base">容器</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {summary.sandboxes.map(sandbox => (
                  <div key={sandbox.name} className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm">
                    <div className="min-w-0"><EntityLink kind="sandbox" id={sandbox.name} /><div className="truncate text-xs text-muted-foreground">{sandbox.workspaceId || "—"}</div></div>
                    <StatusBadge kind="sandbox" status={sandbox.phase ?? "Unknown"} />
                  </div>
                ))}
                {summary.sandboxes.length === 0 && <div className="py-6 text-center text-sm text-muted-foreground">暂无容器</div>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">最近会话</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {sessions.map(session => (
                  <div key={session.sessionId} className="rounded-md border p-2 text-sm">
                    <div className="truncate font-medium">{session.title || session.sessionId}</div>
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <EntityLink kind="session" id={session.sessionId} />
                      <span className="text-xs text-muted-foreground">{formatTime(session.updatedAt)}</span>
                    </div>
                  </div>
                ))}
                {sessions.length === 0 && <div className="py-6 text-center text-sm text-muted-foreground">暂无会话</div>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">最近 Run</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {runs.map(run => (
                  <div key={run.runId} className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm">
                    <div className="min-w-0"><EntityLink kind="run" id={run.runId} /><div className="mt-1 text-xs text-muted-foreground"><EntityLink kind="session" id={run.sessionId} /></div></div>
                    <StatusBadge kind="run" status={run.status} />
                  </div>
                ))}
                {runs.length === 0 && <div className="py-6 text-center text-sm text-muted-foreground">暂无 Run</div>}
              </CardContent>
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}
