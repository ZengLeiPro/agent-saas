import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Info, Loader2, RefreshCw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAdminUrlQuery } from "@/hooks/useAdminUrlQuery";
import { cn } from "@/lib/utils";

import { platformAdminApi } from "./api";
import { AdminErrorAlert, EntityLink, ScopeFilters } from "./common";
import {
  formatExecutionTarget,
  formatToolInvocationStatus,
  formatToolName,
} from "./displayText";
import { classifyFailureReason } from "./errorText";
import type {
  ToolInvocationAnalysisResponse,
  ToolInvocationStatus,
} from "./types";
import { formatMs } from "../RunTraceExplorer/format";

const PAGE_SIZE = 50;
const HOUR_OPTIONS = [24, 72, 168, 720] as const;
const STATUS_OPTIONS: Array<{ value: ToolInvocationStatus | ""; label: string }> = [
  { value: "", label: "全部结果" },
  { value: "failed", label: "仅失败" },
  { value: "completed", label: "仅成功" },
  { value: "running", label: "正在调用" },
  { value: "cancelled", label: "已取消" },
];

function parseHours(raw: string | null): number {
  const value = Number(raw);
  return HOUR_OPTIONS.includes(value as (typeof HOUR_OPTIONS)[number]) ? value : 168;
}

function parseOffset(raw: string | null): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function statusTone(status: ToolInvocationStatus) {
  if (status === "failed") return "bg-destructive/10 text-destructive";
  if (status === "cancelled") return "bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (status === "running") return "bg-blue-500/10 text-blue-700 dark:text-blue-300";
  return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
}

function ToolLabel({ name }: { name: string }) {
  const label = formatToolName(name);
  return (
    <div className="min-w-0">
      <div className="truncate text-xs font-medium" title={name}>{label}</div>
      {label !== name && <div className="truncate font-mono text-[10px] text-muted-foreground">{name}</div>}
    </div>
  );
}

