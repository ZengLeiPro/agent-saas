import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronLeft, Loader2, RefreshCw, X, type LucideIcon } from "lucide-react";
import { EntityIcons } from "@/lib/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SettingsPanelHeader, SettingsPanelHeaderStickyProvider } from "@/components/SettingsCenter/SettingsPanelHeader";
import { useAuth } from "@/contexts/AuthContext";
import { useLoginLogs, useUsers, type LoginLogFilters } from "@/components/UserManager/hooks";
import type { LoginLogEntry } from "@/components/UserManager/types";
import { useTenants } from "@/components/TenantManager/hooks";
import { authFetch } from "@/lib/authFetch";
import { refreshAll } from "@/lib/refreshBus";
import { cn } from "@/lib/utils";
import { DEFAULT_TENANT_ID, DEFAULT_TENANT_SETTINGS, type TenantSettings } from "@/components/TenantManager/types";
import type { ModelList } from "@/types/models";
import { PlatformBillingManager, TenantBillingPanel } from "@/components/BillingManager";
import { pushPlatformAdminUrl, type PlatformAdminSection } from "@/lib/urlSync";
import { AdminErrorAlert, EntityLink } from "@/components/PlatformAdmin/common";
import { formatChannel } from "@/components/PlatformAdmin/displayText";
import { PlatformAdminHeaderControls } from "@/components/PlatformAdmin/PlatformAdminHeaderControls";
import { TenantAdminHeaderControls } from "@/components/TenantAdminHeaderControls";
import { InfraPage, OverviewPage, SandboxesPage, SessionsPage, TenantsPage, UsersPage } from "@/components/PlatformAdmin/pages";
import { SystemSettingsPanel } from "@/components/PlatformAdmin/SystemSettingsPanel";
import { RunTraceExplorer } from "@/components/RunTraceExplorer";
import { OverviewSection as TenantOverviewSection } from "@/components/TenantAnalytics/OverviewSection";
import { QaConsole } from "@/components/QaConsole";

const SystemPromptsManagerPanel = lazy(() => import("@/components/SystemPromptsManager"));
const AgentRuntimeProfilesManagerPanel = lazy(() => import("@/components/AgentRuntimeProfilesManager"));

export type TenantSection = "overview" | "users" | "skills" | "org-agents" | "mcp" | "usage" | "billing" | "files" | "qa" | "audit" | "settings" | "company";
export type PlatformSection = "tenants" | "signup" | "models" | "billing" | "remote-hands" | "tool-controls" | "agent-profiles" | "system-prompts" | "memory-polling" | "global-mcp" | "skill-pool" | "system";

interface ShellButton<T extends string> {
  id: T;
  label: string;
  icon: LucideIcon;
  platformOnly?: boolean;
}

const tenantSettingsSections: ShellButton<TenantSection>[] = [
  { id: "users", label: "成员", icon: EntityIcons.members },
  { id: "skills", label: "技能", icon: EntityIcons.skill },
  { id: "org-agents", label: "企业专家", icon: EntityIcons.expert },
  { id: "mcp", label: "连接器", icon: EntityIcons.connector },
  { id: "billing", label: "计费", icon: EntityIcons.billing },
  { id: "files", label: "文件与数据", icon: EntityIcons.files },
  { id: "company", label: "公司信息", icon: EntityIcons.companyInfo },
  { id: "settings", label: "组织管理", icon: EntityIcons.org },
];

const SETTINGS_NAV_ITEM_SELECTED =
  "relative bg-brand-accent-soft text-foreground font-semibold " +
  "before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 " +
  "before:h-5 before:w-[3px] before:rounded-r-full before:bg-brand-accent";
const SETTINGS_NAV_ITEM_UNSELECTED =
  "text-muted-foreground hover:bg-muted/60 hover:text-foreground";

const platformSettingsSections: ShellButton<PlatformSection>[] = [
  { id: "tenants", label: "组织", icon: EntityIcons.org },
  { id: "signup", label: "注册管理", icon: EntityIcons.signup },
  { id: "models", label: "模型", icon: EntityIcons.model },
  { id: "billing", label: "计费", icon: EntityIcons.billing },
  { id: "remote-hands", label: "执行环境池", icon: EntityIcons.runtimePool },
  { id: "tool-controls", label: "工具开关", icon: EntityIcons.toolControls },
  { id: "agent-profiles", label: "Agent 运行配置", icon: EntityIcons.runtimePool },
  { id: "system-prompts", label: "系统提示语", icon: EntityIcons.systemPrompts },
  { id: "memory-polling", label: "记忆轮询", icon: EntityIcons.memoryPolling },
  { id: "global-mcp", label: "全局 MCP", icon: EntityIcons.connector },
  { id: "skill-pool", label: "技能池", icon: EntityIcons.skill },
  { id: "system", label: "系统配置", icon: EntityIcons.systemConfig },
];

