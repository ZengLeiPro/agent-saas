import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, AlertCircle, ArrowRight, CheckCircle2, Clock3, ExternalLink, Loader2, PauseCircle, RefreshCw, Save, ServerCog, ShieldCheck, SlidersHorizontal, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { authFetch } from "@/lib/authFetch";

type HealthStatus = "ok" | "unhealthy";
type RolloutMode = "disabled" | "drain" | "allowlist" | "tenant" | "all";
type NetworkPolicyMode = "isolated" | "public-egress" | "private-egress";

interface NetworkPolicyConfig {
  mode: NetworkPolicyMode;
  denyPrivateNetworks?: boolean;
  allowCidrs?: string[];
  allowDomains?: string[];
  denyCidrs?: string[];
}

interface EffectiveNetworkPolicy {
  mode?: NetworkPolicyMode | "unknown";
  enforcement?: "enforced" | "not_enforced" | "unknown";
  publicEgressReachable?: boolean | "unknown";
  privateEgressBlocked?: boolean | "unknown";
  metadataBlocked?: boolean | "unknown";
  dnsRebindingProtected?: boolean | "unknown";
  checkedAt?: string;
  probeSandboxName?: string;
  note?: string;
}

interface NetworkPolicyStatus {
  desiredPolicy?: NetworkPolicyConfig;
  effectivePolicy?: EffectiveNetworkPolicy;
}

interface SnatEntry {
  id: string;
  name: string;
  sourceCidr: string;
  snatIp: string;
  status?: string;
  managed: boolean;
}

interface SnatStatus {
  enabled: boolean;
  mode: "disabled" | "probe-only" | "per-sandbox";
  configured: boolean;
  regionId?: string;
  snatTableId?: string;
  snatIp?: string;
  entryNamePrefix: string;
  maxManagedEntries: number;
  managedCount: number;
  unexpectedCount: number;
  orphanCount: number;
  entries: SnatEntry[];
  error?: string;
}

interface RuntimeOperationsResponse {
  generatedAt: string;
  processRole: string | null;
  tenantRemoteHands: {
    hands: Array<{
      id: string;
      description?: string;
      baseUrl: string;
      rollout?: { mode: RolloutMode; userIds?: string[]; usernames?: string[]; tenantIds?: string[] };
      users?: string[];
      tenantIds?: string[];
      authTokenRef?: string;
      authTokenConfigured?: boolean;
      invokeTimeoutMs?: number;
      networkPolicy?: NetworkPolicyConfig;
      recipe?: unknown;
    }>;
    health: Array<{
      id: string;
      status: HealthStatus;
      detail?: string;
      metadata?: RuntimeHandHealthMetadata;
    }>;
  };
  runtimeEventStore: RuntimeEventStoreSummary;
}

interface RuntimeHandHealthMetadata {
  status?: string;
  backend?: string;
  namespace?: string;
  image?: string;
  lifecycle?: {
    enabled?: boolean;
    cleanupIntervalMs?: number;
    idlePauseMs?: number;
    ttlMs?: number;
    orphanGraceMs?: number;
    maxRunningSandboxes?: number;
    warnRunningSandboxes?: number;
    alertWebhookConfigured?: boolean;
  };
  contextSemantics?: {
    workspacePersistence?: "nas-pvc" | "host-workspace" | "ephemeral";
    memoryInjection?: "session-start";
    memoryHotReload?: boolean;
    folderAutoContext?: boolean;
    note?: string;
  };
  sandboxes?: {
    totalCount?: number;
    phaseCounts?: Record<string, number>;
    runningCount?: number;
    pausedCount?: number;
    oldestCreatedAt?: string;
    newestLastActiveAt?: string;
  };
  networkPolicy?: NetworkPolicyStatus;
  snat?: SnatStatus;
}

