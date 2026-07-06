import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { AdminEntityTable, EntityLink, MetricCard, StatusBadge } from "@/components/PlatformAdmin/common";
import { useAdminUrlQuery } from "@/hooks/useAdminUrlQuery";
import { pushPlatformAdminUrl } from "@/lib/urlSync";

import { platformAdminApi } from "../api";
import { formatNumber, formatTime, formatUsd, formatYuan } from "../format";
import type { PlatformSessionRecord, SessionDetailResponse } from "../types";

const SESSION_STATUSES = ["", "idle", "running", "failed", "completed", "cancelled"];

export function SessionsPage({ sessionId }: { sessionId: string | null }) {
  if (sessionId) return <SessionDetail sessionId={sessionId} />;
  return <SessionList />;
}

function SessionList() {
  const adminQuery = useAdminUrlQuery();
  const [rows, setRows] = useState<PlatformSessionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<string[]>([]);

  const tenantId = adminQuery.get("tenantId") ?? "";
  const userId = adminQuery.get("userId") ?? "";
  const status = adminQuery.get("status") ?? "";
  const kind = adminQuery.get("kind") ?? "user";
  const includeDeleted = adminQuery.get("includeDeleted") === "true";
  const cursor = adminQuery.get("cursor") ?? "";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await platformAdminApi.sessions({
        tenantId,
        userId,
        status,
        kind: kind === "subagent" ? "subagent" : "user",
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
  }, [cursor, includeDeleted, kind, status, tenantId, userId]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5">
      <SettingsPanelHeader
        title="会话"
        description="runtime_sessions 投影表驱动的会话列表与详情。"
        actions={
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
            刷新
          </Button>
        }
      />
      {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">加载失败：{error}</div>}
      <AdminEntityTable
        title="会话列表"
        rows={rows}
        rowKey={(row) => row.sessionId}
        loading={loading}
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={tenantId}
              onChange={(event) => adminQuery.patch({ tenantId: event.target.value, cursor: null })}
              placeholder="tenantId"
              className="h-8 w-32 font-mono text-xs"
            />
            <Input
              value={userId}
              onChange={(event) => adminQuery.patch({ userId: event.target.value, cursor: null })}
              placeholder="userId"
              className="h-8 w-44 font-mono text-xs"
            />
            <select className="h-8 rounded-md border bg-background px-2 text-xs" value={status} onChange={(event) => adminQuery.patch({ status: event.target.value, cursor: null })}>
              {SESSION_STATUSES.map(item => <option key={item || "all"} value={item}>{item || "全部状态"}</option>)}
            </select>
            <select className="h-8 rounded-md border bg-background px-2 text-xs" value={kind} onChange={(event) => adminQuery.patch({ kind: event.target.value, cursor: null })}>
              <option value="user">用户会话</option>
              <option value="subagent">子 Agent</option>
            </select>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Checkbox checked={includeDeleted} onCheckedChange={(checked) => adminQuery.patch({ includeDeleted: checked === true, cursor: null })} />
              含已删
            </label>
          </div>
        }
        onRowClick={(row) => {
          pushPlatformAdminUrl({ section: "sessions", entityId: row.sessionId });
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
          { key: "status", header: "状态", cell: row => <Badge variant={row.deletedAt ? "destructive" : "secondary"}>{row.deletedAt ? "已删除" : row.runtimeStatus || "active"}</Badge> },
          { key: "title", header: "标题", cell: row => <div><div className="max-w-72 truncate font-medium" title={row.title ?? undefined}>{row.title || row.sessionId}</div><EntityLink kind="session" id={row.sessionId} /></div> },
          { key: "user", header: "用户", cell: row => <EntityLink kind="user" id={row.userId} label={row.username || undefined} /> },
          { key: "tenant", header: "租户", cell: row => <EntityLink kind="tenant" id={row.tenantId} /> },
          { key: "channel", header: "渠道", cell: row => row.channel || "—" },
          { key: "kind", header: "类型", cell: row => <Badge variant={row.kind === "subagent" ? "outline" : "secondary"}>{row.kind}</Badge> },
          { key: "cost", header: "成本", cell: row => <span className="tabular-nums">{formatUsd(row.totalCostUsd)}</span> },
          { key: "updated", header: "最后活动", cell: row => <span className="whitespace-nowrap text-xs text-muted-foreground">{formatTime(row.updatedAt)}</span> },
        ]}
      />
    </div>
  );
}

function SessionDetail({ sessionId }: { sessionId: string }) {
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
    <div className="mx-auto w-full max-w-6xl space-y-5">
      <SettingsPanelHeader
        title={session?.title || sessionId}
        description={`会话详情 · ${sessionId}`}
        actions={
          <>
            {session && <Button variant="outline" size="sm" onClick={() => {
              pushPlatformAdminUrl({ section: "runs", search: { tenantId: session.tenantId, sessionId: session.sessionId } });
              window.dispatchEvent(new PopStateEvent("popstate"));
            }}>全部 Run</Button>}
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
              刷新
            </Button>
          </>
        }
      />
      {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">加载失败：{error}</div>}
      {loading && !detail ? (
        <div className="flex h-40 items-center justify-center rounded-lg border bg-card text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          加载会话详情...
        </div>
      ) : detail && session ? (
        <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard title="状态" value={session.deletedAt ? "已删除" : session.runtimeStatus || "active"} description={session.kind} />
            <MetricCard title="用户" value={<EntityLink kind="user" id={session.userId} label={session.username || undefined} />} description={<EntityLink kind="tenant" id={session.tenantId} />} />
            <MetricCard title="成本" value={billingCost} description={`请求 ${formatNumber(detail.billing?.requestCount as number | undefined)}`} />
            <MetricCard title="Run" value={formatNumber(detail.runs.length)} description={`最后活动 ${formatTime(session.updatedAt)}`} />
          </div>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_360px]">
            <Card>
              <CardHeader><CardTitle className="text-base">Run 列表</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {detail.runs.map(run => (
                  <div key={run.runId} className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm">
                    <div className="min-w-0">
                      <EntityLink kind="run" id={run.runId} />
                      <div className="mt-1 text-xs text-muted-foreground">{run.model || "—"} · {formatTime(run.updatedAt)}</div>
                    </div>
                    <StatusBadge kind="run" status={run.status} />
                  </div>
                ))}
                {detail.runs.length === 0 && <div className="py-6 text-center text-sm text-muted-foreground">暂无 Run</div>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">容器</CardTitle></CardHeader>
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
                {detail.sandboxes.length === 0 && <div className="py-6 text-center text-sm text-muted-foreground">暂无容器</div>}
              </CardContent>
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}
