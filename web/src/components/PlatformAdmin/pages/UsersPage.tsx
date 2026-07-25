import { useCallback, useEffect, useMemo, useState } from "react";
import { ListX, Loader2, MessageSquareDashed, PackageOpen, RefreshCw, Search, SearchX } from "lucide-react";

import { AdminSelect, type AdminSelectOption } from "@/components/ui/admin-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { AdminEntityTable, AdminErrorAlert, EmptyState, EntityLink, MetricCard, StatusBadge } from "@/components/PlatformAdmin/common";
import { useTenants } from "@/components/TenantManager/hooks";
import type { UserInfo } from "@/components/UserManager/types";
import { useAdminUrlQuery } from "@/hooks/useAdminUrlQuery";
import { navigateAdminSettings, navigatePlatformAdmin } from "@/lib/urlSync";

import { platformAdminApi } from "../api";
import { RUN_LABEL, SESSION_LABEL, TENANT_LABEL, formatRole, formatRunStatus } from "../displayText";
import { formatNumber, formatTime, formatYuan } from "../format";
import type { PlatformRunRecord, PlatformSessionRecord, UserSummaryResponse } from "../types";

export function UsersPage({ userId }: { userId: string | null }) {
  if (userId) return <UserDetail userId={userId} />;
  return <UserList />;
}

