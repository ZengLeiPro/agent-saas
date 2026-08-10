import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, Loader2, X, type LucideIcon } from "lucide-react";
import { EntityIcons } from "@/lib/icons";
import { AdminSelect, type AdminSelectOption } from "@/components/ui/admin-select";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SETTINGS_CONTENT_WIDTH, SettingsPanelHeader, SettingsPanelHeaderStickyProvider } from "@/components/SettingsCenter/SettingsPanelHeader";
import { useAuth } from "@/contexts/AuthContext";
import { useTenants } from "@/components/TenantManager/hooks";
import { authFetch } from "@/lib/authFetch";
import { refreshAll } from "@/lib/refreshBus";
import { cn } from "@/lib/utils";
import { DEFAULT_TENANT_ID, DEFAULT_TENANT_SETTINGS, type TenantSettings } from "@/components/TenantManager/types";
import type { ModelList } from "@/types/models";
import { PlatformBillingManager, TenantBillingPanel } from "@/components/BillingManager";
import { HISTORY_PUSH, useAdminUrlQuery } from "@/hooks/useAdminUrlQuery";
import { decideFocusTrap, findFocusables } from "@/lib/focusTrap";
import { navigateGovernance, navigatePlatformAdmin, type PlatformAdminSection } from "@/lib/urlSync";
import { GovernanceCapabilityNotice } from "@/components/GovernanceConsole";
import { filterCustomerOrganizations, governanceRoute as makeGovernanceRoute, type GovernanceRouteState } from "@/lib/governanceNavigation";
import { PlatformAdminHeaderControls } from "@/components/PlatformAdmin/PlatformAdminHeaderControls";
import { TenantAdminHeaderControls } from "@/components/TenantAdminHeaderControls";
import { InfraPage, OverviewPage, SandboxesPage, SessionsPage, TenantsPage, UsersPage } from "@/components/PlatformAdmin/pages";
import { SystemSettingsPanel } from "@/components/PlatformAdmin/SystemSettingsPanel";
import { RunTraceExplorer } from "@/components/RunTraceExplorer";
import { OverviewSection as TenantOverviewSection } from "@/components/TenantAnalytics/OverviewSection";
import { QaConsole } from "@/components/QaConsole";
import { AuditEventsPanel } from "@/components/GovernanceAuditPanel";
import { GovernanceChangeAuditPage } from "@/components/Governance/GovernanceChangeAuditPage";
import {
  OrganizationCredentialsPage,
  OrganizationGovernancePlaceholder,
  OrganizationMembersPage,
  OrganizationPoliciesPage,
} from "@/components/OrganizationGovernance/OrganizationGovernancePage";
import {
  PlatformAdminsPage,
  PlatformGovernanceUnavailablePage,
  PlatformOrganizationGovernance,
} from "@/components/PlatformGovernance/PlatformGovernancePage";

// 直接内嵌而不走 render prop：本面板只依赖 tenantId/tenantName，走 prop 就得在
// Desktop 两处 + Mobile 两处各传一遍，漏一处该 section 会空白（见 renderOrgAgents 注释）。
const TenantInstructionsPanel = lazy(() => import("@/components/TenantInstructionsEditor")
  .then((m) => ({ default: m.TenantInstructionsSection })));
const SystemPromptsManagerPanel = lazy(() => import("@/components/SystemPromptsManager"));
const AgentRuntimeProfilesManagerPanel = lazy(() => import("@/components/AgentRuntimeProfilesManager"));
const EgressConfigManagerPanel = lazy(() => import("@/components/EgressConfigManager"));
const ConnectorDictionaryManagerPanel = lazy(() => import("@/components/ConnectorDictionaryManager"));
const TenantConnectorDictionaryPanel = lazy(() => import("@/components/ConnectorDictionaryManager/TenantPanel"));

