import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Network, PauseCircle, PlayCircle, RefreshCw, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { AdminEntityTable, AdminErrorAlert, EntityLink, MetricCard, ScopeFilters, StatusBadge } from "@/components/PlatformAdmin/common";
import { useAdminUrlQuery } from "@/hooks/useAdminUrlQuery";
import { pushPlatformAdminUrl } from "@/lib/urlSync";
import { cn } from "@/lib/utils";

import { platformAdminApi } from "../api";
import {
  SANDBOX_LABEL,
  formatBusyState,
  formatHealthStatus,
  formatImageFreshness,
  formatLifecycleState,
  formatManagedState,
  formatSandboxPhase,
  formatSystemOwner,
} from "../displayText";
import { formatDuration, formatNumber, formatTime, sandboxOwnerText } from "../format";
import type { RuntimeOperationsResponse, SandboxRecord } from "../types";

export function SandboxesPage({ sandboxName }: { sandboxName: string | null }) {
  if (sandboxName) return <SandboxDetail sandboxName={sandboxName} />;
  return <SandboxList />;
}

function useSandboxData() {
  const [operations, setOperations] = useState<RuntimeOperationsResponse | null>(null);
  const [sandboxes, setSandboxes] = useState<SandboxRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (mode: "initial" | "refresh" = "refresh") => {
    if (mode === "initial") setLoading(true);
    else setRefreshing(true);
    try {
      const [ops, list] = await Promise.all([
        platformAdminApi.runtimeOperations(),
        platformAdminApi.sandboxes(),
      ]);
      setOperations(ops);
      setSandboxes(list.sandboxes);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load("initial"); }, [load]);
  return { operations, sandboxes, loading, refreshing, error, load };
}

