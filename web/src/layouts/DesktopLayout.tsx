import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Volume2, VolumeX, Loader2, FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";
import { ChatTabContent } from "@/components/chat/ChatTabContent";
import { useSubagentTranscript } from "@/contexts/SubagentTranscriptContext";
import { DesktopSessionSidebar } from "@/components/DesktopSessionSidebar";
import { PanelToggleIcon } from "@/components/icons/PanelToggleIcon";
import { TrashView } from "@/components/chat/TrashView";
import { TokenUsageDisplay } from "@/components/TokenUsageDisplay";
import { BillingMiniBadge } from "@/components/BillingMiniBadge";
import { DisplaySettingsMenu } from "@/components/DisplaySettingsMenu";
import { useChatFontSize } from "@/hooks/useChatFontSize";
import { useChatWidth } from "@/hooks/useChatWidth";
import { useResizePanel } from "@/hooks/useResizePanel";
import { useSystemPanelDock } from "@/hooks/useSystemPanel";
import { SystemPanel } from "@/components/SystemPanel";
import { ResizablePanelDivider } from "@/components/ResizablePanelDivider";
import { saveUserPreferences } from "@agent/shared";
import type { LayoutProps } from "./types";
import { hasSuccessfulFinalOutput } from "./firstDayGuideVisibility";
import { useAuth } from "@/contexts/AuthContext";

const GovernanceConsole = lazy(() => import("@/components/GovernanceConsole").then(m => ({ default: m.GovernanceConsole }))); const AnalysisWorkspaceContent = lazy(() => import("@/components/AnalysisWorkspaceContent").then(m => ({ default: m.AnalysisWorkspaceContent })));
const CronManager = lazy(() => import("@/components/CronManager").then(m => ({ default: m.CronManager })));
const UserManager = lazy(() => import("@/components/UserManager").then(m => ({ default: m.UserManager })));
const TenantManager = lazy(() => import("@/components/TenantManager").then(m => ({ default: m.TenantManager })));
const FileBrowserLazy = lazy(() => import("@/components/FileBrowser").then(m => ({ default: m.FileBrowser })));
const FilePreviewDialog = lazy(() => import("@/components/FilePreviewPanel").then(m => ({ default: m.FilePreviewDialog })));
const FilePreviewPanel = lazy(() => import("@/components/FilePreviewPanel").then(m => ({ default: m.FilePreviewPanel })));
const SubagentTranscriptPanel = lazy(() => import("@/components/SubagentTranscriptPanel").then(m => ({ default: m.SubagentTranscriptPanel })));
const AgentProfilePanel = lazy(() => import("@/components/AgentProfile").then(m => ({ default: m.AgentProfile })));
const MemorySectionPanel = lazy(() => import("@/components/AgentProfile").then(m => ({ default: m.MemorySection })));
const SkillManagerPanel = lazy(() => import("@/components/SkillManager").then(m => ({ default: m.SkillManager })));
const UsageDashboard = lazy(() => import("@/components/UsageDashboard").then(m => ({ default: m.UsageDashboard })));
const EfficiencyViewPanel = lazy(() => import("@/components/UsageDashboard/EfficiencyView").then(m => ({ default: m.EfficiencyView })));
const McpManagerPanel = lazy(() => import("@/components/McpManager").then(m => ({ default: m.McpManager })));
const McpAdminCatalogPanel = lazy(() => import("@/components/McpManager").then(m => ({ default: m.McpAdminCatalog })));
const ModelManagerPanel = lazy(() => import("@/components/ModelManager").then(m => ({ default: m.ModelManager })));
const TenantRemoteHandsManagerPanel = lazy(() => import("@/components/TenantRemoteHandsManager").then(m => ({ default: m.TenantRemoteHandsManager })));
const ToolControlsManagerPanel = lazy(() => import("@/components/ToolControlsManager").then(m => ({ default: m.ToolControlsManager })));
const SignupConfigManagerPanel = lazy(() => import("@/components/SignupConfigManager").then(m => ({ default: m.SignupConfigManager })));
const MemoryPollingManagerPanel = lazy(() => import("@/components/MemoryPollingManager").then(m => ({ default: m.MemoryPollingManager })));
const SettingsContent = lazy(() => import("@/components/SettingsCenter").then(m => ({ default: m.SettingsContent })));
const TenantAdminShell = lazy(() => import("@/components/AdminShells").then(m => ({ default: m.TenantAdminShell })));
const PlatformAdminShell = lazy(() => import("@/components/AdminShells").then(m => ({ default: m.PlatformAdminShell })));
const CapabilityCenterPanel = lazy(() => import("@/components/CapabilityCenter").then(m => ({ default: m.CapabilityCenter })));
const ManagementSettingsAccessGate = lazy(() => import("@/components/ManagementSettingsAccessGate").then(m => ({ default: m.ManagementSettingsAccessGate })));
const PlatformAdminHeaderControls = lazy(() => import("@/components/PlatformAdmin/PlatformAdminHeaderControls").then(m => ({ default: m.PlatformAdminHeaderControls })));
const TenantAdminHeaderControls = lazy(() => import("@/components/TenantAdminHeaderControls").then(m => ({ default: m.TenantAdminHeaderControls })));
import type { TenantSection, PlatformSection } from "@/components/AdminShells";
import { useUnifiedSettingsWorkspace } from "@/hooks/useUnifiedSettingsWorkspace";
import { useManagementSettingsAccess } from "@/hooks/useManagementSettingsAccess";
import { isAnalysisRoute, useUnifiedAnalysisWorkspace } from "@/hooks/useUnifiedAnalysisWorkspace";
import { legacyRoleFallbackTab, managementAccessTarget } from "@/lib/managementAccessView";
import { EmptySessionScenarios } from "@/components/scenarios/EmptySessionScenarios";
import { EmptyChatRecommendCards } from "@/components/scenarios/EmptyChatRecommendCards";
import { useRoleKitConfig } from "@/components/scenarios/useRoleKitConfig";
import { useScenarioDeepLink } from "@/components/scenarios/useScenarioDeepLink";
import { FirstDayGuideBar } from "@/components/onboarding/FirstDayGuideBar";
import { CronCreationWizard } from "@/components/onboarding/CronCreationWizard";
import {
  sendWorkflowExperience,
  type WorkflowOnboardingContext,
} from "@/components/onboarding/workflowOnboarding";
import { ExpertWelcome } from "@/components/experts/ExpertWelcome";
import { CapabilityTabsList } from "@/components/CapabilityCenter/CapabilityTabsList";
import { useCapabilityNavigation } from "@/components/CapabilityCenter/navigation";
import type { CatalogScenarioPublic, ScenarioItem } from "@agent/shared";
const CompanyInfoSectionPanel = lazy(() => import("@/components/CompanyInfoEditor").then(m => ({ default: m.CompanyInfoSection })));
const OrgAgentManagerPanel = lazy(() => import("@/components/OrgAgentManager").then(m => ({ default: m.OrgAgentManager })));

