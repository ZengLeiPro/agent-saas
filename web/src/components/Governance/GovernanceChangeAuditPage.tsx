import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";

import { GovernanceUnavailable } from "@/components/Governance/GovernanceUnavailable";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useGovernanceRequest } from "@/hooks/useGovernanceRequest";
import { governanceAccessApi } from "@agent/shared/lib/governanceApi";

interface GovernanceAuditEvent {
  auditId: string;
  correlationId?: string;
  changeId?: string;
  actorUserId: string;
  actorPersona?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  targetTenantId?: string | null;
  purpose?: string;
  reason?: string;
  result: "intent" | "succeeded" | "failed";
  occurredAt: string;
  metadata?: Record<string, unknown>;
}

interface GovernanceAuditResponse {
  events: GovernanceAuditEvent[];
  nextBefore?: string;
}

const FETCH_LIMIT = 100;
const PAGE_SIZE = 20;

function failureCause(event: GovernanceAuditEvent): string {
  const metadata = event.metadata ?? {};
  for (const key of ["errorCode", "reasonCode", "code"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return event.reason?.trim() || `${event.action}（未提供错误码）`;
}

function resultLabel(result: GovernanceAuditEvent["result"]): string {
  if (result === "succeeded") return "成功";
  if (result === "failed") return "失败";
  return "意图";
}

export function GovernanceChangeAuditPage({ tenantId }: { tenantId?: string }) {
  const request = useMemo(() => () => governanceAccessApi.listAuditEvents<GovernanceAuditResponse>({
    ...(tenantId ? { tenantId } : {}),
    limit: FETCH_LIMIT,
  }), [tenantId]);
  const { data, loading, error, retry } = useGovernanceRequest(request, `governance-audit:${tenantId ?? "platform"}`);
  const [events, setEvents] = useState<GovernanceAuditEvent[]>([]);
  const [nextBefore, setNextBefore] = useState<string | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [action, setAction] = useState("all");
  const [result, setResult] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(0);

  useEffect(() => {
    if (!data) return;
    setEvents(data.events);
    setNextBefore(data.nextBefore);
    setLoadMoreError(null);
    setPage(0);
  }, [data]);

  // API 已按 targetTenantId 强制隔离；前端再做一次防御性过滤，连筛选项也不暴露错租户数据。
  const scopedEvents = useMemo(
    () => tenantId ? events.filter(event => event.targetTenantId === tenantId) : events,
    [events, tenantId],
  );
  const actions = useMemo(() => Array.from(new Set(scopedEvents.map(event => event.action))).sort(), [scopedEvents]);

  const filteredEvents = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return scopedEvents.filter((event) => {
      if (action !== "all" && event.action !== action) return false;
      if (result !== "all" && event.result !== result) return false;
      const day = event.occurredAt.slice(0, 10);
      if (dateFrom && day < dateFrom) return false;
      if (dateTo && day > dateTo) return false;
      if (!needle) return true;
      const haystack = [
        event.actorUserId,
        event.actorPersona,
        event.action,
        event.targetType,
        event.targetId,
        event.purpose,
        event.reason,
        event.changeId,
        event.auditId,
        ...Object.values(event.metadata ?? {}).map(String),
      ].filter(Boolean).join(" ").toLocaleLowerCase();
      return haystack.includes(needle);
    });
  }, [action, dateFrom, dateTo, result, scopedEvents, search]);

  const failureGroups = useMemo(() => {
    const groups = new Map<string, GovernanceAuditEvent[]>();
    for (const event of filteredEvents) {
      if (event.result !== "failed") continue;
      const cause = failureCause(event);
      groups.set(cause, [...(groups.get(cause) ?? []), event]);
    }
    return Array.from(groups, ([cause, grouped]) => ({ cause, events: grouped }))
      .sort((a, b) => b.events.length - a.events.length || a.cause.localeCompare(b.cause));
  }, [filteredEvents]);

  const pageCount = Math.max(1, Math.ceil(filteredEvents.length / PAGE_SIZE));
  const visibleEvents = filteredEvents.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const resetPage = (update: () => void) => {
    update();
    setPage(0);
  };

  const loadMore = async () => {
    if (!nextBefore || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const response = await governanceAccessApi.listAuditEvents<GovernanceAuditResponse>({
        ...(tenantId ? { tenantId } : {}),
        before: nextBefore,
        limit: FETCH_LIMIT,
      });
      setEvents(prev => {
        const known = new Set(prev.map(event => event.auditId));
        return [...prev, ...response.events.filter(event => !known.has(event.auditId))];
      });
      setNextBefore(response.nextBefore);
    } catch (cause) {
      setLoadMoreError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingMore(false);
    }
  };

  if (loading) return <div className="flex min-h-48 items-center justify-center text-sm text-muted-foreground">正在读取治理审计…</div>;
  if (error) return <GovernanceUnavailable error={error} onRetry={retry} />;

  return <div className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-xl font-semibold">治理审计</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {tenantId ? `仅展示组织 ${tenantId} 的权威治理账本。` : "展示平台作用域的权威治理账本。"}
          身份、授权、策略与资源配置变更不会混入登录日志。
        </p>
      </div>
      <Button type="button" variant="outline" onClick={retry}><RefreshCw className="mr-2 size-4" />刷新</Button>
    </div>

    <div className="grid gap-3 rounded-xl border bg-card p-4 md:grid-cols-2 xl:grid-cols-5">
      <Input
        aria-label="搜索治理审计"
        placeholder="搜索操作者、目标、回执…"
        value={search}
        onChange={event => resetPage(() => setSearch(event.target.value))}
      />
      <select aria-label="按动作筛选" className="h-10 rounded-md border bg-background px-3 text-sm" value={action} onChange={event => resetPage(() => setAction(event.target.value))}>
        <option value="all">全部动作</option>
        {actions.map(item => <option key={item} value={item}>{item}</option>)}
      </select>
      <select aria-label="按结果筛选" className="h-10 rounded-md border bg-background px-3 text-sm" value={result} onChange={event => resetPage(() => setResult(event.target.value))}>
        <option value="all">全部结果</option>
        <option value="intent">意图</option>
        <option value="succeeded">成功</option>
        <option value="failed">失败</option>
      </select>
      <Input aria-label="开始日期" type="date" value={dateFrom} onChange={event => resetPage(() => setDateFrom(event.target.value))} />
      <Input aria-label="结束日期" type="date" value={dateTo} onChange={event => resetPage(() => setDateTo(event.target.value))} />
    </div>

    {failureGroups.length > 0 && <section className="space-y-2" aria-label="同因失败聚合">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">同因失败聚合</h3>
        <span className="text-xs text-muted-foreground">按错误码或失败原因归并当前筛选结果</span>
      </div>
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {failureGroups.map(group => <div key={group.cause} className="rounded-lg border border-destructive/20 bg-destructive/5 p-3">
          <div className="flex items-start justify-between gap-2"><span className="break-all font-mono text-xs">{group.cause}</span><Badge variant="destructive">{group.events.length} 次</Badge></div>
          <div className="mt-1 text-xs text-muted-foreground">最近：{new Date(group.events[0].occurredAt).toLocaleString()}</div>
        </div>)}
      </div>
    </section>}

    {!filteredEvents.length ? <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">当前筛选范围没有治理审计事件。</div> : <>
      <div className="overflow-x-auto rounded-xl border bg-card" tabIndex={0} aria-label="治理审计列表，可横向滚动">
        <table className="min-w-[980px] w-full text-sm">
          <thead className="bg-muted/50 text-left text-muted-foreground"><tr><th className="px-4 py-3">时间</th><th className="px-4 py-3">操作者</th><th className="px-4 py-3">动作</th><th className="px-4 py-3">目标</th><th className="px-4 py-3">结果</th><th className="px-4 py-3">原因 / 回执</th></tr></thead>
          <tbody className="divide-y">{visibleEvents.map(event => <tr key={event.auditId}>
            <td className="whitespace-nowrap px-4 py-3">{new Date(event.occurredAt).toLocaleString()}</td>
            <td className="px-4 py-3"><div className="font-mono text-xs">{event.actorUserId}</div><div className="text-xs text-muted-foreground">{event.actorPersona ?? "-"}</div></td>
            <td className="px-4 py-3"><div>{event.action}</div><div className="text-xs text-muted-foreground">{event.purpose ?? "-"}</div></td>
            <td className="px-4 py-3"><div>{event.targetType ?? "-"}</div><div className="font-mono text-xs text-muted-foreground">{event.targetId ?? "-"}</div></td>
            <td className="px-4 py-3"><Badge variant={event.result === "succeeded" ? "secondary" : event.result === "failed" ? "destructive" : "outline"}>{resultLabel(event.result)}</Badge></td>
            <td className="px-4 py-3"><div className="text-xs">{event.result === "failed" ? failureCause(event) : event.reason ?? "-"}</div><div className="mt-1 font-mono text-xs text-muted-foreground">{event.changeId ?? event.auditId}</div></td>
          </tr>)}</tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-muted-foreground">已载入 {events.length} 条，筛选命中 {filteredEvents.length} 条 · 第 {page + 1} / {pageCount} 页</div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(current => Math.max(0, current - 1))}>上一页</Button>
          <Button type="button" variant="outline" size="sm" disabled={page + 1 >= pageCount} onClick={() => setPage(current => Math.min(pageCount - 1, current + 1))}>下一页</Button>
          {nextBefore && <Button type="button" variant="outline" size="sm" disabled={loadingMore} onClick={() => { void loadMore(); }}>{loadingMore ? "加载中…" : "加载更早记录"}</Button>}
        </div>
      </div>
    </>}
    {loadMoreError && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">加载更早记录失败：{loadMoreError}</div>}
  </div>;
}
