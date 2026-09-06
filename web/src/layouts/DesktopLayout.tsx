import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Volume2, VolumeX, Loader2, FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { resolveApprovalTier } from "@/lib/approvalTier";
import { Button } from "@/components/ui/button";
import { FloatingPanel, FLOATING_PANEL_SURFACE } from "@/components/ui/floating-panel";
import { Tabs } from "@/components/ui/tabs";
import { ChatTabContent } from "@/components/chat/ChatTabContent";
import { useSubagentTranscript } from "@/contexts/SubagentTranscriptContext";
import { DesktopSessionSidebar } from "@/components/DesktopSessionSidebar";
import { PanelToggleIcon } from "@/components/icons/PanelToggleIcon";
import { TrashView } from "@/components/chat/TrashView";
import { TokenUsageDisplay } from "@/components/TokenUsageDisplay";
import { BillingMiniBadge } from "@/components/BillingMiniBadge";
import { useChatFontSize } from "@/hooks/useChatFontSize";
import { useResizePanel } from "@/hooks/useResizePanel";
import { useSystemPanelDock } from "@/hooks/useSystemPanel";
import { SystemPanel } from "@/components/SystemPanel";
import { ResizablePanelDivider } from "@/components/ResizablePanelDivider";
import { saveUserPreferences } from "@agent/shared";
import type { LayoutProps } from "./types";
import { hasSuccessfulFinalOutput } from "./firstDayGuideVisibility";
import { useChatRightPanelController } from "./useChatRightPanelController";
import { useDesktopLayoutProtection } from "./useDesktopLayoutProtection";
import { APPS_TAB_UNAVAILABLE_TITLE, getDesktopHeaderTitle } from "./desktopHeaderTitle";
import { useAuth } from "@/contexts/AuthContext";
import { useAppsShellState } from "@/hooks/useAppsShellState";
import { useMySystems } from "@/hooks/useMySystems";
const ManagementWorkspaceContent = lazy(() => import('@/components/ManagementShell/ManagementWorkspaceContent').then(m => ({ default: m.ManagementWorkspaceContent })));
const FileBrowserLazy = lazy(() => import("@/components/FileBrowser").then(m => ({ default: m.FileBrowser })));
const FilePreviewDialog = lazy(() => import("@/components/FilePreviewPanel").then(m => ({ default: m.FilePreviewDialog })));
const FilePreviewPanel = lazy(() => import("@/components/FilePreviewPanel").then(m => ({ default: m.FilePreviewPanel })));
const ArtifactPreviewPanel = lazy(() => import("@/components/artifacts/ArtifactPreviewDialog").then(m => ({ default: m.ArtifactPreviewPanel })));
const SubagentTranscriptPanel = lazy(() => import("@/components/SubagentTranscriptPanel").then(m => ({ default: m.SubagentTranscriptPanel })));
const AgentProfilePanel = lazy(() => import("@/components/AgentProfile").then(m => ({ default: m.AgentProfile })));
const MemorySectionPanel = lazy(() => import("@/components/AgentProfile").then(m => ({ default: m.MemorySection })));
const SettingsContent = lazy(() => import("@/components/SettingsCenter").then(m => ({ default: m.SettingsContent })));
const CapabilityCenterPanel = lazy(() => import("@/components/CapabilityCenter").then(m => ({ default: m.CapabilityCenter })));
const AppHostPanel = lazy(() => import("@/components/AppHost").then(m => ({ default: m.AppHost })));
import {
  CronManager, McpManagerPanel, ModelManagerPanel, SettingsDirtyBoundary,
  SkillManagerPanel, TenantManager, UsageDashboard,
} from "./lazySettingsComponents";
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

