import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Network, PauseCircle, PlayCircle, RefreshCw, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { AdminEntityTable, EntityLink, MetricCard, StatusBadge } from "@/components/PlatformAdmin/common";
import { useAdminUrlQuery } from "@/hooks/useAdminUrlQuery";
import { pushPlatformAdminUrl } from "@/lib/urlSync";
import { cn } from "@/lib/utils";

import { platformAdminApi } from "../api";
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
      || (item.owner?.userId ?? "").toLowerCase().includes(needle);
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
    if (!window.confirm("立即触发 ACS lifecycle cleanup？这会按现有 idle/TTL 策略 pause/delete Sandbox CR。")) return;
    void runAction("cleanup", () => platformAdminApi.cleanupLifecycle());
  };

  const probeNetwork = () => {
    if (!window.confirm("执行 network probe？会创建临时 Sandbox 验证网络策略，完成后删除 Sandbox CR。")) return;
    void runAction("network-probe", () => platformAdminApi.probeNetworkPolicy());
  };

  const cleanupSnat = () => {
    if (!window.confirm("清理 orphan SNAT entry？仅处理受管前缀且无对应活跃 Pod 的 entry。")) return;
    void runAction("snat-cleanup", () => platformAdminApi.cleanupOrphanSnat());
  };

  return (
    <div className="w-full space-y-5">
      <SettingsPanelHeader
        title="容器"
        description="ACS Sandbox 池、属主、生命周期和网络状态。"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={cleanupLifecycle} disabled={!!action}>Lifecycle cleanup</Button>
            <Button variant="outline" size="sm" onClick={probeNetwork} disabled={!!action}>
              <Network className="mr-1.5 h-3.5 w-3.5" />
              Network probe
            </Button>
            <Button variant="outline" size="sm" onClick={cleanupSnat} disabled={!!action}>SNAT cleanup</Button>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={refreshing}>
              <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", refreshing && "animate-spin")} />
              刷新
            </Button>
          </>
        }
      />
      {(error || actionError) && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">操作失败：{error || actionError}</div>}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard title="总数" value={formatNumber(sandboxes.length)} description={`健康 ${acsHealth?.status ?? "unknown"}`} tone={acsHealth?.status === "ok" ? "good" : "warn"} />
        <MetricCard title="Running / Paused" value={`${formatNumber(sandboxes.filter(item => item.phase === "Running").length)} / ${formatNumber(sandboxes.filter(item => item.phase === "Paused").length)}`} description={`${formatNumber(sandboxes.filter(item => item.brokenReason).length)} broken`} />
        <MetricCard title="Lifecycle" value={acsMeta?.lifecycle?.enabled ? "enabled" : "unknown"} description={`idle ${formatDuration(acsMeta?.lifecycle?.idlePauseMs)} · ttl ${formatDuration(acsMeta?.lifecycle?.ttlMs)}`} />
        <MetricCard title="SNAT" value={snat?.mode ?? "unknown"} description={`managed ${formatNumber(snat?.managedCount)} · orphan ${formatNumber(snat?.orphanCount)}`} tone={(snat?.orphanCount ?? 0) > 0 ? "warn" : "default"} />
      </div>
      <AdminEntityTable
        title="Sandbox 列表"
        rows={filtered}
        rowKey={(row) => row.name}
        loading={loading}
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <Input value={q} onChange={(event) => adminQuery.patch({ q: event.target.value })} placeholder="sandbox / workspace / user" className="h-8 w-56 font-mono text-xs" />
            <Input value={tenantId} onChange={(event) => adminQuery.patch({ tenantId: event.target.value })} placeholder="tenantId" className="h-8 w-32 font-mono text-xs" />
            <Input value={workspaceId} onChange={(event) => adminQuery.patch({ workspaceId: event.target.value })} placeholder="workspaceId" className="h-8 w-52 font-mono text-xs" />
            <select className="h-8 rounded-md border bg-background px-2 text-xs" value={phase} onChange={(event) => adminQuery.patch({ phase: event.target.value })}>
              <option value="">全部相位</option>
              <option value="Running">Running</option>
              <option value="Paused">Paused</option>
              <option value="Pending">Pending</option>
              <option value="Failed">Failed</option>
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
          { key: "owner", header: "属主", cell: row => row.owner?.kind === "user" ? <div><EntityLink kind="tenant" id={row.owner.tenantId} /><div><EntityLink kind="user" id={row.owner.userId} /></div></div> : <span className="text-muted-foreground">system</span> },
          { key: "busy", header: "Busy", cell: row => <Badge variant={row.busy ? "default" : "secondary"}>{row.busy ? "busy" : "idle"}</Badge> },
          { key: "image", header: "镜像", cell: row => <div className="max-w-48 truncate font-mono text-xs" title={row.image}>{row.image || "—"}{row.imageStale && <Badge variant="destructive" className="ml-1">stale</Badge>}</div> },
          { key: "idle", header: "空闲", cell: row => <span className="text-xs tabular-nums">{formatDuration(row.idleMs)}</span> },
          { key: "ttl", header: "TTL", cell: row => <span className="text-xs tabular-nums">{formatDuration(row.ttlRemainingMs)}</span> },
          { key: "created", header: "创建", cell: row => <span className="whitespace-nowrap text-xs text-muted-foreground">{formatTime(row.createdAt)}</span> },
        ]}
      />
      {snat?.entries && snat.entries.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">SNAT entries</CardTitle></CardHeader>
          <CardContent className="grid gap-2 md:grid-cols-2">
            {snat.entries.slice(0, 12).map(entry => (
              <div key={entry.id} className="rounded-md border p-2 text-xs">
                <div className="font-mono">{entry.name}</div>
                <div className="mt-1 text-muted-foreground">{entry.sourceCidr} → {entry.snatIp} · {entry.status ?? "unknown"} · {entry.managed ? "managed" : "external"}</div>
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
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [sandboxName]);

  useEffect(() => { void load(); }, [load]);

  const runAction = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    setAction(label);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAction(null);
    }
  }, [load]);

  const pause = () => {
    if (!window.confirm(`暂停 ${sandboxName}？`)) return;
    void runAction("pause", () => platformAdminApi.pauseSandbox(sandboxName));
  };
  const resume = () => {
    if (!window.confirm(`恢复 ${sandboxName}？`)) return;
    void runAction("resume", () => platformAdminApi.resumeSandbox(sandboxName));
  };
  const remove = () => {
    if (!window.confirm(`删除 Sandbox CR ${sandboxName}？这不会删除 NAS workspace。`)) return;
    void runAction("delete", () => platformAdminApi.deleteSandbox(sandboxName));
  };

  return (
    <div className="w-full space-y-5">
      <SettingsPanelHeader
        title={sandbox?.name ?? sandboxName}
        description={`容器详情 · ${sandboxName}`}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={pause} disabled={!!action}>
              <PauseCircle className="mr-1.5 h-3.5 w-3.5" />
              Pause
            </Button>
            <Button variant="outline" size="sm" onClick={resume} disabled={!!action}>
              <PlayCircle className="mr-1.5 h-3.5 w-3.5" />
              Resume
            </Button>
            <Button variant="destructive" size="sm" onClick={remove} disabled={!!action}>
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              Delete
            </Button>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
              刷新
            </Button>
          </>
        }
      />
      {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">加载失败：{error}</div>}
      {loading && !sandbox ? (
        <div className="flex h-40 items-center justify-center rounded-lg border bg-card text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          加载容器详情...
        </div>
      ) : sandbox ? (
        <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard title="状态" value={<StatusBadge kind="sandbox" status={sandbox.phase ?? "Unknown"} />} description={sandbox.brokenReason || "—"} tone={sandbox.brokenReason ? "bad" : "default"} />
            <MetricCard title="属主" value={sandboxOwnerText(sandbox.owner)} description={sandbox.workspaceId || "—"} />
            <MetricCard title="空闲 / TTL" value={`${formatDuration(sandbox.idleMs)} / ${formatDuration(sandbox.ttlRemainingMs)}`} description={`busy=${sandbox.busy ? "yes" : "no"}`} />
            <MetricCard title="镜像" value={sandbox.imageStale ? "stale" : "current"} description={sandbox.image || "—"} tone={sandbox.imageStale ? "warn" : "good"} />
          </div>
          <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
            <Card>
              <CardHeader><CardTitle className="text-base">关联</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div>
                  <div className="text-xs text-muted-foreground">租户</div>
                  <EntityLink kind="tenant" id={sandbox.owner?.tenantId} />
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">用户</div>
                  <EntityLink kind="user" id={sandbox.owner?.userId} />
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">最近会话</div>
                  <EntityLink kind="session" id={sandbox.sessionId} />
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">创建 / 最近活跃</div>
                  <div className="text-xs tabular-nums">{formatTime(sandbox.createdAt)} / {formatTime(sandbox.lastActiveAt)}</div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">原始数据</CardTitle></CardHeader>
              <CardContent>
                <pre className="max-h-[520px] overflow-auto rounded-md bg-muted p-3 text-xs text-muted-foreground">
                  {JSON.stringify(sandbox.raw ?? sandbox, null, 2)}
                </pre>
              </CardContent>
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}
