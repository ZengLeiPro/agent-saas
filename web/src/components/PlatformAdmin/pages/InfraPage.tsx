import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, FolderOpen, HardDrive, Loader2, RefreshCw, SearchX, Trash2, TriangleAlert } from "lucide-react";

import { AdminSelect, type AdminSelectOption } from "@/components/ui/admin-select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { AdminEntityTable, AdminErrorAlert, EmptyState, EntityLink, MetricCard } from "@/components/PlatformAdmin/common";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";

import { platformAdminApi } from "../api";
import { useConfirmDialog } from "../ConfirmDialog";
import { TENANT_LABEL, formatWorkspaceStatus } from "../displayText";
import { formatBytes, formatNumber, formatTime } from "../format";
import type { SystemMetricsResponse, SystemStorageResponse, WorkspaceUsageRecord, WorkspaceUsageStatus } from "../types";

const WORKSPACE_FILTERS: Array<WorkspaceUsageStatus | "all"> = ["all", "active", "soft_deleted", "orphan_tenant", "orphan_user"];
const WORKSPACE_FILTER_OPTIONS: AdminSelectOption[] = WORKSPACE_FILTERS.map(value => ({
  value,
  label: value === "all" ? "全部状态" : formatWorkspaceStatus(value),
}));

export function InfraPage() {
  const { confirm, confirmDialog } = useConfirmDialog();
  // 只读平台 admin：扫描存储/归档目录/永久删除目录 disabled
  const { platformReadOnly } = useAuth();
  const [metrics, setMetrics] = useState<SystemMetricsResponse | null>(null);
  const [storage, setStorage] = useState<SystemStorageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [archivingPath, setArchivingPath] = useState<string | null>(null);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<WorkspaceUsageStatus | "all">("all");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (mode: "initial" | "refresh" = "refresh") => {
    if (mode === "initial") setLoading(true);
    else setRefreshing(true);
    try {
      const [nextMetrics, nextStorage] = await Promise.all([
        platformAdminApi.systemMetrics(),
        platformAdminApi.systemStorage(),
      ]);
      setMetrics(nextMetrics);
      setStorage(nextStorage);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load("initial");
  }, [load]);

  const latest = useCallback((metric: string, label = "") => (
    metrics?.latest.find(item => item.metric === metric && item.label === label) ?? null
  ), [metrics?.latest]);

  // 后端显式声明的数据源可用性：available=false 时所有派生值都不可信，必须渲染「—」而非 0
  const metricsUnavailable = metrics != null && metrics.available === false;
  const storageUnavailable = storage != null && storage.available === false;

  const rootDisk = latest("disk_root");
  const rootDetail = rootDisk?.detailJson as { usedBytes?: number; totalBytes?: number } | null | undefined;
  const nasUsed = latest("disk_nas")?.valueNum ?? null;
  const pgTopTables = useMemo(() => (
    (metrics?.latest ?? [])
      .filter(item => item.metric === "pg_table_size")
      .sort((a, b) => b.valueNum - a.valueNum)
      .slice(0, 5)
  ), [metrics?.latest]);
  const tlsDaysLeft = useMemo(() => {
    const rows = (metrics?.latest ?? []).filter(item => item.metric === "tls_cert_expiry");
    if (rows.length === 0) return null;
    return Math.min(...rows.map(row => row.valueNum / 86400));
  }, [metrics?.latest]);

  const workspaceRows = useMemo(() => {
    const rows = storage?.workspaces ?? [];
    if (statusFilter === "all") return rows;
    return rows.filter(row => row.status === statusFilter);
  }, [statusFilter, storage?.workspaces]);

  const onScan = useCallback(async () => {
    setScanning(true);
    try {
      await platformAdminApi.triggerStorageScan();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  }, [load]);

  const runArchive = useCallback(async (row: WorkspaceUsageRecord, confirmed: string) => {
    setArchivingPath(row.path);
    try {
      await platformAdminApi.archiveWorkspace(row.path, confirmed);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setArchivingPath(null);
    }
  }, [load]);

  const runDelete = useCallback(async (row: WorkspaceUsageRecord, confirmed: string) => {
    setDeletingPath(row.path);
    try {
      await platformAdminApi.deleteWorkspace(row.path, confirmed);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingPath(null);
    }
  }, [load]);

  // 归档 / 删除都要求逐字输入目录名（原来是 window.prompt）。
  // 换成应用内对话框只是换壳，**保护强度不降**：仍然要手打目录名，服务端也仍然校验该值。
  const onArchive = useCallback((row: WorkspaceUsageRecord) => {
    const lastSegment = row.path.split("/").at(-1) ?? row.path;
    confirm({
      title: "归档这个文件目录？",
      description: "归档 = 移动到 runtime/archive/，数据不会被删除，可以人工还原。",
      details: [
        { label: "路径", value: row.path },
        { label: "大小", value: row.bytes < 0 ? "扫描失败" : formatBytes(row.bytes) },
        { label: "文件数", value: formatNumber(row.fileCount) },
      ],
      requireText: lastSegment,
      requireTextLabel: <>输入目录名 <code className="rounded bg-muted px-1 font-mono text-foreground">{lastSegment}</code> 确认归档</>,
      confirmLabel: "归档",
      onConfirm: () => void runArchive(row, lastSegment),
    });
  }, [confirm, runArchive]);

  const onDelete = useCallback((row: WorkspaceUsageRecord) => {
    const lastSegment = row.path.split("/").at(-1) ?? row.path;
    confirm({
      title: "永久删除这个文件目录？",
      description: "目录下的全部文件会被删除，此操作不可恢复，也无法从归档还原。只在确认该目录无主或用户已注销时使用。",
      details: [
        { label: "路径", value: row.path },
        // 「扫描失败」不能显示成 0 B——运维会据此判断「反正是空的，删了吧」
        { label: "大小", value: row.bytes < 0 ? "扫描失败（未计入汇总）" : formatBytes(row.bytes) },
        { label: "文件数", value: formatNumber(row.fileCount) },
        { label: "状态", value: formatWorkspaceStatus(row.status) },
      ],
      requireText: lastSegment,
      requireTextLabel: <>输入目录名 <code className="rounded bg-muted px-1 font-mono text-foreground">{lastSegment}</code> 确认永久删除</>,
      confirmLabel: "永久删除",
      tone: "danger",
      onConfirm: () => void runDelete(row, lastSegment),
    });
  }, [confirm, runDelete]);

  if (loading && !metrics && !storage) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border bg-card text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        正在加载系统资源…
      </div>
    );
  }

  return (
    <div className="w-full space-y-5">
      <SettingsPanelHeader
        title="系统资源"
        description="查看服务器磁盘、用户文件、平台数据和 HTTPS 证书是否需要处理。"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void onScan()} disabled={platformReadOnly || scanning || refreshing} title={platformReadOnly ? "只读模式：写操作需 @admin 执行" : undefined}>
              <RefreshCw className={cn("mr-1.5 size-3.5", scanning && "animate-spin")} />
              手动扫描
            </Button>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={refreshing || scanning}>
              <RefreshCw className={cn("mr-1.5 size-3.5", refreshing && "animate-spin")} />
              刷新
            </Button>
          </div>
        }
      />

      {error && <AdminErrorAlert error={error} />}

      {/* 数据源缺失必须显式告知：否则下面的 0 会被读成“真的没有”，而不是“没采到” */}
      {(metricsUnavailable || storageUnavailable) && (
        <div className="rounded-md border border-warning/30 bg-warning-subtle px-3 py-2 text-xs text-warning-ink">
          {[
            metricsUnavailable ? "系统指标采集未启用" : null,
            storageUnavailable ? "文件用量扫描未启用" : null,
          ].filter(Boolean).join(" · ")}
          ，相关指标显示为「—」表示无法获取，不代表数值为 0。
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <MetricCard
          title="服务器磁盘"
          value={metricsUnavailable || !rootDisk ? "—" : `${rootDisk.valueNum.toFixed(1)}%`}
          description={metricsUnavailable ? "指标采集未启用" : `${formatBytes(rootDetail?.usedBytes)} / ${formatBytes(rootDetail?.totalBytes)}`}
          tone={metricsUnavailable || !rootDisk ? "default" : rootDisk.valueNum >= 90 ? "bad" : rootDisk.valueNum >= 80 ? "warn" : "good"}
        />
        <MetricCard
          title="用户文件存储"
          value={metricsUnavailable || nasUsed == null ? "—" : formatBytes(nasUsed)}
          description={metricsUnavailable ? "指标采集未启用" : "NAS 容量型存储"}
        />
        <MetricCard
          title="平台数据最大表"
          value={metricsUnavailable || !pgTopTables[0] ? "—" : formatBytes(pgTopTables[0].valueNum)}
          description={metricsUnavailable ? "指标采集未启用" : pgTopTables[0]?.label ?? "暂无平台数据"}
        />
        <MetricCard
          title="用户文件目录"
          value={storageUnavailable ? "—" : formatBytes(storage?.summary.totalBytes)}
          description={
            storageUnavailable
              ? "文件用量扫描未启用"
              : `无主目录 ${formatNumber(storage?.summary.orphanCount)} 个 / ${formatBytes(storage?.summary.orphanBytes)}`
          }
          tone={
            storageUnavailable
              ? "default"
              : (storage?.summary.orphanCount ?? 0) > 20 || (storage?.summary.orphanBytes ?? 0) > 10 * 1024 ** 3
                ? "warn"
                : "default"
          }
        />
        <MetricCard
          title="HTTPS 证书"
          value={metricsUnavailable || tlsDaysLeft == null ? "—" : `${tlsDaysLeft.toFixed(1)} 天`}
          description={metricsUnavailable ? "指标采集未启用" : "最短剩余有效期"}
          tone={metricsUnavailable || tlsDaysLeft == null ? "default" : tlsDaysLeft < 7 ? "bad" : tlsDaysLeft < 14 ? "warn" : "good"}
        />
      </div>

      <AdminEntityTable
        title="各组织文件用量"
        storageKey="infra-tenant-usage"
        rows={storage?.summary.byTenant ?? []}
        rowKey={row => row.tenantId}
        defaultSort={{ key: "bytes", direction: "desc" }}
        // 汇总由服务端一次算完，排序就是全量排序
        sortScope="all"
        loading={loading || refreshing}
        skeletonRows={4}
        columns={[
          { key: "tenant", header: TENANT_LABEL, alwaysVisible: true, sortable: true, sortValue: row => row.tenantId, cell: row => <EntityLink kind="tenant" id={row.tenantId} /> },
          { key: "count", header: "文件目录", className: "text-right", sortable: true, sortNumeric: true, sortValue: row => row.workspaceCount, cell: row => formatNumber(row.workspaceCount) },
          { key: "bytes", header: "总量", className: "text-right", sortable: true, sortNumeric: true, sortValue: row => row.bytes, cell: row => formatBytes(row.bytes) },
          {
            key: "ratio",
            header: "占比",
            className: "text-right",
            sortable: true,
            sortNumeric: true,
            sortValue: row => row.bytes,
            cell: row => {
              const total = storage?.summary.totalBytes ?? 0;
              return total > 0 ? `${((row.bytes / total) * 100).toFixed(1)}%` : "—";
            },
          },
        ]}
        emptyState={
          <EmptyState
            icon={storageUnavailable ? TriangleAlert : HardDrive}
            title={storageUnavailable ? "文件用量扫描未启用，无法获取数据" : "暂无组织文件用量数据"}
            description={storageUnavailable
              ? "这里显示「—」表示无法获取，不代表用量为 0。点「手动扫描」可立即采集一次。"
              : "成员上传或生成文件后，扫描任务会在这里汇总各组织的占用。"}
            action={storageUnavailable && !platformReadOnly
              ? { label: "手动扫描", onClick: () => void onScan() }
              : undefined}
          />
        }
      />

      <AdminEntityTable
        title="文件目录明细"
        storageKey="infra-workspaces"
        rows={workspaceRows}
        rowKey={row => row.path}
        // 服务端一次返回全量目录，前端只按状态过滤 → 排序作用于全部行
        sortScope="all"
        loading={loading || refreshing}
        skeletonRows={8}
        toolbar={
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">扫描：{formatTime(storage?.summary.lastScanAt)}</span>
            <AdminSelect
              ariaLabel="筛选文件目录状态"
              options={WORKSPACE_FILTER_OPTIONS}
              value={statusFilter}
              onValueChange={value => setStatusFilter(value as WorkspaceUsageStatus | "all")}
            />
          </div>
        }
        columns={[
          { key: "path", header: "路径", alwaysVisible: true, className: "max-w-[320px]", sortable: true, sortValue: row => row.path, cell: row => <span className="font-mono text-xs">{row.path}</span> },
          { key: "tenant", header: TENANT_LABEL, sortable: true, sortValue: row => row.tenantId, cell: row => <EntityLink kind="tenant" id={row.tenantId} /> },
          // 改造前这两列是纯文本：从「这个目录占了 12 GB」到「这个人是谁」必须自己复制用户名去用户页搜。
          // orphan_user 状态下 userId 为空，此时退回纯文本（EntityLink 会渲染「—」，不适合当身份列）。
          {
            key: "username",
            header: "用户名",
            sortable: true,
            sortValue: row => row.username || null,
            cell: row => row.userId
              ? <EntityLink kind="user" id={row.userId} label={row.username || undefined} tenantId={row.tenantId} />
              : row.username
                ? <span className="font-mono text-xs" title="该目录已无对应用户记录">{row.username}</span>
                : "—",
          },
          {
            key: "realName",
            header: "姓名",
            sortable: true,
            sortValue: row => row.realName || null,
            cell: row => row.realName
              ? (row.userId
                ? <EntityLink kind="user" id={row.userId} label={row.realName} tenantId={row.tenantId} />
                : <span className="text-xs" title="该目录已无对应用户记录">{row.realName}</span>)
              : "—",
          },
          { key: "status", header: "状态", sortable: true, sortValue: row => WORKSPACE_STATUS_ORDER[row.status] ?? 9, cell: row => <WorkspaceStatusBadge status={row.status} /> },
          {
            key: "bytes",
            header: "大小",
            className: "text-right",
            sortable: true,
            sortNumeric: true,
            // bytes < 0 = 扫描失败（缺失，不是 0）→ 返回 null 让它恒排末尾，
            // 排序不会把「扫描失败」伪装成「最小的目录」
            sortValue: row => (row.bytes < 0 ? null : row.bytes),
            // bytes = -1 表示该目录 du 失败/超时（FIX-4），与空目录的 0 区分。
            cell: row => row.bytes < 0
              ? <span className="text-destructive" title="du 失败或超时，未计入汇总">扫描失败</span>
              : formatBytes(row.bytes),
          },
          { key: "scanned", header: "扫描时间", sortable: true, sortNumeric: true, sortValue: row => (row.scannedAt ? Date.parse(row.scannedAt) || null : null), cell: row => formatTime(row.scannedAt) },
          {
            key: "actions",
            header: "",
            alwaysVisible: true,
            className: "w-[104px] text-right",
            cell: row => row.status === "active" ? null : (
              <div className="flex justify-end gap-1">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-8"
                  onClick={(event) => {
                    event.stopPropagation();
                    onArchive(row);
                  }}
                  disabled={platformReadOnly || archivingPath === row.path || deletingPath === row.path}
                  title="归档=移动到 runtime/archive/，不删除数据"
                >
                  {archivingPath === row.path ? <Loader2 className="size-3.5 animate-spin" /> : <Archive className="size-3.5" />}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-8 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete(row);
                  }}
                  disabled={platformReadOnly || archivingPath === row.path || deletingPath === row.path}
                  title="永久删除 workspace 目录"
                >
                  {deletingPath === row.path ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                </Button>
              </div>
            ),
          },
        ]}
        emptyState={
          <EmptyState
            icon={storageUnavailable ? TriangleAlert : statusFilter === "all" ? FolderOpen : SearchX}
            title={storageUnavailable
              ? "文件用量扫描未启用，无法获取数据"
              : statusFilter === "all"
                ? "暂无文件目录数据"
                : `没有「${formatWorkspaceStatus(statusFilter)}」状态的文件目录`}
            description={storageUnavailable
              ? "这里显示「—」表示无法获取，不代表目录数为 0。点「手动扫描」可立即采集一次。"
              : statusFilter === "all"
                ? "成员上传或生成文件后，扫描任务会在这里逐个目录列出占用与归属。"
                : "这通常是好消息：没有待归档或无主目录。切回「全部状态」可以看到所有目录。"}
            tone={!storageUnavailable && statusFilter !== "all" ? "positive" : "default"}
            action={storageUnavailable
              ? (platformReadOnly ? undefined : { label: "手动扫描", onClick: () => void onScan() })
              : statusFilter !== "all"
                ? { label: "查看全部状态", onClick: () => setStatusFilter("all") }
                : undefined}
          />
        }
      />
      {confirmDialog}
    </div>
  );
}

/** 状态列排序权重：需要处理的排前面（无主目录 → 软删 → 正常） */
const WORKSPACE_STATUS_ORDER: Record<string, number> = {
  orphan_tenant: 0,
  orphan_user: 1,
  soft_deleted: 2,
  active: 3,
};

/**
 * 状态徽章走 `ui/badge` 的语义 variant，不再手写「15% 底 + -ink 字」类串
 * ——那正是 S2 把这套形态收进 badge variant 的原因。
 */
function WorkspaceStatusBadge({ status }: { status: WorkspaceUsageStatus }) {
  const variant = status === "active"
    ? "success"
    : status === "soft_deleted"
      ? "warning"
      : "danger";
  return <Badge variant={variant}>{formatWorkspaceStatus(status)}</Badge>;
}