export function ToolAnalysisPanel({ tenantId: fixedTenantId, linkEntities = true }: {
  tenantId?: string;
  linkEntities?: boolean;
}) {
  const url = useAdminUrlQuery();
  const tenantId = fixedTenantId ?? (url.get("toolTenantId") ?? "");
  const userId = url.get("toolUserId") ?? "";
  const toolName = url.get("toolName") ?? "";
  const skillName = url.get("skillName") ?? "";
  const status = (url.get("toolStatus") ?? "") as ToolInvocationStatus | "";
  const hours = parseHours(url.get("toolHours"));
  const offset = parseOffset(url.get("toolOffset"));
  const reasonContains = url.get("toolError") ?? "";
  const [reasonDraft, setReasonDraft] = useState(reasonContains);
  const [data, setData] = useState<ToolInvocationAnalysisResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [knownTools, setKnownTools] = useState<string[]>(toolName ? [toolName] : []);
  const [knownSkills, setKnownSkills] = useState<string[]>(skillName ? [skillName] : []);

  useEffect(() => setReasonDraft(reasonContains), [reasonContains]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await platformAdminApi.toolInvocations({
        tenantId: tenantId || undefined,
        userId: userId || undefined,
        toolName: toolName || undefined,
        skillName: skillName || undefined,
        status: status || undefined,
        reasonContains: reasonContains || undefined,
        hours,
        limit: PAGE_SIZE,
        offset,
      });
      setData(result);
      setKnownTools((current) => [...new Set([...current, ...result.byTool.map((row) => row.toolName), toolName].filter(Boolean))].sort());
      setKnownSkills((current) => [...new Set([...current, ...result.bySkill.map((row) => row.skillName), skillName].filter(Boolean))].sort());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [hours, offset, reasonContains, skillName, status, tenantId, toolName, userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages = data ? Math.max(1, Math.ceil(data.summary.total / PAGE_SIZE)) : 1;
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const skillCoverage = data && data.summary.skillCalls > 0
    ? data.summary.skillCallsTracked / data.summary.skillCalls
    : null;
  const hasFilters = !!(tenantId || userId || toolName || skillName || status || reasonContains || hours !== 168);

  const applyReason = () => url.patch({ toolError: reasonDraft.trim() || null, toolOffset: null });
  const clearFilters = () => url.patch({
    toolTenantId: fixedTenantId ? undefined : null,
    toolUserId: null,
    toolName: null,
    skillName: null,
    toolStatus: null,
    toolError: null,
    toolHours: null,
    toolOffset: null,
  });

  const pageRange = useMemo(() => {
    if (!data || data.summary.total === 0) return "0 条";
    return `${offset + 1}-${Math.min(offset + data.items.length, data.summary.total)} / 共 ${data.summary.total} 条`;
  }, [data, offset]);

  return (
    <Card>
      <CardHeader className="space-y-1 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-sm font-medium">工具与技能排查</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">定位某个组织、用户、工具或技能的调用记录和失败原因。以下筛选只作用于本区域。</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn("mr-1 size-3.5", loading && "animate-spin")} />刷新
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-muted/20 p-3">
          {!fixedTenantId && (
            <ScopeFilters
              tenantId={tenantId}
              userId={userId}
              onChange={(values) => url.patch({
                toolTenantId: values.tenantId,
                toolUserId: values.userId,
                toolOffset: null,
              })}
            />
          )}
          <select
            aria-label="按工具筛选"
            className="h-8 min-w-36 rounded-md border bg-background px-2 text-xs"
            value={toolName}
            onChange={(event) => url.patch({ toolName: event.target.value || null, toolOffset: null })}
          >
            <option value="">全部工具</option>
            {knownTools.map((name) => <option key={name} value={name}>{formatToolName(name)}{formatToolName(name) === name ? "" : `（${name}）`}</option>)}
          </select>
          <select
            aria-label="按技能筛选"
            className="h-8 min-w-40 rounded-md border bg-background px-2 text-xs"
            value={skillName}
            onChange={(event) => url.patch({ skillName: event.target.value || null, toolOffset: null })}
          >
            <option value="">全部技能</option>
            {knownSkills.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <select
            aria-label="按调用结果筛选"
            className="h-8 min-w-28 rounded-md border bg-background px-2 text-xs"
            value={status}
            onChange={(event) => url.patch({ toolStatus: event.target.value || null, toolOffset: null })}
          >
            {STATUS_OPTIONS.map((option) => <option key={option.value || "all"} value={option.value}>{option.label}</option>)}
          </select>
          <select
            aria-label="按时间范围筛选"
            className="h-8 min-w-28 rounded-md border bg-background px-2 text-xs"
            value={hours}
            onChange={(event) => url.patch({ toolHours: Number(event.target.value), toolOffset: null })}
          >
            <option value={24}>最近 24 小时</option>
            <option value={72}>最近 3 天</option>
            <option value={168}>最近 7 天</option>
            <option value={720}>最近 30 天</option>
          </select>
          <div className="flex min-w-52 flex-1 items-center gap-1">
            <Input
              value={reasonDraft}
              onChange={(event) => setReasonDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") applyReason(); }}
              placeholder="搜索失败原因，如 quota exceeded"
              className="h-8 text-xs"
            />
            <Button type="button" variant="secondary" size="sm" className="h-8" onClick={applyReason}>搜索</Button>
          </div>
          {hasFilters && <Button type="button" variant="ghost" size="sm" className="h-8" onClick={clearFilters}>清空筛选</Button>}
        </div>

        {error && <AdminErrorAlert error={error} />}
        {loading && !data ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" />正在加载调用记录…</div>
        ) : data ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                ["调用总数", data.summary.total],
                ["失败或取消", data.summary.failed],
                ["涉及组织", data.summary.affectedTenants],
                ["涉及用户", data.summary.affectedUsers],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl border bg-card px-3 py-2">
                  <div className="text-[11px] text-muted-foreground">{label}</div>
                  <div className={cn("mt-1 text-xl font-semibold tabular-nums", label === "失败或取消" && Number(value) > 0 && "text-destructive")}>{value}</div>
                </div>
              ))}
            </div>

            {data.summary.skillCalls > data.summary.skillCallsTracked && (
              <div className="flex gap-2 rounded-lg border border-blue-200 bg-blue-50/70 px-3 py-2 text-xs text-blue-900 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-100">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                <span>技能名采集是本批次新增能力：当前窗口有 {data.summary.skillCalls - data.summary.skillCallsTracked} 次旧技能调用只能识别为“技能”，无法还原具体技能名。采集覆盖率 {skillCoverage == null ? "—" : `${(skillCoverage * 100).toFixed(0)}%`}。</span>
              </div>
            )}

            <div className="grid gap-3 xl:grid-cols-2">
              <div className="overflow-hidden rounded-xl border">
                <div className="border-b bg-muted/20 px-3 py-2 text-xs font-medium">按工具汇总</div>
                <Table>
                  <TableHeader><TableRow><TableHead>工具</TableHead><TableHead className="text-right">调用</TableHead><TableHead className="text-right">失败</TableHead><TableHead className="text-right">平均耗时</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {data.byTool.length === 0 ? <TableRow><TableCell colSpan={4} className="h-20 text-center text-xs text-muted-foreground">没有匹配的工具调用</TableCell></TableRow> : data.byTool.slice(0, 12).map((row) => (
                      <TableRow key={row.toolName} className="cursor-pointer hover:bg-muted/40" onClick={() => url.patch({ toolName: row.toolName, toolOffset: null })}>
                        <TableCell><ToolLabel name={row.toolName} /></TableCell>
                        <TableCell className="text-right font-mono text-xs">{row.count}</TableCell>
                        <TableCell className={cn("text-right font-mono text-xs", row.failed > 0 && "text-destructive")}>{row.failed}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{formatMs(row.avgDurationMs)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="overflow-hidden rounded-xl border">
                <div className="border-b bg-muted/20 px-3 py-2 text-xs font-medium">按技能汇总</div>
                <Table>
                  <TableHeader><TableRow><TableHead>技能</TableHead><TableHead className="text-right">调用</TableHead><TableHead className="text-right">失败</TableHead><TableHead className="text-right">使用人数</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {data.bySkill.length === 0 ? <TableRow><TableCell colSpan={4} className="h-20 text-center text-xs text-muted-foreground">暂无可识别的技能调用</TableCell></TableRow> : data.bySkill.slice(0, 12).map((row) => (
                      <TableRow key={row.skillName} className="cursor-pointer hover:bg-muted/40" onClick={() => url.patch({ skillName: row.skillName, toolOffset: null })}>
                        <TableCell className="max-w-48 truncate font-mono text-xs" title={row.skillName}>{row.skillName}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{row.count}</TableCell>
                        <TableCell className={cn("text-right font-mono text-xs", row.failed > 0 && "text-destructive")}>{row.failed}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{row.affectedUsers}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>

            <div className="overflow-hidden rounded-xl border">
              <div className="flex items-center justify-between gap-2 border-b bg-muted/20 px-3 py-2">
                <div className="text-xs font-medium">调用明细</div>
                <div className="text-[11px] text-muted-foreground">第 {currentPage}/{totalPages} 页 · {pageRange}</div>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>时间</TableHead><TableHead>组织 / 用户</TableHead><TableHead>工具 / 技能</TableHead><TableHead>结果</TableHead><TableHead>耗时</TableHead><TableHead>失败原因</TableHead><TableHead>执行记录</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.length === 0 ? <TableRow><TableCell colSpan={7} className="h-24 text-center text-xs text-muted-foreground">没有符合筛选条件的调用记录</TableCell></TableRow> : data.items.map((item) => {
                    const friendly = item.error ? classifyFailureReason(item.error) : null;
                    return (
                      <TableRow key={item.invocationId}>
                        <TableCell className="whitespace-nowrap text-[11px] text-muted-foreground">{new Date(item.startedAt).toLocaleString("zh-CN", { hour12: false })}</TableCell>
                        <TableCell className="max-w-48">
                          <div><EntityLink kind="tenant" id={item.tenantId} plain={!linkEntities} /></div>
                          <EntityLink kind="user" id={item.userId} label={item.realName || item.username} tenantId={item.tenantId} plain={!linkEntities} />
                        </TableCell>
                        <TableCell className="max-w-48"><ToolLabel name={item.toolName} />{item.skillName && <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={item.skillName}>{item.skillName}</div>}</TableCell>
                        <TableCell><span className={cn("inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium", statusTone(item.status))}>{formatToolInvocationStatus(item.status)}</span><div className="mt-1 text-[10px] text-muted-foreground">{formatExecutionTarget(item.executionTarget)}</div></TableCell>
                        <TableCell className="whitespace-nowrap font-mono text-xs">{formatMs(item.durationMs)}</TableCell>
                        <TableCell className="max-w-64"><span className={cn("line-clamp-2 text-xs", friendly && "text-destructive")} title={item.error ?? undefined}>{friendly?.summary ?? "—"}</span></TableCell>
                        <TableCell><EntityLink kind="run" id={item.runId} tenantId={item.tenantId} plain={!linkEntities} /></TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              <div className="flex items-center justify-end gap-2 border-t px-3 py-2">
                <Button variant="outline" size="sm" disabled={offset === 0 || loading} onClick={() => url.set("toolOffset", Math.max(0, offset - PAGE_SIZE) || null)}><ChevronLeft className="mr-1 size-3.5" />上一页</Button>
                <Button variant="outline" size="sm" disabled={!data || offset + data.items.length >= data.summary.total || loading} onClick={() => url.set("toolOffset", offset + PAGE_SIZE)}><ChevronRight className="mr-1 size-3.5" />下一页</Button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex h-28 items-center justify-center text-xs text-muted-foreground"><TriangleAlert className="mr-2 size-4" />暂无数据</div>
        )}
      </CardContent>
    </Card>
  );
}