function AdminSettingsModal<T extends string>({
  open,
  title,
  description,
  badge,
  sections,
  active,
  onActiveChange,
  onClose,
  headerControl,
  children,
}: {
  open: boolean;
  title: string;
  description: string;
  badge?: string;
  sections: ShellButton<T>[];
  active: T;
  onActiveChange: (id: T) => void;
  onClose: () => void;
  headerControl?: ReactNode;
  children: ReactNode;
}) {
  // 移动端（<md）两级导航：菜单页 ⇄ 内容页。桌面不受影响（max-md 类不生效）。
  const [mobileView, setMobileView] = useState<"menu" | "content">("menu");
  useEffect(() => {
    if (open) setMobileView("menu");
  }, [open]);
  if (!open) return null;
  const activeItem = sections.find(item => item.id === active) ?? sections[0];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 backdrop-blur-sm md:p-8" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="flex h-full w-full overflow-hidden bg-background pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] shadow-2xl md:h-[min(920px,calc(100vh-96px))] md:w-[min(1184px,calc(100vw-64px))] md:rounded-3xl md:border md:pb-0 md:pt-0" onClick={(event) => event.stopPropagation()}>
        <aside className={cn("flex w-full shrink-0 flex-col bg-muted/20 p-3 md:w-40 md:border-r", mobileView === "content" && "max-md:hidden")}>
          <div className="mb-1 flex justify-end md:hidden">
            <button type="button" className="rounded-full p-2 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={onClose} aria-label={`关闭${title}`}>
              <X className="size-5" />
            </button>
          </div>
          <div className="mb-4 px-1">
            <div className="flex items-center gap-2">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white">
                <EntityIcons.admin className="size-5" />
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{title}</div>
                <div className="truncate text-xs text-muted-foreground">{badge || "管理设置"}</div>
              </div>
            </div>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">{description}</p>
            {headerControl && <div className="mt-3">{headerControl}</div>}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <div className="mb-1 px-2 text-xs font-medium text-muted-foreground">设置</div>
            <div className="space-y-1">
              {sections.map(item => {
                const Icon = item.icon;
                const selected = item.id === activeItem.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                      selected ? SETTINGS_NAV_ITEM_SELECTED : SETTINGS_NAV_ITEM_UNSELECTED,
                    )}
                    onClick={() => { onActiveChange(item.id); setMobileView("content"); }}
                  >
                    <Icon className="size-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>
        <main className={cn("relative flex min-w-0 flex-1 flex-col", mobileView === "menu" && "max-md:hidden")}>
          <div className="flex shrink-0 items-center justify-between gap-2 border-b px-2 py-2 md:hidden">
            <div className="flex min-w-0 items-center gap-1">
              <button type="button" className="rounded-full p-2 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setMobileView("menu")} aria-label="返回设置菜单">
                <ChevronLeft className="size-5" />
              </button>
              <span className="truncate text-sm font-semibold">{activeItem.label}</span>
            </div>
            <button type="button" className="rounded-full p-2 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={onClose} aria-label={`关闭${title}`}>
              <X className="size-5" />
            </button>
          </div>
          <button type="button" className="absolute right-5 top-5 z-30 rounded-full p-2 text-muted-foreground hover:bg-accent hover:text-foreground max-md:hidden" onClick={onClose} aria-label={`关闭${title}`}>
            <X className="size-5" />
          </button>
          <div className="min-h-0 flex-1 overflow-hidden p-4 pt-3 md:p-8 md:pt-5">
            <SettingsPanelHeaderStickyProvider>
              {children}
            </SettingsPanelHeaderStickyProvider>
          </div>
        </main>
      </div>
    </div>
  );
}

function SettingsSectionFallback() {
  return (
    <div className="flex h-full min-h-[240px] items-center justify-center text-sm text-muted-foreground">
      <Loader2 className="mr-2 size-4 animate-spin" />
      加载中...
    </div>
  );
}

