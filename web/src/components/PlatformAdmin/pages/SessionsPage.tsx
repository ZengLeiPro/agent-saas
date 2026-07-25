import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, SearchX } from "lucide-react";

import { AdminSelect, type AdminSelectOption } from "@/components/ui/admin-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { AdminEntityTable, AdminErrorAlert, EmptyState, EntityLink, MetricCard, ScopeFilters, StatusBadge } from "@/components/PlatformAdmin/common";
import { useModelDisplayMap } from "@/components/TenantAnalytics/hooks";
import { useAdminUrlQuery } from "@/hooks/useAdminUrlQuery";
import { navigatePlatformAdmin } from "@/lib/urlSync";

import { platformAdminApi } from "../api";
import { RUN_LABEL, SESSION_LABEL, TENANT_LABEL, formatChannel, formatSessionKind, formatSessionStatus } from "../displayText";
import { formatNumber, formatTime, formatUsd, formatYuan } from "../format";
import type { PlatformSessionRecord, SessionDetailResponse } from "../types";

const SESSION_STATUS_OPTIONS: AdminSelectOption[] = [
  { value: "", label: "全部状态" },
  ...["idle", "running", "failed", "completed", "cancelled"].map((value) => ({
    value,
    label: formatSessionStatus(value),
  })),
];
const SESSION_RANGES: AdminSelectOption[] = [
  { value: "", label: "全部时间" },
  { value: "1", label: "24 小时" },
  { value: "7", label: "7 天" },
  { value: "30", label: "30 天" },
];
const SESSION_KIND_OPTIONS: AdminSelectOption[] = [
  { value: "user", label: formatSessionKind("user") },
  { value: "subagent", label: formatSessionKind("subagent") },
];
const SESSION_CHANNEL_OPTIONS: AdminSelectOption[] = [
  { value: "", label: "全部来源" },
  { value: "web", label: "Web 端" },
  { value: "mobile", label: "移动端" },
  { value: "dingtalk", label: "钉钉" },
  { value: "cron", label: "定时任务" },
  { value: "api", label: "API" },
];

export function SessionsPage({ sessionId }: { sessionId: string | null }) {
  if (sessionId) return <SessionDetail sessionId={sessionId} />;
  return <SessionList />;
}

function SessionList() {
  const adminQuery = useAdminUrlQuery();
  const patchQuery = adminQuery.patch;
  const { labelFor } = useModelDisplayMap();
  const [rows, setRows] = useState<PlatformSessionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<string[]>([]);

  const tenantId = adminQuery.get("tenantId") ?? "";
  const userId = adminQuery.get("userId") ?? "";
  const q = adminQuery.get("q") ?? "";
  const [qInput, setQInput] = useState(q);
  const status = adminQuery.get("status") ?? "";
  const kind = adminQuery.get("kind") ?? "user";
  const channel = adminQuery.get("channel") ?? "";
  const days = adminQuery.get("days") ?? "";
  const includeDeleted = adminQuery.get("includeDeleted") === "true";
  const cursor = adminQuery.get("cursor") ?? "";

  useEffect(() => {
    setQInput(q);
  }, [q]);

  useEffect(() => {
    if (qInput === q) return;
    const timer = window.setTimeout(() => patchQuery({ q: qInput, cursor: null }), 300);
    return () => window.clearTimeout(timer);
  }, [patchQuery, q, qInput]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await platformAdminApi.sessions({
        tenantId,
        userId,
        q,
        status,
        kind: kind === "subagent" ? "subagent" : "user",
        channel,
        updatedFrom: days ? new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000).toISOString() : undefined,
        includeDeleted,
        cursor,
        limit: 50,
      });
      setRows(data.items);
      setNextCursor(data.nextCursor ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [channel, cursor, days, includeDeleted, kind, q, status, tenantId, userId]);

  useEffect(() => { void load(); }, [load]);

  const hasFilters = Boolean(tenantId || userId || q || status || channel || days || includeDeleted);
  const clearFilters = useCallback(
    () => adminQuery.clear(["tenantId", "userId", "q", "status", "channel", "days", "includeDeleted", "cursor"]),
    [adminQuery],
  );

  return (
    <div className="w-full space-y-5">
      <SettingsPanelHeader
        title={SESSION_LABEL}
        description="查看各组织用户的对话；排查失败时，打开对话后继续查看对应的执行记录。"
        actions={
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            刷新
          </Button>
        }
      />
      {error && <AdminErrorAlert error={error} />}
      <AdminEntityTable
        title="对话列表"
        storageKey="sessions"
        rows={rows}
        rowKey={(row) => row.sessionId}
        loading={loading}
        emptyState={
          <EmptyState
            icon={SearchX}
            title="没有符合条件的对话"
            description={hasFilters
              ? "已生效的筛选可能过窄，清除后再看一次。"
              : "还没有任何对话记录。"}
            action={hasFilters ? { label: "清除全部筛选", onClick: clearFilters } : undefined}
          />
        }
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <ScopeFilters
              tenantId={tenantId}
              userId={userId}
              onChange={(values) => adminQuery.patch({ ...values, cursor: null })}
            />
            <Input
              value={qInput}
              onChange={(event) => setQInput(event.target.value)}
              placeholder="搜索对话标题"
              className="h-8 w-44 text-xs"
            />
            <AdminSelect ariaLabel="时间范围" options={SESSION_RANGES} value={days} onValueChange={(value) => adminQuery.patch({ days: value, cursor: null })} />
            <AdminSelect ariaLabel="对话状态" options={SESSION_STATUS_OPTIONS} value={status} onValueChange={(value) => adminQuery.patch({ status: value, cursor: null })} />
            <AdminSelect ariaLabel="对话类型" options={SESSION_KIND_OPTIONS} value={kind} onValueChange={(value) => adminQuery.patch({ kind: value, cursor: null })} />
            <AdminSelect ariaLabel="来源渠道" options={SESSION_CHANNEL_OPTIONS} value={channel} onValueChange={(value) => adminQuery.patch({ channel: value, cursor: null })} />
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Checkbox checked={includeDeleted} onCheckedChange={(checked) => adminQuery.patch({ includeDeleted: checked === true, cursor: null })} />
              包含已删除
            </label>
          </div>
        }
        onRowClick={(row) => {
          navigatePlatformAdmin({ section: "sessions", entityId: row.sessionId });
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
          { key: "status", header: "状态", cell: row => <Badge variant={row.deletedAt ? "destructive" : "secondary"}>{row.deletedAt ? "已删除" : formatSessionStatus(row.runtimeStatus)}</Badge> },
          { key: "title", header: "标题", alwaysVisible: true, cell: row => <div><div className="max-w-72 truncate font-medium" title={row.title ?? undefined}>{row.title || row.sessionId}</div><EntityLink kind="session" id={row.sessionId} /></div> },
          { key: "username", header: "用户名", cell: row => <EntityLink kind="user" id={row.userId} label={row.username || undefined} /> },
          { key: "realName", header: "姓名", cell: row => row.realName ?? "—" },
          { key: "tenant", header: TENANT_LABEL, cell: row => <EntityLink kind="tenant" id={row.tenantId} /> },
          { key: "model", header: "模型", cell: row => <span title={row.model ?? undefined}>{row.model ? labelFor(row.model) : "—"}</span> },
          { key: "channel", header: "来源", cell: row => row.channel ? formatChannel(row.channel) : "—" },
          // 类型已由工具栏的「对话类型」筛选决定（默认只看用户对话），列里每行同值 → 默认隐藏，需要时从「列」里打开
          { key: "kind", header: "类型", hiddenByDefault: true, cell: row => <Badge variant={row.kind === "subagent" ? "outline" : "secondary"}>{formatSessionKind(row.kind)}</Badge> },
          { key: "cost", header: "历史成本（美元）", className: "text-right", sortable: true, sortNumeric: true, sortValue: row => row.totalCostUsd ?? null, cell: row => <span className="tabular-nums" title="历史对话投影只保存模型原始美元计价">{formatUsd(row.totalCostUsd)}</span> },
          { key: "updated", header: "最后活动", sortable: true, sortNumeric: true, sortValue: row => Date.parse(row.updatedAt) || null, cell: row => <span className="whitespace-nowrap text-xs text-muted-foreground">{formatTime(row.updatedAt)}</span> },
        ]}
      />
    </div>
  );
}

