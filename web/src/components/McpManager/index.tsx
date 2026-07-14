import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Plus, RefreshCw, Save, Stethoscope, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/contexts/AuthContext";
import { useTenants } from "@/components/TenantManager/hooks";
import {
  bindMyMcpSecret,
  bindAdminMcpSecret,
  deleteMcpServer,
  deleteMyMcpServer,
  diagnoseMyMcp,
  fetchMcpAdminServers,
  fetchMcpTemplates,
  fetchMyMcp,
  updateMyMcpSelections,
  upsertMcpServer,
  upsertMyMcpServer,
  GLOBAL_TENANT_ID,
} from "@agent/shared";
import type { ManagedMcpServer, McpAdminServersResponse, McpDiagnosticResponse, McpSecretScope, McpSecretStatus, McpTemplatesResponse, MyMcpResponse } from "@agent/shared";

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

export function McpManager() {
  return <McpManagerInner mode="personal" />;
}

export function McpAdminCatalog() {
  return <McpManagerInner mode="admin" />;
}

function McpManagerInner({ mode }: { mode: "personal" | "admin" }) {
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
    return myData.servers.some(s => enabled[s.id] !== s.enabled);
  }, [myData, enabled]);

  const saveSelections = useCallback(async () => {
    setSaving(true);
    try {
      await updateMyMcpSelections(Object.entries(enabled).filter(([, v]) => v).map(([id]) => id));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [enabled, refresh]);

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
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [refresh]);

  if (loading) {
    return <div className="flex flex-1 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <SettingsPanelHeader
        title={mode === "admin" ? "连接器管理" : "连接器"}
        description={mode === "admin" ? "维护组织或全局 MCP Server Catalog。" : "为我的通用 Agent 添加 MCP 连接器、绑定密钥，并选择新会话要加载的工具。"}
        actions={
          <>
            {dirty && (
              <Button size="sm" onClick={() => void saveSelections()} disabled={saving}>
                <Save className="mr-1.5 h-3.5 w-3.5" />
                保存启用状态
              </Button>
            )}
            {mode === "personal" && (
              <Button
                size="sm"
                onClick={() => void savePersonalServer()}
                disabled={saving || !personalForm.id.trim() || !personalForm.name.trim()}
              >
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                保存个人 MCP
              </Button>
            )}
            {mode === "admin" && isAdmin && (
              <Button size="sm" onClick={() => void saveServer()} disabled={saving || !form.id.trim() || !form.name.trim()}>
                <Save className="mr-1.5 h-3.5 w-3.5" />
                保存 Server
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => void diagnose()} disabled={saving}>
              <Stethoscope className="mr-1.5 h-3.5 w-3.5" />诊断
            </Button>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />刷新
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 space-y-6 overflow-auto">
      {error && <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

      {mode === "personal" && (
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-base">添加个人 MCP Server</CardTitle></CardHeader>
          <CardContent className="space-y-3 pt-0">
            <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
              个人 MCP 仅本人可见；为安全起见，当前只支持 http / streamable-http，不支持 stdio command。Secret requirement 会强制使用用户私有 scope。
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <Input placeholder="server id，如 my_notion" value={personalForm.id} onChange={e => setPersonalForm(prev => ({ ...prev, id: e.target.value }))} />
              <Input placeholder="显示名称" value={personalForm.name} onChange={e => setPersonalForm(prev => ({ ...prev, name: e.target.value }))} />
              <Input className="md:col-span-2" placeholder="描述" value={personalForm.description || ""} onChange={e => setPersonalForm(prev => ({ ...prev, description: e.target.value }))} />
              <Input placeholder="风险等级" value={personalForm.riskLevel || "credentialed_external_write"} onChange={e => setPersonalForm(prev => ({ ...prev, riskLevel: e.target.value as ManagedMcpServer["riskLevel"] }))} />
            </div>
            <Textarea className="min-h-28 font-mono text-xs" value={personalConfigText} onChange={e => setPersonalConfigText(e.target.value)} />
            <Textarea className="min-h-20 font-mono text-xs" value={personalSecretsText} onChange={e => setPersonalSecretsText(e.target.value)} placeholder='[{"key":"token","label":"Token","target":"header","name":"Authorization","scope":"user","prefix":"Bearer "}]' />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">我的 MCP Server</CardTitle></CardHeader>
        <CardContent className="space-y-2 pt-0">
          {(myData?.servers.length ?? 0) === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">暂无管理员配置的 MCP Server。</div>
          ) : myData!.servers.map(server => (
            <div key={server.id} className="flex items-start gap-3 rounded-lg border p-3">
              <Switch checked={!!enabled[server.id]} onCheckedChange={(v) => setEnabled(prev => ({ ...prev, [server.id]: v }))} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium"><span>{server.name}</span><span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{server.transport}</span></div>
                <div className="text-xs text-muted-foreground">{server.id}{server.personal ? " · 个人" : ""}{server.enabledByDefault ? " · 默认启用" : ""}{server.riskLevel ? ` · ${server.riskLevel}` : ""}</div>
                {server.description && <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{server.description}</p>}
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
                  <Button variant="ghost" size="icon" onClick={() => void removePersonalServer(server.id)}><Trash2 className="h-4 w-4" /></Button>
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
                  {templates!.templates.map(t => (
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
                    <Button variant="ghost" size="icon" onClick={() => void removeServer(server.id)}><Trash2 className="h-4 w-4" /></Button>
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
