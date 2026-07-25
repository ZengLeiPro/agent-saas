/** 执行记录排查：支持按组织、用户、对话、状态与时间快速定位。 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Loader2, Maximize2, RefreshCw, SearchX } from "lucide-react";

import { ActiveFilterBar, AdminErrorAlert, EmptyState, EntityLink, ScopeFilters, type ActiveFilterItem } from "@/components/PlatformAdmin/common";
import { formatChannel, formatRunStatus } from "@/components/PlatformAdmin/displayText";
import { classifyFailureReason } from "@/components/PlatformAdmin/errorText";
import { platformAdminApi } from "@/components/PlatformAdmin/api";
import type { PlatformRunRecord } from "@/components/PlatformAdmin/types";
import { useModelDisplayMap } from "@/components/TenantAnalytics/hooks";
import { useTenants } from "@/components/TenantManager/hooks";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAdminUrlQuery } from "@/hooks/useAdminUrlQuery";
import { cn } from "@/lib/utils";

import { formatMs, formatTime, runDurationMs } from "./format";
import { isRunFailureStatus } from "./runStatus";
import { RunStatusBadge } from "./StatusBadge";

const HOURS_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: "1 小时" },
  { value: 24, label: "24 小时" },
  { value: 72, label: "3 天" },
  { value: 168, label: "7 天" },
  { value: 720, label: "30 天" },
];

type StatusGroup = "all" | "failed" | "active" | "completed" | "custom";

const STATUS_GROUP_OPTIONS: { value: Exclude<StatusGroup, "custom">; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "failed", label: "失败或取消" },
  { value: "active", label: "进行中" },
  { value: "completed", label: "已完成" },
];

const STATUS_GROUP_QUERY: Record<Exclude<StatusGroup, "custom">, string | undefined> = {
  all: undefined,
  failed: "failed,cancelled",
  active: "pending,running,waiting_approval,waiting_user,waiting_hand",
  completed: "completed",
};

function statusGroupFromQuery(value: string): StatusGroup {
  if (value === "failed" || value === STATUS_GROUP_QUERY.failed) return "failed";
  if (value === "active" || value === STATUS_GROUP_QUERY.active) return "active";
  if (value === "completed") return "completed";
  return value ? "custom" : "all";
}

export function RunListView({
  onSelectRun,
  selectedRunId = null,
  compact = false,
  onExpand,
}: {
  onSelectRun: (runId: string) => void;
  /** 当前打开的执行记录：窄栏形态下靠它高亮「我正在看哪一条」 */
  selectedRunId?: string | null;
  /**
   * 窄栏形态（详情打开时列表压窄常驻）。只保留「状态 + 失败摘要 + 执行记录 + 开始时间」，
   * 完整筛选器留在展开态——320px 里塞 5 档时间窗 + 关键词框只会挤成一团。
   * 生效中的筛选仍以可删除的 chip 呈现，所以窄栏下筛选依然可见可撤销。
   */
  compact?: boolean;
  /** 窄栏下「展开完整列表」（关掉详情），让被折起来的筛选器可达 */
  onExpand?: () => void;
}) {
  const adminQuery = useAdminUrlQuery();
  const { tenants } = useTenants();
  const { labelFor } = useModelDisplayMap();
  const [runs, setRuns] = useState<PlatformRunRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [jumpId, setJumpId] = useState("");
  const [jumping, setJumping] = useState(false);
  const [jumpError, setJumpError] = useState<string | null>(null);

  const tenantId = adminQuery.get("tenantId") ?? "";
  const userId = adminQuery.get("userId") ?? "";
  const sessionId = adminQuery.get("sessionId") ?? "";
  const rawStatus = adminQuery.get("status") ?? "";
  const reasonContains = adminQuery.get("reason") ?? "";
  const [reasonDraft, setReasonDraft] = useState(reasonContains);
  const statusGroup = statusGroupFromQuery(rawStatus);
  const parsedHours = Number(adminQuery.get("hours") ?? 24);
  const hours = HOURS_OPTIONS.some((option) => option.value === parsedHours) ? parsedHours : 24;
  const tenantNames = useMemo(() => new Map(tenants.map((tenant) => [tenant.id, tenant.name])), [tenants]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await platformAdminApi.runs({
        hours,
        limit: 100,
        status: statusGroup === "custom" ? rawStatus : STATUS_GROUP_QUERY[statusGroup],
        tenantId,
        userId,
        sessionId,
        reasonContains,
      });
      setRuns(resp.items);
    } catch (nextError) {
      setError(nextError);
    } finally {
      setLoading(false);
    }
  }, [hours, rawStatus, reasonContains, sessionId, statusGroup, tenantId, userId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => setReasonDraft(reasonContains), [reasonContains]);

  const onJump = useCallback(async () => {
    const id = jumpId.trim();
    if (!id) return;
    setJumping(true);
    setJumpError(null);
    try {
      const { matches } = await platformAdminApi.search(id);
      const exact = matches.find((match) => match.id === id && (match.kind === "run" || match.kind === "session"));
      if (exact?.kind === "run") {
        onSelectRun(exact.id);
        return;
      }
      if (exact?.kind === "session") {
        const detail = await platformAdminApi.sessionDetail(exact.id);
        const latest = detail.runs[0];
        if (latest) {
          onSelectRun(latest.runId);
          return;
        }
        setJumpError("这个对话还没有执行记录。可先打开“对话”查看详情。");
        return;
      }
      setJumpError("没有找到对应的执行记录或对话，请确认粘贴的是完整编号。");
    } catch {
      setJumpError("没有找到对应的执行记录或对话，请确认记录仍在保留期内。");
    } finally {
      setJumping(false);
    }
  }, [jumpId, onSelectRun]);


  const statusLabel = statusGroup === "custom"
    ? rawStatus.split(",").map(formatRunStatus).join("、")
    : STATUS_GROUP_OPTIONS.find((item) => item.value === statusGroup)?.label;

  // 「字段名：值」的中文键值形态（不是查询 DSL），可读性是我们对标下的既有优势
  const activeFilters = useMemo<ActiveFilterItem[]>(() => {
    const items: ActiveFilterItem[] = [];
    if (tenantId) items.push({ key: "tenantId", label: `组织：${tenantNames.get(tenantId) ?? tenantId}`, onRemove: () => adminQuery.patch({ tenantId: null, userId: null }) });
    if (userId) items.push({ key: "userId", label: `用户：${userId}`, onRemove: () => adminQuery.set("userId", null) });
    if (sessionId) items.push({ key: "sessionId", label: `对话：${sessionId}`, onRemove: () => adminQuery.set("sessionId", null) });
    if (statusGroup !== "all") items.push({ key: "status", label: `状态：${statusLabel}`, onRemove: () => adminQuery.set("status", null) });
    if (reasonContains) items.push({ key: "reason", label: `失败原因：${reasonContains}`, onRemove: () => adminQuery.set("reason", null) });
    return items;
  }, [adminQuery, reasonContains, sessionId, statusGroup, statusLabel, tenantId, tenantNames, userId]);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card p-3">
        <div className="flex flex-wrap items-center gap-2">
          {!compact && (
            <ScopeFilters
              tenantId={tenantId}
              userId={userId}
              onChange={(values) => adminQuery.patch({ ...values, cursor: null })}
            />
          )}
          {!compact && (
            <Segmented
              ariaLabel="时间窗"
              size="sm"
              options={HOURS_OPTIONS}
              value={hours}
              onChange={(next) => adminQuery.patch({ hours: next === 24 ? null : next, cursor: null })}
            />
          )}
          {!compact && (
            <div className="flex items-center gap-1">
              <Input
                value={reasonDraft}
                onChange={(event) => setReasonDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") adminQuery.patch({ reason: reasonDraft.trim() || null, cursor: null });
                }}
                placeholder="搜索失败原因关键词"
                className="h-8 w-48 text-xs"
              />
              <Button variant="secondary" size="sm" className="h-8" onClick={() => adminQuery.patch({ reason: reasonDraft.trim() || null, cursor: null })}>搜索</Button>
            </div>
          )}
          <div className={cn(compact && "-mx-1 max-w-full overflow-x-auto px-1")}>
            <Segmented
              ariaLabel="状态分组"
              size="sm"
              options={STATUS_GROUP_OPTIONS}
              // statusGroup 可能是 "custom"（URL 带了手写状态串），此时无选项命中、整体不高亮，
              // 与改造前的三元判断行为一致
              value={statusGroup as Exclude<StatusGroup, "custom">}
              onChange={(next) => adminQuery.patch({ status: next === "all" ? null : next, cursor: null })}
            />
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn("mr-1 size-3.5", loading && "animate-spin")} />
            刷新
          </Button>
          {compact && onExpand && (
            <Button variant="ghost" size="sm" onClick={onExpand} title="关闭详情，回到带完整筛选器的列表">
              <Maximize2 className="mr-1 size-3.5" />
              展开列表
            </Button>
          )}
        </div>

        <ActiveFilterBar
          className="mt-3 border-t pt-3"
          items={activeFilters}
          onClearAll={() => adminQuery.clear(["tenantId", "userId", "sessionId", "status", "reason", "cursor"])}
        />
      </div>

      {!compact && (
        <div className="flex flex-wrap items-start justify-end gap-1.5">
          <Input
            value={jumpId}
            onChange={(event) => {
              setJumpId(event.target.value);
              setJumpError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void onJump();
            }}
            placeholder="粘贴完整执行记录 ID 或对话 ID"
            className="h-8 w-72 font-mono text-xs"
          />
          <Button variant="outline" size="sm" onClick={() => void onJump()} disabled={jumping || !jumpId.trim()}>
            {jumping ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowRight className="size-3.5" />}
            定位
          </Button>
          {jumpError && <div className="basis-full text-right text-xs text-destructive">{jumpError}</div>}
        </div>
      )}

      {error != null && <AdminErrorAlert error={error} />}

      <Card>
        <CardContent className="p-0">
          {loading && !runs ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" /> 正在加载执行记录…
            </div>
          ) : !runs || runs.length === 0 ? (
            <EmptyState
              icon={SearchX}
              title="当前筛选条件下没有执行记录"
              description={activeFilters.length > 0
                ? "已生效的筛选可能过窄。清除筛选或放宽时间窗后再看一次。"
                : "所选时间窗内还没有任何执行。把时间窗放宽到 7 天或 30 天试试。"}
              action={activeFilters.length > 0
                ? {
                  label: "清除全部筛选",
                  onClick: () => adminQuery.clear(["tenantId", "userId", "sessionId", "status", "reason", "cursor"]),
                }
                : undefined}
              secondaryAction={hours < 720
                ? { label: "放宽到 30 天", onClick: () => adminQuery.patch({ hours: 720, cursor: null }) }
                : undefined}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>状态</TableHead>
                  <TableHead>执行记录</TableHead>
                  {!compact && <TableHead>对话</TableHead>}
                  {!compact && <TableHead>组织 / 用户</TableHead>}
                  {!compact && <TableHead>模型</TableHead>}
                  {!compact && <TableHead>来源</TableHead>}
                  <TableHead className="text-right">耗时</TableHead>
                  <TableHead>开始</TableHead>
                  {!compact && <TableHead>结束</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => {
                  const endAt = run.completedAt ?? run.failedAt ?? run.cancelledAt;
                  const duration = runDurationMs(run);
                  const failure = isRunFailureStatus(run.status) && run.statusReason
                    ? classifyFailureReason(run.statusReason)
                    : null;
                  const isSelected = selectedRunId != null && run.runId === selectedRunId;
                  return (
                    <TableRow
                      key={run.runId}
                      // 选中行高亮 + 左侧色条：窄栏常驻后必须能一眼看出「详情里那条是哪一行」
                      data-state={isSelected ? "selected" : undefined}
                      aria-selected={isSelected}
                      className={cn("cursor-pointer", isSelected && "border-l-2 border-l-primary")}
                      onClick={() => onSelectRun(run.runId)}
                    >
                      <TableCell>
                        <div className="space-y-1">
                          <RunStatusBadge status={run.status} />
                          {failure && (
                            <div className={cn("truncate text-2xs text-destructive", compact ? "max-w-32" : "max-w-44")} title={failure.technicalDetail}>
                              {failure.summary}
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell><EntityLink kind="run" id={run.runId} short={compact ? 6 : undefined} /></TableCell>
                      {!compact && <TableCell><EntityLink kind="session" id={run.sessionId} /></TableCell>}
                      {!compact && (
                        <TableCell>
                          <div><EntityLink kind="tenant" id={run.tenantId} label={run.tenantId ? tenantNames.get(run.tenantId) : undefined} /></div>
                          <div className="text-xs text-muted-foreground"><EntityLink kind="user" id={run.userId} label={run.realName || run.username || undefined} /></div>
                        </TableCell>
                      )}
                      {!compact && <TableCell className="max-w-44 truncate text-xs" title={run.model ?? undefined}>{run.model ? labelFor(run.model) : "—"}</TableCell>}
                      {!compact && <TableCell className="text-xs">{run.channel ? formatChannel(run.channel) : "—"}</TableCell>}
                      <TableCell className="text-right text-xs tabular-nums">{formatMs(duration)}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">{formatTime(run.startedAt ?? run.requestedAt)}</TableCell>
                      {!compact && <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">{formatTime(endAt)}</TableCell>}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {runs && runs.length > 0 && (
        <div className="text-xs text-muted-foreground">当前显示 {runs.length} 条（最多 100 条）· 点击任意一行查看完整执行过程</div>
      )}
    </div>
  );
}