type RuntimeEventStoreSummary =
  | { backend: string; status: "disabled" }
  | { backend: string; status: "error"; error: string }
  | {
      backend: "pg";
      status: "ok";
      tablePrefix: string;
      windows: { since1h: string; since24h: string };
      handFailures: {
        last1h: number;
        last24h: number;
        latestAt: string | null;
        recent: Array<{
          timestamp: string;
          tenant_id: string;
          session_id: string;
          run_id: string | null;
          hand_id: string | null;
          reason: string | null;
        }>;
      };
      activeRuns: Array<{ status: string; count: number; latest_at: string | null }>;
      activeRunDetails?: ActiveRunDetail[];
      staleActiveRuns?: ActiveRunDetail[];
      toolInvocations: {
        status24h: Array<{ status: string; count: number }>;
        route24h: { total: number; acs_count: number; ecs_count: number; unrouted_count: number };
        recent: Array<{
          started_at: string;
          tenant_id: string;
          session_id: string;
          run_id: string;
          tool_name: string;
          status: string;
          execution_target: string;
          routed_hand: string;
        }>;
      };
    };

interface ActiveRunDetail {
  tenant_id: string;
  session_id: string;
  run_id: string;
  status: string;
  status_reason: string | null;
  model: string | null;
  channel: string | null;
  requested_at: string;
  started_at: string | null;
  updated_at: string;
  lease_expires_at: string | null;
  worker_id: string | null;
  workspace_id: string | null;
}

const API_URL = "/api/admin/runtime-operations";

function formatDateTime(value?: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatDuration(ms?: number): string {
  if (!ms || ms <= 0) return "-";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.round(hours / 24)} 天`;
}

function statusBadge(status?: string) {
  if (status === "ok") {
    return <Badge className="gap-1 bg-emerald-600 text-white hover:bg-emerald-600"><CheckCircle2 className="h-3 w-3" />健康</Badge>;
  }
  if (status === "unhealthy" || status === "error") {
    return <Badge variant="destructive" className="gap-1"><AlertCircle className="h-3 w-3" />异常</Badge>;
  }
  if (status === "disabled") return <Badge variant="secondary">未启用</Badge>;
  return <Badge variant="outline">未知</Badge>;
}

function rolloutLabel(hand: RuntimeOperationsResponse["tenantRemoteHands"]["hands"][number]): string {
  const mode = hand.rollout?.mode;
  if (mode === "disabled") return "停用";
  if (mode === "drain") return "维护模式";
  if (mode === "all") return "全部用户";
  if (mode === "allowlist") return "用户白名单";
  if (mode === "tenant") return "按组织";
  if ((hand.users?.length ?? 0) > 0) return "Legacy 用户";
  if ((hand.tenantIds?.length ?? 0) > 0) return "Legacy 组织";
  return "Legacy 全部";
}

function routedHandLabel(value?: string): string {
  if (!value) return "-";
  const parts = value.split(":");
  return parts[parts.length - 1] || value;
}

function networkModeLabel(mode?: string): string {
  if (mode === "isolated") return "isolated";
  if (mode === "private-egress") return "private-egress";
  if (mode === "public-egress") return "public-egress";
  return "unknown";
}

function enforcementBadge(enforcement?: string) {
  if (enforcement === "enforced") return <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">已生效</Badge>;
  if (enforcement === "not_enforced") return <Badge variant="destructive">未生效</Badge>;
  return <Badge variant="outline">unknown</Badge>;
}

function boolStatus(value: boolean | "unknown" | undefined): string {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "unknown";
}

function sumCounts(rows?: Array<{ count: number }>): number {
  return rows?.reduce((sum, row) => sum + Number(row.count || 0), 0) ?? 0;
}

type TenantRemoteHandConfig = RuntimeOperationsResponse["tenantRemoteHands"]["hands"][number];

function handRouteSummary(hand: TenantRemoteHandConfig): string {
  return `${hand.id}: ${rolloutLabel(hand)}`;
}

function withRollout(hand: TenantRemoteHandConfig, rollout: { mode: RolloutMode }): TenantRemoteHandConfig {
  const { users: _users, tenantIds: _tenantIds, ...rest } = hand;
  return { ...rest, rollout };
}

function parseLimitInput(label: string, value: string): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) throw new Error(`${label} 必须是 0-1000 的整数`);
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1_000) throw new Error(`${label} 必须是 0-1000 的整数`);
  return parsed;
}

function MetricCard({ title, value, description, tone = "default" }: {
  title: string;
  value: string | number;
  description: string;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  const toneClass = tone === "good"
    ? "text-emerald-700"
    : tone === "bad"
      ? "text-destructive"
      : tone === "warn"
        ? "text-amber-700"
        : "text-foreground";
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs font-medium text-muted-foreground">{title}</div>
        <div className={`mt-2 text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</div>
        <div className="mt-1 text-xs leading-5 text-muted-foreground">{description}</div>
      </CardContent>
    </Card>
  );
}

