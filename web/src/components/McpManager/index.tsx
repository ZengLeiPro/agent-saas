import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ExternalLink, Loader2, Link2Off, Plus, RefreshCw, Save, Stethoscope, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/contexts/AuthContext";
import { useTenants } from "@/components/TenantManager/hooks";
import { ConnectorBrandLogo } from "./ConnectorBrandLogo";
import {
  bindMyMcpSecret,
  bindAdminMcpSecret,
  deleteMcpServer,
  deleteMyMcpServer,
  disconnectMyMcpOAuth,
  diagnoseMyMcp,
  fetchMcpAdminServers,
  fetchMcpTemplates,
  fetchMyMcp,
  updateMyMcpSelections,
  startMyMcpOAuth,
  upsertMcpServer,
  upsertMyMcpServer,
  GLOBAL_TENANT_ID,
} from "@agent/shared";
import type { ManagedMcpServer, McpAdminServersResponse, McpDiagnosticResponse, McpSecretScope, McpSecretStatus, McpServerSummary, McpTemplatesResponse, MyMcpResponse } from "@agent/shared";
import {
  CatalogHeader,
  CapabilityDetailDrawer,
  CapabilitySourceBadge,
  CatalogToolbar,
  type CapabilitySource,
} from "@/components/CapabilityCenter/CatalogUi";

