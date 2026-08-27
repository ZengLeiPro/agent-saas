import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, Loader2, X } from "lucide-react";
import { EntityIcons } from "@/lib/icons";
import { AdminSelect, type AdminSelectOption } from "@/components/ui/admin-select";
import type { SettingsDirtyController } from "@/components/PersonalSettings/dirtyRegistry";
import { SettingsPanelHeaderStickyProvider } from "@/components/SettingsCenter/SettingsPanelHeader";
import {
  PLATFORM_SETTINGS_SECTIONS,
  TENANT_SETTINGS_SECTIONS,
  type AdminSettingsNavigationItem,
  type PlatformSettingsSectionId,
  type TenantSettingsSectionId,
} from "@/components/SettingsCenter/unifiedSettingsConfig";
import { useAuth } from "@/contexts/AuthContext";
import { useTenants } from "@/components/TenantManager/hooks";
import { cn } from "@/lib/utils";
import { PlatformBillingManager, TenantBillingPanel } from "@/components/BillingManager";
import { HISTORY_PUSH, useAdminUrlQuery } from "@/hooks/useAdminUrlQuery";
import { decideFocusTrap, findFocusables } from "@/lib/focusTrap";
import { navigateGovernance, navigatePlatformAdmin, type PlatformAdminSection } from "@/lib/urlSync";
import { GovernanceCapabilityNotice } from "@/components/GovernanceConsole";
import { filterCustomerOrganizations, governanceRoute as makeGovernanceRoute, type GovernanceRouteState } from "@/lib/governanceNavigation";
import { PlatformAdminHeaderControls } from "@/components/PlatformAdmin/PlatformAdminHeaderControls";
import { TenantAdminHeaderControls } from "@/components/TenantAdminHeaderControls";
import { TenantSettingsPanel } from "@/components/TenantSettingsPanel";
import { InfraPage, OverviewPage, SandboxesPage, SessionsPage, TenantsPage, UsersPage } from "@/components/PlatformAdmin/pages";
import { SystemSettingsPanel } from "@/components/PlatformAdmin/SystemSettingsPanel";
import { RunTraceExplorer } from "@/components/RunTraceExplorer";
import { OverviewSection as TenantOverviewSection } from "@/components/TenantAnalytics/OverviewSection";
import { QaConsole } from "@/components/QaConsole";
import { AuditEventsPanel } from "@/components/GovernanceAuditPanel";
import { GovernanceChangeAuditPage } from "@/components/Governance/GovernanceChangeAuditPage";
import {
  OrganizationCredentialsPage,
  OrganizationEnvironmentsPage,
  OrganizationGroupsPage,
  OrganizationMemoryKnowledgePage,
  OrganizationMembersPage,
  OrganizationOffboardingPage,
  OrganizationPoliciesPage,
} from "@/components/OrganizationGovernance/OrganizationGovernancePage";
import { OrganizationUsageBillingPage } from "@/components/OrganizationGovernance/OrganizationUsageBillingPage";
import {
  PlatformAdminsPage,
  PlatformOrganizationGovernance,
  PlatformTemplateCatalogPage,
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
const AgentDwsAccountsPage = lazy(() => import('@/components/AgentDwsAccounts'));

export type TenantSection = "overview" | "usage" | "qa" | "audit" | TenantSettingsSectionId;
export type PlatformSection = PlatformSettingsSectionId;

type ShellButton<T extends string> = AdminSettingsNavigationItem<T>;

const SETTINGS_NAV_ITEM_SELECTED =
  "bg-brand-accent-soft text-foreground font-semibold";
const SETTINGS_NAV_ITEM_UNSELECTED =
  "text-muted-foreground hover:bg-muted/60 hover:text-foreground";

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



export function TenantAdminShell({
  renderUsers,
  renderSkills,
  renderOrgAgents,
  renderMcp,
  renderUsage,
  renderFiles,
  renderCompanyInfo,
  renderAutomation,
  settingsOpen,
  settingsSection,
  onSettingsSectionChange,
  onSettingsClose,
  settingsOnly = false,
  settingsContentOnly = false,
  activeAnalysisSection,
  onAnalysisSectionChange,
  headerControlsPlacement = "inline",
  governanceRoute,
  governanceContentOnly = false,
  governanceContentEmbedded = false,
  onSettingsTargetTenantIdChange,
  dirtyController,
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
  /** 受控：modal 当前 section（合法值见 TENANT_SETTINGS_SECTIONS） */
  settingsSection: TenantSection;
  /** 切换 section 时调用，父级负责改 state + push URL */
  onSettingsSectionChange: (section: TenantSection) => void;
  /** 关闭 modal 时调用，父级负责改 state + push URL */
  onSettingsClose: () => void;
  /** 仅渲染设置 modal，不渲染背后的分析页；用于移动端保留旧入口。 */
  settingsOnly?: boolean;
  /** 仅渲染设置叶子内容，用于桌面统一设置工作区。 */
  settingsContentOnly?: boolean;
  activeAnalysisSection?: TenantSection;
  onAnalysisSectionChange?: (section: TenantSection) => void;
  headerControlsPlacement?: "inline" | "none";
  governanceRoute?: GovernanceRouteState | null;
  governanceContentOnly?: boolean;
  governanceContentEmbedded?: boolean;
  renderAutomation?: () => ReactNode;
  /** 桌面统一设置回传实际组织目标；undefined 表示 Shell 尚不可用。 */
  onSettingsTargetTenantIdChange?: (tenantId: string | null | undefined) => void;
  /** 统一设置或治理工作区的共享未保存导航保护。 */
  dirtyController?: SettingsDirtyController;
}) {
  const { user, isPlatformAdmin } = useAuth();
  const { tenants: allTenants, loading: tenantsLoading } = useTenants();
  const tenants = filterCustomerOrganizations(allTenants);
  const [internalActive, setInternalActive] = useState<TenantSection>("overview");
  const active = activeAnalysisSection ?? internalActive;
  const setActive = onAnalysisSectionChange ?? setInternalActive;
  // 组织切换器（仅平台管理员可见）进 URL：`org` 是业务可读参数名，
  // 分享出去的组织分析链接必须落到同一个组织，而不是分享者自己的默认组织。
  const shellUrl = useAdminUrlQuery();
  const urlTenantId = governanceRoute?.orgId ?? shellUrl.get("org") ?? "";
  const [fallbackTenantId, setFallbackTenantId] = useState(isPlatformAdmin ? urlTenantId : user?.tenantId ?? "");
  const settingsWasOpenRef = useRef(settingsOpen);
  const previousUrlTenantIdRef = useRef(urlTenantId);
  const missingActiveScope = isPlatformAdmin && settingsContentOnly && settingsOpen && settingsWasOpenRef.current
    && previousUrlTenantIdRef.current && !urlTenantId;
  const targetTenantId = urlTenantId || (missingActiveScope ? "" : fallbackTenantId);
  const setTargetTenantId = useCallback((next: string) => {
    const changeTarget = () => {
      setFallbackTenantId(next);
      shellUrl.set("org", next || null, HISTORY_PUSH);
    };
    if (dirtyController) dirtyController.requestNavigation(changeTarget);
    else changeTarget();
  }, [dirtyController, shellUrl]);

  useEffect(() => {
    if (!isPlatformAdmin && !fallbackTenantId && user?.tenantId) setFallbackTenantId(user.tenantId);
  }, [fallbackTenantId, isPlatformAdmin, user?.tenantId]);

  // 跨设置分组时暂存最近选择；若组织 Shell 始终处于前台且历史导航回到空 org，则视为明确清空。
  useEffect(() => {
    if (urlTenantId) setFallbackTenantId(urlTenantId);
    else if (missingActiveScope) setFallbackTenantId("");
    settingsWasOpenRef.current = settingsOpen;
    previousUrlTenantIdRef.current = urlTenantId;
  }, [missingActiveScope, settingsOpen, urlTenantId]);

  // 平台管理员的组织作用域必须来自显式 org 选择，不能用目录首项替代用户决策。
  const explicitPlatformTenantId = isPlatformAdmin && tenants.some(tenant => tenant.id === targetTenantId)
    ? targetTenantId
    : "";
  const effectiveTenantId = isPlatformAdmin
    ? explicitPlatformTenantId
    : user?.tenantId || "";
  useEffect(() => {
    if (!settingsContentOnly) return;
    onSettingsTargetTenantIdChange?.(isPlatformAdmin && tenantsLoading ? undefined : effectiveTenantId || null);
  }, [effectiveTenantId, isPlatformAdmin, onSettingsTargetTenantIdChange, settingsContentOnly, tenantsLoading]);
  useEffect(() => () => {
    if (settingsContentOnly) onSettingsTargetTenantIdChange?.(undefined);
  }, [onSettingsTargetTenantIdChange, settingsContentOnly]);
  const currentTenant = tenants.find(t => t.id === effectiveTenantId);
  const explicitPlatformTenant = tenants.find(t => t.id === explicitPlatformTenantId);
  const tenantSwitcherOptions: AdminSelectOption[] = [
    { value: "", label: "请选择目标组织" },
    ...tenants.map(tenant => ({ value: tenant.id, label: tenant.name })),
  ];

  const tenantSwitcher = isPlatformAdmin && tenants.length > 0 ? (
    // label 包裹的是自定义控件而非原生 select，因此这里的文案改用 span + aria-label 关联
    <div className="block space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">当前组织</span>
      <AdminSelect
        ariaLabel="切换组织管理目标"
        size="md"
        className="w-full"
        options={tenantSwitcherOptions}
        value={explicitPlatformTenantId}
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

  const visibleTenantSettingsSections = (renderOrgAgents
    ? TENANT_SETTINGS_SECTIONS
    : TENANT_SETTINGS_SECTIONS.filter((section) => section.id !== "org-agents")) as ShellButton<TenantSection>[];

  const tenantSectionsToRender: { id: TenantSection; node: ReactNode }[] = [
    { id: "users", node: renderUsers(
      isPlatformAdmin ? explicitPlatformTenantId || undefined : effectiveTenantId,
      isPlatformAdmin ? explicitPlatformTenant?.name : currentTenant?.name,
    ) },
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

  const settingsContent = isPlatformAdmin && !explicitPlatformTenantId
    ? <GovernanceCapabilityNotice title="请先选择目标组织" mode="readonly" />
    : (
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

  if (settingsContentOnly) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-card">
        {tenantSwitcher && (
          <div className="shrink-0 border-b px-5 py-3">
            <div className="max-w-xs">{tenantSwitcher}</div>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-hidden p-4 md:p-8 md:pt-5">
          <SettingsPanelHeaderStickyProvider>{settingsContent}</SettingsPanelHeaderStickyProvider>
        </div>
      </div>
    );
  }

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
        return <OrganizationGroupsPage tenantId={effectiveTenantId} />;
      case "organization.members.offboarding":
        return <OrganizationOffboardingPage tenantId={effectiveTenantId} />;
      case "organization.agents.org-agents":
        return renderOrgAgents ? renderOrgAgents(effectiveTenantId, currentTenant?.name) : <GovernanceCapabilityNotice title="组织智能体" />;
      case "organization.agents.dingtalk-accounts":
        return <AgentDwsAccountsPage tenantId={effectiveTenantId} />;
      case "organization.agents.skills":
        return renderSkills(effectiveTenantId, currentTenant?.name);
      case "organization.agents.connectors":
        return <OrganizationCredentialsPage tenantId={effectiveTenantId} />;
      case "organization.agents.memory-knowledge":
        return <OrganizationMemoryKnowledgePage tenantId={effectiveTenantId} />;
      case "organization.agents.model-tools":
        return <TenantSettingsPanel tenantId={effectiveTenantId} section="model-tools" />;
      case "organization.agents.environments":
        return <OrganizationEnvironmentsPage tenantId={effectiveTenantId} />;
      case "organization.agents.files-data":
        return renderFiles();
      case "organization.governance.automation":
        return renderAutomation ? renderAutomation() : <GovernanceCapabilityNotice title="自动化任务" />;
      case "organization.governance.usage":
        return (
          <OrganizationUsageBillingPage tenantId={effectiveTenantId} tenantName={currentTenant?.name} usage={renderUsage(effectiveTenantId)} />
        );
      case "organization.governance.qa":
        return <QaConsole tenantId={effectiveTenantId} />;
      case "organization.governance.audit":
        return <GovernanceChangeAuditPage tenantId={effectiveTenantId} />;
      case "organization.settings.profile":
        return renderCompanyInfo(effectiveTenantId, currentTenant?.name);
      case "organization.settings.rules":
        return <TenantInstructionsPanel tenantId={effectiveTenantId} tenantName={currentTenant?.name} />;
      case "organization.settings.brand":
        return <TenantSettingsPanel tenantId={effectiveTenantId} section="brand" />;
      case "organization.settings.security":
        return <TenantSettingsPanel tenantId={effectiveTenantId} section="security" />;
      default:
        return <GovernanceCapabilityNotice title="该治理能力" />;
    }
  })();

  if (governanceContentOnly) {
    return (
      <div className={cn(
        "min-h-full bg-muted/20 p-3 sm:p-4",
        governanceContentEmbedded && "h-full min-h-0 overflow-auto bg-card p-4 md:p-6",
      )}>
        {governanceContent}
      </div>
    );
  }

  const content = (() => {
    if (!effectiveTenantId) return <GovernanceCapabilityNotice title="请先选择目标组织" mode="readonly" />;
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
  settingsContentOnly = false,
  headerControlsPlacement = "inline",
  governanceRoute,
  governanceContentOnly = false,
  governanceContentEmbedded = false,
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
  /** 仅渲染设置 modal，不渲染背后的分析页；用于移动端保留旧入口。 */
  settingsOnly?: boolean;
  /** 仅渲染设置叶子内容，用于桌面统一设置工作区。 */
  settingsContentOnly?: boolean;
  headerControlsPlacement?: "inline" | "none";
  governanceRoute?: GovernanceRouteState | null;
  governanceContentOnly?: boolean;
  governanceContentEmbedded?: boolean;
}) {
  // mount-once-visited（与 TenantAdminShell 同模式）
  const [visitedPlatformSections, setVisitedPlatformSections] = useState<Set<PlatformSection>>(() =>
    settingsOpen ? new Set([settingsSection]) : new Set(),
  );
  useEffect(() => {
    if (!settingsOpen) return;
    setVisitedPlatformSections(prev => (prev.has(settingsSection) ? prev : new Set(prev).add(settingsSection)));
  }, [settingsOpen, settingsSection]);

  const platformSectionsToRender: { id: PlatformSection; render: () => ReactNode }[] = [
    { id: "tenants", render: renderTenants },
    { id: "signup", render: () => renderSignupConfig ? renderSignupConfig() : null },
    { id: "platform-admins", render: () => <PlatformAdminsPage /> },
    { id: "agent-templates", render: () => <PlatformTemplateCatalogPage kind="agent" /> },
    { id: "environment-templates", render: () => <PlatformTemplateCatalogPage kind="environment" /> },
    { id: "models", render: renderModels },
    { id: "billing", render: () => <PlatformBillingManager /> },
    { id: "remote-hands", render: renderRemoteHands },
    { id: "tool-controls", render: renderToolControls },
    { id: "connector-dictionary", render: () => <ConnectorDictionaryManagerPanel /> },
    { id: "agent-profiles", render: () => <AgentRuntimeProfilesManagerPanel /> },
    { id: "system-prompts", render: () => <SystemPromptsManagerPanel /> },
    { id: "memory-polling", render: renderMemoryPolling },
    { id: "global-mcp", render: renderMcp },
    { id: "skill-pool", render: renderSkills },
    { id: "egress", render: () => <EgressConfigManagerPanel /> },
    { id: "system", render: () => <SystemSettingsPanel /> },
  ];

  const settingsContent = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        {platformSectionsToRender.map(({ id, render }) => {
          if (!visitedPlatformSections.has(id)) return null;
          const isActive = id === settingsSection;
          return (
            <div key={id} className={cn("h-full min-h-0", !isActive && "hidden")} aria-hidden={!isActive}>
              <Suspense fallback={<SettingsSectionFallback />}>
                {render()}
              </Suspense>
            </div>
          );
        })}
      </div>
    </div>
  );

  if (settingsContentOnly) {
    return (
      <div className="h-full min-h-0 bg-card p-4 md:p-8 md:pt-5">
        <SettingsPanelHeaderStickyProvider>{settingsContent}</SettingsPanelHeaderStickyProvider>
      </div>
    );
  }

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
        return <PlatformTemplateCatalogPage kind="agent" />;
      case "platform.resource-center.environment-templates":
        return <PlatformTemplateCatalogPage kind="environment" />;
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
        return <RunTraceExplorer runId={governanceRoute.entityId} onRunIdChange={(next) => navigateGovernance(
          makeGovernanceRoute("platform.runtime.runs", { entityId: next, search: governanceRoute.search }),
          { replace: next === null },
        )} />;
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
    return (
      <div className={cn(
        "min-h-full bg-muted/20 p-3 sm:p-4",
        governanceContentEmbedded && "h-full min-h-0 overflow-auto bg-card p-4 md:p-6",
      )}>
        {governanceContent}
      </div>
    );
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
    <AdminSettingsModal open={settingsOpen} title="平台管理" description="" badge="平台管理员" sections={PLATFORM_SETTINGS_SECTIONS} active={settingsSection} onActiveChange={onSettingsSectionChange} onClose={onSettingsClose}>
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