function SessionDetail({ sessionId }: { sessionId: string }) {
  const { labelFor } = useModelDisplayMap();
  const [detail, setDetail] = useState<SessionDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await platformAdminApi.sessionDetail(sessionId);
      setDetail(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => { void load(); }, [load]);

  const session = detail?.session;
  const billingCost = typeof detail?.billing?.totalCostYuan === "number"
    ? formatYuan(detail.billing.totalCostYuan)
    : formatUsd(session?.totalCostUsd);

  return (
    <div className="w-full space-y-5">
      <SettingsPanelHeader
        title={session?.title || sessionId}
        description={`对话详情 · ${sessionId}`}
        actions={
          <>
            {session && <Button variant="outline" size="sm" onClick={() => {
              navigatePlatformAdmin({ section: "runs", search: { tenantId: session.tenantId, sessionId: session.sessionId } });
            }}>查看全部{RUN_LABEL}</Button>}
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              刷新
            </Button>
          </>
        }
      />
      {error && <AdminErrorAlert error={error} />}
      {loading && !detail ? (
        <div className="flex h-40 items-center justify-center rounded-lg border bg-card text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" />
          正在加载对话详情…
        </div>
      ) : detail && session ? (
        <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard title="状态" value={session.deletedAt ? "已删除" : formatSessionStatus(session.runtimeStatus)} description={formatSessionKind(session.kind)} />
            <MetricCard title="用户" value={<EntityLink kind="user" id={session.userId} label={session.username || undefined} />} description={<EntityLink kind="tenant" id={session.tenantId} />} />
            <MetricCard title="成本" value={billingCost} description={`请求 ${formatNumber(detail.billing?.requestCount as number | undefined)}`} />
            <MetricCard title={RUN_LABEL} value={formatNumber(detail.runs.length)} description={`最后活动 ${formatTime(session.updatedAt)}`} />
          </div>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_360px]">
            <Card>
              <CardHeader><CardTitle className="text-base">执行记录</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {detail.runs.map(run => (
                  <div key={run.runId} className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm">
                    <div className="min-w-0">
                      <EntityLink kind="run" id={run.runId} />
                      <div className="mt-1 text-xs text-muted-foreground">{run.model ? labelFor(run.model) : "—"} · {formatTime(run.updatedAt)}</div>
                    </div>
                    <StatusBadge kind="run" status={run.status} />
                  </div>
                ))}
                {detail.runs.length === 0 && <div className="py-6 text-center text-sm text-muted-foreground">暂无执行记录</div>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">执行环境</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {detail.sandboxes.map(sandbox => (
                  <div key={sandbox.name} className="rounded-md border p-2 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <EntityLink kind="sandbox" id={sandbox.name} />
                      <StatusBadge kind="sandbox" status={sandbox.phase ?? "Unknown"} />
                    </div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">{sandbox.workspaceId || "—"}</div>
                  </div>
                ))}
                {detail.sandboxes.length === 0 && <div className="py-6 text-center text-sm text-muted-foreground">暂无执行环境</div>}
              </CardContent>
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}
