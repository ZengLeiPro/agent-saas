import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, ExternalLink, Loader2, Link2Off, Plus, RefreshCw, Save, Stethoscope, Trash2, TriangleAlert } from "lucide-react";
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
  getPlatform,
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
import {
  DingtalkConnectorCard,
  DingtalkConnectorDrawer,
  dingtalkMatchesCatalog,
  useDwsConnections,
} from "@/components/CapabilityCenter/DingtalkConnector";

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

/** 把说明文字里的 URL 渲染成可点击链接（新窗口打开），其余保持纯文本。 */
function renderInstructions(text: string): ReactNode[] {
  return text.split(/(https?:\/\/[^\s，。；）」]+)/g).map((part, index) =>
    /^https?:\/\//.test(part)
      ? <a key={index} href={part} target="_blank" rel="noopener noreferrer" className="text-brand-600 underline underline-offset-2 hover:text-brand-700">{part}</a>
      : part,
  );
}

function connectorSource(server: McpServerSummary): CapabilitySource {
  if (server.personal) return "personal";
  if (server.tenantId === GLOBAL_TENANT_ID) return "platform";
  return "organization";
}

function connectorStatus(server: McpServerSummary, checking = false): { label: string; className: string } {
  if (server.oauth && server.oauth.status !== "connected") {
    return server.oauth.status === "error"
      ? { label: "授权失败", className: "text-destructive" }
      : { label: "未连接", className: "text-muted-foreground" };
  }
  if ((server.secretRequirements ?? []).some((requirement) => requirement.required !== false && !requirement.configured)) {
    return { label: "待配置", className: "text-amber-700 dark:text-amber-300" };
  }
  if (!server.enabled) return { label: "可启用", className: "text-muted-foreground" };
  if (checking) return { label: "检测中", className: "text-brand-600" };
  if (server.connection?.status === "connected") {
    return {
      label: server.connection.toolCount > 0 ? `可用 · ${server.connection.toolCount} 个工具` : "可用",
      className: "text-success",
    };
  }
  if (server.connection?.status === "error") return { label: "连接异常", className: "text-destructive" };
  return { label: "待检测", className: "text-amber-700 dark:text-amber-300" };
}

export function McpManager({ embedded = false }: { embedded?: boolean }) {
  return <McpManagerInner mode="personal" embedded={embedded} />;
}

export function McpAdminCatalog() {
  return <McpManagerInner mode="admin" embedded={false} />;
}