const SuspenseFallback = (
  <div className="flex flex-1 items-center justify-center">
    <Loader2 className="size-6 animate-spin text-muted-foreground" />
  </div>
);

/**
 * 浮动内容框：纯白面板浮在品牌底（--background）上，靠描边勾轮廓、双层柔和阴影撑起层次。
 * 主会话、右侧预览/文件/系统面板与能力中心共用同一档，切 tab 时外框不跳。
 */
const FLOATING_PANEL_SURFACE =
  "bg-card ring-1 ring-border/60 shadow-[0_2px_6px_rgba(15,23,42,0.05),0_10px_28px_-10px_rgba(15,23,42,0.10)]";

export function DesktopLayout(props: LayoutProps) {
  const {
    sidebarSessions, sessionId, selectSession, newSession, newPersonalSession, confirmDeleteSession, confirmDeleteSessions, renameSession, autoTitleSession, compactSession,
    isLoadingSessions, activeTab, governanceRoute, platformAdminSection, platformAdminEntityId, tenantAdminSection, setTenantAdminRoute, setActiveTab, pushActiveTab, setPlatformAdminRoute, settingsOpen, settingsSection, openSettings, closeSettings, setSettingsSection,
    adminSettings, openAdminSettings, closeAdminSettings, setAdminSettingsSection,
    isAdmin, isPlatformAdmin, isOnline, connectionState,
    messages, loading, isLoadingMessages, hasMoreHistory, isLoadingEarlier, loadEarlierMessages,
    retryMessage, forkFromMessage, lastMessageRef, scrollContainerRef, isNearBottomRef,
    handlePermissionResponse, handleAskUserResponse,
    uploadedFiles, removeFile, input, uploading, uploadError, dismissUploadError, setInput,
    sendMessage, interjectMessage, sendVoiceMessage, stopping, stopGeneration, handleFileSelect, handleAssetSelect, handlePaste, ttsProps, ttsStateMap, modelList,
    queuedInterjections, cancelQueuedInterjection, editQueuedInterjection, resendQueuedInterjection, dismissQueuedInterjection,
    selectedModel, onModelChange, autoApproveRunShell, setAutoApproveRunShell, ttsPlayer, tokenUsage, contextUsage,
    hasMoreSessions, isLoadingMoreSessions, loadMoreSessions, loadGroupSessions,
    previewFilePath, previewFileOwner, previewMode, openFilePreview, dockFilePreview, expandFilePreview, closeFilePreview,
    fileBrowserOpen, toggleFileBrowser, closeFileBrowser,
    isTrashPreview, previewTrashSession, trashPreviewSessionId,
    agentProfile, sessionParticipants,
    startOrgAgentSession, activeOrgAgent, activeOrgAgentReadOnly, myOrgAgents, personalAgentEnabled, orgAgentIdentityLoading,
  } = props;

  const { user: authUser, updatePreferences, isLoading: authLoading, authEnabled } = useAuth();
  const {
    mode: settingsMode,
    target: settingsTarget,
    activeSection: activeSettingsSection,
    navigate: handleSettingsNavigate,
    close: handleCloseUnifiedSettings,
    open: handleOpenUnifiedSettings,
    onControllerChange: handleSettingsControllerChange,
  } = useUnifiedSettingsWorkspace({
    settingsOpen, settingsSection, adminSettings, openSettings, closeSettings, setSettingsSection,
    openAdminSettings, closeAdminSettings, setAdminSettingsSection,
  });
  const analysisMode = !settingsMode && isAnalysisRoute(governanceRoute); const accessTarget = managementAccessTarget({ settingsOpen, adminSettingsTarget: adminSettings?.target, activeTab, governanceArea: governanceRoute?.area });
  const managementAccess = useManagementSettingsAccess({ user: authUser, authLoading, authEnabled, active: accessTarget !== null || isAdmin }); const { open: handleOpenAnalysis, close: handleCloseAnalysis, navigate: handleAnalysisNavigate } = useUnifiedAnalysisWorkspace({ mode: analysisMode, governanceRoute, managementAccess, sessionId, pushActiveTab, setActiveTab });
  const subagentTranscriptContext = useSubagentTranscript();
  const subagentTranscript = subagentTranscriptContext?.transcript ?? null;
  const closeSubagentTranscript = subagentTranscriptContext?.closeTranscript;
  const [activeUsageCard, setActiveUsageCard] = useState<"context" | "billing" | null>(null);
  const [capabilityReplayOpen, setCapabilityReplayOpen] = useState(false);
  const handleContextCardOpenChange = useCallback((open: boolean) => {
    setActiveUsageCard((current) => open ? "context" : current === "context" ? null : current);
  }, []);
  const handleBillingCardOpenChange = useCallback((open: boolean) => {
    setActiveUsageCard((current) => open ? "billing" : current === "billing" ? null : current);
  }, []);
  const { config: roleKitConfig } = useRoleKitConfig();
  const roleKitV2Enabled = roleKitConfig.roleKitV2Enabled;
  const sidebarLayout = authUser?.preferences?.sidebarLayout ?? "double";
  const authorizationModeEnabled = authUser?.preferences?.authorizationModeEnabled === true;
  const handleSidebarLayoutChange = useCallback((layout: "double" | "single") => {
    updatePreferences({ sidebarLayout: layout });
    void saveUserPreferences({ sidebarLayout: layout }).then((saved) => {
      if (saved) updatePreferences(saved);
    });
  }, [updatePreferences]);

  const { isLarge: chatFontLarge, setIsLarge: setChatFontLarge } = useChatFontSize();
  const { isWide: chatWidthWide, setIsWide: setChatWidthWide } = useChatWidth();
  const { activeCapabilityTab, handleCapabilityTabChange } = useCapabilityNavigation(personalAgentEnabled);

  // 企业系统面板：从当前会话消息流 fold，与演示回放共用同一个 hook
  const { snapshot: systemPanel, pulse: systemPanelPulse, open: systemPanelOpen, selectView: selectSystemPanelView, dismiss: dismissSystemPanel } =
    useSystemPanelDock(messages, sessionId);

  const capabilityReplayActive = activeTab === "capabilities" && capabilityReplayOpen;
  // 工作流回放自行渲染会话卡与系统数据卡；目录态仍由外层提供统一浮动白框。
  const contentPanelFloating = settingsMode || analysisMode
    || activeTab === "chat"
    || (activeTab === "capabilities" && !capabilityReplayOpen)
    || activeTab === "cron";

  const sidePreviewOpen = !!previewFilePath && previewMode === "side";

  useEffect(() => {
    closeSubagentTranscript?.();
  }, [closeSubagentTranscript, sessionId]);

  /**
   * 右栏是**单 slot + 优先级**，不是多个布尔的「或」。
   *
   * 优先级 subagent > preview > system > browser。子任务详情与文件预览都是用户显式
   * 点开的；子任务详情是当前最新意图，system 则是自动跟随 Agent 的。
   * 被压住的一方不卸载（走 hidden），保住滚动位置与内部状态。
   */
  const rightPanelKind: 'subagent' | 'preview' | 'system' | 'browser' | null =
    subagentTranscript ? 'subagent'
      : sidePreviewOpen ? 'preview'
        : systemPanelOpen ? 'system'
          : fileBrowserOpen ? 'browser'
            : null;
  const rightPanelOpen = rightPanelKind !== null;
  const showRightPanel = !settingsMode && !analysisMode && activeTab === "chat" && rightPanelOpen;
  const rightPanelKey = rightPanelKind === 'subagent'
    ? subagentTranscript?.childSessionId ?? null
    : rightPanelKind === 'preview' ? previewFilePath : rightPanelKind;
  const { ratio: splitRatio, containerRef: splitContainerRef, onDividerMouseDown, onDividerDoubleClick } = useResizePanel(0.5, 0.25, 0.75, rightPanelKey);

  // 侧边栏折叠
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("sidebar-collapsed") === "true");
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(prev => {
      const next = !prev;
      localStorage.setItem("sidebar-collapsed", String(next));
      return next;
    });
  }, []);

  const [cronHeaderNavigationTarget, setCronHeaderNavigationTarget] = useState<HTMLDivElement | null>(null);
  const [cronHeaderActionsTarget, setCronHeaderActionsTarget] = useState<HTMLDivElement | null>(null);

  // Header 标题：根据 activeTab 动态显示
  const headerTitle = useMemo(() => {
    if (activeTab === "profile") return "我的 Agent";
    if (activeTab === "capabilities") return "能力中心";
    if (activeTab === "scenarios") return "任务模板";
    if (activeTab === "cron") return "任务中心";
    if (activeTab === "tenants") return "组织分析";
    if (activeTab === "tenant-admin") return "组织分析";
    if (activeTab === "platform-admin") return "平台分析";
    if (activeTab === "skills") return "技能管理";
    if (activeTab === "usage") return "Token 用量";
    if (activeTab === "mcp") return "MCP 配置";
    if (activeTab === "models") return "模型管理";
    if (activeTab === "trash") return "回收站";
    if (isTrashPreview) return "回收站预览";
    return sidebarSessions.find(s => s.id === sessionId)?.title || activeOrgAgent?.name || (orgAgentIdentityLoading ? "企业专家" : agentProfile?.name) || "KY Agent";
  }, [activeTab, isTrashPreview, sidebarSessions, sessionId, activeOrgAgent, agentProfile, orgAgentIdentityLoading]);

  // mount-once-visited：首次切换到 tab 后永久挂载
  const [cronMounted, setCronMounted] = useState(false);
  const [tenantsMounted, setTenantsMounted] = useState(false);
  const [profileMounted, setProfileMounted] = useState(false);
  const [skillsMounted, setSkillsMounted] = useState(false);
  const [usageMounted, setUsageMounted] = useState(false);
  const [mcpMounted, setMcpMounted] = useState(false);
  const [modelsMounted, setModelsMounted] = useState(false);
  const [tenantAdminMounted, setTenantAdminMounted] = useState(false);
  const [platformAdminMounted, setPlatformAdminMounted] = useState(false);
  const [trashMounted, setTrashMounted] = useState(false);
  const [capabilitiesMounted, setCapabilitiesMounted] = useState(false);
  const [roleDetailId, setRoleDetailId] = useState<string | null>(null);
  const [lastTriedScenario, setLastTriedScenario] = useState<ScenarioItem | null>(null);
  const [activeWorkflow, setActiveWorkflow] = useState<WorkflowOnboardingContext | null>(null);
  const [cronWizardOpen, setCronWizardOpen] = useState(false);
  const [cronWizardScenario, setCronWizardScenario] = useState<ScenarioItem | null>(null);
  useEffect(() => {
    if (activeTab === "cron" && !cronMounted) setCronMounted(true);
    if (activeTab === "capabilities" && !capabilitiesMounted) setCapabilitiesMounted(true);
    if (activeTab === "tenants" && !tenantsMounted && isPlatformAdmin) setTenantsMounted(true);
    if (activeTab === "profile" && !profileMounted) setProfileMounted(true);
    if (activeTab === "skills" && !skillsMounted && isAdmin) setSkillsMounted(true);
    if (activeTab === "usage" && !usageMounted && isAdmin) setUsageMounted(true);
    if (activeTab === "mcp" && !mcpMounted) setMcpMounted(true);
    if (activeTab === "models" && !modelsMounted && isPlatformAdmin) setModelsMounted(true);
    if (activeTab === "tenant-admin" && !tenantAdminMounted) setTenantAdminMounted(true);
    if (activeTab === "platform-admin" && !platformAdminMounted) setPlatformAdminMounted(true);
    if (activeTab === "trash" && !trashMounted) setTrashMounted(true);
  }, [activeTab, capabilitiesMounted, cronMounted, tenantsMounted, profileMounted, skillsMounted, usageMounted, mcpMounted, modelsMounted, tenantAdminMounted, platformAdminMounted, trashMounted, isAdmin, isPlatformAdmin]);

  // ---- 场景库「试一试」链路 ----
  // 整页场景库里点「试一试」：新建会话 → 预填起手 prompt（不自动发送）→ 切回聊天视图。
  // 顺序不能反：newSession 内部会清空输入框（clearComposer），必须先建会话再 setInput。
  const handleTryScenario = useCallback((prompt: string, scenario?: ScenarioItem) => {
    if (!personalAgentEnabled || loading) return;
    setActiveWorkflow(null);
    if (scenario) setLastTriedScenario(scenario);
    newPersonalSession();
    setInput(prompt);
    setActiveTab("chat");
  }, [loading, newPersonalSession, personalAgentEnabled, setInput, setActiveTab]);

  // 空会话推荐卡：当前会话本来就是空的，直接预填当前输入框即可，无需再新建会话
  const handlePrefillScenario = useCallback((prompt: string, scenario?: ScenarioItem) => {
    if (!personalAgentEnabled || loading) return;
    setActiveWorkflow(null);
    if (scenario) setLastTriedScenario(scenario);
    setInput(prompt);
  }, [loading, personalAgentEnabled, setInput]);

  const handleStartWorkflow = useCallback((
    message: string,
    scenario: WorkflowOnboardingContext["scenario"],
  ) => {
    if (!personalAgentEnabled || loading) return;
    setActiveWorkflow({
      scenario,
    });
    newPersonalSession();
    setInput(message);
    setActiveTab("chat");
  }, [loading, newPersonalSession, personalAgentEnabled, setInput, setActiveTab]);

  const handlePrefillWorkflow = useCallback((message: string, scenario: CatalogScenarioPublic) => {
    if (!personalAgentEnabled || loading) return;
    setActiveWorkflow({ scenario });
    setInput(message);
  }, [loading, personalAgentEnabled, setInput]);

  const handleSendMessage = useCallback(async () => {
    await sendWorkflowExperience(sendMessage, input, activeWorkflow);
  }, [activeWorkflow, input, sendMessage]);

  // 场景直达：消费 ?scenario=<id>（官网注册落地 / 销售场景链接），预填起手指令
  useScenarioDeepLink(handlePrefillScenario, () => pushActiveTab("capabilities"));

  // 「查看全部场景」：push 版切换，浏览器后退可回到聊天
  const handleViewAllScenarios = useCallback(() => {
    pushActiveTab("capabilities");
  }, [pushActiveTab]);

  const handleOpenCronWizard = useCallback(() => {
    if (lastTriedScenario?.mode === "recurring") {
      setCronWizardScenario(lastTriedScenario);
      setCronWizardOpen(true);
      return;
    }
    pushActiveTab("capabilities");
  }, [lastTriedScenario, pushActiveTab]);

  // 新会话空白态的推荐槽位。MessageList 被 memo，这里必须用 useMemo 保持节点引用稳定，
  // 避免输入框每次击键（input 变化触发本组件重渲染）都打穿 MessageList 的 memo。
  const chatEmptySlot = useMemo(() => (
    roleKitV2Enabled ? (
      <EmptyChatRecommendCards
        onTryScenario={handlePrefillScenario}
        onStartWorkflow={handlePrefillWorkflow}
        onViewAll={handleViewAllScenarios}
      />
    ) : (
      <EmptySessionScenarios
        onTryScenario={handlePrefillScenario}
        onStartWorkflow={handlePrefillWorkflow}
        onViewAll={handleViewAllScenarios}
      />
    )
  ), [handlePrefillScenario, handlePrefillWorkflow, handleViewAllScenarios, roleKitV2Enabled]);

  const expertEmptySlot = useMemo(() => activeOrgAgent ? (
    <ExpertWelcome expert={activeOrgAgent} onPrefill={setInput} />
  ) : null, [activeOrgAgent, setInput]);

  const unavailableEmptySlot = useMemo(() => (
    <div className="mx-auto flex max-w-xl flex-col items-center px-4 py-16 text-center">
      <div className="text-lg font-semibold">当前没有可用的企业专家</div>
      <p className="mt-2 text-sm text-muted-foreground">请联系组织管理员完成专家指派后再开始对话。</p>
    </div>
  ), []);
  const identityLoadingEmptySlot = useMemo(() => (
    <div className="mx-auto flex max-w-xl flex-col items-center px-4 py-16 text-center">
      <div className="text-lg font-semibold">正在加载企业专家</div>
      <p className="mt-2 text-sm text-muted-foreground">正在同步组织为你配置的专家与会话。</p>
    </div>
  ), []);

  // Legacy tabs retain role-based fallback. Management workspaces are intentionally
  // excluded: their snapshot gates are the sole entry authority.
  useEffect(() => {
    const fallback = legacyRoleFallbackTab({ activeTab, personalAgentEnabled, isAdmin, isPlatformAdmin });
    if (fallback) setActiveTab(fallback);
  }, [isAdmin, isPlatformAdmin, personalAgentEnabled, activeTab, setActiveTab]);

  if (!analysisMode && activeTab === "tenant-admin" && governanceRoute?.area === "organization") {
    return (
      <Suspense fallback={SuspenseFallback}>
        <ManagementSettingsAccessGate scope="tenant" target="tenant" access={managementAccess}
          onRetry={managementAccess.retry} onReturnPersonal={() => handleOpenUnifiedSettings(settingsSection)}>
          <GovernanceConsole area="organization" route={governanceRoute} onExit={() => setActiveTab("chat")}>
          <TenantAdminShell
            renderUsers={(tenantId, tenantName) => <UserManager tenantIdScope={tenantId} tenantName={tenantName} />}
            renderSkills={(tenantId, tenantName) => <SkillManagerPanel mode="tenant" tenantIdScope={tenantId} tenantName={tenantName} />}
            renderOrgAgents={(tenantId, tenantName) => <OrgAgentManagerPanel tenantId={tenantId} tenantName={tenantName} />}
            renderMcp={() => <McpAdminCatalogPanel />}
            renderUsage={(tenantId) => <UsageDashboard tenantId={tenantId} scope="tenant" fullWidth />}
            renderFiles={() => <FileBrowserLazy onPreviewFile={openFilePreview} owner={authUser?.username} fullPage reserveCloseButtonSpace />}
            renderCompanyInfo={(tenantId, tenantName) => <CompanyInfoSectionPanel tenantId={tenantId} tenantName={tenantName} />}
            renderAutomation={() => <CronManager />}
            settingsOpen={false}
            settingsSection="users"
            onSettingsSectionChange={() => undefined}
            onSettingsClose={() => undefined}
            governanceRoute={governanceRoute}
            governanceContentOnly
          />
          </GovernanceConsole>
        </ManagementSettingsAccessGate>
      </Suspense>
    );
  }

  if (!analysisMode && activeTab === "platform-admin" && governanceRoute?.area === "platform") {
    return (
      <Suspense fallback={SuspenseFallback}>
        <ManagementSettingsAccessGate scope="platform" target="platform" access={managementAccess}
          onRetry={managementAccess.retry} onReturnPersonal={() => handleOpenUnifiedSettings(settingsSection)}>
          <GovernanceConsole area="platform" route={governanceRoute} onExit={() => setActiveTab("chat")}>
          <PlatformAdminShell
            renderTenants={() => <TenantManager />}
            renderSignupConfig={() => <SignupConfigManagerPanel />}
            renderModels={() => <ModelManagerPanel />}
            renderRemoteHands={() => <TenantRemoteHandsManagerPanel />}
            renderToolControls={() => <ToolControlsManagerPanel />}
            renderMemoryPolling={() => <MemoryPollingManagerPanel />}
            renderMcp={() => <McpAdminCatalogPanel />}
            renderSkills={() => <SkillManagerPanel mode="platform" />}
            renderEfficiency={() => <EfficiencyViewPanel />}
            activeSection={platformAdminSection}
            entityId={platformAdminEntityId}
            onSectionChange={setPlatformAdminRoute}
            settingsOpen={false}
            settingsSection="tenants"
            onSettingsSectionChange={() => undefined}
            onSettingsClose={() => undefined}
            governanceRoute={governanceRoute}
            governanceContentOnly
          />
          </GovernanceConsole>
        </ManagementSettingsAccessGate>
      </Suspense>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <DesktopSessionSidebar
        sessions={sidebarSessions}
        activeSessionId={sessionId}
        onSelect={selectSession}
        onNew={newSession}
        onDelete={confirmDeleteSession}
        onDeleteMany={confirmDeleteSessions}
        onRename={renameSession}
        onAutoTitle={autoTitleSession}
        onCompact={compactSession}
        isLoading={isLoadingSessions}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onOpenSettings={handleOpenUnifiedSettings}
        onOpenAnalysis={handleOpenAnalysis} analysisMode={analysisMode} analysisRoute={analysisMode ? governanceRoute : null} onAnalysisNavigate={handleAnalysisNavigate} onCloseAnalysis={handleCloseAnalysis}
        settingsMode={settingsMode}
        settingsTarget={settingsTarget}
        activeSettingsSection={activeSettingsSection}
        onSettingsNavigate={handleSettingsNavigate}
        onCloseSettings={handleCloseUnifiedSettings}
        isAdmin={isAdmin}
        isPlatformAdmin={isPlatformAdmin}
        settingsAccess={managementAccess}
        hasMore={hasMoreSessions}
        isLoadingMore={isLoadingMoreSessions}
        onLoadMore={loadMoreSessions}
        onLoadGroupSessions={loadGroupSessions}
        hidden={settingsMode || analysisMode ? false : sidebarCollapsed}
        onCollapse={settingsMode || analysisMode ? undefined : toggleSidebar}
        onPreviewTrashSession={previewTrashSession}
        trashPreviewSessionId={trashPreviewSessionId}
        sidebarLayout={sidebarLayout}
        personalAgentEnabled={personalAgentEnabled}
      />

      {/* 右侧内容区 */}
      <div
        ref={showRightPanel ? splitContainerRef : undefined}
        className={cn(
          "my-2.5 mr-2.5 flex min-h-0 min-w-0 flex-1",
          sidebarCollapsed && !settingsMode && !analysisMode && "ml-2.5",
          chatFontLarge && "chat-font-large",
          chatWidthWide && "chat-width-wide",
        )}
      >
        <div
          className={cn(
            "relative flex min-h-0 min-w-0 flex-col overflow-hidden",
            !capabilityReplayActive && "rounded-xl",
            contentPanelFloating && FLOATING_PANEL_SURFACE,
          )}
          style={showRightPanel
            ? { flexBasis: `calc(${(1 - splitRatio) * 100}% - 5px)`, flexShrink: 0, flexGrow: 0 }
            : { flex: 1 }}
        >
        {/* Header 内含任务中心的 portal 宿主，只隐藏不卸载，避免切页时与 portal 清理竞争。 */}
        <header
          className={cn(
            "flex shrink-0 items-center gap-3",
            activeTab === "capabilities" || activeTab === "cron" ? "h-14 px-6" : "h-12 px-4",
            contentPanelFloating ? "bg-card" : "bg-background",
            capabilityReplayActive && "hidden",
          )}
          onClick={(e) => {
            if ((e.target as HTMLElement).closest("button, a, input, textarea, select, [role=button]")) return;
            (scrollContainerRef as React.RefObject<HTMLDivElement>)?.current?.scrollTo({ top: 0, behavior: "smooth" });
          }}
        >
          <div className={cn("flex min-w-0 items-center gap-2", activeTab === "chat" && "flex-1")}>
            {/* 侧边栏展开后，收起入口移到侧边栏 header；此处只在收起态承接展开入口 */}
            {sidebarCollapsed && !settingsMode && !analysisMode && (
              <Button
                variant="ghost"
                size="icon"
                className="size-9 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
                onClick={(e) => { e.stopPropagation(); toggleSidebar(); }}
                title="展开侧边栏"
              >
                <PanelToggleIcon className="size-5" />
              </Button>
            )}
            <div
              ref={setCronHeaderNavigationTarget}
              className={cn("min-w-0", activeTab !== "cron" && "hidden")}
            />
            {activeTab === "capabilities" ? (
              <Tabs value={activeCapabilityTab} onValueChange={handleCapabilityTabChange} className="min-w-0">
                <CapabilityTabsList
                  activeValue={activeCapabilityTab}
                  showTemplates={personalAgentEnabled}
                  className="w-[30rem] max-w-[min(30rem,calc(100vw-24rem))]"
                />
              </Tabs>
            ) : activeTab !== "cron" &&
              activeTab !== "tenants" &&
              activeTab !== "tenant-admin" &&
              activeTab !== "platform-admin" ? (
              <div className="min-w-0 flex-1 truncate text-base font-semibold">
                {headerTitle}
              </div>
            ) : null}
          </div>
          {!analysisMode && activeTab === "platform-admin" && (
            <Suspense fallback={null}>
              <PlatformAdminHeaderControls
                active={platformAdminSection}
                onActiveChange={(section) => setPlatformAdminRoute(section)}
                className="min-w-0 flex-1"
              />
            </Suspense>
          )}
          {!analysisMode && activeTab === "tenant-admin" && (
            <Suspense fallback={null}>
              <TenantAdminHeaderControls
                active={tenantAdminSection}
                onActiveChange={setTenantAdminRoute}
                className="min-w-0 flex-1"
              />
            </Suspense>
          )}
          <div
            ref={setCronHeaderActionsTarget}
            className={cn(
              "ml-auto shrink-0 items-center gap-2",
              activeTab === "cron" ? "flex" : "hidden",
            )}
          />
          {activeTab === "chat" && (
            <div className="ml-auto flex shrink-0 items-center gap-2">
              {modelList?.showContextTokens !== false && (
                <TokenUsageDisplay
                  tokenUsage={tokenUsage}
                  contextUsage={contextUsage}
                  allowDetails={modelList?.allowContextTokenDetails === true}
                  messages={messages}
                  onOpenChildSession={selectSession}
                  open={activeUsageCard === "context"}
                  onOpenChange={handleContextCardOpenChange}
                />
              )}
              <BillingMiniBadge
                isAdmin={isAdmin}
                sessionId={sessionId}
                open={activeUsageCard === "billing"}
                onOpenChange={handleBillingCardOpenChange}
              />
              <DisplaySettingsMenu
                isLarge={chatFontLarge}
                isWide={chatWidthWide}
                onFontSizeChange={setChatFontLarge}
                onWidthChange={setChatWidthWide}
              />
              {ttsPlayer.available && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  onClick={ttsPlayer.toggleAutoPlay}
                  title={ttsPlayer.autoPlay ? "Auto-play voice on" : "Auto-play voice off"}
                >
                  {ttsPlayer.autoPlay ? (
                    <Volume2 className="size-5 text-primary" />
                  ) : (
                    <VolumeX className="size-5 text-muted-foreground" />
                  )}
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={toggleFileBrowser}
                title="文件浏览器"
              >
                <FolderOpen className={cn("size-[18px]", fileBrowserOpen ? "text-primary" : "text-muted-foreground")} />
              </Button>
            </div>
          )}
        </header>

        {!isOnline && (
          <div className="shrink-0 bg-warning px-4 py-1.5 text-center text-xs font-medium text-foreground">
            Network disconnected
          </div>
        )}
        {connectionState === 'reconnecting' && (
          <div className="shrink-0 bg-warning/80 px-4 py-1.5 text-center text-xs font-medium text-foreground flex items-center justify-center gap-2">
            <Loader2 className="size-3 animate-spin" />
            重新连接中...
          </div>
        )}

        {/* Tab 内容 */}
        <div className={cn("flex min-h-0 flex-1 overflow-hidden", activeTab !== "chat" && "hidden")}>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <ChatTabContent
              messages={messages}
              loading={loading}
              isLoadingMessages={isLoadingMessages}
              hasMoreHistory={hasMoreHistory}
              isLoadingEarlier={isLoadingEarlier}
              onLoadEarlier={loadEarlierMessages}
              lastMessageRef={lastMessageRef}
              scrollContainerRef={scrollContainerRef}
              isNearBottomRef={isNearBottomRef}
              onPermissionResponse={handlePermissionResponse}
              onAskUserResponse={handleAskUserResponse}
              onRetry={retryMessage}
              onFork={forkFromMessage}
              uploadedFiles={uploadedFiles}
              onRemoveFile={removeFile}
              input={input}
              uploading={uploading}
              uploadError={uploadError}
              onDismissUploadError={dismissUploadError}
              onInputChange={setInput}
              onSend={() => { void handleSendMessage(); }}
              onInterject={() => { void interjectMessage(); }}
              onStop={stopGeneration}
              stopping={stopping}
              queuedInterjections={queuedInterjections}
              onCancelQueuedInterjection={cancelQueuedInterjection}
              onEditQueuedInterjection={editQueuedInterjection}
              onResendQueuedInterjection={resendQueuedInterjection}
              onDismissQueuedInterjection={dismissQueuedInterjection}
              onFileSelect={(event) => { void handleFileSelect(event); }}
              onAssetSelect={handleAssetSelect}
              onPaste={(event) => { void handlePaste(event); }}
              tts={ttsProps}
              ttsStateMap={ttsStateMap}
              modelList={modelList}
              selectedModel={selectedModel}
              sessionId={sessionId}
              onModelChange={onModelChange}
              canAutoApproveRunShell={!authorizationModeEnabled}
              autoApproveRunShell={autoApproveRunShell}
              onAutoApproveRunShellChange={setAutoApproveRunShell}
              onSendVoice={(wavBlob, durationMs) => sendVoiceMessage(wavBlob, durationMs)}
              readOnly={isTrashPreview || activeOrgAgentReadOnly || orgAgentIdentityLoading}
              readOnlyInputPlaceholder={!isTrashPreview && orgAgentIdentityLoading ? "正在加载企业专家..." : (!isTrashPreview && activeOrgAgentReadOnly ? "该企业专家当前不可用，请联系组织管理员" : undefined)}
              agentProfile={orgAgentIdentityLoading ? null : agentProfile}
              sessionParticipants={sessionParticipants}
              emptySlot={activeOrgAgent ? expertEmptySlot : (orgAgentIdentityLoading ? identityLoadingEmptySlot : (personalAgentEnabled ? chatEmptySlot : unavailableEmptySlot))}
              initialComposer={!isTrashPreview && !orgAgentIdentityLoading && !activeOrgAgentReadOnly && (Boolean(activeOrgAgent) || personalAgentEnabled)}
              orgAgent={isTrashPreview ? null : activeOrgAgent}
              onNewOrgAgentConversation={activeOrgAgent && !activeOrgAgentReadOnly && !loading
                ? () => { startOrgAgentSession(activeOrgAgent.id); }
                : undefined}
              onSwitchOrgAgent={activeOrgAgent && myOrgAgents.length > 1 && !loading
                ? () => { pushActiveTab("capabilities"); }
                : undefined}
            />
          </div>
        </div>
        {capabilitiesMounted && (
          <div className={cn("min-h-0 flex-1 overflow-hidden", activeTab !== "capabilities" && "hidden")}>
            <Suspense fallback={SuspenseFallback}>
              <CapabilityCenterPanel
                experts={myOrgAgents}
                personalAgentEnabled={personalAgentEnabled}
                onStartExpert={startOrgAgentSession}
                onTryScenario={handleTryScenario}
                onStartWorkflow={handleStartWorkflow}
                onRequestDiagnosis={handleStartWorkflow}
                onWorkflowSelected={(scenario) => setActiveWorkflow({ scenario })}
                onWorkflowReplayOpenChange={setCapabilityReplayOpen}
                roleDetailId={roleDetailId}
                onOpenRoleDetail={setRoleDetailId}
                onCloseRoleDetail={() => setRoleDetailId(null)}
                actionsDisabled={loading}
              />
            </Suspense>
          </div>
        )}
        {cronMounted && (
          // 白框内不整页滚动：列表栏与详情栏各自滚，滚动条才不会压在圆角边上
          <div className={cn("min-h-0 flex-1 overflow-hidden", activeTab !== "cron" && "hidden")}>
            <Suspense fallback={SuspenseFallback}>
              <CronManager
                headerNavigationTarget={cronHeaderNavigationTarget}
                headerActionsTarget={cronHeaderActionsTarget}
              />
            </Suspense>
          </div>
        )}
        {tenantsMounted && (
          <div className={cn("min-h-0 flex-1 overflow-auto", activeTab !== "tenants" && "hidden")}>
            <Suspense fallback={SuspenseFallback}>
              <TenantManager />
            </Suspense>
          </div>
        )}
        {profileMounted && (
          <div className={cn("min-h-0 flex-1 overflow-auto", activeTab !== "profile" && "hidden")}>
            <Suspense fallback={SuspenseFallback}>
              <AgentProfilePanel />
            </Suspense>
          </div>
        )}
        {skillsMounted && (
          <div className={cn("min-h-0 flex-1 overflow-auto", activeTab !== "skills" && "hidden")}>
            <Suspense fallback={SuspenseFallback}>
              <SkillManagerPanel mode={isPlatformAdmin ? "platform" : "tenant"} tenantIdScope={isPlatformAdmin ? undefined : authUser?.tenantId} />
            </Suspense>
          </div>
        )}
        {usageMounted && (
          <div className={cn("min-h-0 flex-1 overflow-auto", activeTab !== "usage" && "hidden")}>
            <Suspense fallback={SuspenseFallback}>
              <UsageDashboard tenantId={isPlatformAdmin ? undefined : authUser?.tenantId} scope={isPlatformAdmin ? "platform" : "tenant"} />
            </Suspense>
          </div>
        )}
        {mcpMounted && (
          <div className={cn("min-h-0 flex-1 overflow-auto", activeTab !== "mcp" && "hidden")}>
            <Suspense fallback={SuspenseFallback}>
              <McpManagerPanel />
            </Suspense>
          </div>
        )}
        {modelsMounted && (
          <div className={cn("min-h-0 flex-1 overflow-auto", activeTab !== "models" && "hidden")}>
            <Suspense fallback={SuspenseFallback}>
              <ModelManagerPanel />
            </Suspense>
          </div>
        )}

        {tenantAdminMounted && !analysisMode && (
          <div className={cn("min-h-0 flex-1 overflow-hidden", activeTab !== "tenant-admin" && "hidden")}>
            <Suspense fallback={SuspenseFallback}>
              <ManagementSettingsAccessGate scope="tenant" target="tenant"
                access={managementAccess} onRetry={managementAccess.retry}
                onReturnPersonal={() => handleOpenUnifiedSettings(settingsSection)}>
              <TenantAdminShell
                renderUsers={(tenantId, tenantName) => <UserManager tenantIdScope={tenantId} tenantName={tenantName} />}
                renderSkills={(tenantId, tenantName) => <SkillManagerPanel mode="tenant" tenantIdScope={tenantId} tenantName={tenantName} />}
                renderOrgAgents={(tenantId, tenantName) => <OrgAgentManagerPanel tenantId={tenantId} tenantName={tenantName} />}
                renderMcp={() => <McpAdminCatalogPanel />}
                renderUsage={(tenantId) => <UsageDashboard tenantId={tenantId} scope="tenant" fullWidth />}
            renderFiles={() => (
              <FileBrowserLazy onPreviewFile={openFilePreview} owner={authUser?.username} fullPage reserveCloseButtonSpace />
            )}
                renderCompanyInfo={(tenantId, tenantName) => <CompanyInfoSectionPanel tenantId={tenantId} tenantName={tenantName} />}
                settingsOpen={false}
                settingsSection="users"
                onSettingsSectionChange={(section) => setAdminSettingsSection(section)}
                onSettingsClose={closeAdminSettings}
                activeAnalysisSection={tenantAdminSection}
                onAnalysisSectionChange={setTenantAdminRoute}
                headerControlsPlacement="none"
              />
              </ManagementSettingsAccessGate>
            </Suspense>
          </div>
        )}
        {platformAdminMounted && !analysisMode && (
          <div className={cn("min-h-0 flex-1 overflow-hidden", activeTab !== "platform-admin" && "hidden")}>
            <Suspense fallback={SuspenseFallback}>
              <ManagementSettingsAccessGate scope="platform" target="platform"
                access={managementAccess} onRetry={managementAccess.retry}
                onReturnPersonal={() => handleOpenUnifiedSettings(settingsSection)}>
              <PlatformAdminShell
                renderTenants={() => <TenantManager />}
                renderSignupConfig={() => <SignupConfigManagerPanel />}
                renderModels={() => <ModelManagerPanel />}
                renderRemoteHands={() => <TenantRemoteHandsManagerPanel />}
                renderToolControls={() => <ToolControlsManagerPanel />}
                renderMemoryPolling={() => <MemoryPollingManagerPanel />}
                renderMcp={() => <McpAdminCatalogPanel />}
                renderSkills={() => <SkillManagerPanel mode="platform" />}
                renderEfficiency={() => <EfficiencyViewPanel />}
                activeSection={platformAdminSection}
                entityId={platformAdminEntityId}
                onSectionChange={setPlatformAdminRoute}
                settingsOpen={false}
                settingsSection="tenants"
                onSettingsSectionChange={(section) => setAdminSettingsSection(section)}
                onSettingsClose={closeAdminSettings}
                headerControlsPlacement="none"
              />
              </ManagementSettingsAccessGate>
            </Suspense>
          </div>
        )}

        {trashMounted && (
          <div className={cn("min-h-0 flex-1 overflow-auto", activeTab !== "trash" && "hidden")}>
            <TrashView
              onClose={() => { setActiveTab("chat"); previewTrashSession(null); }}
              onPreviewSession={(id) => previewTrashSession(id)}
              activePreviewId={trashPreviewSessionId}
            />
          </div>
        )}
        {personalAgentEnabled
          && !activeOrgAgent
          && activeTab === "chat"
          && roleKitV2Enabled
          && roleKitConfig.firstDayGuideBar.enabled && (
          <FirstDayGuideBar
            visible={hasSuccessfulFinalOutput(messages)}
            activeScenario={lastTriedScenario ?? undefined}
            activeWorkflow={activeWorkflow ?? undefined}
            onOpenCronWizard={handleOpenCronWizard}
            onOpenExampleDemo={handleViewAllScenarios}
            onStartWorkflow={(message, context) => handleStartWorkflow(message, context.scenario)}
            onConnectWorkflow={(context) => {
              setActiveWorkflow(context);
              pushActiveTab("capabilities");
              const params = new URLSearchParams({ returnToWorkflowId: context.scenario.workflowId });
              window.history.replaceState({}, "", `/capabilities/connectors?${params.toString()}`);
            }}
            onRequestDiagnosis={(context) => handleStartWorkflow(
              `我想为「${context.scenario.title}」预约落地诊断，请先确认业务边界、现有系统和所需人审。`,
              context.scenario,
            )}
            onViewWorkflow={(context) => {
              setActiveWorkflow(context);
              pushActiveTab("capabilities");
              const params = new URLSearchParams({ workflow: context.scenario.id, intent: "view" });
              window.history.replaceState({}, "", `/capabilities/templates?${params.toString()}`);
            }}
            stageTimeoutMs={roleKitConfig.firstDayGuideBar.stageTimeoutMs}
          />
        )}
        {personalAgentEnabled && roleKitV2Enabled && (
          <CronCreationWizard
            open={cronWizardOpen}
            scenario={cronWizardScenario}
            onOpenChange={setCronWizardOpen}
          />
        )}
        {!!previewFilePath && previewMode === "dialog" && (
          <Suspense fallback={null}>
            <FilePreviewDialog
              open
              filePath={previewFilePath}
              owner={previewFileOwner}
              onClose={closeFilePreview}
              onDock={dockFilePreview}
            />
          </Suspense>
        )}
        {analysisMode && governanceRoute && <AnalysisWorkspaceContent route={governanceRoute} access={managementAccess} onReturnPersonal={() => handleOpenUnifiedSettings(settingsSection)}
          openFilePreview={openFilePreview} platformAdminSection={platformAdminSection} platformAdminEntityId={platformAdminEntityId} setPlatformAdminRoute={setPlatformAdminRoute} />}
        {settingsMode && (
          <div className="absolute inset-0 z-30 min-h-0 overflow-hidden bg-card" data-testid="unified-settings-content">
            <div className={cn("h-full min-h-0", settingsTarget !== "personal" && "hidden")}>
              <Suspense fallback={SuspenseFallback}>
                <SettingsContent
                  open
                  section={settingsSection}
                  onSectionChange={setSettingsSection}
                  onClose={handleCloseUnifiedSettings}
                  onNavigationControllerChange={handleSettingsControllerChange}
                  renderMemory={() => <MemorySectionPanel />}
                  renderFiles={() => (
                    <FileBrowserLazy
                      onPreviewFile={openFilePreview}
                      owner={authUser?.username}
                      fullPage
                      reserveCloseButtonSpace
                    />
                  )}
                  sidebarLayout={sidebarLayout}
                  onSidebarLayoutChange={handleSidebarLayoutChange}
                  personalAgentEnabled={personalAgentEnabled}
                  renderTrash={() => (
                    <TrashView
                      onClose={handleCloseUnifiedSettings}
                      onPreviewSession={(id) => previewTrashSession(id)}
                      activePreviewId={trashPreviewSessionId}
                      showHeader={false}
                    />
                  )}
                />
              </Suspense>
            </div>

            <Suspense fallback={SuspenseFallback}>
              <ManagementSettingsAccessGate scope="tenant" target={settingsTarget} access={managementAccess} onRetry={managementAccess.retry} onReturnPersonal={() => handleSettingsNavigate("personal", settingsSection)} persistAfterVisit>
                <TenantAdminShell
                    renderUsers={(tenantId, tenantName) => <UserManager tenantIdScope={tenantId} tenantName={tenantName} />}
                    renderSkills={(tenantId, tenantName) => <SkillManagerPanel mode="tenant" tenantIdScope={tenantId} tenantName={tenantName} />}
                    renderOrgAgents={(tenantId, tenantName) => <OrgAgentManagerPanel tenantId={tenantId} tenantName={tenantName} />}
                    renderMcp={() => <McpAdminCatalogPanel />}
                    renderUsage={(tenantId) => <UsageDashboard tenantId={tenantId} scope="tenant" fullWidth />}
                    renderFiles={() => <FileBrowserLazy onPreviewFile={openFilePreview} owner={authUser?.username} fullPage reserveCloseButtonSpace />}
                    renderCompanyInfo={(tenantId, tenantName) => <CompanyInfoSectionPanel tenantId={tenantId} tenantName={tenantName} />}
                    settingsOpen={settingsTarget === "tenant"}
                    settingsContentOnly
                    settingsSection={(settingsTarget === "tenant" ? activeSettingsSection : "users") as TenantSection}
                    onSettingsSectionChange={(section) => handleSettingsNavigate("tenant", section)}
                    onSettingsClose={handleCloseUnifiedSettings}
                />
              </ManagementSettingsAccessGate>
            </Suspense>

            <Suspense fallback={SuspenseFallback}>
              <ManagementSettingsAccessGate scope="platform" target={settingsTarget} access={managementAccess} onRetry={managementAccess.retry} onReturnPersonal={() => handleSettingsNavigate("personal", settingsSection)} persistAfterVisit>
                <PlatformAdminShell
                    renderTenants={() => <TenantManager />}
                    renderSignupConfig={() => <SignupConfigManagerPanel />}
                    renderModels={() => <ModelManagerPanel />}
                    renderRemoteHands={() => <TenantRemoteHandsManagerPanel />}
                    renderToolControls={() => <ToolControlsManagerPanel />}
                    renderMemoryPolling={() => <MemoryPollingManagerPanel />}
                    renderMcp={() => <McpAdminCatalogPanel />}
                    renderSkills={() => <SkillManagerPanel mode="platform" />}
                    renderEfficiency={() => <EfficiencyViewPanel />}
                    activeSection={platformAdminSection}
                    entityId={platformAdminEntityId}
                    onSectionChange={setPlatformAdminRoute}
                    settingsOpen={settingsTarget === "platform"}
                    settingsContentOnly
                    settingsSection={(settingsTarget === "platform" ? activeSettingsSection : "tenants") as PlatformSection}
                    onSettingsSectionChange={(section) => handleSettingsNavigate("platform", section)}
                    onSettingsClose={handleCloseUnifiedSettings}
                />
              </ManagementSettingsAccessGate>
            </Suspense>
          </div>
        )}
        </div>

        {rightPanelOpen && (
          <>
            <div className={cn("w-2.5 shrink-0 items-center justify-center", showRightPanel ? "flex" : "hidden")}>
              <ResizablePanelDivider
                label="调整右侧面板宽度"
                onMouseDown={onDividerMouseDown}
                onDoubleClick={onDividerDoubleClick}
              />
            </div>
            <div
              className={cn(
                "min-w-0 flex-col overflow-hidden rounded-xl",
                FLOATING_PANEL_SURFACE,
                showRightPanel ? "flex" : "hidden",
              )}
              style={{ flexBasis: `calc(${splitRatio * 100}% - 5px)`, flexShrink: 0, flexGrow: 0 }}
            >
              {rightPanelKind === 'subagent' && subagentTranscript ? (
                <Suspense fallback={SuspenseFallback}>
                  <SubagentTranscriptPanel
                    childSessionId={subagentTranscript.childSessionId}
                    title={subagentTranscript.title}
                    onClose={() => closeSubagentTranscript?.()}
                  />
                </Suspense>
              ) : null}
              {rightPanelKind === 'preview' && previewFilePath ? (
                <Suspense fallback={SuspenseFallback}>
                  <FilePreviewPanel
                    filePath={previewFilePath}
                    owner={previewFileOwner}
                    onBack={closeFilePreview}
                    onExpand={expandFilePreview}
                  />
                </Suspense>
              ) : null}
              {systemPanel ? (
                <div className={cn("flex h-full min-h-0 flex-col", rightPanelKind !== 'system' && "hidden")}>
                  <SystemPanel
                    snapshot={systemPanel}
                    pulse={systemPanelPulse}
                    onSelectView={selectSystemPanelView}
                    onClose={dismissSystemPanel}
                    className="min-h-0 flex-1"
                  />
                </div>
              ) : null}
              <div className={cn("flex h-full flex-col", rightPanelKind !== 'browser' && "hidden")}>
                <Suspense fallback={SuspenseFallback}>
                  <FileBrowserLazy
                    onClose={closeFileBrowser}
                    onPreviewFile={openFilePreview}
                    owner={authUser?.username}
                  />
                </Suspense>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
