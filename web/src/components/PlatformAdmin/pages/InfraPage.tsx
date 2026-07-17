import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, Loader2, RefreshCw, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { AdminEntityTable, AdminErrorAlert, EntityLink, MetricCard } from "@/components/PlatformAdmin/common";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";

import { platformAdminApi } from "../api";
import { TENANT_LABEL, formatWorkspaceStatus } from "../displayText";
import { formatBytes, formatNumber, formatTime } from "../format";
import type { SystemMetricsResponse, SystemStorageResponse, WorkspaceUsageRecord, WorkspaceUsageStatus } from "../types";

const WORKSPACE_FILTERS: Array<WorkspaceUsageStatus | "all"> = ["all", "active", "soft_deleted", "orphan_tenant", "orphan_user"];

export function InfraPage() {
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

  const onArchive = useCallback(async (row: WorkspaceUsageRecord) => {
    const lastSegment = row.path.split("/").at(-1) ?? row.path;
    const confirmed = window.prompt(`输入目录名确认归档：${lastSegment}`);
    if (confirmed !== lastSegment) return;
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

  const onDelete = useCallback(async (row: WorkspaceUsageRecord) => {
    const lastSegment = row.path.split("/").at(-1) ?? row.path;
    const sizeText = row.bytes < 0 ? "扫描失败" : formatBytes(row.bytes);
    if (!window.confirm(`永久删除 workspace 目录 ${row.path}？\n\n大小：${sizeText}\n文件数：${formatNumber(row.fileCount)}\n\n此操作不可恢复。`)) return;
    const confirmed = window.prompt(`输入目录名确认永久删除：${lastSegment}`);
    if (confirmed !== lastSegment) return;
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

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <MetricCard
          title="服务器磁盘"
          value={rootDisk ? `${rootDisk.valueNum.toFixed(1)}%` : "—"}
          description={`${formatBytes(rootDetail?.usedBytes)} / ${formatBytes(rootDetail?.totalBytes)}`}
          tone={(rootDisk?.valueNum ?? 0) >= 90 ? "bad" : (rootDisk?.valueNum ?? 0) >= 80 ? "warn" : "good"}
        />
        <MetricCard
          title="用户文件存储"
          value={formatBytes(nasUsed)}
          description="NAS 容量型存储"
        />
        <MetricCard
          title="平台数据最大表"
          value={pgTopTables[0] ? formatBytes(pgTopTables[0].valueNum) : "—"}
          description={pgTopTables[0]?.label ?? "暂无平台数据"}
        />
        <MetricCard
          title="用户文件目录"
          value={formatBytes(storage?.summary.totalBytes)}
          description={`无主目录 ${formatNumber(storage?.summary.orphanCount)} 个 / ${formatBytes(storage?.summary.orphanBytes)}`}
          tone={(storage?.summary.orphanCount ?? 0) > 20 || (storage?.summary.orphanBytes ?? 0) > 10 * 1024 ** 3 ? "warn" : "default"}
        />
        <MetricCard
          title="HTTPS 证书"
          value={tlsDaysLeft == null ? "—" : `${tlsDaysLeft.toFixed(1)} 天`}
          description="最短剩余有效期"
          tone={tlsDaysLeft == null ? "default" : tlsDaysLeft < 7 ? "bad" : tlsDaysLeft < 14 ? "warn" : "good"}
        />
      </div>

      <AdminEntityTable
        title="各组织文件用量"
        rows={storage?.summary.byTenant ?? []}
        rowKey={row => row.tenantId}
        columns={[
          { key: "tenant", header: TENANT_LABEL, cell: row => <EntityLink kind="tenant" id={row.tenantId} /> },
          { key: "count", header: "文件目录", className: "text-right", cell: row => formatNumber(row.workspaceCount) },
          { key: "bytes", header: "总量", className: "text-right", cell: row => formatBytes(row.bytes) },
          {
            key: "ratio",
            header: "占比",
            className: "text-right",
            cell: row => {
              const total = storage?.summary.totalBytes ?? 0;
              return total > 0 ? `${((row.bytes / total) * 100).toFixed(1)}%` : "—";
            },
          },
        ]}
        emptyText="暂无组织文件用量数据"
      />

      <AdminEntityTable
        title="文件目录明细"
        rows={workspaceRows}
        rowKey={row => row.path}
        toolbar={
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">扫描：{formatTime(storage?.summary.lastScanAt)}</span>
            <select
              className="h-8 rounded-md border bg-background px-2 text-xs"
              value={statusFilter}
              onChange={event => setStatusFilter(event.target.value as WorkspaceUsageStatus | "all")}
              aria-label="筛选 workspace 状态"
            >
              {WORKSPACE_FILTERS.map(value => (
                <option key={value} value={value}>{value === "all" ? "全部状态" : formatWorkspaceStatus(value)}</option>
              ))}
            </select>
          </div>
        }
        columns={[
          { key: "path", header: "路径", className: "max-w-[320px]", cell: row => <span className="font-mono text-xs">{row.path}</span> },
          { key: "tenant", header: TENANT_LABEL, cell: row => <EntityLink kind="tenant" id={row.tenantId} /> },
          { key: "username", header: "用户名", cell: row => row.username ? <span className="font-mono text-xs">{row.username}</span> : "—" },
          { key: "realName", header: "姓名", cell: row => row.realName ?? "—" },
          { key: "status", header: "状态", cell: row => <WorkspaceStatusBadge status={row.status} /> },
          {
            key: "bytes",
            header: "大小",
            className: "text-right",
            // bytes = -1 表示该目录 du 失败/超时（FIX-4），与空目录的 0 区分。
            cell: row => row.bytes < 0
              ? <span className="text-destructive" title="du 失败或超时，未计入汇总">扫描失败</span>
              : formatBytes(row.bytes),
          },
          { key: "scanned", header: "扫描时间", cell: row => formatTime(row.scannedAt) },
          {
            key: "actions",
            header: "",
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
                    void onArchive(row);
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
                    void onDelete(row);
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
        emptyText="暂无文件目录数据"
      />
    </div>
  );
}

function WorkspaceStatusBadge({ status }: { status: WorkspaceUsageStatus }) {
  const className = status === "active"
    ? "border-0 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
    : status === "soft_deleted"
      ? "border-0 bg-amber-500/15 text-amber-700 dark:text-amber-300"
      : "border-0 bg-destructive/15 text-destructive";
  return <Badge className={className}>{formatWorkspaceStatus(status)}</Badge>;
}