function McpManagerInner({ mode, embedded }: { mode: "personal" | "admin"; embedded: boolean }) {
  // platformReadOnly：只读平台 admin，admin 态（全局 MCP 管理）写入口 disabled；个人态连接器不受影响
  const { isAdmin, isPlatformAdmin, user, platformReadOnly } = useAuth();
  // tenants 列表仅平台 admin 可见（路由用 requirePlatformAdmin，hook 内部
  // 对非平台 admin 自动跳过请求）。组织 admin 不显示 selector，后端兜底 own。
  const { tenants } = useTenants();
  const [myData, setMyData] = useState<MyMcpResponse | null>(null);
  const [adminData, setAdminData] = useState<McpAdminServersResponse | null>(null);
  const [templates, setTemplates] = useState<McpTemplatesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
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
  // 钉钉是平台内置连接（DWS device flow），与 MCP 连接器同 grid 展示但数据流独立。
  const dws = useDwsConnections(mode === "personal");
  const [dingtalkDetailOpen, setDingtalkDetailOpen] = useState(false);

  const diagnose = useCallback(async (force = false) => {
    setDiagnosing(true);
    try {
      const result = await diagnoseMyMcp(force);
      setDiagnostic(result);
      const connectionByServer = new Map(result.connections.map(connection => [connection.serverName, connection]));
      setMyData(current => current ? {
        ...current,
        servers: current.servers.map(server => ({ ...server, connection: connectionByServer.get(server.id) })),
      } : current);
      return result;
    } catch (err) {
      const result: McpDiagnosticResponse = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        toolCount: 0,
        tools: [],
        connections: [],
      };
      setDiagnostic(result);
      return result;
    } finally {
      setDiagnosing(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // admin 态（全局 MCP 管理）只管 Catalog，不拉个人域数据——
      // 个人账号连接/启用统一走能力中心 → 连接器，避免在平台管理页混入个人绑定。
      if (mode === "personal") {
        const mine = await fetchMyMcp();
        setMyData(mine);
        setEnabled(Object.fromEntries(mine.servers.map(s => [s.id, s.enabled])));
        const hasReadyEnabledServer = mine.servers.some(server =>
          server.enabled
          && (!server.oauth || server.oauth.status === "connected")
          && !(server.secretRequirements ?? []).some(requirement => requirement.required !== false && !requirement.configured),
        );
        if (hasReadyEnabledServer) void diagnose(false);
      }
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
  }, [diagnose, isAdmin, mode]);

  useEffect(() => { void refresh(); }, [refresh]);

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
      await diagnose(false);
    } catch (err) {
      setEnabled(previous);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [diagnose, enabled]);

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
      // 绑定后重取个人视图；若该连接器所有必填凭据已就绪且尚未启用，则自动启用，
      // 免去「绑定完还要再点一次启用」的额外步骤。
      const mine = await fetchMyMcp();
      setMyData(mine);
      const nextEnabled = Object.fromEntries(mine.servers.map(s => [s.id, s.enabled]));
      const target = mine.servers.find(s => s.id === serverId);
      const readyToEnable = target && !target.enabled
        && (!target.oauth || target.oauth.status === 'connected')
        && !(target.secretRequirements ?? []).some(r => r.required !== false && !r.configured);
      if (readyToEnable) {
        setSaving(false);
        await saveSelections({ ...nextEnabled, [serverId]: true });
        return;
      }
      setEnabled(nextEnabled);
      if (target?.enabled) await diagnose(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [diagnose, saveSelections, secretInputs]);

  /**
   * 角色 → 可绑 scope 的判定：
   *   - user：所有登录用户
   *   - tenant：admin（包括组织 admin，前提是 server 属本组织；跨组织的 server 普通用户/组织 admin 看不到）
   *   - global：仅平台 admin
   */
  const canBindSecret = useCallback((req: McpSecretStatus): boolean => {
    if (req.scope === 'user') return true;
    if (req.scope === 'tenant') return isAdmin;
    // global：仅超级管理员（只读平台 admin 会被服务端 403，前端直接禁入口）
    return isPlatformAdmin && !platformReadOnly;
  }, [isAdmin, isPlatformAdmin, platformReadOnly]);

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
    // 在用户手势上下文中同步开弹窗（异步后再 open 会被拦截），拿到授权 URL 后再导航；
    // 弹窗被浏览器拦截时退回整页跳转。
    const popup = window.open('', `mcp-oauth-${serverId}`, 'popup,width=600,height=720');
    try {
      const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      const result = await startMyMcpOAuth(serverId, returnTo);
      if (result.authorizationUrl) {
        if (popup && !popup.closed) {
          popup.location.href = result.authorizationUrl;
          return;
        }
        window.location.assign(result.authorizationUrl);
        return;
      }
      popup?.close();
      await refresh();
    } catch (err) {
      popup?.close();
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [refresh]);

  // 弹窗授权完成后，callback 页从 API 域 postMessage 通知本页刷新连接状态。
  useEffect(() => {
    const apiOrigin = (() => {
      try {
        const base = getPlatform().platformConfig.getBaseUrl();
        return base ? new URL(base).origin : window.location.origin;
      } catch {
        return window.location.origin;
      }
    })();
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== apiOrigin) return;
      const data = event.data as { type?: string } | null;
      if (!data || data.type !== 'mcp_oauth_result') return;
      void refresh();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
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
  // 钉钉内置连接计入「全部 / 已启用（有已连接组织）/ 平台提供」的计数。
  const connectorFilters = useMemo(() => [
    { value: "all" as const, label: "全部", count: connectorServers.length + 1 },
    { value: "enabled" as const, label: "已启用", count: enabledCount + (dws.hasConnected ? 1 : 0) },
    { value: "platform" as const, label: "平台提供", count: connectorServers.filter((server) => connectorSource(server) === "platform").length + 1 },
    { value: "organization" as const, label: "组织提供", count: connectorServers.filter((server) => connectorSource(server) === "organization").length },
    { value: "personal" as const, label: "我创建的", count: connectorServers.filter((server) => connectorSource(server) === "personal").length },
  ], [connectorServers, dws.hasConnected, enabledCount]);
  const showDingtalkCard = dingtalkMatchesCatalog(query, activeFilter, dws);
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
            <>
              <Button variant="outline" onClick={() => { void diagnose(true); }} disabled={diagnosing}>
                {diagnosing ? <Loader2 className="size-4 animate-spin" /> : <Stethoscope className="size-4" />}
                检测连接
              </Button>
              <Button variant="outline" onClick={openCreatePersonalServer}>
                <Plus className="size-4" />自定义连接器
              </Button>
            </>
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
          {filteredServers.length === 0 && !showDingtalkCard ? (
            <div className="rounded-2xl border border-dashed px-6 py-12 text-center text-sm text-muted-foreground">
              没有找到匹配的连接器
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {showDingtalkCard ? (
                <DingtalkConnectorCard dws={dws} onOpenDetail={() => setDingtalkDetailOpen(true)} />
              ) : null}
              {filteredServers.map((server) => {
                const source = connectorSource(server);
                const oauthReady = !server.oauth || server.oauth.status === "connected";
                const missingSecrets = (server.secretRequirements ?? []).some((requirement) => requirement.required !== false && !requirement.configured);
                const selected = enabled[server.id] === true;
                const connectionChecking = diagnosing && selected && oauthReady && !missingSecrets;
                const status = connectorStatus(server, connectionChecking);
                const connectionFailed = selected && server.connection?.status === "error";
                const connectionReady = selected && server.connection?.status === "connected";
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
                              connectionReady
                                ? "border-transparent bg-success text-success-foreground shadow-sm hover:bg-success/85"
                                : connectionFailed
                                  ? "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15"
                                : "bg-muted/40 text-muted-foreground hover:border-success/40 hover:bg-success/10 hover:text-success",
                            )}
                            disabled={saving || diagnosing || (!!server.oauth && !server.oauth.platformConfigured)}
                            title={server.oauth && !server.oauth.platformConfigured ? "平台管理员尚未完成授权配置，暂不可连接" : undefined}
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
                            {pendingServerId === server.id || connectionChecking
                              ? <Loader2 className="size-4 animate-spin" />
                              : connectionFailed
                                ? <TriangleAlert className="size-4" />
                                : selected
                                  ? <Check className="size-4" strokeWidth={2.5} />
                                  : <Plus className="size-4" />}
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
                  <div className={`mt-1 text-xs font-medium ${connectorStatus(detailServer, diagnosing && detailServer.enabled).className}`}>{connectorStatus(detailServer, diagnosing && detailServer.enabled).label}</div>
                </div>
              </div>

              {detailServer.enabled
                && (!detailServer.oauth || detailServer.oauth.status === "connected")
                && !(detailServer.secretRequirements ?? []).some(requirement => requirement.required !== false && !requirement.configured) ? (
                  <div className={cn(
                    "rounded-xl border p-4",
                    detailServer.connection?.status === "error" && "border-destructive/40 bg-destructive/5",
                  )}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium">真实连接检测</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {diagnosing
                            ? "正在连接远端服务并读取工具清单…"
                            : detailServer.connection?.status === "connected"
                              ? `连接正常，Agent 可使用 ${detailServer.connection.toolCount} 个工具。`
                              : detailServer.connection?.status === "error"
                                ? "远端连接失败，Agent 当前不会看到这个连接器。"
                                : "尚未完成远端检测。"}
                        </div>
                      </div>
                      <Button size="sm" variant="outline" onClick={() => { void diagnose(true); }} disabled={diagnosing}>
                        {diagnosing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                        重新检测
                      </Button>
                    </div>
                    {detailServer.connection?.checkedAt ? (
                      <div className="mt-2 text-xs text-muted-foreground">
                        最近检测：{new Date(detailServer.connection.checkedAt).toLocaleString("zh-CN", { hour12: false })}
                      </div>
                    ) : null}
                    {detailServer.connection?.lastError ? (
                      <div className="mt-2 break-words text-xs text-destructive">{detailServer.connection.lastError}</div>
                    ) : null}
                  </div>
                ) : null}

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
                    {requirement.instructions ? <div className="mt-1 break-words text-xs leading-5 text-muted-foreground">{renderInstructions(requirement.instructions)}</div> : null}
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

        <DingtalkConnectorDrawer open={dingtalkDetailOpen} onOpenChange={setDingtalkDetailOpen} dws={dws} />

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
            {mode === "admin" && isAdmin && (
              <Button size="sm" onClick={() => void saveServer()} disabled={platformReadOnly || saving || !form.id.trim() || !form.name.trim()}>
                <Save className="size-3.5" />
                保存 Server
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => void diagnose(true)} disabled={saving || diagnosing}>
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

      {/* admin 态不渲染「我的连接器」：个人账号连接（OAuth）/启用/个人 secret 绑定
          统一走能力中心 → 连接器，平台管理页只维护 Server Catalog 本身。 */}
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
                    <Button variant="ghost" size="icon" onClick={() => void removeServer(server.id)} disabled={platformReadOnly}><Trash2 className="size-4" /></Button>
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