const SCOPE_BADGE: Record<McpSecretScope, { label: string; className: string }> = {
  user: { label: "用户私有", className: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100" },
  tenant: { label: "组织共享", className: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100" },
  global: { label: "全局", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100" },
};

const EMPTY_SERVER: ManagedMcpServer = {
  id: "",
  name: "",
  description: "",
  enabledByDefault: true,
  config: { type: "http", url: "https://example.com/mcp" },
  // tenantId 不预填，让后端按 caller 身份默认（组织 admin 强制 own）。
  // 平台 admin 想要全局 / 跨组织 server 可通过下方 selector 显式选择。
};

type ConnectorFilter = "all" | "enabled" | "platform" | "organization" | "personal";

function connectorSource(server: McpServerSummary): CapabilitySource {
  if (server.personal) return "personal";
  if (server.tenantId === GLOBAL_TENANT_ID) return "platform";
  return "organization";
}

function connectorStatus(server: McpServerSummary): { label: string; className: string } {
  if (server.oauth && server.oauth.status !== "connected") {
    return server.oauth.status === "error"
      ? { label: "授权失败", className: "text-destructive" }
      : { label: "未连接", className: "text-muted-foreground" };
  }
  if ((server.secretRequirements ?? []).some((requirement) => requirement.required !== false && !requirement.configured)) {
    return { label: "待配置", className: "text-amber-700 dark:text-amber-300" };
  }
  return server.enabled
    ? { label: "已启用", className: "text-success" }
    : { label: "可启用", className: "text-muted-foreground" };
}

export function McpManager({ embedded = false }: { embedded?: boolean }) {
  return <McpManagerInner mode="personal" embedded={embedded} />;
}

export function McpAdminCatalog() {
  return <McpManagerInner mode="admin" embedded={false} />;
}

function McpManagerInner({ mode, embedded }: { mode: "personal" | "admin"; embedded: boolean }) {
  const { isAdmin, isPlatformAdmin, user } = useAuth();
  // tenants 列表仅平台 admin 可见（路由用 requirePlatformAdmin，hook 内部
  // 对非平台 admin 自动跳过请求）。组织 admin 不显示 selector，后端兜底 own。
  const { tenants } = useTenants();
  const [myData, setMyData] = useState<MyMcpResponse | null>(null);
  const [adminData, setAdminData] = useState<McpAdminServersResponse | null>(null);
  const [templates, setTemplates] = useState<McpTemplatesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [diagnostic, setDiagnostic] = useState<McpDiagnosticResponse | null>(null);
  const [form, setForm] = useState<ManagedMcpServer>(EMPTY_SERVER);
  const [configText, setConfigText] = useState(JSON.stringify(EMPTY_SERVER.config, null, 2));
  const [personalForm, setPersonalForm] = useState<ManagedMcpServer>({
    ...EMPTY_SERVER,
    id: "",
    name: "",
    enabledByDefault: false,
    config: { type: "streamable-http", url: "https://example.com/mcp" },
    secretRequirements: [],
  });
  const [personalConfigText, setPersonalConfigText] = useState(JSON.stringify({ type: "streamable-http", url: "https://example.com/mcp" }, null, 2));
  const [personalSecretsText, setPersonalSecretsText] = useState("[]");
  const [secretInputs, setSecretInputs] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<ConnectorFilter>("all");
  const [detailServerId, setDetailServerId] = useState<string | null>(null);
  const [customDialogOpen, setCustomDialogOpen] = useState(false);
  const [pendingServerId, setPendingServerId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const mine = await fetchMyMcp();
      setMyData(mine);
      setEnabled(Object.fromEntries(mine.servers.map(s => [s.id, s.enabled])));
      if (mode === "admin" && isAdmin) {
        const [adminServers, templateData] = await Promise.all([fetchMcpAdminServers(), fetchMcpTemplates()]);
        setAdminData(adminServers);
        setTemplates(templateData);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [isAdmin, mode]);

  useEffect(() => { void refresh(); }, [refresh]);

  const dirty = useMemo(() => {
    if (!myData) return false;
    return myData.servers.some((server) => enabled[server.id] !== server.enabled);
  }, [myData, enabled]);

  const saveSelections = useCallback(async (nextEnabled: Record<string, boolean>) => {
    const previous = enabled;
    setEnabled(nextEnabled);
    setSaving(true);
    try {
      await updateMyMcpSelections(Object.entries(nextEnabled).filter(([, value]) => value).map(([id]) => id));
      setMyData((current) => current ? {
        ...current,
        servers: current.servers.map((server) => ({ ...server, enabled: nextEnabled[server.id] === true })),
      } : current);
    } catch (err) {
      setEnabled(previous);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [enabled]);

  const diagnose = useCallback(async () => {
    setDiagnostic(null);
    setSaving(true);
    try {
      setDiagnostic(await diagnoseMyMcp());
    } catch (err) {
      setDiagnostic({ ok: false, error: err instanceof Error ? err.message : String(err), toolCount: 0, tools: [] });
    } finally {
      setSaving(false);
    }
  }, []);

  const editServer = useCallback((server: ManagedMcpServer) => {
    setForm(server);
    setConfigText(JSON.stringify(server.config, null, 2));
  }, []);

  const saveServer = useCallback(async () => {
    setSaving(true);
    try {
      const config = JSON.parse(configText) as Record<string, unknown>;
      // tenantId 仅在显式有值（平台 admin 选了某个 tenant 或 '*'）时上送；
      // 否则省略，让后端按 caller 身份默认。组织 admin 入参也会被后端强制 own。
      const payload: ManagedMcpServer = { ...form, config };
      if (!payload.tenantId) delete payload.tenantId;
      await upsertMcpServer(payload);
      setForm(EMPTY_SERVER);
      setConfigText(JSON.stringify(EMPTY_SERVER.config, null, 2));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [configText, form, refresh]);

  const editPersonalServer = useCallback((server: ManagedMcpServer) => {
    setPersonalForm({ ...server, enabledByDefault: false });
    setPersonalConfigText(JSON.stringify(server.config, null, 2));
    setPersonalSecretsText(JSON.stringify((server.secretRequirements ?? []).map(req => ({ ...req, scope: "user" })), null, 2));
    setCustomDialogOpen(true);
  }, []);

  const savePersonalServer = useCallback(async () => {
    setSaving(true);
    try {
      const config = JSON.parse(personalConfigText) as Record<string, unknown>;
      const secretRequirements = JSON.parse(personalSecretsText || "[]") as ManagedMcpServer["secretRequirements"];
      await upsertMyMcpServer({
        ...personalForm,
        config,
        enabledByDefault: false,
        secretRequirements: (secretRequirements ?? []).map(req => ({ ...req, scope: "user" as const })),
      });
      const reset = {
        ...EMPTY_SERVER,
        id: "",
        name: "",
        enabledByDefault: false,
        config: { type: "streamable-http", url: "https://example.com/mcp" },
        secretRequirements: [],
      };
      setPersonalForm(reset);
      setPersonalConfigText(JSON.stringify(reset.config, null, 2));
      setPersonalSecretsText("[]");
      setCustomDialogOpen(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [personalConfigText, personalForm, personalSecretsText, refresh]);


  /**
   * 按 requirement.scope 路由到不同 endpoint：
   *   - user   → /me/.../secrets/:key（任意登录用户都可绑自己的）
   *   - tenant → /admin/.../secrets/:key（同组织 admin / 平台 admin 可绑）
   *   - global → /admin/.../secrets/:key（仅平台 admin 可绑，且 server.tenantId === '*'）
   * scope 不由前端传，由后端 server.secretRequirements 元数据决定，前端只挑 endpoint。
   */
  const bindSecret = useCallback(async (serverId: string, key: string, scope: McpSecretScope) => {
    const inputKey = `${serverId}:${key}`;
    const value = secretInputs[inputKey]?.trim();
    if (!value) return;
    setSaving(true);
    try {
      if (scope === 'user') {
        await bindMyMcpSecret(serverId, key, value);
      } else {
        await bindAdminMcpSecret(serverId, key, value);
      }
      setSecretInputs(prev => ({ ...prev, [inputKey]: "" }));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [refresh, secretInputs]);

  /**
   * 角色 → 可绑 scope 的判定：
   *   - user：所有登录用户
   *   - tenant：admin（包括组织 admin，前提是 server 属本组织；跨组织的 server 普通用户/组织 admin 看不到）
   *   - global：仅平台 admin
   */
  const canBindSecret = useCallback((req: McpSecretStatus): boolean => {
    if (req.scope === 'user') return true;
    if (req.scope === 'tenant') return isAdmin;
    return isPlatformAdmin; // global
  }, [isAdmin, isPlatformAdmin]);

  const noBindReason = useCallback((req: McpSecretStatus): string => {
    if (req.scope === 'tenant') return '组织共享 secret 需管理员配置';
    if (req.scope === 'global') return '全局 secret 需平台管理员配置';
    return '';
  }, []);

  const applyTemplate = useCallback((server: ManagedMcpServer) => {
    setForm(server);
    setConfigText(JSON.stringify(server.config, null, 2));
  }, []);

  const connectOAuth = useCallback(async (serverId: string) => {
    setSaving(true);
    try {
      const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      const result = await startMyMcpOAuth(serverId, returnTo);
      if (result.authorizationUrl) {
        window.location.assign(result.authorizationUrl);
        return;
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [refresh]);

  const disconnectOAuth = useCallback(async (serverId: string) => {
    if (!confirm('断开后，本平台将停止使用这份授权；如需同时撤销第三方平台的授权，请在对应账号设置中操作。确定断开？')) return;
    setSaving(true);
    try {
      await disconnectMyMcpOAuth(serverId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [refresh]);

  const removeServer = useCallback(async (id: string) => {
    if (!confirm(`删除 MCP Server ${id}？`)) return;
    setSaving(true);
    try {
      await deleteMcpServer(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [refresh]);

  const removePersonalServer = useCallback(async (id: string) => {
    if (!confirm(`删除个人 MCP Server ${id}？`)) return;
    setSaving(true);
    try {
      await deleteMyMcpServer(id);
      setDetailServerId(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [refresh]);

  const connectorServers = myData?.servers ?? [];
  const enabledCount = connectorServers.filter((server) => server.enabled).length;
  const filteredServers = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return connectorServers.filter((server) => {
      const source = connectorSource(server);
      const matchesFilter = activeFilter === "all"
        || (activeFilter === "enabled" ? server.enabled : source === activeFilter);
      const matchesQuery = !normalizedQuery
        || server.name.toLocaleLowerCase().includes(normalizedQuery)
        || (server.description ?? "").toLocaleLowerCase().includes(normalizedQuery);
      return matchesFilter && matchesQuery;
    });
  }, [activeFilter, connectorServers, query]);
  const connectorFilters = useMemo(() => [
    { value: "all" as const, label: "全部", count: connectorServers.length },
    { value: "enabled" as const, label: "已启用", count: enabledCount },
    { value: "platform" as const, label: "平台提供", count: connectorServers.filter((server) => connectorSource(server) === "platform").length },
    { value: "organization" as const, label: "组织提供", count: connectorServers.filter((server) => connectorSource(server) === "organization").length },
    { value: "personal" as const, label: "我创建的", count: connectorServers.filter((server) => connectorSource(server) === "personal").length },
  ], [connectorServers, enabledCount]);
  const detailServer = detailServerId ? connectorServers.find((server) => server.id === detailServerId) ?? null : null;

  const toggleServer = useCallback(async (server: McpServerSummary, nextValue: boolean) => {
    if (saving) return;
    setPendingServerId(server.id);
    try {
      await saveSelections({ ...enabled, [server.id]: nextValue });
    } finally {
      setPendingServerId(null);
    }
  }, [enabled, saveSelections, saving]);

  const openCreatePersonalServer = useCallback(() => {
    const reset: ManagedMcpServer = {
      ...EMPTY_SERVER,
      id: "",
      name: "",
      enabledByDefault: false,
      config: { type: "streamable-http", url: "https://example.com/mcp" },
      secretRequirements: [],
    };
    setPersonalForm(reset);
    setPersonalConfigText(JSON.stringify(reset.config, null, 2));
    setPersonalSecretsText("[]");
    setCustomDialogOpen(true);
  }, []);

  if (loading) {
    return <div className="flex flex-1 items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>;
  }

  if (mode === "personal") {
    return (
      <div className={cn("flex min-h-0 w-full flex-col", !embedded && "mx-auto h-full max-w-6xl")}>
        <CatalogHeader
          title="连接器"
          description="连接常用账号，让 Agent 在你的权限范围内使用数据和工具。"
          actions={
            <Button variant="outline" onClick={openCreatePersonalServer}>
              <Plus className="size-4" />自定义连接器
            </Button>
          }
        />

        <CatalogToolbar
          query={query}
          onQueryChange={setQuery}
          searchPlaceholder="搜索连接器名称或描述"
          filters={connectorFilters}
          activeFilter={activeFilter}
          onFilterChange={setActiveFilter}
        />

        <div className={cn("min-h-0 flex-1 pb-2", !embedded && "overflow-auto")}>
          {error ? <div className="mb-4 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}
          {filteredServers.length === 0 ? (
            <div className="rounded-2xl border border-dashed px-6 py-12 text-center text-sm text-muted-foreground">
              {connectorServers.length === 0 ? "暂无可用连接器" : "没有找到匹配的连接器"}
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {filteredServers.map((server) => {
                const source = connectorSource(server);
                const status = connectorStatus(server);
                const oauthReady = !server.oauth || server.oauth.status === "connected";
                const missingSecrets = (server.secretRequirements ?? []).some((requirement) => requirement.required !== false && !requirement.configured);
                const selected = enabled[server.id] === true;
                return (
                  <Card
                    key={server.id}
                    className="group cursor-pointer border-border/70 transition-all hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-md"
                    onClick={() => setDetailServerId(server.id)}
                    onKeyDown={(event) => {
                      if ((event.target as HTMLElement).closest("button")) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setDetailServerId(server.id);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    <CardContent className="flex min-h-36 items-start gap-4 p-5">
                      <ConnectorBrandLogo server={server} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate font-semibold">{server.name}</div>
                            <div className="mt-1 flex flex-wrap items-center gap-2">
                              <CapabilitySourceBadge source={source} />
                              <span className={`text-xs font-medium ${status.className}`}>{status.label}</span>
                            </div>
                          </div>
                          <button
                            type="button"
                            className={cn(
                              "flex size-8 shrink-0 items-center justify-center rounded-lg border transition-colors",
                              selected
                                ? "border-transparent bg-success text-success-foreground shadow-sm hover:bg-success/85"
                                : "bg-muted/40 text-muted-foreground hover:border-success/40 hover:bg-success/10 hover:text-success",
                            )}
                            disabled={saving || (!!server.oauth && !server.oauth.platformConfigured)}
                            aria-label={oauthReady && !missingSecrets ? `${selected ? "停用" : "启用"} ${server.name}` : `配置 ${server.name}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              if (!oauthReady) {
                                setPendingServerId(server.id);
                                void connectOAuth(server.id).finally(() => setPendingServerId(null));
                              } else if (missingSecrets) {
                                setDetailServerId(server.id);
                              } else {
                                void toggleServer(server, !selected);
                              }
                            }}
                          >
                            {pendingServerId === server.id ? <Loader2 className="size-4 animate-spin" /> : selected ? <Check className="size-4" strokeWidth={2.5} /> : <Plus className="size-4" />}
                          </button>
                        </div>
                        <p className="mt-3 line-clamp-2 text-sm leading-5 text-muted-foreground">{server.description || "暂无连接器说明"}</p>
                        <div className="mt-3 text-xs text-muted-foreground">点击查看权限与账号配置</div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>

        <CapabilityDetailDrawer
          open={!!detailServer}
          onOpenChange={(open) => { if (!open) setDetailServerId(null); }}
          title={detailServer?.name ?? "连接器详情"}
          description={detailServer?.description}
        >
          {detailServer ? (
            <>
              <div className="flex items-center gap-3">
                <ConnectorBrandLogo server={detailServer} />
                <div>
                  <CapabilitySourceBadge source={connectorSource(detailServer)} />
                  <div className={`mt-1 text-xs font-medium ${connectorStatus(detailServer).className}`}>{connectorStatus(detailServer).label}</div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-muted/40 p-3">
                  <div className="text-xs text-muted-foreground">连接方式</div>
                  <div className="mt-1 text-sm font-medium">{detailServer.transport === "stdio" ? "本地服务" : "远程服务"}</div>
                </div>
                <div className="rounded-xl bg-muted/40 p-3">
                  <div className="text-xs text-muted-foreground">权限级别</div>
                  <div className="mt-1 text-sm font-medium">
                    {detailServer.riskLevel === "read_only" ? "只读" : detailServer.riskLevel ? "可执行操作" : "按连接器配置"}
                  </div>
                </div>
              </div>

              {detailServer.oauth ? (
                <div className="rounded-xl border p-4">
                  <div className="text-sm font-medium">账号授权</div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">授权只属于当前账号，组织内其他成员无法使用你的凭据。</p>
                  <div className="mt-3">
                    {detailServer.oauth.status === "connected" ? (
                      <Button variant="outline" size="sm" onClick={() => { void disconnectOAuth(detailServer.id); }} disabled={saving}>
                        <Link2Off className="size-3.5" />断开账号
                      </Button>
                    ) : (
                      <Button size="sm" onClick={() => { void connectOAuth(detailServer.id); }} disabled={saving || !detailServer.oauth.platformConfigured}>
                        <ExternalLink className="size-3.5" />连接账号
                      </Button>
                    )}
                  </div>
                  {!detailServer.oauth.platformConfigured ? <div className="mt-2 text-xs text-amber-700 dark:text-amber-300">平台管理员尚未完成授权配置</div> : null}
                  {detailServer.oauth.status === "error" && detailServer.oauth.lastError ? <div className="mt-2 text-xs text-destructive">{detailServer.oauth.lastError}</div> : null}
                </div>
              ) : null}

              {(detailServer.secretRequirements ?? []).map((requirement) => {
                const inputKey = `${detailServer.id}:${requirement.key}`;
                const canBind = canBindSecret(requirement);
                const badge = SCOPE_BADGE[requirement.scope];
                const disabledReason = canBind ? "" : noBindReason(requirement);
                return (
                  <div key={requirement.key} className="rounded-xl border p-4">
                    <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      <span>{requirement.label}</span>
                      {requirement.required === false ? <span className="text-xs font-normal text-muted-foreground">可选</span> : null}
                      <span className={`rounded px-1.5 py-0.5 text-[10px] ${badge.className}`}>{badge.label}</span>
                      <span className={requirement.configured ? "text-success" : "text-destructive"}>{requirement.configured ? "已绑定" : "未绑定"}</span>
                    </div>
                    {requirement.instructions ? <div className="mt-1 text-xs leading-5 text-muted-foreground">{requirement.instructions}</div> : null}
                    <div className="mt-3 flex gap-2">
                      <Input
                        type="password"
                        autoComplete="new-password"
                        passwordManager="ignore"
                        placeholder={canBind ? `输入 ${requirement.label}` : disabledReason}
                        value={secretInputs[inputKey] || ""}
                        onChange={(event) => setSecretInputs((previous) => ({ ...previous, [inputKey]: event.target.value }))}
                        disabled={!canBind}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => { void bindSecret(detailServer.id, requirement.key, requirement.scope); }}
                        disabled={!canBind || saving || !secretInputs[inputKey]?.trim()}
                      >
                        绑定
                      </Button>
                    </div>
                  </div>
                );
              })}

              {(!detailServer.oauth || detailServer.oauth.status === "connected")
                && !(detailServer.secretRequirements ?? []).some((requirement) => requirement.required !== false && !requirement.configured) ? (
                  <Button
                    className="w-full"
                    variant={enabled[detailServer.id] ? "outline" : "default"}
                    disabled={saving}
                    onClick={() => { void toggleServer(detailServer, !enabled[detailServer.id]); }}
                  >
                    {pendingServerId === detailServer.id ? <Loader2 className="size-4 animate-spin" /> : enabled[detailServer.id] ? <Check className="size-4" /> : <Plus className="size-4" />}
                    {enabled[detailServer.id] ? "停用连接器" : "启用连接器"}
                  </Button>
                ) : null}

              {detailServer.personal ? (
                <div className="grid grid-cols-2 gap-2 border-t pt-5">
                  <Button variant="outline" onClick={() => editPersonalServer(detailServer as ManagedMcpServer)}>编辑配置</Button>
                  <Button variant="ghost" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => { void removePersonalServer(detailServer.id); }}>
                    <Trash2 className="size-4" />删除
                  </Button>
                </div>
              ) : null}
            </>
          ) : null}
        </CapabilityDetailDrawer>

        <Dialog open={customDialogOpen} onOpenChange={setCustomDialogOpen}>
          <DialogContent className="max-h-[min(760px,calc(100vh-48px))] max-w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>{personalForm.id ? "编辑自定义连接器" : "添加自定义连接器"}</DialogTitle>
              <DialogDescription>仅你本人可见；当前支持 remote MCP 地址，账号密钥始终按用户隔离。</DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 md:grid-cols-2">
              <Input placeholder="连接器 ID，如 my_notion" value={personalForm.id} onChange={(event) => setPersonalForm((previous) => ({ ...previous, id: event.target.value }))} />
              <Input placeholder="显示名称" value={personalForm.name} onChange={(event) => setPersonalForm((previous) => ({ ...previous, name: event.target.value }))} />
              <Input className="md:col-span-2" placeholder="描述" value={personalForm.description || ""} onChange={(event) => setPersonalForm((previous) => ({ ...previous, description: event.target.value }))} />
              <Input placeholder="风险等级" value={personalForm.riskLevel || "credentialed_external_write"} onChange={(event) => setPersonalForm((previous) => ({ ...previous, riskLevel: event.target.value as ManagedMcpServer["riskLevel"] }))} />
            </div>
            <div className="space-y-1.5">
              <div className="text-sm font-medium">连接配置</div>
              <Textarea className="min-h-32 font-mono text-xs" value={personalConfigText} onChange={(event) => setPersonalConfigText(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <div className="text-sm font-medium">密钥要求</div>
              <Textarea className="min-h-24 font-mono text-xs" value={personalSecretsText} onChange={(event) => setPersonalSecretsText(event.target.value)} placeholder='[{"key":"token","label":"Token","target":"header","name":"Authorization","scope":"user","prefix":"Bearer "}]' />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCustomDialogOpen(false)}>取消</Button>
              <Button onClick={() => { void savePersonalServer(); }} disabled={saving || !personalForm.id.trim() || !personalForm.name.trim()}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}保存连接器
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <SettingsPanelHeader
        title={mode === "admin" ? "连接器管理" : "连接器"}
        description={mode === "admin" ? "维护组织或全局 MCP Server Catalog。" : "连接自己的常用账号，让 Agent 在你的权限范围内使用数据和工具。"}
        actions={
          <>
            {dirty && (
              <Button size="sm" onClick={() => void saveSelections(enabled)} disabled={saving}>
                <Save className="size-3.5" />
                保存启用状态
              </Button>
            )}
            {mode === "admin" && isAdmin && (
              <Button size="sm" onClick={() => void saveServer()} disabled={saving || !form.id.trim() || !form.name.trim()}>
                <Save className="size-3.5" />
                保存 Server
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => void diagnose()} disabled={saving}>
              <Stethoscope className="size-3.5" />诊断
            </Button>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              <RefreshCw className="size-3.5" />刷新
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 space-y-6 overflow-auto">
      {error && <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">我的连接器</CardTitle></CardHeader>
        <CardContent className="space-y-2 pt-0">
          {(myData?.servers.length ?? 0) === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">暂无可用连接器。</div>
          ) : myData!.servers.map(server => (
            <div key={server.id} className="flex items-start gap-3 rounded-lg border p-3">
              <Switch
                checked={!!enabled[server.id]}
                onCheckedChange={(v) => setEnabled(prev => ({ ...prev, [server.id]: v }))}
                disabled={!!server.oauth && server.oauth.status !== 'connected'}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <span>{server.name}</span>
                  {server.oauth?.beta && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800 dark:bg-amber-900 dark:text-amber-100">Beta</span>}
                  {server.oauth && (
                    <span className={`rounded px-1.5 py-0.5 text-[10px] ${server.oauth.status === 'connected' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100' : 'bg-muted text-muted-foreground'}`}>
                      {server.oauth.status === 'connected' ? '已连接' : server.oauth.status === 'pending' ? '等待授权' : server.oauth.status === 'error' ? '授权失败' : '未连接'}
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">{server.personal ? "个人连接器" : "由平台提供"}{server.enabledByDefault ? " · 默认启用" : ""}</div>
                {server.description && <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{server.description}</p>}
                {server.oauth && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {server.oauth.status === 'connected' ? (
                      <Button size="sm" variant="outline" onClick={() => void disconnectOAuth(server.id)} disabled={saving}>
                        <Link2Off className="size-3.5" />断开
                      </Button>
                    ) : (
                      <Button size="sm" onClick={() => void connectOAuth(server.id)} disabled={saving || !server.oauth.platformConfigured}>
                        <ExternalLink className="size-3.5" />连接账号
                      </Button>
                    )}
                    {!server.oauth.platformConfigured && <span className="text-xs text-amber-700 dark:text-amber-300">平台管理员尚未完成 OAuth 应用配置</span>}
                    {server.oauth.status === 'error' && server.oauth.lastError && <span className="text-xs text-destructive">{server.oauth.lastError}</span>}
                  </div>
                )}
                {(server.secretRequirements ?? []).length > 0 && (
                  <div className="mt-3 space-y-2">
                    {server.secretRequirements!.map(req => {
                      const inputKey = `${server.id}:${req.key}`;
                      const canBind = canBindSecret(req);
                      const badge = SCOPE_BADGE[req.scope];
                      const disabledReason = canBind ? '' : noBindReason(req);
                      return (
                        <div key={req.key} className="rounded-md border bg-muted/30 p-2">
                          <div className="mb-1 flex items-center gap-2 text-xs font-medium">
                            <span>{req.label}</span>
                            <span className={`rounded px-1.5 py-0.5 text-[10px] ${badge.className}`}>{badge.label}</span>
                            <span className={req.configured ? "text-green-600" : "text-destructive"}>{req.configured ? "已绑定" : "未绑定"}</span>
                          </div>
                          {req.instructions && <div className="mb-2 text-xs text-muted-foreground">{req.instructions}</div>}
                          <div className="flex gap-2">
                            <Input
                              type="password"
                              autoComplete="new-password"
                              passwordManager="ignore"
                              placeholder={canBind ? `输入 ${req.label}` : disabledReason}
                              value={secretInputs[inputKey] || ""}
                              onChange={e => setSecretInputs(prev => ({ ...prev, [inputKey]: e.target.value }))}
                              disabled={!canBind}
                            />
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void bindSecret(server.id, req.key, req.scope)}
                              disabled={!canBind || saving || !secretInputs[inputKey]?.trim()}
                              title={disabledReason || undefined}
                            >
                              绑定
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              {server.personal && (
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm" onClick={() => editPersonalServer(server as ManagedMcpServer)}>编辑</Button>
                  <Button variant="ghost" size="icon" onClick={() => void removePersonalServer(server.id)}><Trash2 className="size-4" /></Button>
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {diagnostic && (
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-base">诊断结果</CardTitle></CardHeader>
          <CardContent className="space-y-2 pt-0 text-sm">
            <div className={diagnostic.ok ? "text-green-600" : "text-destructive"}>{diagnostic.ok ? `连接成功，发现 ${diagnostic.toolCount} 个工具` : `连接失败：${diagnostic.error || "未知错误"}`}</div>
            {diagnostic.tools.slice(0, 20).map(t => <div key={`${t.serverName}/${t.toolName}`} className="rounded bg-muted px-2 py-1 text-xs">{t.serverName}/{t.toolName} — {t.description || "无描述"}</div>)}
          </CardContent>
        </Card>
      )}

      {mode === "admin" && isAdmin && (
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-base">管理员：MCP Server Catalog</CardTitle></CardHeader>
          <CardContent className="space-y-4 pt-0">
            {(templates?.templates.length ?? 0) > 0 && (
              <div className="rounded-lg border bg-muted/30 p-3">
                <div className="mb-2 text-sm font-medium">从安全模板创建</div>
                <div className="grid gap-2 md:grid-cols-3">
                  {templates!.templates.filter(t => isPlatformAdmin || !(t.server.config as { oauth?: unknown }).oauth).map(t => (
                    <button key={t.id} className="rounded border bg-background p-2 text-left text-xs hover:bg-accent" onClick={() => applyTemplate(t.server)}>
                      <div className="font-medium">{t.name}</div>
                      <div className="mt-1 text-muted-foreground">{t.riskLevel}{t.recommendedDefault ? " · 推荐默认启用" : " · 默认关闭"}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="grid gap-3 md:grid-cols-2">
              <Input placeholder="server id，如 github" value={form.id} onChange={e => setForm(prev => ({ ...prev, id: e.target.value }))} />
              <Input placeholder="显示名称" value={form.name} onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))} />
              <Input className="md:col-span-2" placeholder="描述" value={form.description || ""} onChange={e => setForm(prev => ({ ...prev, description: e.target.value }))} />
              <Input placeholder="风险等级" value={form.riskLevel || "workspace_write"} onChange={e => setForm(prev => ({ ...prev, riskLevel: e.target.value as ManagedMcpServer["riskLevel"] }))} />
              <label className="flex items-center gap-2 text-sm"><Switch checked={form.enabledByDefault === true} onCheckedChange={v => setForm(prev => ({ ...prev, enabledByDefault: v }))} />默认对用户启用</label>
              {isPlatformAdmin && (
                <label className="flex flex-col gap-1 text-xs md:col-span-2">
                  <span className="font-medium">组织归属（仅平台 admin 可改）</span>
                  <select
                    className="rounded border bg-background px-2 py-1.5 text-sm"
                    value={form.tenantId ?? ""}
                    onChange={e => setForm(prev => ({ ...prev, tenantId: e.target.value || undefined }))}
                  >
                    <option value="">默认（本组织 {user?.tenantId ?? ""}）</option>
                    <option value={GLOBAL_TENANT_ID}>全局 server (* — 所有组织用户可见)</option>
                    {tenants.filter(t => t.id !== user?.tenantId).map(t => (
                      <option key={t.id} value={t.id}>跨组织：{t.name}（{t.id}）{t.disabled ? " · disabled" : ""}</option>
                    ))}
                  </select>
                  <span className="text-muted-foreground">
                    组织 admin 配的 server 强制绑到本组织；平台 admin 可配「全局」让所有组织用户可用，或代某组织配 server。
                  </span>
                </label>
              )}
            </div>
            <Textarea className="min-h-40 font-mono text-xs" value={configText} onChange={e => setConfigText(e.target.value)} />
            <Textarea className="min-h-24 font-mono text-xs" value={JSON.stringify(form.secretRequirements ?? [], null, 2)} onChange={e => { try { setForm(prev => ({ ...prev, secretRequirements: JSON.parse(e.target.value) })); } catch { /* keep typing */ } }} placeholder="secretRequirements JSON" />

            <div className="space-y-2">
              {(adminData?.servers ?? []).map(server => {
                const tenantBadge = server.tenantId === GLOBAL_TENANT_ID
                  ? { label: "全局", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100" }
                  : server.tenantId === user?.tenantId
                    ? { label: `本组织 ${server.tenantId}`, className: "bg-muted text-muted-foreground" }
                    : { label: `跨组织 ${server.tenantId ?? "?"}`, className: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100" };
                return (
                  <div key={server.id} className="flex items-center gap-2 rounded border p-2 text-sm">
                    <button className="min-w-0 flex-1 text-left" onClick={() => editServer(server)}>
                      <div className="flex items-center gap-2 font-medium">
                        <span>{server.name}</span>
                        <span className="text-xs text-muted-foreground">({server.id})</span>
                        <span className={`rounded px-1.5 py-0.5 text-xs ${tenantBadge.className}`}>{tenantBadge.label}</span>
                      </div>
                      <div className="truncate text-xs text-muted-foreground">{server.description || JSON.stringify(server.config)}</div>
                    </button>
                    <Button variant="ghost" size="icon" onClick={() => void removeServer(server.id)}><Trash2 className="size-4" /></Button>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
      </div>
    </div>
  );
}
