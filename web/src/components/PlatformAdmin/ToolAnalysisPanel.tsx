import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Info,
  Loader2,
  RefreshCw,
  SearchX,
  Sparkles,
  TriangleAlert,
  Wrench,
} from "lucide-react";

import { AdminSelect, type AdminSelectOption } from "@/components/ui/admin-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAdminUrlQuery } from "@/hooks/useAdminUrlQuery";
import { cn } from "@/lib/utils";

import { platformAdminApi } from "./api";
import { AdminErrorAlert, EmptyState, EntityLink, MetricCard, ScopeFilters } from "./common";
import { formatNumber } from "./format";
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
const STATUS_OPTIONS: AdminSelectOption[] = [
  { value: "", label: "全部结果" },
  { value: "failed", label: "仅失败" },
  { value: "completed", label: "仅成功" },
  { value: "running", label: "正在调用" },
  { value: "cancelled", label: "已取消" },
];
const HOUR_SELECT_OPTIONS: AdminSelectOption[] = [
  { value: "24", label: "最近 24 小时" },
  { value: "72", label: "最近 3 天" },
  { value: "168", label: "最近 7 天" },
  { value: "720", label: "最近 30 天" },
];

function parseHours(raw: string | null): number {
  const value = Number(raw);
  return HOUR_OPTIONS.includes(value as (typeof HOUR_OPTIONS)[number]) ? value : 168;
}

function parseOffset(raw: string | null): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

/**
 * 手写 pill 收口到 `ui/badge` 的语义 variant。
 * 改造前是 `inline-flex rounded-full px-2 py-0.5 text-2xs` + 一个本地 `statusTone()`——
 * 全站第 10 个「像徽章但不是 Badge」的实现（S1/S2 报告第五节第 4 条、S3 范围外发现 3）。
 */
function invocationBadgeVariant(status: ToolInvocationStatus): "danger" | "warning" | "info" | "success" {
  if (status === "failed") return "danger";
  if (status === "cancelled") return "warning";
  if (status === "running") return "info";
  return "success";
}

/**
 * 工具名。`onSelect` 传了就渲染成按钮 —— 点一下把这个工具写进本区域筛选，
 * 不必再去顶部下拉里翻（交互审计 P0 第 3 项：从「看到异常」到「只看这个工具」要一步到位）。
 */