function MetricCard({ title, value, description }: { title: string; value: string | number; description: string }) {
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{title}</CardTitle></CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold">{value}</div>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}


function cloneTenantSettings(settings: TenantSettings): TenantSettings {
  return {
    features: { ...settings.features },
    quotas: { ...settings.quotas },
    models: { ...settings.models, allowedModels: [...settings.models.allowedModels], displayOverrides: { ...(settings.models.displayOverrides ?? {}) } },
    mcp: { ...settings.mcp, defaultEnabledServerIds: [...settings.mcp.defaultEnabledServerIds] },
    branding: { ...settings.branding },
    personalization: { ...settings.personalization },
    security: { ...settings.security },
  };
}

function splitLines(value: string): string[] {
  return value.split(/[\n,]/).map(v => v.trim()).filter(Boolean);
}

function numericValue(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function SettingSwitch({
  label,
  description,
  checked,
  onCheckedChange,
  disabled = false,
}: {
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className={`flex items-start justify-between gap-4 rounded-xl border p-3 ${disabled ? "opacity-70" : ""}`}>
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs leading-5 text-muted-foreground">{description}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </div>
  );
}

function TenantSettingsPanel({ tenantId }: { tenantId: string }) {
  const { isPlatformAdmin, canPlatform } = useAuth();
  const readOnly = isPlatformAdmin
    && (tenantId === DEFAULT_TENANT_ID || !canPlatform("customer_config.manage"));
  const [settings, setSettings] = useState<TenantSettings>(() => cloneTenantSettings(DEFAULT_TENANT_SETTINGS));
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [defaultMcpText, setDefaultMcpText] = useState("");
  const [modelList, setModelList] = useState<ModelList | null>(null);

  const load = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    try {
      const res = await authFetch(`/api/tenants/${tenantId}/settings`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || "加载组织管理失败");
      const next = (data as { settings: TenantSettings }).settings;
      setSettings(next);
      setDefaultMcpText(next.mcp.defaultEnabledServerIds.join("\n"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let cancelled = false;
    authFetch("/api/models")
      .then(async (res) => (res.ok ? (await res.json() as ModelList) : null))
      .then((next) => {
        if (!cancelled) setModelList(next);
      })
      .catch(() => {
        if (!cancelled) setModelList(null);
      });
    return () => { cancelled = true; };
  }, []);

  const patch = useCallback((recipe: (draft: TenantSettings) => void) => {
    setSettings((prev: TenantSettings) => {
      const draft = cloneTenantSettings(prev);
      recipe(draft);
      return draft;
    });
    setSaved(false);
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const payload = cloneTenantSettings(settings);
      payload.mcp.defaultEnabledServerIds = splitLines(defaultMcpText);
      const res = await authFetch(`/api/tenants/${tenantId}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: payload }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || "保存组织管理失败");
      const next = (data as { settings: TenantSettings }).settings;
      setSettings(next);
      setDefaultMcpText(next.mcp.defaultEnabledServerIds.join("\n"));
      await refreshAll();
      setSaved(true);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [defaultMcpText, settings, tenantId]);

  const modelOptions = modelList?.groups.flatMap(group =>
    group.models.map(model => ({
      ref: `${group.id}/${model.id}`,
      label: settings.models.showGroupNames ? `${group.name}/${model.name}` : model.name,
    })),
  ) ?? [];

  const toggleAllowedModel = useCallback((modelRef: string, checked: boolean) => {
    patch(d => {
      d.models.allowedModels = checked
        ? Array.from(new Set([...d.models.allowedModels, modelRef]))
        : d.models.allowedModels.filter(ref => ref !== modelRef);
      if (d.models.defaultModel === modelRef && !checked) d.models.defaultModel = undefined;
    });
  }, [patch]);

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <SettingsPanelHeader
        title="组织管理"
        description={`配置组织 ${tenantId} 的功能开关、配额、模型、MCP、安全和品牌策略。`}
        actions={<Button onClick={() => { void save(); }} disabled={readOnly || loading || saving}>{saving ? "保存中..." : "保存设置"}</Button>}
      />
      <fieldset disabled={readOnly} className="min-h-0 flex-1 space-y-5 overflow-auto">
      {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
      {saved && <div className="rounded-md bg-success/10 px-3 py-2 text-sm text-success">组织管理已保存</div>}
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">功能开关</CardTitle></CardHeader>
          <CardContent className="grid gap-3">
            <SettingSwitch label="文件能力" description="允许组织用户访问文件浏览、上传和预览。" checked={settings.features.filesEnabled} onCheckedChange={checked => patch(d => { d.features.filesEnabled = checked; })} />
            <SettingSwitch label="定时任务" description="允许创建和运行 Cron 自动化任务。" checked={settings.features.cronEnabled} onCheckedChange={checked => patch(d => { d.features.cronEnabled = checked; })} />
            <SettingSwitch label="MCP 工具" description="允许组织使用 MCP 服务与工具密钥。" checked={settings.features.mcpEnabled} onCheckedChange={checked => patch(d => { d.features.mcpEnabled = checked; })} />
            <SettingSwitch label="自定义技能" description="允许用户维护自己的技能。" checked={settings.features.customSkillsEnabled} onCheckedChange={checked => patch(d => { d.features.customSkillsEnabled = checked; })} />
            <SettingSwitch label="调试模式" description="允许开启思考、工具和执行细节展示。" checked={settings.features.debugModeAllowed} onCheckedChange={checked => patch(d => { d.features.debugModeAllowed = checked; })} />
            <SettingSwitch label="自动压缩上下文" description="会话上下文达到各模型配置的触发线时，回合结束后自动压缩（还需模型配置上下文窗口）。" checked={settings.features.autoCompactEnabled} onCheckedChange={checked => patch(d => { d.features.autoCompactEnabled = checked; })} />
            <SettingSwitch
              label="AI 生图"
              description="平台托管的付费能力，仅平台管理员可为组织开通；此处只读展示当前授权状态。"
              checked={settings.features.imageGenEnabled === true}
              onCheckedChange={() => undefined}
              disabled
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">配额</CardTitle></CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            {[
              ["maxUsers", "用户数上限"],
              ["maxAdmins", "管理员上限"],
              ["maxStorageMb", "存储上限 MB"],
              ["monthlyTokenLimit", "月 Token 上限"],
              ["maxTurnsPerRequest", "单次最大轮数"],
              ["rateLimitMaxRequests", "限流请求数"],
            ].map(([key, label]) => (
              <div key={key} className="space-y-1.5">
                <Label>{label}</Label>
                <Input
                  type="number"
                  min={1}
                  value={settings.quotas[key as keyof TenantSettings["quotas"]] ?? ""}
                  onChange={event => patch(d => { d.quotas[key as keyof TenantSettings["quotas"]] = numericValue(event.target.value); })}
                  placeholder="不限制"
                />
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">个性化</CardTitle></CardHeader>
          <CardContent className="grid gap-3">
            <SettingSwitch
              label="首日新手引导条"
              description="在聊天输入框下方展示首日引导。默认关闭，需要时按组织开启。"
              checked={settings.personalization.firstDayGuideBarEnabled}
              onCheckedChange={checked => patch(d => { d.personalization.firstDayGuideBarEnabled = checked; })}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">模型策略</CardTitle></CardHeader>
          <CardContent className="grid gap-3">
            <div className="space-y-1.5">
              <Label>默认模型</Label>
              <select
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={settings.models.defaultModel ?? ""}
                onChange={event => patch(d => { d.models.defaultModel = event.target.value || undefined; })}
              >
                <option value="">继承平台默认</option>
                {modelOptions.map(model => (
                  <option key={model.ref} value={model.ref}>{model.label}</option>
                ))}
              </select>
            </div>
            <SettingSwitch label="允许用户切换模型" description="关闭后可在后续运行时策略中限制用户只能使用默认模型。" checked={settings.models.allowUserModelSwitch} onCheckedChange={checked => patch(d => { d.models.allowUserModelSwitch = checked; })} />
            <SettingSwitch label="显示分组名" description="模型选择器中显示模型分组标题。" checked={!!settings.models.showGroupNames} onCheckedChange={checked => patch(d => { d.models.showGroupNames = checked; })} />
            <div className="space-y-2">
              <div>
                <Label>可用模型白名单</Label>
                <p className="mt-1 text-xs text-muted-foreground">不勾选任何模型表示继承平台默认可用范围。</p>
              </div>
              {modelOptions.length === 0 ? (
                <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">模型列表加载中或暂无可选模型。</div>
              ) : (
                <div className="grid max-h-56 gap-2 overflow-auto rounded-md border p-3 sm:grid-cols-2">
                  {modelOptions.map(model => (
                    <label key={model.ref} className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={settings.models.allowedModels.includes(model.ref)}
                        onChange={event => toggleAllowedModel(model.ref, event.target.checked)}
                      />
                      <span>
                        <span className="block font-medium">{model.label}</span>
                        <span className="block text-xs text-muted-foreground">{model.ref}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">MCP 策略</CardTitle></CardHeader>
          <CardContent className="grid gap-3">
            <SettingSwitch label="允许组织 MCP" description="允许组织管理员维护本组织共享 MCP 服务。" checked={settings.mcp.allowTenantServers} onCheckedChange={checked => patch(d => { d.mcp.allowTenantServers = checked; })} />
            <SettingSwitch label="允许全局 MCP" description="允许组织用户使用平台全局 MCP 服务。" checked={settings.mcp.allowGlobalServers} onCheckedChange={checked => patch(d => { d.mcp.allowGlobalServers = checked; })} />
            <div className="space-y-1.5">
              <Label>默认启用 MCP 服务 ID</Label>
              <textarea autoComplete="off" className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm" value={defaultMcpText} onChange={event => { setDefaultMcpText(event.target.value); setSaved(false); }} placeholder="每行一个服务 ID" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">品牌</CardTitle></CardHeader>
          <CardContent className="grid gap-3">
            <div className="space-y-1.5"><Label>显示名称</Label><Input value={settings.branding.displayName ?? ""} onChange={event => patch(d => { d.branding.displayName = event.target.value.trim() || undefined; })} /></div>
            <div className="space-y-1.5"><Label>Logo 地址</Label><Input value={settings.branding.logoUrl ?? ""} onChange={event => patch(d => { d.branding.logoUrl = event.target.value.trim() || undefined; })} /></div>
            <div className="space-y-1.5"><Label>主色</Label><Input value={settings.branding.primaryColor ?? ""} onChange={event => patch(d => { d.branding.primaryColor = event.target.value.trim() || undefined; })} placeholder="#2563eb" /></div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">安全</CardTitle></CardHeader>
          <CardContent className="grid gap-3">
            <div className="space-y-1.5"><Label>密码最小长度</Label><Input type="number" min={1} value={settings.security.passwordMinLength ?? ""} onChange={event => patch(d => { d.security.passwordMinLength = numericValue(event.target.value); })} placeholder="系统默认" /></div>
            <div className="space-y-1.5"><Label>会话有效期（小时）</Label><Input type="number" min={1} value={settings.security.sessionTtlHours ?? ""} onChange={event => patch(d => { d.security.sessionTtlHours = numericValue(event.target.value); })} placeholder="系统默认" /></div>
            <SettingSwitch label="要求钉钉绑定" description="开启后可作为后续登录策略和成员校验依据。" checked={settings.security.requireDingtalkBinding} onCheckedChange={checked => patch(d => { d.security.requireDingtalkBinding = checked; })} />
          </CardContent>
        </Card>
      </div>
      </fieldset>
    </div>
  );
}

const AUDIT_EVENT_LABELS: Record<string, string> = {
  login_success: "登录成功",
  login_fail: "登录失败",
  app_foreground: "进入前台",
  app_background: "进入后台",
  page_viewed: "浏览页面",
  chat_message_sent: "发送消息",
  session_opened: "查看对话",
  session_soft_deleted: "移入回收站",
  session_restored: "恢复对话",
  session_permanently_deleted: "永久删除",
  session_renamed: "重命名对话",
  session_forked: "复刻对话",
  session_share_updated: "更新对话分享",
  session_share_revoked: "撤销对话分享",
  group_created: "创建分组",
  group_updated: "更新分组",
  group_deleted: "删除分组",
  group_sessions_added: "分组添加对话",
  group_sessions_removed: "分组移除对话",
  cron_job_created: "创建任务",
  cron_job_updated: "编辑任务",
  cron_job_deleted: "删除任务",
  cron_job_toggled: "启停任务",
  cron_job_triggered: "手动执行",
  user_created: "创建用户",
  user_updated: "编辑用户",
  user_deleted: "删除用户",
  user_avatar_updated: "更换头像",
  user_disabled: "禁用用户",
  user_enabled: "启用用户",
  user_password_changed: "修改密码",
  user_phone_updated: "更新手机号",
  user_phone_verified: "验证手机号",
  file_previewed: "预览文件",
  file_downloaded: "下载文件",
  file_deleted: "删除文件",
  agent_profile_viewed: "查看主页",
  agent_profile_updated: "编辑资料",
  agent_persona_viewed: "查看人格",
  agent_persona_updated: "编辑人格",
  agent_memory_viewed: "查看记忆",
  agent_memory_updated: "编辑记忆",
  agent_avatar_uploaded: "上传头像",
  agent_avatar_reset: "重置头像",
  tenant_created: "创建组织",
  tenant_updated: "更新组织",
  tenant_disabled: "禁用组织",
  tenant_enabled: "启用组织",
  tenant_deleted: "删除组织",
  mcp_user_selections_updated: "更新 MCP 选择",
  mcp_secret_bound: "绑定 MCP 密钥",
  mcp_server_updated: "更新 MCP 服务",
  mcp_server_deleted: "删除 MCP 服务",
  mcp_admin_user_selections_updated: "管理员更新 MCP",
  mcp_oauth_connected: "连接器账号授权",
  mcp_oauth_revoked: "断开连接器账号",
  skill_custom_uploaded: "上传自定义技能",
  skill_tenant_uploaded: "上传组织技能",
  skill_pool_uploaded: "上传平台技能",
  skill_document_updated: "更新技能文档",
  skill_visibility_updated: "更新技能可见性",
  skill_platform_settings_updated: "更新平台技能设置",
  skill_tenant_selections_updated: "更新组织技能选择",
  skill_tenant_settings_updated: "更新组织技能设置",
  skill_tenant_own_settings_updated: "更新组织自有技能设置",
  skill_tenant_deleted: "删除组织技能",
  skill_promoted: "发布技能",
  skill_promoted_to_tenant: "发布到组织技能",
  skill_custom_deleted: "删除自定义技能",
  skill_user_selections_updated: "更新技能选择",
  platform_capability_denied: "平台能力拒绝",
  platform_privileged_action: "平台授权操作",
  platform_user_search: "平台用户检索",
  billing_account_adjusted: "调整积分流水",
};

const auditCategories = [
  { value: "", label: "全部事件" },
  { value: "login", label: "登录" },
  { value: "platform", label: "平台运营" },
  { value: "activity", label: "活动" },
  { value: "session", label: "对话" },
  { value: "group", label: "分组" },
  { value: "cron", label: "定时任务" },
  { value: "user", label: "用户管理" },
  { value: "file", label: "文件" },
  { value: "agent", label: "AI 助手" },
  { value: "skill", label: "技能" },
  { value: "mcp", label: "连接器" },
  { value: "tenant", label: "组织" },
];

const auditChannels = [
  { value: "", label: "全部渠道" },
  { value: "web", label: "Web 端" },
  { value: "mobile", label: "移动端" },
  { value: "dingtalk", label: "钉钉" },
];

function formatAuditTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return iso;
  }
}

function shanghaiDateBoundary(date: string, endOfDay = false): string | undefined {
  if (!date) return undefined;
  const localTime = endOfDay ? "23:59:59.999" : "00:00:00.000";
  return new Date(`${date}T${localTime}+08:00`).toISOString();
}

function auditEventLabel(event: string): string {
  return AUDIT_EVENT_LABELS[event] || "其他操作";
}

function auditEventBadgeClass(event: string): string {
  if (event === "login_fail") return "bg-destructive text-destructive-foreground border-0";
  if (event === "login_success") return "bg-success/15 text-success border-0";
  if (event.startsWith("tenant_")) return "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border-0";
  if (event.startsWith("user_")) return "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border-0";
  if (event.startsWith("mcp_")) return "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-0";
  if (event.startsWith("skill_")) return "bg-purple-500/15 text-purple-700 dark:text-purple-300 border-0";
  if (event.startsWith("file_")) return "bg-teal-500/15 text-teal-700 dark:text-teal-300 border-0";
  if (event.startsWith("cron_")) return "bg-warning/15 text-warning border-0";
  return "bg-muted text-muted-foreground border-0";
}

function AuditEventsPanel({
  scope,
  tenantId,
  tenantName,
}: {
  scope: "tenant" | "platform";
  tenantId?: string;
  tenantName?: string;
}) {
  const { users } = useUsers();
  const { tenants } = useTenants();
  const [category, setCategory] = useState("");
  const [channel, setChannel] = useState("");
  const [usernameFilter, setUsernameFilter] = useState("");
  const [tenantIdFilter, setTenantIdFilter] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const tenantUsers = useMemo(
    () => tenantId ? users.filter(user => user.tenantId === tenantId) : users,
    [tenantId, users],
  );
  const tenantUsernames = useMemo(() => tenantUsers.map(user => user.username), [tenantUsers]);
  const filters: LoginLogFilters = useMemo(() => ({
    username: usernameFilter.trim() || (scope === "tenant" ? (tenantUsernames.length > 0 ? tenantUsernames : ["__empty_tenant__"]) : undefined),
    tenantId: scope === "tenant" ? tenantId : tenantIdFilter.trim() || undefined,
    category: category || undefined,
    channel: channel || undefined,
    startTime: shanghaiDateBoundary(startDate),
    endTime: shanghaiDateBoundary(endDate, true),
  }), [category, channel, endDate, scope, startDate, tenantId, tenantIdFilter, tenantUsernames, usernameFilter]);

  const { entries, total, loading, error, offset, limit, refresh, nextPage, prevPage } = useLoginLogs(filters);
  const userMap = useMemo(() => new Map(users.map(user => [user.username, user])), [users]);
  const uniqueActors = useMemo(() => new Set(entries.map(entry => entry.username)).size, [entries]);
  const failures = entries.filter(entry => entry.event === "login_fail").length;
  const adminOps = entries.filter(entry => entry.event.includes("_") && !["login_success", "login_fail", "page_viewed", "app_foreground", "app_background"].includes(entry.event)).length;

  useEffect(() => { void refresh(); }, [refresh]);

  const emptyTenant = scope === "tenant" && tenantUsernames.length === 0;

  return (
    <div className="w-full space-y-5">
      <SettingsPanelHeader
        title={scope === "tenant" ? "组织操作记录" : "平台操作记录"}
        description={scope === "tenant"
          ? `查看 ${tenantName || tenantId || "当前组织"} 的登录、成员、文件、工具和配置变更记录。`
          : "查看跨组织的登录、用户、工具、技能、文件和执行环境变更。"}
        actions={<Button variant="outline" onClick={() => { void refresh(); }} disabled={loading}><RefreshCw className={cn("mr-2 size-4", loading && "animate-spin")} />刷新</Button>}
      />

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard title="事件总数" value={total} description="符合当前筛选条件" />
        <MetricCard title="当前页操作者" value={uniqueActors} description="本页涉及账号数" />
        <MetricCard title="失败登录" value={failures} description="本页登录失败事件" />
        <MetricCard title="管理操作" value={adminOps} description="本页配置/资源变更" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">筛选条件</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-7">
          <div className="space-y-1.5">
            <Label>事件类别</Label>
            <select className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={category} onChange={event => setCategory(event.target.value)}>
              {auditCategories.map(item => <option key={item.value || "all"} value={item.value}>{item.label}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>渠道</Label>
            <select className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={channel} onChange={event => setChannel(event.target.value)}>
              {auditChannels.map(item => <option key={item.value || "all"} value={item.value}>{item.label}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>用户名</Label>
            <Input value={usernameFilter} onChange={event => setUsernameFilter(event.target.value)} placeholder="用户名" />
          </div>
          <div className="space-y-1.5">
            <Label>组织</Label>
            <select
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={scope === "tenant" ? tenantId || "" : tenantIdFilter}
              onChange={event => setTenantIdFilter(event.target.value)}
              disabled={scope === "tenant"}
            >
              <option value="">全部组织</option>
              {tenants.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>开始日期</Label>
            <Input type="date" value={startDate} onChange={event => setStartDate(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>结束日期</Label>
            <Input type="date" value={endDate} onChange={event => setEndDate(event.target.value)} />
          </div>
          <div className="flex items-end">
            <Button className="w-full" onClick={() => { void refresh(); }} disabled={loading || emptyTenant}>查询</Button>
          </div>
        </CardContent>
      </Card>

      {error && <AdminErrorAlert error={error} />}
      {emptyTenant && <div className="rounded-md bg-warning/10 px-3 py-2 text-sm text-warning">当前组织暂无成员，审计列表为空。</div>}

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle className="text-base">事件列表</CardTitle>
          <div className="text-xs text-muted-foreground">第 {Math.floor(offset / limit) + 1} 页 · {offset + 1}-{Math.min(offset + entries.length, total)} / {total}</div>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />正在加载操作记录…
            </div>
          ) : entries.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">暂无操作记录</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>事件</TableHead>
                  <TableHead>操作者</TableHead>
                  <TableHead>组织</TableHead>
                  <TableHead>渠道/IP</TableHead>
                  <TableHead>详情</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry: LoginLogEntry, index) => {
                  const actor = userMap.get(entry.username);
                  const rowTenantId = entry.tenantId || actor?.tenantId || (scope === "tenant" ? tenantId : undefined);
                  return (
                    <TableRow key={`${entry.timestamp}-${entry.username}-${entry.event}-${index}`}>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatAuditTime(entry.timestamp)}</TableCell>
                      <TableCell><Badge className={auditEventBadgeClass(entry.event)} title={entry.event}>{auditEventLabel(entry.event)}</Badge></TableCell>
                      <TableCell>
                        <div className="font-medium">
                          {actor ? (
                            <EntityLink kind="user" id={actor.id} label={actor.realName || entry.username} tenantId={actor.tenantId} />
                          ) : entry.username}
                        </div>
                        <div className="text-xs text-muted-foreground">{entry.username}</div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground"><EntityLink kind="tenant" id={rowTenantId} /></TableCell>
                      <TableCell>
                        <div className="text-xs">{formatChannel(entry.channel)}</div>
                        <div className="text-xs text-muted-foreground">{entry.ip || "-"}</div>
                      </TableCell>
                      <TableCell className="max-w-sm truncate text-xs text-muted-foreground" title={entry.detail || entry.failReason || ""}>{entry.detail || entry.failReason || "-"}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={prevPage} disabled={loading || offset === 0}>上一页</Button>
        <Button variant="outline" size="sm" onClick={nextPage} disabled={loading || offset + limit >= total}>下一页</Button>
      </div>
    </div>
  );
}

export function TenantAdminShell({
  renderUsers,
  renderSkills,
  renderOrgAgents,
  renderMcp,
  renderUsage,
  renderFiles,
  renderCompanyInfo,
  settingsOpen,
  settingsSection,
  onSettingsSectionChange,
  onSettingsClose,
  settingsOnly = false,
  activeAnalysisSection,
  onAnalysisSectionChange,
  headerControlsPlacement = "inline",
}: {
  renderUsers: (tenantId?: string, tenantName?: string) => ReactNode;
  renderSkills: (tenantId?: string, tenantName?: string) => ReactNode;
  /**
   * 「企业专家」section（2026-07 唯恩批次）。Desktop 两处 TenantAdminShell 实例
   * 都必须传（漏一处 = 从聊天页打开设置 modal 时 section 空白）；mobile 本期不做，
   * 缺省时导航项整体隐藏（零变化）。
   */
  renderOrgAgents?: (tenantId?: string, tenantName?: string) => ReactNode;
  renderMcp: () => ReactNode;
  renderUsage: (tenantId?: string) => ReactNode;
  renderFiles: () => ReactNode;
  renderCompanyInfo: (tenantId: string, tenantName?: string) => ReactNode;
  /** 受控：modal 是否打开（由 useChatAppState.adminSettings 控制） */
  settingsOpen: boolean;
  /** 受控：modal 当前 section（合法值见 tenantSettingsSections） */
  settingsSection: TenantSection;
  /** 切换 section 时调用，父级负责改 state + push URL */
  onSettingsSectionChange: (section: TenantSection) => void;
  /** 关闭 modal 时调用，父级负责改 state + push URL */
  onSettingsClose: () => void;
  /** 仅渲染设置 modal，不渲染背后的分析页；用于从任意页面打开管理弹窗时保持原页面不变。 */
  settingsOnly?: boolean;
  activeAnalysisSection?: TenantSection;
  onAnalysisSectionChange?: (section: TenantSection) => void;
  headerControlsPlacement?: "inline" | "none";
}) {
  const { user, isPlatformAdmin } = useAuth();
  const { tenants } = useTenants();
  const [internalActive, setInternalActive] = useState<TenantSection>("overview");
  const active = activeAnalysisSection ?? internalActive;
  const setActive = onAnalysisSectionChange ?? setInternalActive;
  const [targetTenantId, setTargetTenantId] = useState(user?.tenantId ?? "");

  useEffect(() => {
    if (!targetTenantId && user?.tenantId) setTargetTenantId(user.tenantId);
  }, [targetTenantId, user?.tenantId]);

  const effectiveTenantId = isPlatformAdmin ? targetTenantId || user?.tenantId || "" : user?.tenantId || "";
  const currentTenant = tenants.find(t => t.id === effectiveTenantId);

  const tenantSwitcher = isPlatformAdmin && tenants.length > 0 ? (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">当前组织</span>
      <select
        className="h-9 w-full rounded-md border bg-background px-3 text-sm"
        value={effectiveTenantId}
        onChange={event => setTargetTenantId(event.target.value)}
        aria-label="切换组织管理目标"
      >
        {tenants.map(tenant => (
          <option key={tenant.id} value={tenant.id}>
            {tenant.name}
          </option>
        ))}
      </select>
    </label>
  ) : null;

  // mount-once-visited：避免切换 section 时 panel 整体 unmount/mount 引发的数据
  // 重拉与闪烁。visited 只增不减；modal 整体关闭后随 shell unmount 一并回收。
  const [visitedTenantSections, setVisitedTenantSections] = useState<Set<TenantSection>>(() =>
    settingsOpen ? new Set([settingsSection]) : new Set(),
  );
  useEffect(() => {
    if (!settingsOpen) return;
    setVisitedTenantSections(prev => (prev.has(settingsSection) ? prev : new Set(prev).add(settingsSection)));
  }, [settingsOpen, settingsSection]);

  const visibleTenantSettingsSections = renderOrgAgents
    ? tenantSettingsSections
    : tenantSettingsSections.filter((section) => section.id !== "org-agents");

  const tenantSectionsToRender: { id: TenantSection; node: ReactNode }[] = [
    { id: "users", node: renderUsers(effectiveTenantId, currentTenant?.name) },
    { id: "skills", node: renderSkills(effectiveTenantId, currentTenant?.name) },
    ...(renderOrgAgents ? [{ id: "org-agents" as TenantSection, node: renderOrgAgents(effectiveTenantId, currentTenant?.name) }] : []),
    { id: "mcp", node: renderMcp() },
    { id: "billing", node: <TenantBillingPanel tenantId={effectiveTenantId} tenantName={currentTenant?.name} /> },
    { id: "files", node: renderFiles() },
    { id: "company", node: renderCompanyInfo(effectiveTenantId, currentTenant?.name) },
    { id: "settings", node: <TenantSettingsPanel tenantId={effectiveTenantId} /> },
  ];

  const settingsContent = (
    <>
      {tenantSectionsToRender.map(({ id, node }) => {
        if (!visitedTenantSections.has(id)) return null;
        const isActive = id === settingsSection;
        return (
          <div key={id} className={cn("h-full min-h-0", !isActive && "hidden")} aria-hidden={!isActive}>
            <Suspense fallback={<SettingsSectionFallback />}>
              {node}
            </Suspense>
          </div>
        );
      })}
    </>
  );

  const content = (() => {
    if (active === "usage") return renderUsage(effectiveTenantId);
    if (active === "qa") return <QaConsole tenantId={effectiveTenantId} />;
    if (active === "audit") return <AuditEventsPanel scope="tenant" tenantId={effectiveTenantId} tenantName={currentTenant?.name} />;
    return (
      <TenantOverviewSection
        tenantId={effectiveTenantId}
        onTenantChange={isPlatformAdmin ? setTargetTenantId : undefined}
        onNavigateUsage={() => setActive("usage")}
      />
    );
  })();

  const settingsModal = (
    <AdminSettingsModal open={settingsOpen} title="组织管理" description="" badge={isPlatformAdmin ? "平台管理员" : "组织管理员"} sections={visibleTenantSettingsSections} active={settingsSection} onActiveChange={onSettingsSectionChange} onClose={onSettingsClose} headerControl={tenantSwitcher}>
      {settingsContent}
    </AdminSettingsModal>
  );

  if (settingsOnly) return settingsModal;

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/20">
      {headerControlsPlacement === "inline" && (
        <div className="shrink-0 overflow-x-auto border-b bg-background px-3 py-2">
          <TenantAdminHeaderControls
            active={active}
            onActiveChange={setActive}
          />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-3 sm:p-4">
        {content}
      </div>
    </div>
  );
}

export function PlatformAdminShell({
  renderTenants,
  renderSignupConfig,
  renderModels,
  renderRemoteHands,
  renderToolControls,
  renderMemoryPolling,
  renderMcp,
  renderSkills,
  renderEfficiency,
  activeSection,
  entityId,
  onSectionChange,
  settingsOpen,
  settingsSection,
  onSettingsSectionChange,
  onSettingsClose,
  settingsOnly = false,
  headerControlsPlacement = "inline",
}: {
  renderTenants: () => ReactNode;
  renderSignupConfig?: () => ReactNode;
  renderModels: () => ReactNode;
  renderRemoteHands: () => ReactNode;
  renderToolControls: () => ReactNode;
  renderMemoryPolling: () => ReactNode;
  renderMcp: () => ReactNode;
  renderSkills: () => ReactNode;
  renderEfficiency: () => ReactNode;
  activeSection: PlatformAdminSection;
  entityId: string | null;
  onSectionChange: (section: PlatformAdminSection, entityId?: string | null) => void;
  settingsOpen: boolean;
  settingsSection: PlatformSection;
  onSettingsSectionChange: (section: PlatformSection) => void;
  onSettingsClose: () => void;
  /** 仅渲染设置 modal，不渲染背后的分析页；用于从任意页面打开管理弹窗时保持原页面不变。 */
  settingsOnly?: boolean;
  headerControlsPlacement?: "inline" | "none";
}) {
  // 委托平台管理员：客户域操作按能力授权，平台全局配置仍仅 @admin 可写。
  const { platformReadOnly } = useAuth();
  // mount-once-visited（与 TenantAdminShell 同模式）
  const [visitedPlatformSections, setVisitedPlatformSections] = useState<Set<PlatformSection>>(() =>
    settingsOpen ? new Set([settingsSection]) : new Set(),
  );
  useEffect(() => {
    if (!settingsOpen) return;
    setVisitedPlatformSections(prev => (prev.has(settingsSection) ? prev : new Set(prev).add(settingsSection)));
  }, [settingsOpen, settingsSection]);

  const platformSectionsToRender: { id: PlatformSection; node: ReactNode }[] = [
    { id: "tenants", node: renderTenants() },
    { id: "signup", node: renderSignupConfig ? renderSignupConfig() : null },
    { id: "models", node: renderModels() },
    { id: "billing", node: <PlatformBillingManager /> },
    { id: "remote-hands", node: renderRemoteHands() },
    { id: "tool-controls", node: renderToolControls() },
    { id: "agent-profiles", node: <AgentRuntimeProfilesManagerPanel /> },
    { id: "system-prompts", node: <SystemPromptsManagerPanel /> },
    { id: "memory-polling", node: renderMemoryPolling() },
    { id: "global-mcp", node: renderMcp() },
    { id: "skill-pool", node: renderSkills() },
    { id: "system", node: <SystemSettingsPanel /> },
  ];

  const settingsContent = (
    <div className="flex h-full min-h-0 flex-col">
      {/* 委托运营提示条 */}
      {platformReadOnly && (
        <div className="mb-3 shrink-0 rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          委托运营账号：客户与运维操作按授权开放；平台全局配置、原始会话内容和高风险删除仍需 @admin 执行。
        </div>
      )}
      <div className="min-h-0 flex-1">
        {platformSectionsToRender.map(({ id, node }) => {
          if (!visitedPlatformSections.has(id)) return null;
          const isActive = id === settingsSection;
          return (
            <div key={id} className={cn("h-full min-h-0", !isActive && "hidden")} aria-hidden={!isActive}>
              <Suspense fallback={<SettingsSectionFallback />}>
                {node}
              </Suspense>
            </div>
          );
        })}
      </div>
    </div>
  );

  const content = (() => {
    if (activeSection === "audit") return <AuditEventsPanel scope="platform" />;
    if (activeSection === "overview") return <OverviewPage />;
    if (activeSection === "tenants") return <TenantsPage tenantId={entityId} />;
    if (activeSection === "users") return <UsersPage userId={entityId} />;
    if (activeSection === "sessions") return <SessionsPage sessionId={entityId} />;
    if (activeSection === "runs") {
      return <RunTraceExplorer runId={entityId} onRunIdChange={(next) => {
        pushPlatformAdminUrl({ section: "runs", entityId: next, search: window.location.search });
        window.dispatchEvent(new PopStateEvent("popstate"));
      }} />;
    }
    if (activeSection === "sandboxes") return <SandboxesPage sandboxName={entityId} />;
    if (activeSection === "infra") return <InfraPage />;
    return renderEfficiency();
  })();

  const settingsModal = (
    <AdminSettingsModal open={settingsOpen} title="平台管理" description="" badge="平台管理员" sections={platformSettingsSections} active={settingsSection} onActiveChange={onSettingsSectionChange} onClose={onSettingsClose}>
      {settingsContent}
    </AdminSettingsModal>
  );

  if (settingsOnly) return settingsModal;

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/20">
      {headerControlsPlacement === "inline" && (
        <div className="shrink-0 overflow-x-auto border-b bg-background px-3 py-2">
          <PlatformAdminHeaderControls
            active={activeSection}
            onActiveChange={(section) => onSectionChange(section)}
            className="md:min-w-[720px]"
            searchClassName="md:w-72 md:min-w-72"
          />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-3 sm:p-4">
        {content}
      </div>
    </div>
  );
}