const SuspenseFallback = (
  <div className="flex flex-1 items-center justify-center">
    <Loader2 className="size-6 animate-spin text-muted-foreground" />
  </div>
);
export function DesktopLayout(props: LayoutProps) {
  const {
    sidebarSessions, sessionId, selectSession, newSession, newPersonalSession, confirmDeleteSession, confirmDeleteSessions, renameSession, autoTitleSession, compactSession,
    isLoadingSessions, activeTab, governanceRoute, platformAdminSection, platformAdminEntityId, setActiveTab, pushActiveTab, setPlatformAdminRoute, settingsOpen, settingsSection, openSettings, closeSettings, setSettingsSection,
    adminSettings, openAdminSettings, closeAdminSettings, setAdminSettingsSection,
    isAdmin, isPlatformAdmin, isOnline, connectionState,
    messages, loading, isLoadingMessages, sessionLoadError, retrySessionLoad, hasMoreHistory, isLoadingEarlier, loadEarlierMessages,
    retryMessage, forkFromMessage, lastMessageRef, scrollContainerRef, isNearBottomRef,
    handlePermissionResponse, handleAskUserResponse,
    uploadedFiles, removeFile, input, sandboxProfile, setSandboxProfile, uploading, uploadError, dismissUploadError, setInput,
    sendMessage, sendVoiceMessage, stopping, stopGeneration, handleFileSelect, handleAssetSelect, handlePaste, ttsProps, ttsStateMap, modelList,
    queuedInterjections, cancelQueuedInterjection, editQueuedInterjection, resendQueuedInterjection, dismissQueuedInterjection,
    selectedModel, onModelChange, autoApproveRunShell, setAutoApproveRunShell, ttsPlayer, tokenUsage, contextUsage,
    automation, automationTimeline, automationPending, automationError, controlAutomation,
    hasMoreSessions, isLoadingMoreSessions, loadMoreSessions, loadGroupSessions,
    previewFilePath, previewFileOwner, previewMode, openFilePreview, dockFilePreview, expandFilePreview, closeFilePreview,
    previewArtifact, closeArtifactPreview,
    fileBrowserOpen, toggleFileBrowser, closeFileBrowser,
    isTrashPreview, previewTrashSession, trashPreviewSessionId,
    agentProfile, sessionParticipants,
    startOrgAgentSession, activeOrgAgent, activeOrgAgentReadOnly, sessionReadOnly, activeAgentTargetUnavailableReason, activeAgentTargetLabel, myOrgAgents, personalAgentEnabled, orgAgentIdentityLoading,
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
    openAdminSettings, closeAdminSettings, setAdminSettingsSection, isPlatformAdmin, organizationSettingsTargetId: undefined,
    governanceRoute, closeOrganizationSettings: closeSettings,
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
  // TASK-256：统一三档 tier（缺省默认全部授权，与服务端一致）。
  const approvalTier = resolveApprovalTier(authUser?.preferences);
  const handleSidebarLayoutChange = useCallback((layout: "double" | "single") => {
    updatePreferences({ sidebarLayout: layout });
    void saveUserPreferences({ sidebarLayout: layout }).then((saved) => { if (saved) updatePreferences(saved); });
  }, [updatePreferences]);
  const { isLarge: chatFontLarge, setIsLarge: setChatFontLarge } = useChatFontSize();
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

  const [taskDetailPanelTarget, setTaskDetailPanelTarget] = useState<HTMLDivElement | null>(null); const [taskDetailOpen, setTaskDetailOpen] = useState(false);
  const {
    businessStepPanelOpen, businessStepDetailHost, setBusinessStepDetailHost, rightPanelKind, rightPanelKey,
    handleBusinessStepPanelOpenChange, handleOpenFilePreview, handleCloseFilePreview, handleDockFilePreview,
    handleExpandFilePreview, handleToggleFileBrowser, handleCloseFileBrowser, handleCloseSubagentTranscript,
  } = useChatRightPanelController({
    sessionId, previewFilePath, previewMode, previewArtifact, fileBrowserOpen,
    subagentTranscript: subagentTranscript ?? null, systemPanelOpen,
    openFilePreview, closeFilePreview, dockFilePreview, expandFilePreview,
    toggleFileBrowser, closeFileBrowser, closeSubagentTranscript,
  });
  const rightPanelOpen = rightPanelKind !== null;
  const showRightPanel = !settingsMode && !analysisMode && activeTab === "chat" && rightPanelOpen;
  const showTaskDetailPanel = !settingsMode && !analysisMode && activeTab === "cron" && taskDetailOpen;
  const showDockedPanel = showRightPanel || showTaskDetailPanel; const dockedPanelKey = showTaskDetailPanel ? "task-detail" : rightPanelKey;
  const { ratio: splitRatio, containerRef: splitContainerRef, onDividerMouseDown, onDividerDoubleClick } = useResizePanel(0.35, 0.25, 0.75, dockedPanelKey);
  const dockedPanelWidth = `clamp(26rem, ${splitRatio * 100}%, 46rem)`;

  // 侧边栏折叠状态
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("sidebar-collapsed") === "true");
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(prev => {
      const next = !prev;
      localStorage.setItem("sidebar-collapsed", String(next));
      return next;
    });
  }, []);
  const layoutProtection = useDesktopLayoutProtection({
    enabled: !settingsMode && !analysisMode && (activeTab === "chat" || activeTab === "cron"),
    sidebarLayout,
    sidebarPersistentlyCollapsed: sidebarCollapsed,
    panelOpen: showDockedPanel,
    panelRatio: splitRatio,
  });
  const [responsiveSidebarRevealed, setResponsiveSidebarRevealed] = useState(false);
  const responsiveSidebarOverlayOpen = layoutProtection.hideSidebar && responsiveSidebarRevealed;
  useEffect(() => {
    if (!layoutProtection.hideSidebar) {
      setResponsiveSidebarRevealed(false);
      return;
    }
    if (!responsiveSidebarRevealed) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setResponsiveSidebarRevealed(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [layoutProtection.hideSidebar, responsiveSidebarRevealed]);
  const responsiveSidebarMode = layoutProtection.hideSidebar
    ? responsiveSidebarOverlayOpen ? "secondary-hidden" : "hidden"
    : layoutProtection.hideSecondarySidebar
      ? "secondary-hidden"
      : "none";
  const panelOverlay = layoutProtection.overlayPanel && showDockedPanel;
  const responsivePanelStyle = panelOverlay
    ? { width: `min(${dockedPanelWidth}, calc(100% - 1rem))`, flexShrink: 0 }
    : { width: dockedPanelWidth, flexShrink: 0 };

  const [cronHeaderNavigationTarget, setCronHeaderNavigationTarget] = useState<HTMLDivElement | null>(null);
  const [cronHeaderActionsTarget, setCronHeaderActionsTarget] = useState<HTMLDivElement | null>(null);

  // 定制软件壳路由：独立订阅同一条 popstate 通道，不经 useChatAppState（§5.2）
  const { appsRoute } = useAppsShellState();
  // 安装实例走壳内单一来源，与左栏入口共享同一次 GET /api/systems/mine
  const { status: appsStatus, installations: appsInstallations } = useMySystems();
  const appsInstallation = useMemo(
    () => appsInstallations.find((item) => item.installationId === appsRoute?.installationId) ?? null,
    [appsInstallations, appsRoute?.installationId],
  );
  // §6.6：header 显示《系统名》；列表已就绪却查无此实例 = 已停用 / 不再可见 → 「暂不可用」
  const appsTitle = appsInstallation?.name
    ?? (appsRoute && appsStatus === "ready" ? APPS_TAB_UNAVAILABLE_TITLE : null);

  const headerTitle = useMemo(() => getDesktopHeaderTitle({
    activeTab,
    isTrashPreview,
    sidebarSessions,
    sessionId,
    activeAgentTargetLabel,
    activeOrgAgent,
    orgAgentIdentityLoading,
    agentProfile,
    appsTitle,
  }), [activeTab, isTrashPreview, sidebarSessions, sessionId, activeAgentTargetLabel, activeOrgAgent, agentProfile, orgAgentIdentityLoading, appsTitle]);

  // mount-once-visited：首次切换到 tab 后永久挂载
  const [cronMounted, setCronMounted] = useState(false);
  const [tenantsMounted, setTenantsMounted] = useState(false);
  const [profileMounted, setProfileMounted] = useState(false);
  const [skillsMounted, setSkillsMounted] = useState(false);
  const [usageMounted, setUsageMounted] = useState(false);
  const [mcpMounted, setMcpMounted] = useState(false);
  const [modelsMounted, setModelsMounted] = useState(false);
  const [trashMounted, setTrashMounted] = useState(false);
  const [capabilitiesMounted, setCapabilitiesMounted] = useState(false);
  const [appsMounted, setAppsMounted] = useState(false);
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
    if (activeTab === "trash" && !trashMounted) setTrashMounted(true);
    if (activeTab === "apps" && !appsMounted) setAppsMounted(true);
  }, [activeTab, capabilitiesMounted, cronMounted, tenantsMounted, profileMounted, skillsMounted, usageMounted, mcpMounted, modelsMounted, trashMounted, appsMounted, isAdmin, isPlatformAdmin]);

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
    if (orgAgentIdentityLoading) return;
    const fallback = legacyRoleFallbackTab({ activeTab, personalAgentEnabled, isAdmin, isPlatformAdmin });
    if (fallback) setActiveTab(fallback);
  }, [isAdmin, isPlatformAdmin, personalAgentEnabled, orgAgentIdentityLoading, activeTab, setActiveTab]);

  return (
    <div ref={layoutProtection.containerRef} className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
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
        onCollapse={settingsMode || analysisMode ? undefined : responsiveSidebarOverlayOpen ? () => setResponsiveSidebarRevealed(false) : toggleSidebar}
        onPreviewTrashSession={previewTrashSession}
        trashPreviewSessionId={trashPreviewSessionId}
        sidebarLayout={sidebarLayout}
        personalAgentEnabled={personalAgentEnabled || orgAgentIdentityLoading}
        responsiveMode={responsiveSidebarMode}
        className={cn(responsiveSidebarOverlayOpen && "absolute inset-y-0 left-0 z-50 shadow-2xl")}
      />
      {responsiveSidebarOverlayOpen && (
        <button type="button" className="absolute inset-0 z-40 bg-black/10" aria-label="关闭临时侧边栏" onClick={() => setResponsiveSidebarRevealed(false)} />
      )}

      {/* 右侧内容区 */}
      <div
        ref={showDockedPanel ? splitContainerRef : undefined}
        className={cn(
          "relative my-2.5 mr-2.5 flex min-h-0 min-w-0 flex-1",
          (sidebarCollapsed || layoutProtection.hideSidebar) && !settingsMode && !analysisMode && "ml-2.5",
          chatFontLarge && "chat-font-large",
        )}
      >
        <div
          className={cn(
            "relative flex min-h-0 min-w-0 flex-col overflow-hidden",
            !capabilityReplayActive && "rounded-xl",
            contentPanelFloating && FLOATING_PANEL_SURFACE,
          )}
          style={{ flex: 1 }}
        >
        <div
          className={cn("contents", settingsMode && "invisible")}
          aria-hidden={settingsMode || undefined}
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
            {(sidebarCollapsed || (layoutProtection.hideSidebar && !responsiveSidebarOverlayOpen)) && !settingsMode && !analysisMode && (
              <Button
                variant="ghost"
                size="icon"
                className="size-9 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
                onClick={(e) => { e.stopPropagation(); if (layoutProtection.hideSidebar) setResponsiveSidebarRevealed(true); else toggleSidebar(); }}
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
                onClick={handleToggleFileBrowser}
                title="文件浏览器"
              >
                <FolderOpen className={cn("size-[18px]", fileBrowserOpen ? "text-primary" : "text-muted-foreground")} />
              </Button>
            </div>
          )}
        </header>

        {!isOnline && (
          <div className="shrink-0 bg-warning px-4 py-1.5 text-center text-xs font-medium text-foreground">
            网络未连接
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
              isLoadingMessages={isLoadingMessages} sessionLoadError={sessionLoadError} onRetrySessionLoad={retrySessionLoad}
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
              input={input} sandboxProfile={sandboxProfile} onSandboxProfileChange={setSandboxProfile}
              uploading={uploading}
              uploadError={uploadError}
              onDismissUploadError={dismissUploadError}
              onInputChange={setInput}
              onSend={() => { void handleSendMessage(); }}
              onStop={stopGeneration}
              stopping={stopping}
              queuedInterjections={queuedInterjections}
              onCancelQueuedInterjection={cancelQueuedInterjection}
              onEditQueuedInterjection={editQueuedInterjection}
              onResendQueuedInterjection={resendQueuedInterjection}
              onDismissQueuedInterjection={dismissQueuedInterjection}
              automation={automation}
              automationTimeline={automationTimeline}
              automationPending={automationPending}
              automationError={automationError}
              onAutomationControl={controlAutomation}
              onFileSelect={(event) => { void handleFileSelect(event); }}
              onAssetSelect={handleAssetSelect}
              onPaste={(event) => { void handlePaste(event); }}
              tts={ttsProps}
              ttsStateMap={ttsStateMap}
              modelList={modelList}
              selectedModel={selectedModel}
              sessionId={sessionId}
              businessStepDetailMode="desktop"
              businessStepDetailHost={businessStepDetailHost}
              businessStepPanelOpen={businessStepPanelOpen}
              onBusinessStepPanelOpenChange={handleBusinessStepPanelOpenChange}
              onModelChange={onModelChange}
              canAutoApproveRunShell={approvalTier === "ask"}
              autoApproveRunShell={autoApproveRunShell}
              onAutoApproveRunShellChange={setAutoApproveRunShell}
              onSendVoice={(wavBlob, durationMs) => sendVoiceMessage(wavBlob, durationMs)}
              readOnly={isTrashPreview || sessionReadOnly || activeOrgAgentReadOnly || orgAgentIdentityLoading}
              readOnlyInputPlaceholder={sessionReadOnly ? "任务执行会话仅供协作成员查看" : (!isTrashPreview && orgAgentIdentityLoading ? "正在加载 Agent 目录..." : (!isTrashPreview && activeOrgAgentReadOnly ? activeAgentTargetUnavailableReason?.message ?? "该 Agent 当前不可用，请联系组织管理员" : undefined))}
              agentProfile={orgAgentIdentityLoading ? null : agentProfile}
              sessionParticipants={sessionParticipants}
              emptySlot={activeOrgAgent ? expertEmptySlot : (orgAgentIdentityLoading ? identityLoadingEmptySlot : (personalAgentEnabled ? chatEmptySlot : unavailableEmptySlot))}
              initialComposer={!isTrashPreview && !sessionReadOnly && !orgAgentIdentityLoading && !activeOrgAgentReadOnly && (Boolean(activeOrgAgent) || personalAgentEnabled)}
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
        {appsMounted && (
          // §5.5：定制软件切走再切回要保留页面与滚动位置 —— 与其它标签同款
          // 「惰性挂载 + hidden 隐藏」，**禁止条件卸载 iframe**。
          <div className={cn("min-h-0 flex-1 overflow-hidden", activeTab !== "apps" && "hidden")}>
            <Suspense fallback={SuspenseFallback}>
              <AppHostPanel appsRoute={appsRoute} />
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
                detailPanelTarget={taskDetailPanelTarget}
                onTaskDetailOpenChange={setTaskDetailOpen}
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
        </div>
        {!!previewFilePath && previewMode === "dialog" && (
          <Suspense fallback={null}>
            <FilePreviewDialog
              open
              filePath={previewFilePath}
              owner={previewFileOwner}
              onClose={handleCloseFilePreview}
              onDock={handleDockFilePreview}
            />
          </Suspense>
        )}
        {(analysisMode || (settingsMode && settingsTarget !== 'personal')) && governanceRoute && (
          <ManagementWorkspaceContent
            route={governanceRoute}
            access={managementAccess}
            onReturnPersonal={() => handleOpenUnifiedSettings(settingsSection)}
            platformAdminSection={platformAdminSection}
            platformAdminEntityId={platformAdminEntityId}
            setPlatformAdminRoute={setPlatformAdminRoute}
          />
        )}
        {settingsMode && settingsTarget === 'personal' && <Suspense fallback={SuspenseFallback}><SettingsDirtyBoundary onControllerChange={handleSettingsControllerChange}>{(dirtyController) => (
          <div className="absolute inset-0 z-30 min-h-0 overflow-hidden bg-card" data-testid="unified-settings-content">
            <div className="h-full min-h-0">
              <Suspense fallback={SuspenseFallback}>
                <SettingsContent
                  open
                  section={settingsSection}
                  onSectionChange={setSettingsSection}
                  onClose={handleCloseUnifiedSettings}
                  dirtyController={dirtyController}
                  renderMemory={() => <MemorySectionPanel />}
                  renderFiles={() => (
                    <FileBrowserLazy
                      onPreviewFile={handleOpenFilePreview}
                      owner={authUser?.username}
                      fullPage
                      reserveCloseButtonSpace
                    />
                  )}
                  sidebarLayout={sidebarLayout}
                  onSidebarLayoutChange={handleSidebarLayoutChange}
                  chatFontLarge={chatFontLarge}
                  onChatFontSizeChange={setChatFontLarge}
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
          </div>
        )}</SettingsDirtyBoundary></Suspense>}
        </div>

        {rightPanelOpen && (
          <>
            <div className={cn("w-2.5 shrink-0 items-center justify-center", showRightPanel && !panelOverlay ? "flex" : "hidden")}>
              <ResizablePanelDivider
                label="调整右侧面板宽度"
                onMouseDown={onDividerMouseDown}
                onDoubleClick={onDividerDoubleClick}
              />
            </div>
            <FloatingPanel
              className={cn("min-w-0 flex-col", showRightPanel ? "flex" : "hidden", panelOverlay && "absolute inset-y-0 right-0 z-40")}
              style={responsivePanelStyle}
              data-responsive-panel-mode={panelOverlay ? "overlay" : "docked"}
            >
              {rightPanelKind === 'business-step' ? (
                <div ref={setBusinessStepDetailHost} className="h-full min-h-0" data-business-step-detail-host />
              ) : null}
              {rightPanelKind === 'subagent' && subagentTranscript ? (
                <Suspense fallback={SuspenseFallback}>
                  <SubagentTranscriptPanel
                    childSessionId={subagentTranscript.childSessionId}
                    title={subagentTranscript.title}
                    onClose={handleCloseSubagentTranscript}
                  />
                </Suspense>
              ) : null}
              {rightPanelKind === 'artifact' && previewArtifact ? (
                <Suspense fallback={SuspenseFallback}>
                  <ArtifactPreviewPanel {...previewArtifact} onClose={closeArtifactPreview} />
                </Suspense>
              ) : null}
              {rightPanelKind === 'preview' && previewFilePath ? (
                <Suspense fallback={SuspenseFallback}>
                  <FilePreviewPanel
                    filePath={previewFilePath}
                    owner={previewFileOwner}
                    onBack={handleCloseFilePreview}
                    onExpand={handleExpandFilePreview}
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
                    onClose={handleCloseFileBrowser}
                    onPreviewFile={handleOpenFilePreview}
                    owner={authUser?.username}
                  />
                </Suspense>
              </div>
            </FloatingPanel>
          </>
        )}

        <div className={cn("w-2.5 shrink-0 items-center justify-center", showTaskDetailPanel && !panelOverlay ? "flex" : "hidden")}>
          <ResizablePanelDivider label="调整任务详情宽度" onMouseDown={onDividerMouseDown} onDoubleClick={onDividerDoubleClick} />
        </div>
        <div
          ref={setTaskDetailPanelTarget}
          className={cn("min-w-0 flex-col", showTaskDetailPanel ? "flex" : "hidden", panelOverlay && "absolute inset-y-0 right-0 z-40")}
          style={responsivePanelStyle}
          data-responsive-panel-mode={panelOverlay ? "overlay" : "docked"}
        />
        <span ref={layoutProtection.fontProbeRef} className="pointer-events-none absolute size-px invisible" style={{ width: "1rem" }} aria-hidden="true" />
      </div>
    </div>
  );
}