function ToolLabel({ name, onSelect, active }: { name: string; onSelect?: (name: string) => void; active?: boolean }) {
  const label = formatToolName(name);
  const body = (
    <>
      <span className="block truncate text-xs font-medium">{label}</span>
      {label !== name && <span className="block truncate font-mono text-2xs text-muted-foreground">{name}</span>}
    </>
  );
  if (!onSelect) {
    return <div className="min-w-0" title={name}>{body}</div>;
  }
  return (
    <button
      type="button"
      onClick={(event) => { event.stopPropagation(); onSelect(name); }}
      title={active ? `已按「${label}」筛选` : `只看「${label}」的调用记录`}
      aria-pressed={active}
      className={cn(
        "-mx-1 block min-w-0 max-w-full rounded px-1 py-0.5 text-left hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        active && "bg-primary/10",
      )}
    >
      {body}
    </button>
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

  const toolSelectOptions = useMemo<AdminSelectOption[]>(() => [
    { value: "", label: "全部工具" },
    ...knownTools.map((name) => ({
      value: name,
      // 中文名与原始名不同时并排显示，排障时需要肉眼比对原始工具名
      label: formatToolName(name) === name ? name : `${formatToolName(name)}（${name}）`,
    })),
  ], [knownTools]);
  const skillSelectOptions = useMemo<AdminSelectOption[]>(() => [
    { value: "", label: "全部技能" },
    ...knownSkills.map((name) => ({ value: name, label: name })),
  ], [knownSkills]);

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
            <CardTitle>工具与技能排查</CardTitle>
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
          <AdminSelect
            ariaLabel="按工具筛选"
            className="min-w-36"
            options={toolSelectOptions}
            value={toolName}
            onValueChange={(value) => url.patch({ toolName: value || null, toolOffset: null })}
          />
          <AdminSelect
            ariaLabel="按技能筛选"
            className="min-w-40"
            options={skillSelectOptions}
            value={skillName}
            onValueChange={(value) => url.patch({ skillName: value || null, toolOffset: null })}
          />
          <AdminSelect
            ariaLabel="按调用结果筛选"
            className="min-w-28"
            options={STATUS_OPTIONS}
            value={status}
            onValueChange={(value) => url.patch({ toolStatus: value || null, toolOffset: null })}
          />
          <AdminSelect
            ariaLabel="按时间范围筛选"
            className="min-w-28"
            options={HOUR_SELECT_OPTIONS}
            value={String(hours)}
            onValueChange={(value) => url.patch({ toolHours: Number(value), toolOffset: null })}
          />
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
            {/* 四张汇总卡原先是本文件内第 6 套指标卡实现，现归一到 common/MetricCard。
                「失败或取消」做成入口：点一下直接切到仅失败视图（指标卡即入口）。 */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <MetricCard title="调用总数" value={formatNumber(data.summary.total)} />
              <MetricCard
                title="失败或取消"
                value={formatNumber(data.summary.failed)}
                tone={data.summary.failed > 0 ? "bad" : "good"}
                description={data.summary.failed > 0 ? "点击只看失败调用" : "窗口内没有失败"}
                onClick={data.summary.failed > 0
                  ? () => url.patch({ toolStatus: "failed", toolOffset: null })
                  : undefined}
              />
              <MetricCard title="涉及组织" value={formatNumber(data.summary.affectedTenants)} />
              <MetricCard title="涉及用户" value={formatNumber(data.summary.affectedUsers)} />
            </div>

            {data.summary.skillCalls > data.summary.skillCallsTracked && (
              <div className="flex gap-2 rounded-lg border border-info/30 bg-info-subtle px-3 py-2 text-xs text-info-ink">
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
                    {data.byTool.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} className="p-0">
                          <EmptyState
                            compact
                            icon={hasFilters ? SearchX : Wrench}
                            title={hasFilters ? "没有匹配的工具调用" : "窗口内没有工具调用"}
                            description={hasFilters
                              ? "当前筛选把结果收窄到 0。清空筛选或放宽时间范围后再看一次。"
                              : "把时间范围放宽到 30 天可以确认是否更早有过调用。"}
                            action={hasFilters
                              ? { label: "清空筛选", onClick: clearFilters }
                              : { label: "放宽到最近 30 天", onClick: () => url.patch({ toolHours: 720, toolOffset: null }) }}
                          />
                        </TableCell>
                      </TableRow>
                    ) : data.byTool.slice(0, 12).map((row) => (
                      <TableRow key={row.toolName} className="cursor-pointer" onClick={() => url.patch({ toolName: row.toolName, toolOffset: null })}>
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
                    {data.bySkill.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} className="p-0">
                          <EmptyState
                            compact
                            icon={hasFilters ? SearchX : Sparkles}
                            title="暂无可识别的技能调用"
                            description={data.summary.skillCalls > 0
                              ? `窗口内有 ${formatNumber(data.summary.skillCalls)} 次技能调用，但都是采集技能名之前的旧数据，无法还原具体技能。`
                              : hasFilters
                                ? "当前筛选下没有技能调用。清空筛选后再看一次。"
                                : "技能调用要等成员真正用到技能后才会出现。"}
                            action={hasFilters
                              ? { label: "清空筛选", onClick: clearFilters }
                              : undefined}
                          />
                        </TableCell>
                      </TableRow>
                    ) : data.bySkill.slice(0, 12).map((row) => (
                      <TableRow key={row.skillName} className="cursor-pointer" onClick={() => url.patch({ skillName: row.skillName, toolOffset: null })}>
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
                <div className="text-2xs text-muted-foreground">第 {currentPage}/{totalPages} 页 · {pageRange}</div>
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
                        <TableCell className="whitespace-nowrap text-2xs text-muted-foreground">{new Date(item.startedAt).toLocaleString("zh-CN", { hour12: false })}</TableCell>
                        <TableCell className="max-w-48">
                          <div><EntityLink kind="tenant" id={item.tenantId} plain={!linkEntities} /></div>
                          <EntityLink kind="user" id={item.userId} label={item.realName || item.username} tenantId={item.tenantId} plain={!linkEntities} />
                        </TableCell>
                        <TableCell className="max-w-48"><ToolLabel name={item.toolName} />{item.skillName && <div className="mt-1 truncate font-mono text-2xs text-muted-foreground" title={item.skillName}>{item.skillName}</div>}</TableCell>
                        <TableCell><Badge variant={invocationBadgeVariant(item.status)}>{formatToolInvocationStatus(item.status)}</Badge><div className="mt-1 text-2xs text-muted-foreground">{formatExecutionTarget(item.executionTarget)}</div></TableCell>
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