function UserList() {
  const adminQuery = useAdminUrlQuery();
  const patchQuery = adminQuery.patch;
  const { tenants } = useTenants();
  const [rows, setRows] = useState<UserInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<string[]>([]);

  const q = adminQuery.get("q") ?? "";
  const [qInput, setQInput] = useState(q);
  const tenantId = adminQuery.get("tenantId") ?? "";
  const cursor = adminQuery.get("cursor") ?? "";

  useEffect(() => {
    setQInput(q);
  }, [q]);

  useEffect(() => {
    if (qInput === q) return;
    const timer = window.setTimeout(() => patchQuery({ q: qInput, cursor: null }), 300);
    return () => window.clearTimeout(timer);
  }, [patchQuery, q, qInput]);

  const tenantSelectOptions = useMemo<AdminSelectOption[]>(() => [
    { value: "", label: "全部组织" },
    ...tenants.map(tenant => ({ value: tenant.id, label: tenant.name })),
  ], [tenants]);

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
    <div className="w-full space-y-5">
      <SettingsPanelHeader
        title="用户"
        description="按姓名、用户名或组织找到用户，并继续查看该用户的对话、执行记录与成本。"
        actions={
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            刷新
          </Button>
        }
      />
      {error && <AdminErrorAlert error={error} />}
      <AdminEntityTable
        title="用户列表"
        storageKey="users"
        rows={rows}
        rowKey={(row) => row.id}
        loading={loading}
        // cursor 分页：rows 只是当前 50 条，排序不是全量排序，必须明示
        sortScope="page"
        skeletonRows={8}
        emptyState={
          <EmptyState
            icon={SearchX}
            title={q || tenantId ? "没有匹配的用户" : "还没有任何用户"}
            description={q || tenantId
              ? "关键词按用户名、姓名、用户 ID 精确/前缀匹配，不匹配手机号中间段。换个关键词，或清除组织筛选后再看一次。"
              : "组织下还没有成员。在「平台管理 · 组织」里为组织添加成员后，这里会显示。"}
            action={q || tenantId
              ? { label: "清除筛选", onClick: () => adminQuery.clear(["q", "tenantId", "cursor"]) }
              : { label: "去组织配置添加成员", onClick: () => navigateAdminSettings("platform", "tenants") }}
          />
        }
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={qInput}
                onChange={(event) => setQInput(event.target.value)}
                placeholder="用户名 / 姓名 / 用户 ID"
                className="h-8 w-56 pl-7 text-xs"
              />
            </div>
            <AdminSelect
              ariaLabel="按组织筛选"
              options={tenantSelectOptions}
              value={tenantId}
              onValueChange={(value) => adminQuery.patch({ tenantId: value, cursor: null })}
            />
          </div>
        }
        onRowClick={(row) => {
          navigatePlatformAdmin({ section: "users", entityId: row.id });
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
          { key: "user", header: "用户", alwaysVisible: true, sortable: true, sortValue: row => row.realName || row.username, cell: row => <div><div className="font-medium">{row.realName || row.username}</div><EntityLink kind="user" id={row.id} /></div> },
          { key: "tenant", header: TENANT_LABEL, sortable: true, sortValue: row => tenantName.get(row.tenantId) ?? row.tenantId, cell: row => <EntityLink kind="tenant" id={row.tenantId} label={tenantName.get(row.tenantId) ?? row.tenantId} /> },
          // 管理员排前面（降序），排查权限问题时先看谁有管理员
          { key: "role", header: "角色", sortable: true, sortNumeric: true, sortValue: row => (row.role === "admin" ? 1 : 0), cell: row => <Badge variant={row.role === "admin" ? "default" : "secondary"}>{formatRole(row.role)}</Badge> },
          { key: "position", header: "岗位", sortable: true, sortValue: row => row.position || null, cell: row => row.position || "—" },
          { key: "status", header: "状态", sortable: true, sortNumeric: true, sortValue: row => (row.disabled ? 1 : 0), cell: row => <Badge variant={row.disabled ? "destructive" : "secondary"}>{row.disabled ? "已禁用" : "启用中"}</Badge> },
          { key: "updated", header: "最后更新", sortable: true, sortNumeric: true, sortValue: row => (row.updatedAt ? Date.parse(row.updatedAt) || null : null), cell: row => <span className="whitespace-nowrap text-xs text-muted-foreground">{formatTime(row.updatedAt)}</span> },
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
    <div className="w-full space-y-5">
      <SettingsPanelHeader
        title={user?.realName || user?.username || userId}
        description={`用户详情 · ${userId}`}
        actions={
          <>
            {user && <Button variant="outline" size="sm" onClick={() => {
              navigatePlatformAdmin({ section: "sessions", search: { tenantId: user.tenantId, userId: user.id } });
            }}>{SESSION_LABEL}</Button>}
            {user && <Button variant="outline" size="sm" onClick={() => {
              navigatePlatformAdmin({ section: "runs", search: { tenantId: user.tenantId, userId: user.id } });
            }}>{RUN_LABEL}</Button>}
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              刷新
            </Button>
          </>
        }
      />
      {error && <AdminErrorAlert error={error} />}
      {loading && !summary ? (
        <div className="flex h-40 items-center justify-center rounded-lg border bg-card text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" />
          加载用户详情...
        </div>
      ) : summary && user ? (
        <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard title="角色" value={formatRole(user.role)} description={<EntityLink kind="tenant" id={user.tenantId} />} />
            <MetricCard title="近 30 天对话" value={formatNumber(summary.sessions30d)} description={`最后活跃 ${formatTime(summary.lastActiveAt)}`} />
            <MetricCard title="近 30 天执行" value={formatNumber(summary.runs30d.total)} description={Object.entries(summary.runs30d.byStatus).map(([k, v]) => `${formatRunStatus(k)}：${v}`).join(" · ") || "—"} />
            <MetricCard title="近 30 天成本" value={formatYuan(summary.costYuan30d)} description={`累计 ${formatYuan(summary.costYuanTotal)}`} />
          </div>
          <div className="grid gap-4 xl:grid-cols-3">
            <Card density="compact">
              <CardHeader><CardTitle>执行环境</CardTitle></CardHeader>
              <CardContent className="space-y-1.5">
                {summary.sandboxes.map(sandbox => (
                  <div key={sandbox.name} className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm">
                    <div className="min-w-0"><EntityLink kind="sandbox" id={sandbox.name} /><div className="truncate text-xs text-muted-foreground">{sandbox.workspaceId || "—"}</div></div>
                    <StatusBadge kind="sandbox" status={sandbox.phase ?? "Unknown"} />
                  </div>
                ))}
                {summary.sandboxes.length === 0 && (
                  <EmptyState
                    compact
                    icon={PackageOpen}
                    title="当前没有执行环境"
                    description="环境空闲后会被自动回收；用户下次发起任务时自动重建，不需要人工干预。"
                    action={{
                      label: "查看全部执行环境",
                      onClick: () => navigatePlatformAdmin({ section: "sandboxes", search: { tenantId: user.tenantId, q: user.username } }),
                    }}
                  />
                )}
              </CardContent>
            </Card>
            <Card density="compact">
              <CardHeader><CardTitle>最近对话</CardTitle></CardHeader>
              <CardContent className="space-y-1.5">
                {sessions.map(session => (
                  <div key={session.sessionId} className="rounded-md border p-2 text-sm">
                    <div className="truncate font-medium">{session.title || session.sessionId}</div>
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <EntityLink kind="session" id={session.sessionId} />
                      <span className="text-xs text-muted-foreground">{formatTime(session.updatedAt)}</span>
                    </div>
                  </div>
                ))}
                {sessions.length === 0 && (
                  <EmptyState
                    compact
                    icon={MessageSquareDashed}
                    title="这个用户还没有对话"
                    description="可能是新加入的成员，也可能对话都被删除了。勾选「包含已删除」能看到删除记录。"
                    action={{
                      label: "包含已删除查看",
                      onClick: () => navigatePlatformAdmin({ section: "sessions", search: { tenantId: user.tenantId, userId: user.id, includeDeleted: true } }),
                    }}
                  />
                )}
              </CardContent>
            </Card>
            <Card density="compact">
              <CardHeader><CardTitle>最近执行</CardTitle></CardHeader>
              <CardContent className="space-y-1.5">
                {runs.map(run => (
                  <div key={run.runId} className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm">
                    <div className="min-w-0"><EntityLink kind="run" id={run.runId} /><div className="mt-1 text-xs text-muted-foreground"><EntityLink kind="session" id={run.sessionId} /></div></div>
                    <StatusBadge kind="run" status={run.status} />
                  </div>
                ))}
                {runs.length === 0 && (
                  <EmptyState
                    compact
                    icon={ListX}
                    title="近 30 天没有执行记录"
                    description="这里只看近 30 天。要确认是否更早有过执行，可以放宽到该组织的全部记录。"
                    action={{
                      label: `查看该组织的${RUN_LABEL}`,
                      onClick: () => navigatePlatformAdmin({ section: "runs", search: { tenantId: user.tenantId } }),
                    }}
                  />
                )}
              </CardContent>
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}