export type TenantSection = "overview" | "users" | "skills" | "org-agents" | "mcp" | "connector-dictionary" | "usage" | "billing" | "files" | "qa" | "audit" | "settings" | "company" | "instructions";
export type PlatformSection = "tenants" | "signup" | "models" | "billing" | "remote-hands" | "tool-controls" | "connector-dictionary" | "agent-profiles" | "system-prompts" | "memory-polling" | "global-mcp" | "skill-pool" | "egress" | "system";

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
  { id: "connector-dictionary", label: "连接器映射", icon: EntityIcons.connector },
  { id: "billing", label: "计费", icon: EntityIcons.billing },
  { id: "files", label: "文件与数据", icon: EntityIcons.files },
  { id: "company", label: "公司信息", icon: EntityIcons.companyInfo },
  { id: "instructions", label: "自定义规则", icon: EntityIcons.tenantInstructions },
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
  { id: "connector-dictionary", label: "连接器映射", icon: EntityIcons.connector },
  { id: "agent-profiles", label: "系统 Agent", icon: EntityIcons.runtimePool },
  { id: "system-prompts", label: "系统提示语", icon: EntityIcons.systemPrompts },
  { id: "memory-polling", label: "记忆轮询", icon: EntityIcons.memoryPolling },
  { id: "global-mcp", label: "全局 MCP", icon: EntityIcons.connector },
  { id: "skill-pool", label: "技能池", icon: EntityIcons.skill },
  { id: "egress", label: "网络出口", icon: EntityIcons.egress },
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
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (open) setMobileView("menu");
  }, [open]);

  /**
   * 打开时把焦点移进面板，关闭时还给触发它的元素。
   * 不做的话：打开后第一次按 Tab 之前，焦点还留在背后的页面上，屏幕阅读器会继续
   * 念背景内容；关闭后焦点掉到 body，键盘用户得从头 Tab 一遍才能回到原来的位置。
   */
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel) return;
      findFocusables(panel)[0]?.focus();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      previouslyFocused?.focus?.();
    };
  }, [open]);

  /**
   * Esc 关闭 + 焦点陷阱。
   *
   * 这个组件标了 `role="dialog" aria-modal="true"`，但改造前**没有任何键盘处理**：
   * 按 Esc 关不掉（点遮罩才行），Tab 会一路跑到模态背后的页面上去——对屏幕阅读器
   * 和纯键盘用户，这个「模态」等于没关住。声明了 aria-modal 却不实现对应行为，
   * 比不声明更糟。
   *
   * 没有引 Radix Dialog 重写：这个壳有移动端两级导航、自定义栅格与安全区内边距，
   * 换壳的爆炸半径远大于补两个 handler。
   */
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      // 决策逻辑抽在 lib/focusTrap（可单测，不必渲染整个管理壳），这里只绑定与执行
      const decision = decideFocusTrap({
        container: panel,
        activeElement: document.activeElement,
        shiftKey: event.shiftKey,
      });
      if (decision.preventDefault) event.preventDefault();
      decision.focus?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;
  const activeItem = sections.find(item => item.id === active) ?? sections[0];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 backdrop-blur-sm md:p-8" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div ref={panelRef} className="flex h-full w-full overflow-hidden bg-background pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] shadow-2xl md:h-[min(920px,calc(100vh-96px))] md:w-[min(1184px,calc(100vw-64px))] md:rounded-3xl md:border md:pb-0 md:pt-0" onClick={(event) => event.stopPropagation()}>
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

