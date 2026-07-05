import { Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { BarChart3, Building2, Cpu, Database, FileText, Gauge, Globe2, KeyRound, ListTree, Loader2, Plug, Puzzle, RefreshCw, ServerCog, ShieldCheck, Info, UserPlus, Users, X, Activity, WalletCards } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { DEFAULT_TENANT_ID, DEFAULT_TENANT_SETTINGS, type TenantSettings } from "@/components/TenantManager/types";
import type { ModelList } from "@/types/models";
import { PlatformBillingManager, TenantBillingPanel } from "@/components/BillingManager";
import { RunTraceExplorer } from "@/components/RunTraceExplorer";

export type TenantSection = "overview" | "users" | "skills" | "mcp" | "usage" | "billing" | "files" | "audit" | "settings" | "company";
export type PlatformSection = "overview" | "tenants" | "signup" | "models" | "billing" | "remote-hands" | "runtime" | "run-trace" | "tool-controls" | "global-mcp" | "skill-pool" | "security" | "system";

interface ShellButton<T extends string> {
  id: T;
  label: string;
  icon: typeof Gauge;
  platformOnly?: boolean;
}

const tenantAnalysisSections: ShellButton<TenantSection>[] = [
  { id: "overview", label: "概览", icon: Gauge },
  { id: "usage", label: "用量与配额", icon: BarChart3 },
  { id: "audit", label: "审计", icon: FileText },
];

const tenantSettingsSections: ShellButton<TenantSection>[] = [
  { id: "users", label: "成员", icon: Users },
  { id: "skills", label: "Agent / Skill", icon: Puzzle },
  { id: "mcp", label: "MCP 工具", icon: Plug },
  { id: "billing", label: "计费", icon: WalletCards },
  { id: "files", label: "文件与数据", icon: Database },
  { id: "company", label: "公司信息", icon: Info },
  { id: "settings", label: "组织管理", icon: ShieldCheck },
];

const platformAnalysisSections: ShellButton<PlatformSection>[] = [
  { id: "overview", label: "概览", icon: Gauge },
  { id: "security", label: "平台审计", icon: ShieldCheck },
];

const SETTINGS_NAV_ITEM_SELECTED =
  "relative bg-brand-accent-soft text-foreground font-semibold " +
  "before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 " +
  "before:h-5 before:w-[3px] before:rounded-r-full before:bg-brand-accent";
const SETTINGS_NAV_ITEM_UNSELECTED =
  "text-muted-foreground hover:bg-muted/60 hover:text-foreground";

const platformSettingsSections: ShellButton<PlatformSection>[] = [
  { id: "tenants", label: "组织", icon: Building2 },
  { id: "signup", label: "注册管理", icon: UserPlus },
  { id: "models", label: "模型", icon: Cpu },
  { id: "billing", label: "计费", icon: WalletCards },
  { id: "remote-hands", label: "执行环境池", icon: ServerCog },
  { id: "runtime", label: "运行态", icon: Activity },
  { id: "run-trace", label: "Run 追踪", icon: ListTree },
  { id: "tool-controls", label: "工具开关", icon: Globe2 },
  { id: "global-mcp", label: "全局 MCP", icon: KeyRound },
  { id: "skill-pool", label: "Skill 池", icon: Puzzle },
  { id: "system", label: "系统配置", icon: Database },
];

function ShellFrame<T extends string>({
  title,
  description,
  badge,
  sections,
  active,
  onActiveChange,
  children,
}: {
  title: string;
  description: string;
  badge?: string;
  sections: ShellButton<T>[];
  active: T;
  onActiveChange: (id: T) => void;
  children: ReactNode;
}) {
  return (
    <div className="h-full overflow-auto bg-muted/20 p-4 sm:p-6">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        <div className="rounded-3xl border bg-card p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold">{title}</h2>
                {badge && <Badge variant="secondary">{badge}</Badge>}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            </div>
          </div>
          <nav className="mt-4 flex flex-wrap gap-2" aria-label={`${title} 页面菜单`}>
            {sections.map(item => {
              const Icon = item.icon;
              const selected = item.id === active;
              return (
                <Button
                  key={item.id}
                  type="button"
                  size="sm"
                  variant={selected ? "default" : "outline"}
                  onClick={() => onActiveChange(item.id)}
                  className="shrink-0 gap-2"
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Button>
              );
            })}
          </nav>
        </div>
        {children}
      </div>
    </div>
  );
}

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
  if (!open) return null;
  const activeItem = sections.find(item => item.id === active) ?? sections[0];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-8 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="flex h-[min(920px,calc(100vh-96px))] w-[min(1184px,calc(100vw-64px))] overflow-hidden rounded-3xl border bg-background shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <aside className="flex w-40 shrink-0 flex-col border-r bg-muted/20 p-3">
          <div className="mb-4 px-1">
            <div className="flex items-center gap-2">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white">
                <ShieldCheck className="h-5 w-5" />
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
                    onClick={() => onActiveChange(item.id)}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>
        <main className="relative flex min-w-0 flex-1 flex-col">
          <button type="button" className="absolute right-5 top-5 z-30 rounded-full p-2 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={onClose} aria-label={`关闭${title}`}>
            <X className="h-5 w-5" />
          </button>
          <div className="min-h-0 flex-1 overflow-hidden p-8 pt-5">
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
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
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

function SettingSwitch({ label, description, checked, onCheckedChange }: { label: string; description: string; checked: boolean; onCheckedChange: (checked: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border p-3">
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs leading-5 text-muted-foreground">{description}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

function TenantSettingsPanel({ tenantId }: { tenantId: string }) {
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
        actions={<Button onClick={() => { void save(); }} disabled={loading || saving}>{saving ? "保存中..." : "保存设置"}</Button>}
      />
      <div className="min-h-0 flex-1 space-y-5 overflow-auto">
      {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
      {saved && <div className="rounded-md bg-success/10 px-3 py-2 text-sm text-success">组织管理已保存</div>}
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">功能开关</CardTitle></CardHeader>
          <CardContent className="grid gap-3">
            <SettingSwitch label="文件能力" description="允许组织用户访问文件浏览、上传和预览。" checked={settings.features.filesEnabled} onCheckedChange={checked => patch(d => { d.features.filesEnabled = checked; })} />
            <SettingSwitch label="定时任务" description="允许创建和运行 Cron 自动化任务。" checked={settings.features.cronEnabled} onCheckedChange={checked => patch(d => { d.features.cronEnabled = checked; })} />
            <SettingSwitch label="MCP 工具" description="允许组织使用 MCP server 与工具密钥。" checked={settings.features.mcpEnabled} onCheckedChange={checked => patch(d => { d.features.mcpEnabled = checked; })} />
            <SettingSwitch label="自定义 Skill" description="允许用户维护自定义 Agent Skill。" checked={settings.features.customSkillsEnabled} onCheckedChange={checked => patch(d => { d.features.customSkillsEnabled = checked; })} />
            <SettingSwitch label="Debug 模式" description="允许开启思考、工具和执行细节展示。" checked={settings.features.debugModeAllowed} onCheckedChange={checked => patch(d => { d.features.debugModeAllowed = checked; })} />
            <SettingSwitch label="自动压缩上下文" description="会话上下文超过模型窗口 80% 时，回合结束后自动压缩（还需模型配置 context_window）。" checked={settings.features.autoCompactEnabled} onCheckedChange={checked => patch(d => { d.features.autoCompactEnabled = checked; })} />
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
            <SettingSwitch label="允许组织 MCP" description="允许组织管理员维护本组织共享 MCP server。" checked={settings.mcp.allowTenantServers} onCheckedChange={checked => patch(d => { d.mcp.allowTenantServers = checked; })} />
            <SettingSwitch label="允许全局 MCP" description="允许组织用户使用平台全局 MCP server。" checked={settings.mcp.allowGlobalServers} onCheckedChange={checked => patch(d => { d.mcp.allowGlobalServers = checked; })} />
            <div className="space-y-1.5">
              <Label>默认启用 MCP server ID</Label>
              <textarea className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm" value={defaultMcpText} onChange={event => { setDefaultMcpText(event.target.value); setSaved(false); }} placeholder="每行一个 server id" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">品牌</CardTitle></CardHeader>
          <CardContent className="grid gap-3">
            <div className="space-y-1.5"><Label>显示名称</Label><Input value={settings.branding.displayName ?? ""} onChange={event => patch(d => { d.branding.displayName = event.target.value.trim() || undefined; })} /></div>
            <div className="space-y-1.5"><Label>Logo URL</Label><Input value={settings.branding.logoUrl ?? ""} onChange={event => patch(d => { d.branding.logoUrl = event.target.value.trim() || undefined; })} /></div>
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
      </div>
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
  session_opened: "查看会话",
  session_soft_deleted: "移入回收站",
  session_restored: "恢复会话",
  session_permanently_deleted: "永久删除",
  session_renamed: "重命名会话",
  session_forked: "复刻会话",
  group_created: "创建分组",
  group_updated: "更新分组",
  group_deleted: "删除分组",
  group_sessions_added: "分组添加会话",
  group_sessions_removed: "分组移除会话",
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
  mcp_user_selections_updated: "更新 MCP 选择",
  mcp_secret_bound: "绑定 MCP 密钥",
  mcp_server_updated: "更新 MCP 服务",
  mcp_server_deleted: "删除 MCP 服务",
  mcp_admin_user_selections_updated: "管理员更新 MCP",
  skill_document_updated: "更新 Skill 文档",
  skill_visibility_updated: "更新 Skill 可见性",
  skill_promoted: "发布 Skill",
  skill_custom_deleted: "删除自定义 Skill",
  skill_user_selections_updated: "更新 Skill 选择",
};

const auditCategories = [
  { value: "", label: "全部事件" },
  { value: "login", label: "登录" },
  { value: "activity", label: "活动" },
  { value: "session", label: "会话" },
  { value: "group", label: "分组" },
  { value: "cron", label: "定时任务" },
  { value: "user", label: "用户管理" },
  { value: "file", label: "文件" },
  { value: "agent", label: "Agent" },
  { value: "skill", label: "Skill" },
  { value: "mcp", label: "MCP" },
  { value: "tenant", label: "组织" },
];

const auditChannels = [
  { value: "", label: "全部渠道" },
  { value: "web", label: "Web" },
  { value: "mobile", label: "Mobile" },
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

function auditEventLabel(event: string): string {
  return AUDIT_EVENT_LABELS[event] || event;
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
  const [category, setCategory] = useState("");
  const [channel, setChannel] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const tenantUsers = useMemo(
    () => tenantId ? users.filter(user => user.tenantId === tenantId) : users,
    [tenantId, users],
  );
  const tenantUsernames = useMemo(() => tenantUsers.map(user => user.username), [tenantUsers]);
  const filters: LoginLogFilters = useMemo(() => ({
    username: scope === "tenant" ? (tenantUsernames.length > 0 ? tenantUsernames : ["__empty_tenant__"]) : undefined,
    category: category || undefined,
    channel: channel || undefined,
    startTime: startDate ? new Date(startDate).toISOString() : undefined,
    endTime: endDate ? new Date(`${endDate}T23:59:59.999Z`).toISOString() : undefined,
  }), [category, channel, endDate, scope, startDate, tenantUsernames]);

  const { entries, total, loading, error, offset, limit, refresh, nextPage, prevPage } = useLoginLogs(filters);
  const userMap = useMemo(() => new Map(users.map(user => [user.username, user])), [users]);
  const uniqueActors = useMemo(() => new Set(entries.map(entry => entry.username)).size, [entries]);
  const failures = entries.filter(entry => entry.event === "login_fail").length;
  const adminOps = entries.filter(entry => entry.event.includes("_") && !["login_success", "login_fail", "page_viewed", "app_foreground", "app_background"].includes(entry.event)).length;

  useEffect(() => { void refresh(); }, [refresh]);

  const emptyTenant = scope === "tenant" && tenantUsernames.length === 0;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5">
      <SettingsPanelHeader
        title={scope === "tenant" ? "组织审计" : "平台审计"}
        description={scope === "tenant"
          ? `查看 ${tenantName || tenantId || "当前组织"} 的登录、成员、文件、工具和配置变更记录。`
          : "查看跨组织登录、用户、组织、工具、Skill、文件和运行时相关操作记录。"}
        actions={<Button variant="outline" onClick={() => { void refresh(); }} disabled={loading}><RefreshCw className={cn("mr-2 h-4 w-4", loading && "animate-spin")} />刷新</Button>}
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
        <CardContent className="grid gap-3 md:grid-cols-5">
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

      {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
      {emptyTenant && <div className="rounded-md bg-warning/10 px-3 py-2 text-sm text-warning">当前组织暂无成员，审计列表为空。</div>}

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle className="text-base">事件列表</CardTitle>
          <div className="text-xs text-muted-foreground">第 {Math.floor(offset / limit) + 1} 页 · {offset + 1}-{Math.min(offset + entries.length, total)} / {total}</div>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />加载审计事件...
            </div>
          ) : entries.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">暂无审计事件</div>
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
                  return (
                    <TableRow key={`${entry.timestamp}-${entry.username}-${entry.event}-${index}`}>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatAuditTime(entry.timestamp)}</TableCell>
                      <TableCell><Badge className={auditEventBadgeClass(entry.event)}>{auditEventLabel(entry.event)}</Badge></TableCell>
                      <TableCell>
                        <div className="font-medium">{actor?.realName || entry.username}</div>
                        <div className="text-xs text-muted-foreground">{entry.username}</div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{actor?.tenantId || (scope === "tenant" ? tenantId : "-")}</TableCell>
                      <TableCell>
                        <div className="text-xs">{entry.channel}</div>
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

function PlaceholderAdminPanel({ title, description, points }: { title: string; description: string; points: string[] }) {
  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <SettingsPanelHeader title={title} description={description} />
      <div className="min-h-0 flex-1 overflow-auto">
      <Card>
        <CardContent className="p-5">
          <div className="grid gap-3 md:grid-cols-2">
            {points.map(point => <div key={point} className="rounded-xl border bg-muted/20 p-3 text-sm text-muted-foreground">{point}</div>)}
          </div>
        </CardContent>
      </Card>
      </div>
    </div>
  );
}

export function TenantAdminShell({
  renderUsers,
  renderSkills,
  renderMcp,
  renderUsage,
  renderFiles,
  renderCompanyInfo,
  settingsOpen,
  settingsSection,
  onSettingsSectionChange,
  onSettingsClose,
  settingsOnly = false,
}: {
  renderUsers: (tenantId?: string, tenantName?: string) => ReactNode;
  renderSkills: (tenantId?: string, tenantName?: string) => ReactNode;
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
}) {
  const { user, isPlatformAdmin } = useAuth();
  const { users } = useUsers();
  const { tenants } = useTenants();
  const [active, setActive] = useState<TenantSection>("overview");
  const [targetTenantId, setTargetTenantId] = useState(user?.tenantId ?? "");

  useEffect(() => {
    if (!targetTenantId && user?.tenantId) setTargetTenantId(user.tenantId);
  }, [targetTenantId, user?.tenantId]);

  const effectiveTenantId = isPlatformAdmin ? targetTenantId || user?.tenantId || "" : user?.tenantId || "";
  const currentTenant = tenants.find(t => t.id === effectiveTenantId);
  const tenantUsers = useMemo(() => users.filter(u => u.tenantId === effectiveTenantId), [users, effectiveTenantId]);
  const admins = tenantUsers.filter(u => u.role === "admin");
  const disabledUsers = tenantUsers.filter(u => u.disabled);

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

  const tenantSectionsToRender: { id: TenantSection; node: ReactNode }[] = [
    { id: "users", node: renderUsers(effectiveTenantId, currentTenant?.name) },
    { id: "skills", node: renderSkills(effectiveTenantId, currentTenant?.name) },
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
    if (active === "audit") return <AuditEventsPanel scope="tenant" tenantId={effectiveTenantId} tenantName={currentTenant?.name} />;
    return (
      <div className="mx-auto w-full max-w-5xl space-y-5">
        <SettingsPanelHeader
          title="组织分析"
          description="保留组织概览、用量与配额、审计分析；成员、工具与组织管理收敛到头像菜单的设置入口。"
          actions={isPlatformAdmin && tenants.length > 0 ? (
            <select className="h-9 rounded-md border bg-background px-3 text-sm" value={effectiveTenantId} onChange={event => setTargetTenantId(event.target.value)}>
              {tenants.map(tenant => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}
            </select>
          ) : undefined}
        />
        <div className="rounded-2xl border bg-card p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm text-muted-foreground">当前组织</div>
              <div className="mt-1 text-xl font-semibold">{currentTenant?.name || effectiveTenantId || "当前组织"}</div>
              <div className="text-sm text-muted-foreground">slug: {effectiveTenantId || "-"}</div>
            </div>
            <Badge variant={currentTenant?.disabled ? "destructive" : "secondary"}>{currentTenant?.disabled ? "已禁用" : "启用中"}</Badge>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard title="成员" value={tenantUsers.length} description="当前组织用户总数" />
          <MetricCard title="管理员" value={admins.length} description="可管理组织能力的账号" />
          <MetricCard title="已禁用" value={disabledUsers.length} description="当前不可登录账号" />
          <MetricCard title="管理范围" value={isPlatformAdmin ? "跨组织" : "本组织"} description="由当前角色决定" />
        </div>
      </div>
    );
  })();

  const settingsModal = (
    <AdminSettingsModal open={settingsOpen} title="组织管理" description="" badge={isPlatformAdmin ? "平台 Admin" : "组织 Admin"} sections={tenantSettingsSections} active={settingsSection} onActiveChange={onSettingsSectionChange} onClose={onSettingsClose} headerControl={tenantSwitcher}>
      {settingsContent}
    </AdminSettingsModal>
  );

  if (settingsOnly) return settingsModal;

  return (
    <>
      <ShellFrame title="组织分析" description="组织级概览、用量与审计" badge={isPlatformAdmin ? "平台 Admin" : "组织 Admin"} sections={tenantAnalysisSections} active={active} onActiveChange={setActive}>{content}</ShellFrame>
    </>
  );
}

export function PlatformAdminShell({
  renderTenants,
  renderSignupConfig,
  renderModels,
  renderRemoteHands,
  renderRuntimeOperations,
  renderToolControls,
  renderMcp,
  renderSkills,
  renderUsage,
  settingsOpen,
  settingsSection,
  onSettingsSectionChange,
  onSettingsClose,
  settingsOnly = false,
}: {
  renderTenants: () => ReactNode;
  renderSignupConfig?: () => ReactNode;
  renderModels: () => ReactNode;
  renderRemoteHands: () => ReactNode;
  renderRuntimeOperations: () => ReactNode;
  renderToolControls: () => ReactNode;
  renderMcp: () => ReactNode;
  renderSkills: () => ReactNode;
  renderUsage: () => ReactNode;
  settingsOpen: boolean;
  settingsSection: PlatformSection;
  onSettingsSectionChange: (section: PlatformSection) => void;
  onSettingsClose: () => void;
  /** 仅渲染设置 modal，不渲染背后的分析页；用于从任意页面打开管理弹窗时保持原页面不变。 */
  settingsOnly?: boolean;
}) {
  const { users } = useUsers();
  const { tenants } = useTenants();
  const [active, setActive] = useState<PlatformSection>("overview");
  const activeTenants = tenants.filter(t => !t.disabled);
  const platformAdmins = users.filter(u => u.role === "admin" && u.tenantId === DEFAULT_TENANT_ID);

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
    { id: "runtime", node: renderRuntimeOperations() },
    { id: "run-trace", node: <RunTraceExplorer /> },
    { id: "tool-controls", node: renderToolControls() },
    { id: "global-mcp", node: renderMcp() },
    { id: "skill-pool", node: renderSkills() },
    { id: "system", node: <PlaceholderAdminPanel title="系统配置" description="平台运行参数、集成、备份、存储和健康检查。" points={["钉钉与外部集成配置", "存储、备份、恢复与数据保留", "系统版本、健康检查、队列和任务状态", "平台公告、维护窗口和运营参数"]} /> },
  ];

  const settingsContent = (
    <>
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
    </>
  );

  const content = (() => {
    if (active === "security") return <AuditEventsPanel scope="platform" />;
    return (
      <div className="mx-auto w-full max-w-5xl space-y-5">
        <SettingsPanelHeader title="平台分析" description="保留平台概览和平台审计分析；组织、模型、Web 工具、全局 MCP、Skill 池和系统配置收敛到头像菜单的设置入口。" />
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard title="组织总数" value={tenants.length} description="包含已禁用组织" />
          <MetricCard title="活跃组织" value={activeTenants.length} description="当前可接入资源" />
          <MetricCard title="用户总数" value={users.length} description="跨组织账号总数" />
          <MetricCard title="平台管理员" value={platformAdmins.length} description="默认平台组织管理员" />
        </div>
        <div className="rounded-2xl border bg-card p-5 shadow-sm">
          <h3 className="text-sm font-semibold">全局管理入口</h3>
          <p className="mt-1 text-sm text-muted-foreground">组织、模型、Web 工具、全局 MCP、Skill 池和平台审计已从个人设置中心迁移到这里。</p>
        </div>
        {renderUsage()}
      </div>
    );
  })();

  const settingsModal = (
    <AdminSettingsModal open={settingsOpen} title="平台管理" description="" badge="平台 Admin" sections={platformSettingsSections} active={settingsSection} onActiveChange={onSettingsSectionChange} onClose={onSettingsClose}>
      {settingsContent}
    </AdminSettingsModal>
  );

  if (settingsOnly) return settingsModal;

  return (
    <>
      <ShellFrame title="平台分析" description="跨组织概览与平台审计" badge="平台 Admin" sections={platformAnalysisSections} active={active} onActiveChange={setActive}>{content}</ShellFrame>
    </>
  );
}