export function RuntimeOperationsManager() {
  const [data, setData] = useState<RuntimeOperationsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [applyingAction, setApplyingAction] = useState<string | null>(null);
  const [maxRunningText, setMaxRunningText] = useState("");
  const [warnRunningText, setWarnRunningText] = useState("");

  const load = useCallback(async (mode: "initial" | "refresh" = "refresh") => {
    if (mode === "initial") setLoading(true);
    else setRefreshing(true);
    try {
      const res = await authFetch(API_URL);
      const body = (await res.json().catch(() => ({}))) as Partial<RuntimeOperationsResponse> & { error?: string };
      if (!res.ok || !body.generatedAt) throw new Error(body.error || `HTTP ${res.status}`);
      setData(body as RuntimeOperationsResponse);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load("initial"); }, [load]);

  const healthById = useMemo(() => {
    const map = new Map<string, RuntimeOperationsResponse["tenantRemoteHands"]["health"][number]>();
    for (const item of data?.tenantRemoteHands.health ?? []) map.set(item.id, item);
    return map;
  }, [data?.tenantRemoteHands.health]);

  const acsHealth = data?.tenantRemoteHands.health.find((item) => item.id === "agent-saas-acs")
    ?? data?.tenantRemoteHands.health.find((item) => item.metadata?.backend === "acs-agent-sandbox");
  const acsMeta = acsHealth?.metadata;
  const runtimeStore = data?.runtimeEventStore;
  const activeRunCount = runtimeStore?.status === "ok" ? sumCounts(runtimeStore.activeRuns) : 0;
  const handFailure1h = runtimeStore?.status === "ok" ? runtimeStore.handFailures.last1h : "-";
  const handFailureTone = runtimeStore?.status === "ok" && runtimeStore.handFailures.last1h > 0 ? "bad" : "good";
  const allHandsHealthy = (data?.tenantRemoteHands.health ?? []).every((item) => item.status === "ok");
  const runningSandboxes = acsMeta?.sandboxes?.runningCount ?? 0;
  const snat = acsMeta?.snat;

  useEffect(() => {
    if (!acsMeta?.lifecycle) return;
    setMaxRunningText(String(acsMeta.lifecycle.maxRunningSandboxes ?? ""));
    setWarnRunningText(String(acsMeta.lifecycle.warnRunningSandboxes ?? ""));
  }, [acsMeta?.lifecycle?.maxRunningSandboxes, acsMeta?.lifecycle?.warnRunningSandboxes]);

  const saveTenantRemoteHands = useCallback(async (nextHands: TenantRemoteHandConfig[], label: string) => {
    if (!data) return;
    const before = data.tenantRemoteHands.hands.map(handRouteSummary).join("\n");
    const after = nextHands.map(handRouteSummary).join("\n");
    if (!window.confirm(`${label}\n\n当前：\n${before}\n\n变更后：\n${after}`)) return;
    setApplyingAction(label);
    setActionError(null);
    setActionMessage(null);
    try {
      const res = await authFetch("/api/admin/tenant-remote-hands", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantRemoteHands: { hands: nextHands } }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setActionMessage(`${label} 已生效`);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplyingAction(null);
    }
  }, [data, load]);

  const applyRoutePreset = useCallback((preset: "acs-all" | "acs-drain" | "ecs-all" | "remote-off") => {
    if (!data) return;
    const labels = {
      "acs-all": "切到 ACS 全量",
      "acs-drain": "ACS 维护模式",
      "ecs-all": "回退 ECS 全量",
      "remote-off": "停用全部执行环境池",
    } as const;
    const nextHands = data.tenantRemoteHands.hands.map((hand) => {
      if (preset === "remote-off") return withRollout(hand, { mode: "drain" });
      if (hand.id === "agent-saas-acs") {
        if (preset === "acs-all") return withRollout(hand, { mode: "all" });
        return withRollout(hand, { mode: preset === "acs-drain" || preset === "ecs-all" ? "drain" : "disabled" });
      }
      if (hand.id === "agent-saas-ecs") {
        if (preset === "ecs-all") return withRollout(hand, { mode: "all" });
        return withRollout(hand, { mode: "disabled" });
      }
      return withRollout(hand, { mode: "disabled" });
    });
    void saveTenantRemoteHands(nextHands, labels[preset]);
  }, [data, saveTenantRemoteHands]);

  const saveAcsRuntimeConfig = useCallback(async () => {
    setApplyingAction("保存 ACS 上限");
    setActionError(null);
    setActionMessage(null);
    try {
      const maxRunningSandboxes = parseLimitInput("Max running", maxRunningText);
      const warnRunningSandboxes = parseLimitInput("Warn running", warnRunningText);
      if (maxRunningSandboxes > 0 && warnRunningSandboxes > maxRunningSandboxes) {
        throw new Error("Warn running 不能大于 Max running");
      }
      const res = await authFetch(`${API_URL}/acs/runtime-config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxRunningSandboxes, warnRunningSandboxes }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setActionMessage("ACS 上限已保存");
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplyingAction(null);
    }
  }, [load, maxRunningText, warnRunningText]);

  const runLifecycleCleanup = useCallback(async () => {
    if (!window.confirm("立即触发 ACS lifecycle cleanup？这只会按现有 idle/TTL 策略 pause/delete Sandbox CR，不会物理删除 NAS workspace。")) return;
    setApplyingAction("执行 cleanup");
    setActionError(null);
    setActionMessage(null);
    try {
      const res = await authFetch(`${API_URL}/acs/lifecycle-cleanup`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { error?: string; report?: { paused?: string[]; deleted?: string[] } };
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setActionMessage(`Cleanup 已执行：paused ${body.report?.paused?.length ?? 0}，deleted ${body.report?.deleted?.length ?? 0}`);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplyingAction(null);
    }
  }, [load]);

  const runNetworkPolicyProbe = useCallback(async () => {
    if (!window.confirm("执行 ACS network probe？这会创建一个临时 Sandbox，验证公网、metadata、VPC 内网和 DNS rebinding 阻断；完成后删除 Sandbox CR，不物理删除 NAS workspace。")) return;
    setApplyingAction("执行 network probe");
    setActionError(null);
    setActionMessage(null);
    try {
      const res = await authFetch(`${API_URL}/acs/network-policy/probe`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { error?: string; networkPolicy?: NetworkPolicyStatus };
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      const effective = body.networkPolicy?.effectivePolicy;
      setActionMessage(`Network probe 已完成：${effective?.enforcement ?? "unknown"}，public ${boolStatus(effective?.publicEgressReachable)}，private blocked ${boolStatus(effective?.privateEgressBlocked)}`);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplyingAction(null);
    }
  }, [load]);

  const cleanupOrphanSnat = useCallback(async () => {
    const current = snat;
    if (!window.confirm(`清理 ACS orphan SNAT entry？\n\n当前 managed=${current?.managedCount ?? "-"}，orphan=${current?.orphanCount ?? "-"}，unexpected=${current?.unexpectedCount ?? "-"}。\n只会删除 ${current?.entryNamePrefix ?? "agent-saas-acs"} 前缀下、没有对应活跃 Pod 的 /32 entry。`)) return;
    setApplyingAction("清理 orphan SNAT");
    setActionError(null);
    setActionMessage(null);
    try {
      const res = await authFetch(`${API_URL}/acs/snat/cleanup-orphans`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { error?: string; report?: { deleted?: string[]; unexpected?: SnatEntry[] } };
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setActionMessage(`SNAT cleanup 已执行：deleted ${body.report?.deleted?.length ?? 0}，unexpected ${body.report?.unexpected?.length ?? 0}`);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplyingAction(null);
    }
  }, [load, snat]);

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col">
      <SettingsPanelHeader
        title="运行态"
        description="查看执行环境池、ACS Sandbox、运行队列和最近故障，不暴露密钥。"
        actions={
          <>
            <Button
              size="sm"
              onClick={() => { void saveAcsRuntimeConfig(); }}
              disabled={!!applyingAction || !maxRunningText || !warnRunningText}
            >
              {applyingAction === "保存 ACS 上限" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-3.5 w-3.5" />}
              保存上限
            </Button>
            <Button variant="outline" size="sm" onClick={() => { void load(); }} disabled={loading || refreshing}>
              {refreshing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
              刷新
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 space-y-4 overflow-auto">
      {error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading && !data ? (
        <div className="flex h-48 items-center justify-center rounded-2xl border bg-card text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          加载运行态...
        </div>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              title="执行环境池健康"
              value={allHandsHealthy ? "正常" : "异常"}
              description={`${data?.tenantRemoteHands.health.length ?? 0} 个执行环境池`}
              tone={allHandsHealthy ? "good" : "bad"}
            />
            <MetricCard
              title="Running Sandbox"
              value={runningSandboxes}
              description={`${acsMeta?.sandboxes?.pausedCount ?? 0} 个 Paused / ${acsMeta?.sandboxes?.totalCount ?? 0} 总数`}
              tone={runningSandboxes > 0 ? "warn" : "good"}
            />
            <MetricCard
              title="近 1 小时执行环境故障"
              value={handFailure1h}
              description={runtimeStore?.status === "ok" ? `近 24 小时 ${runtimeStore.handFailures.last24h} 次` : "PG runtime 未可用"}
              tone={handFailureTone}
            />
            <MetricCard
              title="活跃 Run"
              value={activeRunCount}
              description={runtimeStore?.status === "ok" ? "pending / running / waiting" : "无法读取 runtime store"}
              tone={activeRunCount > 0 ? "warn" : "good"}
            />
          </div>

          {(actionError || actionMessage) && (
            <div className={actionError ? "rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" : "rounded-md bg-emerald-600/10 px-3 py-2 text-sm text-emerald-700"}>
              {actionError || actionMessage}
            </div>
          )}

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <SlidersHorizontal className="h-4 w-4" />
                  执行面操作
                </CardTitle>
                <div className="text-xs text-muted-foreground">只改执行环境池的灰度发布配置；已有 run 的环境记录不会被删除。</div>
              </CardHeader>
              <CardContent className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                <Button variant="outline" size="sm" onClick={() => applyRoutePreset("acs-all")} disabled={!!applyingAction}>
                  {applyingAction === "切到 ACS 全量" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <ArrowRight className="mr-1.5 h-3.5 w-3.5" />}
                  ACS 全量
                </Button>
                <Button variant="outline" size="sm" onClick={() => applyRoutePreset("acs-drain")} disabled={!!applyingAction}>
                  <PauseCircle className="mr-1.5 h-3.5 w-3.5" />
                  ACS 维护
                </Button>
                <Button variant="outline" size="sm" onClick={() => applyRoutePreset("ecs-all")} disabled={!!applyingAction}>
                  <ArrowRight className="mr-1.5 h-3.5 w-3.5" />
                  回退 ECS
                </Button>
                <Button variant="outline" size="sm" onClick={() => applyRoutePreset("remote-off")} disabled={!!applyingAction}>
                  <PauseCircle className="mr-1.5 h-3.5 w-3.5" />
                  全部停新
                </Button>
                <Button asChild variant="ghost" size="sm" className="justify-start sm:col-span-2 xl:col-span-4">
                  <a href="/platform-admin/settings/remote-hands">
                    <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                    打开执行环境池详细配置
                  </a>
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">ACS 容量保护</CardTitle>
                <div className="text-xs text-muted-foreground">调整 orchestrator 的运行时上限；生产会持久化到 runtime config 文件。</div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <label className="space-y-1.5 text-sm">
                    <span className="text-xs font-medium text-muted-foreground">Max running</span>
                    <Input inputMode="numeric" value={maxRunningText} onChange={(event) => setMaxRunningText(event.target.value)} placeholder="8" />
                  </label>
                  <label className="space-y-1.5 text-sm">
                    <span className="text-xs font-medium text-muted-foreground">Warn running</span>
                    <Input inputMode="numeric" value={warnRunningText} onChange={(event) => setWarnRunningText(event.target.value)} placeholder="6" />
                  </label>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => { void runLifecycleCleanup(); }} disabled={!!applyingAction}>
                    {applyingAction === "执行 cleanup" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
                    立即 cleanup
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                <div>
                  <CardTitle className="text-base">执行环境池</CardTitle>
                  <div className="mt-1 text-xs text-muted-foreground">配置、灰度发布与实时健康</div>
                </div>
                <ServerCog className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>池</TableHead>
                      <TableHead>Rollout</TableHead>
                      <TableHead>Network</TableHead>
                      <TableHead>凭据</TableHead>
                      <TableHead>Health</TableHead>
                      <TableHead className="text-right">Timeout</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(data?.tenantRemoteHands.hands ?? []).map((hand) => {
                      const health = healthById.get(hand.id);
                      return (
                        <TableRow key={hand.id}>
                          <TableCell>
                            <div className="font-mono text-xs">{hand.id}</div>
                            <div className="mt-1 max-w-72 truncate text-xs text-muted-foreground">{hand.baseUrl}</div>
                          </TableCell>
                          <TableCell>{rolloutLabel(hand)}</TableCell>
                          <TableCell>
                            <div className="space-y-1">
                              <Badge variant="outline">{networkModeLabel(hand.networkPolicy?.mode)}</Badge>
                              <div className="text-xs text-muted-foreground">
                                deny private: {hand.networkPolicy?.denyPrivateNetworks === false ? "no" : "yes"}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell>{hand.authTokenRef ? "Vault ref" : hand.authTokenConfigured ? "Inline token" : "未配置"}</TableCell>
                          <TableCell>
                            <div className="space-y-1">
                              {statusBadge(health?.status)}
                              {health?.detail && <div className="max-w-64 truncate text-xs text-destructive">{health.detail}</div>}
                            </div>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{hand.invokeTimeoutMs ? formatDuration(hand.invokeTimeoutMs) : "-"}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Activity className="h-4 w-4" />
                  ACS Sandbox
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Health</span>
                  {statusBadge(acsHealth?.status)}
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Namespace</span>
                  <span className="font-mono text-xs">{acsMeta?.namespace ?? "-"}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Lifecycle</span>
                  <Badge variant={acsMeta?.lifecycle?.enabled ? "secondary" : "destructive"}>
                    {acsMeta?.lifecycle?.enabled ? "启用" : "停用"}
                  </Badge>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-md border p-2">
                    <div className="text-xs text-muted-foreground">Total</div>
                    <div className="mt-1 text-lg font-semibold tabular-nums">{acsMeta?.sandboxes?.totalCount ?? "-"}</div>
                  </div>
                  <div className="rounded-md border p-2">
                    <div className="text-xs text-muted-foreground">Running</div>
                    <div className="mt-1 text-lg font-semibold tabular-nums">{acsMeta?.sandboxes?.runningCount ?? "-"}</div>
                  </div>
                  <div className="rounded-md border p-2">
                    <div className="text-xs text-muted-foreground">Paused</div>
                    <div className="mt-1 text-lg font-semibold tabular-nums">{acsMeta?.sandboxes?.pausedCount ?? "-"}</div>
                  </div>
                </div>
                <div className="space-y-1 border-t pt-3 text-xs text-muted-foreground">
                  <div>Idle pause: {formatDuration(acsMeta?.lifecycle?.idlePauseMs)}</div>
                  <div>TTL: {formatDuration(acsMeta?.lifecycle?.ttlMs)}</div>
                  <div>Quota: warn {acsMeta?.lifecycle?.warnRunningSandboxes ?? "-"} / max {acsMeta?.lifecycle?.maxRunningSandboxes ?? "-"}</div>
                  <div>Alert webhook: {acsMeta?.lifecycle?.alertWebhookConfigured ? "已配置" : "未配置"}</div>
                </div>
                <div className="space-y-1 border-t pt-3 text-xs text-muted-foreground">
                  <div>Workspace: {acsMeta?.contextSemantics?.workspacePersistence ?? "-"}</div>
                  <div>Memory: {acsMeta?.contextSemantics?.memoryInjection ?? "-"} / hot reload {acsMeta?.contextSemantics?.memoryHotReload ? "yes" : "no"}</div>
                  <div>Folder auto context: {acsMeta?.contextSemantics?.folderAutoContext ? "yes" : "no"}</div>
                </div>
                <div className="space-y-2 border-t pt-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">SNAT</span>
                    <Badge variant={snat?.enabled ? "secondary" : "outline"}>{snat?.mode ?? "unknown"}</Badge>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div className="rounded-md border p-2">
                      <div className="text-muted-foreground">managed</div>
                      <div className="mt-1 font-medium tabular-nums">{snat?.managedCount ?? "-"}</div>
                    </div>
                    <div className="rounded-md border p-2">
                      <div className="text-muted-foreground">orphan</div>
                      <div className="mt-1 font-medium tabular-nums">{snat?.orphanCount ?? "-"}</div>
                    </div>
                    <div className="rounded-md border p-2">
                      <div className="text-muted-foreground">unexpected</div>
                      <div className="mt-1 font-medium tabular-nums">{snat?.unexpectedCount ?? "-"}</div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => { void cleanupOrphanSnat(); }} disabled={!!applyingAction || !snat?.enabled || !snat.configured}>
                      {applyingAction === "清理 orphan SNAT" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1.5 h-3.5 w-3.5" />}
                      清理 orphan SNAT
                    </Button>
                    <div className="text-xs text-muted-foreground">
                      {snat?.configured ? `${snat.snatIp ?? "-"} / max ${snat.maxManagedEntries}` : "未配置云侧参数"}
                    </div>
                  </div>
                  {snat?.error && <div className="text-xs leading-5 text-destructive">{snat.error}</div>}
                </div>
                <div className="space-y-2 border-t pt-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">Desired network</span>
                    <Badge variant="outline">{networkModeLabel(acsMeta?.networkPolicy?.desiredPolicy?.mode)}</Badge>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">Effective</span>
                    {enforcementBadge(acsMeta?.networkPolicy?.effectivePolicy?.enforcement)}
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div className="rounded-md border p-2">
                      <div className="text-muted-foreground">public</div>
                      <div className="mt-1 font-medium">{boolStatus(acsMeta?.networkPolicy?.effectivePolicy?.publicEgressReachable)}</div>
                    </div>
                    <div className="rounded-md border p-2">
                      <div className="text-muted-foreground">private blocked</div>
                      <div className="mt-1 font-medium">{boolStatus(acsMeta?.networkPolicy?.effectivePolicy?.privateEgressBlocked)}</div>
                    </div>
                    <div className="rounded-md border p-2">
                      <div className="text-muted-foreground">metadata blocked</div>
                      <div className="mt-1 font-medium">{boolStatus(acsMeta?.networkPolicy?.effectivePolicy?.metadataBlocked)}</div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => { void runNetworkPolicyProbe(); }} disabled={!!applyingAction}>
                      {applyingAction === "执行 network probe" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />}
                      Run probe
                    </Button>
                    <div className="text-xs text-muted-foreground">
                      {acsMeta?.networkPolicy?.effectivePolicy?.checkedAt
                        ? `checked ${formatDateTime(acsMeta.networkPolicy.effectivePolicy.checkedAt)}`
                        : "not probed"}
                    </div>
                  </div>
                  {acsMeta?.networkPolicy?.effectivePolicy?.note && (
                    <div className="text-xs leading-5 text-muted-foreground">{acsMeta.networkPolicy.effectivePolicy.note}</div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Clock3 className="h-4 w-4" />
                  活跃 Run
                </CardTitle>
              </CardHeader>
              <CardContent>
                {runtimeStore?.status !== "ok" ? (
                  <div className="rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">
                    {runtimeStore?.status === "error" ? runtimeStore.error : "Runtime EventStore 未启用 PG。"}
                  </div>
                ) : runtimeStore.activeRuns.length === 0 ? (
                  <div className="rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">当前没有 active run。</div>
                ) : (
                  <div className="space-y-4">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Status</TableHead>
                          <TableHead className="text-right">数量</TableHead>
                          <TableHead>最近更新</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {runtimeStore.activeRuns.map((row) => (
                          <TableRow key={row.status}>
                            <TableCell>{row.status}</TableCell>
                            <TableCell className="text-right tabular-nums">{row.count}</TableCell>
                            <TableCell>{formatDateTime(row.latest_at)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    {(runtimeStore.staleActiveRuns?.length ?? 0) > 0 && (
                      <div className="space-y-2">
                        <div className="text-xs font-medium text-amber-700">超过 15 分钟未更新</div>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Status</TableHead>
                              <TableHead>租户</TableHead>
                              <TableHead>会话</TableHead>
                              <TableHead>Run</TableHead>
                              <TableHead>更新</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {(runtimeStore.staleActiveRuns ?? []).slice(0, 6).map((row) => (
                              <TableRow key={row.run_id}>
                                <TableCell>{row.status}</TableCell>
                                <TableCell className="font-mono text-xs">{row.tenant_id}</TableCell>
                                <TableCell>
                                  <a className="font-mono text-xs text-primary hover:underline" href={`/chat/${encodeURIComponent(row.session_id)}`}>
                                    {row.session_id.slice(0, 8)}
                                  </a>
                                </TableCell>
                                <TableCell className="font-mono text-xs">{row.run_id.slice(0, 8)}</TableCell>
                                <TableCell>{formatDateTime(row.updated_at)}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">近 24 小时工具路由</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {runtimeStore?.status === "ok" ? (
                  <>
                    <div className="grid grid-cols-4 gap-2">
                      <div className="rounded-md border p-2">
                        <div className="text-xs text-muted-foreground">Total</div>
                        <div className="mt-1 font-semibold tabular-nums">{runtimeStore.toolInvocations.route24h.total}</div>
                      </div>
                      <div className="rounded-md border p-2">
                        <div className="text-xs text-muted-foreground">ACS</div>
                        <div className="mt-1 font-semibold tabular-nums">{runtimeStore.toolInvocations.route24h.acs_count}</div>
                      </div>
                      <div className="rounded-md border p-2">
                        <div className="text-xs text-muted-foreground">ECS</div>
                        <div className="mt-1 font-semibold tabular-nums">{runtimeStore.toolInvocations.route24h.ecs_count}</div>
                      </div>
                      <div className="rounded-md border p-2">
                        <div className="text-xs text-muted-foreground">Unrouted</div>
                        <div className="mt-1 font-semibold tabular-nums">{runtimeStore.toolInvocations.route24h.unrouted_count}</div>
                      </div>
                    </div>
                    <Table>
                      <TableHeader>
                      <TableRow>
                        <TableHead>时间</TableHead>
                        <TableHead>租户</TableHead>
                        <TableHead>会话</TableHead>
                        <TableHead>工具</TableHead>
                        <TableHead>路由</TableHead>
                        <TableHead>Status</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {runtimeStore.toolInvocations.recent.slice(0, 6).map((row) => (
                          <TableRow key={`${row.started_at}:${row.session_id}:${row.tool_name}`}>
                            <TableCell>{formatDateTime(row.started_at)}</TableCell>
                            <TableCell className="font-mono text-xs">{row.tenant_id}</TableCell>
                            <TableCell>
                              <a className="font-mono text-xs text-primary hover:underline" href={`/chat/${encodeURIComponent(row.session_id)}`}>
                                {row.session_id.slice(0, 8)}
                              </a>
                            </TableCell>
                            <TableCell>{row.tool_name}</TableCell>
                            <TableCell>{routedHandLabel(row.routed_hand)}</TableCell>
                            <TableCell>{row.status}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </>
                ) : (
                  <div className="rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">暂无 PG 路由数据。</div>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">最近执行环境故障</CardTitle>
            </CardHeader>
            <CardContent>
              {runtimeStore?.status !== "ok" ? (
                <div className="rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">暂无 PG failure 数据。</div>
              ) : runtimeStore.handFailures.recent.length === 0 ? (
                <div className="rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">没有最近失败记录。</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>时间</TableHead>
                      <TableHead>租户</TableHead>
                      <TableHead>会话</TableHead>
                      <TableHead>Run</TableHead>
                      <TableHead>池</TableHead>
                      <TableHead>原因</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {runtimeStore.handFailures.recent.map((row) => (
                      <TableRow key={`${row.timestamp}:${row.session_id}:${row.reason}`}>
                        <TableCell>{formatDateTime(row.timestamp)}</TableCell>
                        <TableCell className="font-mono text-xs">{row.tenant_id}</TableCell>
                        <TableCell>
                          <a className="font-mono text-xs text-primary hover:underline" href={`/chat/${encodeURIComponent(row.session_id)}`}>
                            {row.session_id.slice(0, 8)}
                          </a>
                        </TableCell>
                        <TableCell className="font-mono text-xs">{row.run_id ? row.run_id.slice(0, 8) : "-"}</TableCell>
                        <TableCell>{routedHandLabel(row.hand_id ?? undefined)}</TableCell>
                        <TableCell className="max-w-xl truncate">{row.reason ?? "-"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {data?.generatedAt && (
                <div className="mt-3 text-xs text-muted-foreground">
                  更新时间：{formatDateTime(data.generatedAt)}，processRole: {data.processRole ?? "-"}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
      </div>
    </div>
  );
}