// 本地 MetricCard 已删除，统一用 `PlatformAdmin/common` 的那一套（S3-7）。
// 差异：改用 Card 的 compact 密度 + 数值带 tabular-nums，审计的 4 张卡口径文字不变。


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

  const defaultModelOptions: AdminSelectOption[] = [
    { value: "", label: "继承平台默认" },
    ...modelOptions.map(model => ({ value: model.ref, label: model.label })),
  ];

  const toggleAllowedModel = useCallback((modelRef: string, checked: boolean) => {
    patch(d => {
      d.models.allowedModels = checked
        ? Array.from(new Set([...d.models.allowedModels, modelRef]))
        : d.models.allowedModels.filter(ref => ref !== modelRef);
      if (d.models.defaultModel === modelRef && !checked) d.models.defaultModel = undefined;
    });
  }, [patch]);

  return (
    <div className={cn("flex h-full min-h-0 flex-col", SETTINGS_CONTENT_WIDTH)}>
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
              <AdminSelect
                ariaLabel="默认模型"
                size="md"
                className="w-full"
                options={defaultModelOptions}
                value={settings.models.defaultModel ?? ""}
                onValueChange={value => patch(d => { d.models.defaultModel = value || undefined; })}
              />
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
  governanceRoute,
  governanceContentOnly = false,
  renderAutomation,
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
  governanceRoute?: GovernanceRouteState | null;
  governanceContentOnly?: boolean;
  renderAutomation?: () => ReactNode;
}) {
  const { user, isPlatformAdmin } = useAuth();
  const { tenants: allTenants } = useTenants();
  const tenants = filterCustomerOrganizations(allTenants);
  const [internalActive, setInternalActive] = useState<TenantSection>("overview");
  const active = activeAnalysisSection ?? internalActive;
  const setActive = onAnalysisSectionChange ?? setInternalActive;
  // 组织切换器（仅平台管理员可见）进 URL：`org` 是业务可读参数名，
  // 分享出去的组织分析链接必须落到同一个组织，而不是分享者自己的默认组织。
  const shellUrl = useAdminUrlQuery();
  const urlTenantId = governanceRoute?.orgId ?? shellUrl.get("org") ?? "";
  const [fallbackTenantId, setFallbackTenantId] = useState(user?.tenantId ?? "");
  const targetTenantId = urlTenantId || fallbackTenantId;
  const setTargetTenantId = useCallback(
    (next: string) => shellUrl.set("org", next || null, HISTORY_PUSH),
    [shellUrl],
  );

  useEffect(() => {
    if (!fallbackTenantId && user?.tenantId) setFallbackTenantId(user.tenantId);
  }, [fallbackTenantId, user?.tenantId]);

  // 管理弹窗路径（/tenant-admin/settings/*）不带 search，`org` 会暂时消失；
  // 把最近一次的选择记进 fallback，避免打开再关闭管理弹窗后被打回自己的组织。
  useEffect(() => {
    if (urlTenantId) setFallbackTenantId(urlTenantId);
  }, [urlTenantId]);

  const effectiveTenantId = isPlatformAdmin
    ? targetTenantId || tenants[0]?.id || ""
    : user?.tenantId || "";
  const currentTenant = tenants.find(t => t.id === effectiveTenantId);
  const tenantSwitcherOptions: AdminSelectOption[] = tenants.map(tenant => ({
    value: tenant.id,
    label: tenant.name,
  }));

  const tenantSwitcher = isPlatformAdmin && tenants.length > 0 ? (
    // label 包裹的是自定义控件而非原生 select，因此这里的文案改用 span + aria-label 关联
    <div className="block space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">当前组织</span>
      <AdminSelect
        ariaLabel="切换组织管理目标"
        size="md"
        className="w-full"
        options={tenantSwitcherOptions}
        value={effectiveTenantId}
        onValueChange={setTargetTenantId}
      />
    </div>
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
    { id: "connector-dictionary" as TenantSection, node: <TenantConnectorDictionaryPanel tenantId={effectiveTenantId} tenantName={currentTenant?.name} /> },
    { id: "billing", node: <TenantBillingPanel tenantId={effectiveTenantId} tenantName={currentTenant?.name} /> },
    { id: "files", node: renderFiles() },
    { id: "company", node: renderCompanyInfo(effectiveTenantId, currentTenant?.name) },
    { id: "instructions", node: <TenantInstructionsPanel tenantId={effectiveTenantId} tenantName={currentTenant?.name} /> },
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

  const governanceContent = (() => {
    if (!governanceRoute) return null;
    if (!effectiveTenantId) return <GovernanceCapabilityNotice title="组织作用域" mode="readonly" />;
    switch (governanceRoute.routeId) {
      case "organization.overview.overview":
        return <TenantOverviewSection tenantId={effectiveTenantId} />;
      case "organization.members.list":
      case "organization.members.owners":
      case "organization.members.member":
        return <OrganizationMembersPage tenantId={effectiveTenantId} route={governanceRoute} />;
      case "organization.members.policies":
        return <OrganizationPoliciesPage tenantId={effectiveTenantId} />;
      case "organization.members.groups":
        return <OrganizationGovernancePlaceholder title="部门与群组" detail="目录 Group Resolver 与聚合成员接口尚未接入。" />;
      case "organization.members.offboarding":
        return <OrganizationGovernancePlaceholder title="离职撤权与资源交接" detail="完整资产转移和未交接清单 API 尚未达到 V2 合同。" />;
      case "organization.agents.org-agents":
        return renderOrgAgents ? renderOrgAgents(effectiveTenantId, currentTenant?.name) : <GovernanceCapabilityNotice title="组织 Agent" />;
      case "organization.agents.skills":
        return renderSkills(effectiveTenantId, currentTenant?.name);
      case "organization.agents.connectors":
        return <OrganizationCredentialsPage tenantId={effectiveTenantId} />;
      case "organization.agents.memory-knowledge":
        return <OrganizationGovernancePlaceholder title="Memory 与知识" detail="治理资源列表接口尚未提供，不能用个人 Memory 或旧知识列表代替。" />;
      case "organization.agents.model-tools":
        return <OrganizationPoliciesPage tenantId={effectiveTenantId} />;
      case "organization.agents.environments":
        return <OrganizationGovernancePlaceholder title="Environment 可用范围" detail="Environment Template 目录列表与可用范围选择器尚未接入。" />;
      case "organization.agents.files-data":
        return renderFiles();
      case "organization.governance.automation":
        return renderAutomation ? renderAutomation() : <GovernanceCapabilityNotice title="自动化任务" />;
      case "organization.governance.usage":
        return renderUsage(effectiveTenantId);
      case "organization.governance.qa":
        return <QaConsole tenantId={effectiveTenantId} />;
      case "organization.governance.audit":
        return <GovernanceChangeAuditPage tenantId={effectiveTenantId} />;
      case "organization.settings.profile":
        return renderCompanyInfo(effectiveTenantId, currentTenant?.name);
      case "organization.settings.rules":
        return <TenantInstructionsPanel tenantId={effectiveTenantId} tenantName={currentTenant?.name} />;
      case "organization.settings.brand":
        return <OrganizationGovernancePlaceholder title="品牌" detail="组织品牌设置仍在旧大表单中，尚未拆成治理独立写合同。" />;
      case "organization.settings.security":
        return <TenantSettingsPanel tenantId={effectiveTenantId} />;
      default:
        return <GovernanceCapabilityNotice title="该治理能力" />;
    }
  })();

  if (governanceContentOnly) {
    return <div className="min-h-full bg-muted/20 p-3 sm:p-4">{governanceContent}</div>;
  }

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
  governanceRoute,
  governanceContentOnly = false,
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
  governanceRoute?: GovernanceRouteState | null;
  governanceContentOnly?: boolean;
}) {
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
    { id: "connector-dictionary", node: <ConnectorDictionaryManagerPanel /> },
    { id: "agent-profiles", node: <AgentRuntimeProfilesManagerPanel /> },
    { id: "system-prompts", node: <SystemPromptsManagerPanel /> },
    { id: "memory-polling", node: renderMemoryPolling() },
    { id: "global-mcp", node: renderMcp() },
    { id: "skill-pool", node: renderSkills() },
    { id: "egress", node: <EgressConfigManagerPanel /> },
    { id: "system", node: <SystemSettingsPanel /> },
  ];

  const settingsContent = (
    <div className="flex h-full min-h-0 flex-col">
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

  const governanceContent = (() => {
    if (!governanceRoute) return null;
    switch (governanceRoute.routeId) {
      case "platform.overview.overview":
        return <OverviewPage />;
      case "platform.org-business.tenants":
        return governanceRoute.entityId
          ? <PlatformOrganizationGovernance tenantId={governanceRoute.entityId} route={governanceRoute} />
          : <TenantsPage tenantId={null} />;
      case "platform.org-business.users":
        return <UsersPage userId={governanceRoute.entityId} />;
      case "platform.org-business.entitlements-billing":
        return <PlatformBillingManager />;
      case "platform.org-business.signup":
        return renderSignupConfig ? renderSignupConfig() : <GovernanceCapabilityNotice title="注册管理" />;
      case "platform.org-business.platform-admins":
        return <PlatformAdminsPage />;
      case "platform.resource-center.agent-templates":
        return <PlatformGovernanceUnavailablePage title="Agent Template" reason="治理 Agent Template 列表 API 尚未提供。" />;
      case "platform.resource-center.environment-templates":
        return <PlatformGovernanceUnavailablePage title="Environment Template" reason="当前只有按 ID 查询，不能枚举猜测模板目录。" />;
      case "platform.resource-center.models":
        return renderModels();
      case "platform.resource-center.skills":
        return renderSkills();
      case "platform.resource-center.connectors":
        return renderMcp();
      case "platform.resource-center.tools":
        return renderToolControls();
      case "platform.runtime.sessions":
        return <SessionsPage sessionId={governanceRoute.entityId} />;
      case "platform.runtime.runs":
        return <RunTraceExplorer runId={governanceRoute.entityId} onRunIdChange={(next) => navigateGovernance(makeGovernanceRoute("platform.runtime.runs", { entityId: next }))} />;
      case "platform.runtime.execution-providers":
        return renderRemoteHands();
      case "platform.runtime.environments":
        return <SandboxesPage sandboxName={governanceRoute.entityId} />;
      case "platform.runtime.infra":
        return <InfraPage />;
      case "platform.runtime.efficiency":
        return renderEfficiency();
      case "platform.governance.audit":
        return <GovernanceChangeAuditPage />;
      case "platform.governance.network-security":
        return <EgressConfigManagerPanel />;
      case "platform.governance.system-prompts":
        return <SystemPromptsManagerPanel />;
      case "platform.governance.memory-policy":
        return renderMemoryPolling();
      case "platform.governance.system-settings":
        return <SystemSettingsPanel />;
      default:
        return <GovernanceCapabilityNotice title="该治理能力" />;
    }
  })();

  if (governanceContentOnly) {
    return <div className="min-h-full bg-muted/20 p-3 sm:p-4">{governanceContent}</div>;
  }

  const content = (() => {
    if (activeSection === "audit") return <AuditEventsPanel scope="platform" />;
    if (activeSection === "overview") return <OverviewPage />;
    if (activeSection === "tenants") return <TenantsPage tenantId={entityId} />;
    if (activeSection === "users") return <UsersPage userId={entityId} />;
    if (activeSection === "sessions") return <SessionsPage sessionId={entityId} />;
    if (activeSection === "runs") {
      return <RunTraceExplorer runId={entityId} onRunIdChange={(next) => {
        // 同 section 内换 entityId：整串 search 透传（列表筛选必须原样保留）
        navigatePlatformAdmin({ section: "runs", entityId: next, search: window.location.search });
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