function SandboxList() {
  const adminQuery = useAdminUrlQuery();
  const { operations, sandboxes, loading, refreshing, error, load } = useSandboxData();
  const [action, setAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const q = adminQuery.get("q") ?? "";
  const tenantId = adminQuery.get("tenantId") ?? "";
  const workspaceId = adminQuery.get("workspaceId") ?? "";
  const phase = adminQuery.get("phase") ?? "";

  const acsHealth = operations?.tenantRemoteHands.health.find(item => item.id === "agent-saas-acs")
    ?? operations?.tenantRemoteHands.health.find(item => item.metadata?.backend === "acs-agent-sandbox");
  const acsMeta = acsHealth?.metadata;
  const snat = acsMeta?.snat;

  const filtered = useMemo(() => sandboxes.filter(item => {
    const needle = q.toLowerCase();
    if (tenantId && item.owner?.tenantId !== tenantId) return false;
    if (workspaceId && item.workspaceId !== workspaceId) return false;
    if (phase && item.phase !== phase) return false;
    if (!needle) return true;
    return item.name.toLowerCase().includes(needle)
      || (item.workspaceId ?? "").toLowerCase().includes(needle)
      || (item.owner?.userId ?? "").toLowerCase().includes(needle)
      || (item.owner?.username ?? "").toLowerCase().includes(needle)
      || (item.owner?.realName ?? "").toLowerCase().includes(needle);
  }), [phase, q, sandboxes, tenantId, workspaceId]);

  const runAction = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    setAction(label);
    setActionError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setAction(null);
    }
  }, [load]);

  const cleanupLifecycle = () => {
    if (!window.confirm("立即清理长期空闲的执行环境？平台会按现有规则暂停或删除环境，用户文件不会被删除。")) return;
    void runAction("cleanup", () => platformAdminApi.cleanupLifecycle());
  };

  const probeNetwork = () => {
    if (!window.confirm("执行网络自检？平台会创建一个临时执行环境，检查完成后自动删除。")) return;
    void runAction("network-probe", () => platformAdminApi.probeNetworkPolicy());
  };

  const cleanupSnat = () => {
    if (!window.confirm("清理已经失效的网络出口规则？只处理平台托管且没有对应执行环境的规则。")) return;
    void runAction("snat-cleanup", () => platformAdminApi.cleanupOrphanSnat());
  };

  const pauseSandbox = (row: SandboxRecord) => {
    if (!window.confirm(`暂停执行环境 ${row.name}？`)) return;
    void runAction(`pause:${row.name}`, () => platformAdminApi.pauseSandbox(row.name));
  };

  const startSandbox = (row: SandboxRecord) => {
    if (!window.confirm(`启动执行环境 ${row.name}？`)) return;
    void runAction(`resume:${row.name}`, () => platformAdminApi.resumeSandbox(row.name));
  };

  const deleteSandbox = (row: SandboxRecord) => {
    if (!window.confirm(`删除执行环境 ${row.name}？用户文件不会被删除。`)) return;
    void runAction(`delete:${row.name}`, () => platformAdminApi.deleteSandbox(row.name));
  };

  return (
    <div className="w-full space-y-5">
      <SettingsPanelHeader
        title={SANDBOX_LABEL}
        description="查看每个用户的执行环境是否正常、是否被占用，以及需要暂停、启动或删除的环境。"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={cleanupLifecycle} disabled={!!action}>清理空闲环境</Button>
            <Button variant="outline" size="sm" onClick={probeNetwork} disabled={!!action}>
              <Network className="size-3.5" />
              网络自检
            </Button>
            <Button variant="outline" size="sm" onClick={cleanupSnat} disabled={!!action}>清理失效出口规则</Button>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={refreshing}>
              <RefreshCw className={cn("mr-1.5 size-3.5", refreshing && "animate-spin")} />
              刷新
            </Button>
          </>
        }
      />
      {(error || actionError) && <AdminErrorAlert error={error || actionError} title="操作失败" />}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard title="总数" value={formatNumber(sandboxes.length)} description={`健康 ${formatHealthStatus(acsHealth?.status)}`} tone={acsHealth?.status === "ok" ? "good" : "warn"} />
        <MetricCard title="运行 / 暂停" value={`${formatNumber(sandboxes.filter(item => item.phase === "Running").length)} / ${formatNumber(sandboxes.filter(item => item.phase === "Paused").length)}`} description={`${formatNumber(sandboxes.filter(item => item.brokenReason).length)} 个异常`} />
        <MetricCard title="自动清理" value={formatLifecycleState(acsMeta?.lifecycle?.enabled)} description={`空闲 ${formatDuration(acsMeta?.lifecycle?.idlePauseMs)} · 最长保留 ${formatDuration(acsMeta?.lifecycle?.ttlMs)}`} />
        <MetricCard title="网络出口" value={snat?.mode ?? "未知"} description={`平台托管 ${formatNumber(snat?.managedCount)} · 失效 ${formatNumber(snat?.orphanCount)}`} tone={(snat?.orphanCount ?? 0) > 0 ? "warn" : "default"} />
      </div>
      <AdminEntityTable
        title="执行环境列表"
        rows={filtered}
        rowKey={(row) => row.name}
        loading={loading}
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <Input value={q} onChange={(event) => adminQuery.patch({ q: event.target.value })} placeholder="搜索用户、姓名或环境名称" className="h-8 w-56 text-xs" />
            <ScopeFilters tenantId={tenantId} onChange={(values) => adminQuery.patch(values)} />
            <Input value={workspaceId} onChange={(event) => adminQuery.patch({ workspaceId: event.target.value })} placeholder="文件目录 ID（可选）" className="h-8 w-52 font-mono text-xs" />
            <select className="h-8 rounded-md border bg-background px-2 text-xs" value={phase} onChange={(event) => adminQuery.patch({ phase: event.target.value })}>
              <option value="">全部状态</option>
              <option value="Running">{formatSandboxPhase("Running")}</option>
              <option value="Paused">{formatSandboxPhase("Paused")}</option>
              <option value="Pending">{formatSandboxPhase("Pending")}</option>
              <option value="Failed">{formatSandboxPhase("Failed")}</option>
            </select>
          </div>
        }
        onRowClick={(row) => {
          pushPlatformAdminUrl({ section: "sandboxes", entityId: row.name });
          window.dispatchEvent(new PopStateEvent("popstate"));
        }}
        columns={[
          { key: "phase", header: "状态", cell: row => <div className="space-y-1"><StatusBadge kind="sandbox" status={row.phase ?? "Unknown"} /><div className="max-w-44 truncate text-[11px] text-destructive">{row.brokenReason}</div></div> },
          { key: "name", header: "名称", cell: row => <EntityLink kind="sandbox" id={row.name} /> },
          { key: "owner", header: "组织 / 用户", cell: row => row.owner?.kind === "user" ? <div><EntityLink kind="tenant" id={row.owner.tenantId} /><div><EntityLink kind="user" id={row.owner.userId} /></div></div> : <span className="text-muted-foreground">{formatSystemOwner(row.owner?.kind)}</span> },
          { key: "username", header: "用户名", cell: row => row.owner?.username ? <span className="font-mono text-xs">{row.owner.username}</span> : "—" },
          { key: "realName", header: "姓名", cell: row => row.owner?.realName ?? "—" },
          { key: "busy", header: "占用", cell: row => <Badge variant={row.busy ? "default" : "secondary"}>{formatBusyState(row.busy)}</Badge> },
          { key: "image", header: "运行版本", cell: row => <Badge variant={row.imageStale ? "destructive" : "secondary"} title={row.image}>{formatImageFreshness(row.imageStale)}</Badge> },
          { key: "idle", header: "空闲", cell: row => <span className="text-xs tabular-nums">{formatDuration(row.idleMs)}</span> },
          { key: "ttl", header: "剩余时间", cell: row => <span className="text-xs tabular-nums">{formatDuration(row.ttlRemainingMs)}</span> },
          { key: "created", header: "创建", cell: row => <span className="whitespace-nowrap text-xs text-muted-foreground">{formatTime(row.createdAt)}</span> },
          {
            key: "actions",
            header: "操作",
            className: "w-[132px] text-right",
            cell: row => (
              <div className="flex justify-end gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  title="暂停"
                  disabled={!!action || row.phase === "Paused"}
                  onClick={(event) => {
                    event.stopPropagation();
                    pauseSandbox(row);
                  }}
                >
                  {action === `pause:${row.name}` ? <Loader2 className="size-3.5 animate-spin" /> : <PauseCircle className="size-3.5" />}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  title="启动"
                  disabled={!!action || row.phase !== "Paused"}
                  onClick={(event) => {
                    event.stopPropagation();
                    startSandbox(row);
                  }}
                >
                  {action === `resume:${row.name}` ? <Loader2 className="size-3.5 animate-spin" /> : <PlayCircle className="size-3.5" />}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  title="删除执行环境"
                  disabled={!!action}
                  onClick={(event) => {
                    event.stopPropagation();
                    deleteSandbox(row);
                  }}
                >
                  {action === `delete:${row.name}` ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                </Button>
              </div>
            ),
          },
        ]}
      />
      {snat?.entries && snat.entries.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">网络出口技术详情</CardTitle></CardHeader>
          <CardContent className="grid gap-2 md:grid-cols-2">
            {snat.entries.slice(0, 12).map(entry => (
              <div key={entry.id} className="rounded-md border p-2 text-xs">
                <div className="font-mono">{entry.name}</div>
                <div className="mt-1 text-muted-foreground">{entry.sourceCidr} → {entry.snatIp} · {entry.status ?? "未知"} · {formatManagedState(entry.managed)}</div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function SandboxDetail({ sandboxName }: { sandboxName: string }) {
  const [sandbox, setSandbox] = useState<SandboxRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [data, list] = await Promise.all([
        platformAdminApi.sandbox(sandboxName),
        platformAdminApi.sandboxes().catch(() => ({ sandboxes: [] })),
      ]);
      const summary = list.sandboxes.find(item => item.name === sandboxName);
      setSandbox({ ...data, ...summary, raw: data.raw ?? summary?.raw ?? data });
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/not found/i.test(message)) setSandbox(null);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [sandboxName]);

  useEffect(() => { void load(); }, [load]);

  const goBackToList = useCallback(() => {
    pushPlatformAdminUrl({ section: "sandboxes" });
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);

  const runAction = useCallback(async (
    label: string,
    fn: () => Promise<unknown>,
    options: { reload?: boolean; onSuccess?: () => void } = {},
  ) => {
    setAction(label);
    setError(null);
    let succeeded = false;
    try {
      await fn();
      if (options.reload !== false) await load();
      succeeded = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAction(null);
      if (succeeded) options.onSuccess?.();
    }
  }, [load]);

  const pause = () => {
    if (!window.confirm(`暂停 ${sandboxName}？`)) return;
    void runAction("pause", () => platformAdminApi.pauseSandbox(sandboxName));
  };
  const resume = () => {
    if (!window.confirm(`启动 ${sandboxName}？`)) return;
    void runAction("resume", () => platformAdminApi.resumeSandbox(sandboxName));
  };
  const remove = () => {
    if (!window.confirm(`删除执行环境“${sandboxName}”？用户文件不会被删除。`)) return;
    void runAction("delete", () => platformAdminApi.deleteSandbox(sandboxName), {
      reload: false,
      onSuccess: goBackToList,
    });
  };
  const missing = !loading && !sandbox && /not found/i.test(error ?? "");
  const actionDisabled = !!action || (!sandbox && (loading || !!error));

  return (
    <div className="w-full space-y-5">
      <SettingsPanelHeader
        title={sandbox?.name ?? sandboxName}
        description={`执行环境详情 · ${sandboxName}`}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={pause} disabled={actionDisabled}>
              <PauseCircle className="size-3.5" />
              暂停
            </Button>
            <Button variant="outline" size="sm" onClick={resume} disabled={actionDisabled}>
              <PlayCircle className="size-3.5" />
              启动
            </Button>
            <Button variant="destructive" size="sm" onClick={remove} disabled={actionDisabled}>
              <Trash2 className="size-3.5" />
              删除
            </Button>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              刷新
            </Button>
          </>
        }
      />
      {error && (missing
        ? <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">执行环境不存在或已删除。</div>
        : <AdminErrorAlert error={error} />)}
      {loading && !sandbox ? (
        <div className="flex h-40 items-center justify-center rounded-lg border bg-card text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" />
          加载执行环境详情...
        </div>
      ) : missing ? (
        <div className="flex h-40 flex-col items-center justify-center gap-3 rounded-lg border bg-card text-sm text-muted-foreground">
          <div>平台没有找到这个执行环境，它可能已经被自动清理。</div>
          <Button variant="outline" size="sm" onClick={goBackToList}>返回列表</Button>
        </div>
      ) : sandbox ? (
        <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard title="状态" value={<StatusBadge kind="sandbox" status={sandbox.phase ?? "Unknown"} />} description={sandbox.brokenReason || "—"} tone={sandbox.brokenReason ? "bad" : "default"} />
            <MetricCard title="归属" value={sandboxOwnerText(sandbox.owner)} description={sandbox.workspaceId || "—"} />
            <MetricCard title="空闲 / 剩余时间" value={`${formatDuration(sandbox.idleMs)} / ${formatDuration(sandbox.ttlRemainingMs)}`} description={`占用状态：${formatBusyState(sandbox.busy)}`} />
            <MetricCard title="运行版本" value={formatImageFreshness(sandbox.imageStale)} description={sandbox.image || "—"} tone={sandbox.imageStale ? "warn" : "good"} />
          </div>
          <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
            <Card>
              <CardHeader><CardTitle className="text-base">关联</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div>
                  <div className="text-xs text-muted-foreground">组织</div>
                  <EntityLink kind="tenant" id={sandbox.owner?.tenantId} />
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">用户</div>
                  <EntityLink kind="user" id={sandbox.owner?.userId} />
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">最近对话</div>
                  <EntityLink kind="session" id={sandbox.sessionId} />
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">创建 / 最近活跃</div>
                  <div className="text-xs tabular-nums">{formatTime(sandbox.createdAt)} / {formatTime(sandbox.lastActiveAt)}</div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <details>
                <summary className="cursor-pointer list-none px-5 py-4 text-base font-medium">技术详情</summary>
                <CardContent className="border-t pt-4">
                  <pre className="max-h-[520px] overflow-auto rounded-md bg-muted p-3 text-xs text-muted-foreground">
                    {JSON.stringify(sandbox.raw ?? sandbox, null, 2)}
                  </pre>
                </CardContent>
              </details>
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}
