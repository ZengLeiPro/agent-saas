import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Volume2, VolumeX, Loader2, PanelLeft, FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChatTabContent } from "@/components/chat/ChatTabContent";
import { FilePreviewDialog, FilePreviewPanel } from "@/components/FilePreviewPanel";
import { DesktopSessionSidebar } from "@/components/DesktopSessionSidebar";
import { TrashView } from "@/components/chat/TrashView";
import { TokenUsageDisplay } from "@/components/TokenUsageDisplay";
import { BillingMiniBadge } from "@/components/BillingMiniBadge";
import { FontSizeToggle } from "@/components/FontSizeToggle";
import { WidthToggle } from "@/components/WidthToggle";
import { PlatformAdminHeaderControls } from "@/components/PlatformAdmin/PlatformAdminHeaderControls";
import { TenantAdminHeaderControls } from "@/components/TenantAdminHeaderControls";
import { useChatFontSize } from "@/hooks/useChatFontSize";
import { useChatWidth } from "@/hooks/useChatWidth";
import { useResizePanel } from "@/hooks/useResizePanel";
import { saveUserPreferences } from "@agent/shared";
import type { LayoutProps } from "./types";
import { useAuth } from "@/contexts/AuthContext";

const CronManager = lazy(() => import("@/components/CronManager").then(m => ({ default: m.CronManager })));
const UserManager = lazy(() => import("@/components/UserManager").then(m => ({ default: m.UserManager })));
const TenantManager = lazy(() => import("@/components/TenantManager").then(m => ({ default: m.TenantManager })));
const FileBrowserLazy = lazy(() => import("@/components/FileBrowser").then(m => ({ default: m.FileBrowser })));
const AgentProfilePanel = lazy(() => import("@/components/AgentProfile").then(m => ({ default: m.AgentProfile })));
const AllAgentsListPanel = lazy(() => import("@/components/AgentProfile").then(m => ({ default: m.AllAgentsList })));
const SkillsSectionPanel = lazy(() => import("@/components/AgentProfile").then(m => ({ default: m.SkillsSection })));
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
const SettingsModal = lazy(() => import("@/components/SettingsCenter").then(m => ({ default: m.SettingsModal })));
const TenantAdminShell = lazy(() => import("@/components/AdminShells").then(m => ({ default: m.TenantAdminShell })));
const PlatformAdminShell = lazy(() => import("@/components/AdminShells").then(m => ({ default: m.PlatformAdminShell })));
const ScenariosPanelLazy = lazy(() => import("@/components/scenarios/ScenariosPanel").then(m => ({ default: m.ScenariosPanel })));
import type { TenantSection, PlatformSection } from "@/components/AdminShells";
import { EmptySessionScenarios } from "@/components/scenarios/EmptySessionScenarios";
import { EmptyChatRecommendCards } from "@/components/scenarios/EmptyChatRecommendCards";
import { useRoleKitConfig } from "@/components/scenarios/useRoleKitConfig";
import { useScenarioDeepLink } from "@/components/scenarios/useScenarioDeepLink";
import { FirstDayGuideBar } from "@/components/onboarding/FirstDayGuideBar";
import { CronCreationWizard } from "@/components/onboarding/CronCreationWizard";
import type { ScenarioItem } from "@agent/shared";
const CompanyInfoSectionPanel = lazy(() => import("@/components/CompanyInfoEditor").then(m => ({ default: m.CompanyInfoSection })));
const OrgAgentManagerPanel = lazy(() => import("@/components/OrgAgentManager").then(m => ({ default: m.OrgAgentManager })));

const SuspenseFallback = (
  <div className="flex flex-1 items-center justify-center">
    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
  </div>
);

export function DesktopLayout(props: LayoutProps) {
  const {
    sidebarSessions, unreadAiReplySessionIds, sessionId, selectSession, newSession, confirmDeleteSession, confirmDeleteSessions, renameSession, autoTitleSession, compactSession,
    isLoadingSessions, activeTab, platformAdminSection, platformAdminEntityId, setActiveTab, pushActiveTab, setPlatformAdminRoute, settingsOpen, settingsSection, openSettings, closeSettings, setSettingsSection,
    adminSettings, openAdminSettings, closeAdminSettings, setAdminSettingsSection,
    isAdmin, isPlatformAdmin, isOnline, connectionState,
    messages, loading, isLoadingMessages, retryMessage, forkFromMessage, lastMessageRef, scrollContainerRef, isNearBottomRef,
    handlePermissionResponse, handleAskUserResponse,
    uploadedFiles, removeFile, input, uploading, uploadError, dismissUploadError, setInput,
    sendMessage, sendVoiceMessage, stopping, stopGeneration, handleFileSelect, handlePaste, ttsProps, ttsStateMap, modelList,
    selectedModel, onModelChange, autoApproveRunShell, setAutoApproveRunShell, ttsPlayer, tokenUsage, contextUsage,
    hasMoreSessions, isLoadingMoreSessions, loadMoreSessions, loadGroupSessions,
    previewFilePath, previewFileOwner, previewMode, openFilePreview, dockFilePreview, closeFilePreview,
    fileBrowserOpen, toggleFileBrowser, closeFileBrowser,
    isTrashPreview, previewTrashSession, trashPreviewSessionId,
    agentProfile, sessionParticipants,
    startOrgAgentSession, activeOrgAgent, activeOrgAgentReadOnly, myOrgAgents,
  } = props;

  const { user: authUser, updatePreferences } = useAuth();
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

  const sidePreviewOpen = !!previewFilePath && previewMode === "side";
  const rightPanelOpen = sidePreviewOpen || fileBrowserOpen;
  const rightPanelKey = sidePreviewOpen ? previewFilePath : (fileBrowserOpen ? 'browser' : null);
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

  // Cron 任务计数（由 CronManager 回报）
  const [cronJobCount, setCronJobCount] = useState<{ enabled: number; total: number } | null>(null);
  const handleCronJobCountChange = useCallback((enabled: number, total: number) => {
    setCronJobCount({ enabled, total });
  }, []);

  // Header 标题：根据 activeTab 动态显示
  const headerTitle = useMemo(() => {
    if (activeTab === "profile") return "我的 Agent";
    if (activeTab === "scenarios") return "场景库";
    if (activeTab === "cron") return "定时任务";
    if (activeTab === "tenants") return "组织分析";
    if (activeTab === "tenant-admin") return "组织分析";
    if (activeTab === "platform-admin") return "平台分析";
    if (activeTab === "skills") return "Skill 管理";
    if (activeTab === "usage") return "Token 用量";
    if (activeTab === "mcp") return "MCP 配置";
    if (activeTab === "models") return "模型管理";
    if (activeTab === "trash") return "回收站";
    if (isTrashPreview) return "回收站预览";
    return sidebarSessions.find(s => s.id === sessionId)?.title || agentProfile?.name || "KY Agent";
  }, [activeTab, isTrashPreview, sidebarSessions, sessionId, agentProfile]);

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
  const [scenariosMounted, setScenariosMounted] = useState(false);
  const [roleDetailId, setRoleDetailId] = useState<string | null>(null);
  const [lastTriedScenario, setLastTriedScenario] = useState<ScenarioItem | null>(null);
  const [cronWizardOpen, setCronWizardOpen] = useState(false);
  const [cronWizardScenario, setCronWizardScenario] = useState<ScenarioItem | null>(null);
  const [tenantAdminSection, setTenantAdminSection] = useState<TenantSection>("overview");
  useEffect(() => {
    if (activeTab === "cron" && !cronMounted) setCronMounted(true);
    if (activeTab === "scenarios" && !scenariosMounted) setScenariosMounted(true);
    if (activeTab === "tenants" && !tenantsMounted && isPlatformAdmin) setTenantsMounted(true);
    if (activeTab === "profile" && !profileMounted) setProfileMounted(true);
    if (activeTab === "skills" && !skillsMounted && isAdmin) setSkillsMounted(true);
    if (activeTab === "usage" && !usageMounted && isAdmin) setUsageMounted(true);
    if (activeTab === "mcp" && !mcpMounted) setMcpMounted(true);
    if (activeTab === "models" && !modelsMounted && isPlatformAdmin) setModelsMounted(true);
    if (activeTab === "tenant-admin" && !tenantAdminMounted && isAdmin) setTenantAdminMounted(true);
    if (activeTab === "platform-admin" && !platformAdminMounted && isPlatformAdmin) setPlatformAdminMounted(true);
    if (activeTab === "trash" && !trashMounted) setTrashMounted(true);
  }, [activeTab, cronMounted, tenantsMounted, profileMounted, skillsMounted, usageMounted, mcpMounted, modelsMounted, tenantAdminMounted, platformAdminMounted, trashMounted, scenariosMounted, isAdmin, isPlatformAdmin]);

  // ---- 场景库「试一试」链路 ----
  // 整页场景库里点「试一试」：新建会话 → 预填起手 prompt（不自动发送）→ 切回聊天视图。
  // 顺序不能反：newSession 内部会清空输入框（clearComposer），必须先建会话再 setInput。
  const handleTryScenario = useCallback((prompt: string, scenario?: ScenarioItem) => {
    if (scenario) setLastTriedScenario(scenario);
    newSession();
    setInput(prompt);
    setActiveTab("chat");
  }, [newSession, setInput, setActiveTab]);

  // 空会话推荐卡：当前会话本来就是空的，直接预填当前输入框即可，无需再新建会话
  const handlePrefillScenario = useCallback((prompt: string, scenario?: ScenarioItem) => {
    if (scenario) setLastTriedScenario(scenario);
    setInput(prompt);
  }, [setInput]);

  // 场景直达：消费 ?scenario=<id>（官网注册落地 / 销售场景链接），预填起手指令
  useScenarioDeepLink(handlePrefillScenario);

  // 「查看全部场景」：push 版切换，浏览器后退可回到聊天
  const handleViewAllScenarios = useCallback(() => {
    pushActiveTab("scenarios");
  }, [pushActiveTab]);

  const handleOpenRoleDetail = useCallback((roleId: string) => {
    setRoleDetailId(roleId);
    pushActiveTab("scenarios");
  }, [pushActiveTab]);

  const handleOpenCronWizard = useCallback(() => {
    if (lastTriedScenario?.mode === "recurring") {
      setCronWizardScenario(lastTriedScenario);
      setCronWizardOpen(true);
      return;
    }
    pushActiveTab("scenarios");
  }, [lastTriedScenario, pushActiveTab]);

  // 新会话空白态的推荐槽位。MessageList 被 memo，这里必须用 useMemo 保持节点引用稳定，
  // 避免输入框每次击键（input 变化触发本组件重渲染）都打穿 MessageList 的 memo。
  const chatEmptySlot = useMemo(() => (
    roleKitV2Enabled ? (
      <EmptyChatRecommendCards
        onTryScenario={handlePrefillScenario}
        onViewAll={handleViewAllScenarios}
        onOpenRoleDetail={handleOpenRoleDetail}
      />
    ) : (
      <EmptySessionScenarios
        onTryScenario={handlePrefillScenario}
        onViewAll={handleViewAllScenarios}
      />
    )
  ), [handleOpenRoleDetail, handlePrefillScenario, handleViewAllScenarios, roleKitV2Enabled]);

  // 非 admin 用户访问 admin-only tab 时重定向到 chat
  // 组织分析对 admin 可见；平台分析仅限平台 admin。
  useEffect(() => {
    if (!isAdmin && (activeTab === "skills" || activeTab === "usage" || activeTab === "tenant-admin")) {
      setActiveTab("chat");
    }
    if (!isPlatformAdmin && (activeTab === "tenants" || activeTab === "models" || activeTab === "platform-admin")) {
      setActiveTab("chat");
    }
  }, [isAdmin, isPlatformAdmin, activeTab, setActiveTab]);

  return (
    <div className="flex min-h-0 flex-1">
      <DesktopSessionSidebar
        sessions={sidebarSessions}
        unreadAiReplySessionIds={unreadAiReplySessionIds}
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
        onPushTab={pushActiveTab}
        onOpenSettings={openSettings}
        onOpenAdminSettings={openAdminSettings}
        isAdmin={isAdmin}
        isPlatformAdmin={isPlatformAdmin}
        hasMore={hasMoreSessions}
        isLoadingMore={isLoadingMoreSessions}
        onLoadMore={loadMoreSessions}
        onLoadGroupSessions={loadGroupSessions}
        hidden={sidebarCollapsed}
        onPreviewTrashSession={previewTrashSession}
        trashPreviewSessionId={trashPreviewSessionId}
        sidebarLayout={sidebarLayout}
        onStartOrgAgentSession={startOrgAgentSession}
        orgAgents={myOrgAgents}
      />

      {/* 右侧内容区 */}
      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", chatFontLarge && "chat-font-large", chatWidthWide && "chat-width-wide")}>
        {/* 内容区 header */}
        <header
          className="flex h-12 shrink-0 items-center gap-3 border-b bg-background px-4"
          onClick={(e) => {
            if ((e.target as HTMLElement).closest("button, a, input, textarea, select, [role=button]")) return;
            (scrollContainerRef as React.RefObject<HTMLDivElement>)?.current?.scrollTo({ top: 0, behavior: "smooth" });
          }}
        >
          <div className="flex min-w-0 items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={(e) => { e.stopPropagation(); toggleSidebar(); }}
              title={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
            >
              <PanelLeft className="h-4 w-4" />
            </Button>
            <div className="truncate text-base font-semibold">
              {headerTitle}
            </div>
            {activeTab === "cron" && cronJobCount && (
              <span className="text-xs text-muted-foreground">
                ({cronJobCount.enabled}/{cronJobCount.total})
              </span>
            )}
            {activeTab === "chat" && sessionId ? (
              <Badge variant="secondary">
                {sessionId.slice(0, 8)}
              </Badge>
            ) : null}
          </div>
          {activeTab === "platform-admin" && (
            <PlatformAdminHeaderControls
              active={platformAdminSection}
              onActiveChange={(section) => setPlatformAdminRoute(section)}
              className="min-w-0 flex-1"
            />
          )}
          {activeTab === "tenant-admin" && (
            <TenantAdminHeaderControls
              active={tenantAdminSection}
              onActiveChange={setTenantAdminSection}
              className="min-w-0 flex-1"
            />
          )}
          {activeTab === "chat" && (
            <div className="ml-auto flex items-center gap-2">
              {modelList?.showContextTokens !== false && (
                <TokenUsageDisplay tokenUsage={tokenUsage} contextUsage={contextUsage} />
              )}
              <BillingMiniBadge sessionId={sessionId} />
              <FontSizeToggle isLarge={chatFontLarge} onChange={setChatFontLarge} />
              <div className="w-0.5" />
              <WidthToggle isWide={chatWidthWide} onChange={setChatWidthWide} />
              {ttsPlayer.available && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={ttsPlayer.toggleAutoPlay}
                  title={ttsPlayer.autoPlay ? "Auto-play voice on" : "Auto-play voice off"}
                >
                  {ttsPlayer.autoPlay ? (
                    <Volume2 className="h-5 w-5 text-primary" />
                  ) : (
                    <VolumeX className="h-5 w-5 text-muted-foreground" />
                  )}
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={toggleFileBrowser}
                title="文件浏览器"
              >
                <FolderOpen className={cn("h-5 w-5", fileBrowserOpen ? "text-primary" : "text-muted-foreground")} />
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
            <Loader2 className="h-3 w-3 animate-spin" />
            重新连接中...
          </div>
        )}

        {/* Tab 内容 */}
        <div ref={rightPanelOpen ? splitContainerRef : undefined} className={cn("flex min-h-0 flex-1 overflow-hidden", activeTab !== "chat" && "hidden")}>
          <div className="flex min-h-0 min-w-0 flex-col overflow-hidden" style={rightPanelOpen ? { flexBasis: `${(1 - splitRatio) * 100}%`, flexShrink: 0, flexGrow: 0 } : { flex: 1 }}>
            <ChatTabContent
              messages={messages}
              loading={loading}
              isLoadingMessages={isLoadingMessages}
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
              onSend={() => { void sendMessage(); }}
              onStop={stopGeneration}
              stopping={stopping}
              onFileSelect={(event) => { void handleFileSelect(event); }}
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
              readOnly={isTrashPreview || activeOrgAgentReadOnly}
              readOnlyInputPlaceholder={!isTrashPreview && activeOrgAgentReadOnly ? "该专职 Agent 当前不可用，请联系组织管理员" : undefined}
              agentProfile={agentProfile}
              sessionParticipants={sessionParticipants}
              emptySlot={activeOrgAgent ? undefined : chatEmptySlot}
              orgAgent={isTrashPreview ? null : activeOrgAgent}
              onNewOrgAgentConversation={activeOrgAgent && !activeOrgAgentReadOnly
                ? () => { void startOrgAgentSession(activeOrgAgent.id); }
                : undefined}
            />
          </div>
          {rightPanelOpen && (
            <>
              {/* 拖拽分割条 */}
              <div
                className="group relative flex w-0 shrink-0 cursor-col-resize items-center justify-center"
                onMouseDown={onDividerMouseDown}
                onDoubleClick={onDividerDoubleClick}
              >
                <div className="absolute inset-y-0 -left-1 -right-1 z-10" />
                <div className="pointer-events-none absolute inset-y-0 w-px bg-border transition-colors group-hover:w-[3px] group-hover:bg-primary/30" />
              </div>
              <div className="flex min-w-0 flex-col overflow-hidden" style={{ flexBasis: `${splitRatio * 100}%`, flexShrink: 0, flexGrow: 0 }}>
                {sidePreviewOpen && previewFilePath ? (
                  <FilePreviewPanel filePath={previewFilePath} owner={previewFileOwner} onBack={closeFilePreview} />
                ) : null}
                <div className={cn("flex h-full flex-col", sidePreviewOpen && "hidden")}>
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
        {scenariosMounted && (
          <div className={cn("min-h-0 flex-1 overflow-auto", activeTab !== "scenarios" && "hidden")}>
            <Suspense fallback={SuspenseFallback}>
              <ScenariosPanelLazy
                onTryScenario={handleTryScenario}
                roleDetailId={roleDetailId}
                onOpenRoleDetail={setRoleDetailId}
                onCloseRoleDetail={() => setRoleDetailId(null)}
              />
            </Suspense>
          </div>
        )}
        {cronMounted && (
          <div className={cn("min-h-0 flex-1 overflow-auto", activeTab !== "cron" && "hidden")}>
            <Suspense fallback={SuspenseFallback}>
              <CronManager onJobCountChange={handleCronJobCountChange} />
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

        {tenantAdminMounted && (
          <div className={cn("min-h-0 flex-1 overflow-hidden", activeTab !== "tenant-admin" && "hidden")}>
            <Suspense fallback={SuspenseFallback}>
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
                settingsOpen={adminSettings?.target === "tenant"}
                settingsSection={(adminSettings?.target === "tenant" ? adminSettings.section : "users") as TenantSection}
                onSettingsSectionChange={(section) => setAdminSettingsSection(section)}
                onSettingsClose={closeAdminSettings}
                activeAnalysisSection={tenantAdminSection}
                onAnalysisSectionChange={setTenantAdminSection}
                headerControlsPlacement="none"
              />
            </Suspense>
          </div>
        )}
        {platformAdminMounted && (
          <div className={cn("min-h-0 flex-1 overflow-hidden", activeTab !== "platform-admin" && "hidden")}>
            <Suspense fallback={SuspenseFallback}>
              <PlatformAdminShell
                renderTenants={() => <TenantManager />}
                renderSignupConfig={() => <SignupConfigManagerPanel />}
                renderModels={() => <ModelManagerPanel />}
                renderRemoteHands={() => <TenantRemoteHandsManagerPanel />}
                renderToolControls={() => <ToolControlsManagerPanel />}
                renderMcp={() => <McpAdminCatalogPanel />}
                renderSkills={() => <SkillManagerPanel mode="platform" />}
                renderEfficiency={() => <EfficiencyViewPanel />}
                activeSection={platformAdminSection}
                entityId={platformAdminEntityId}
                onSectionChange={setPlatformAdminRoute}
                settingsOpen={adminSettings?.target === "platform"}
                settingsSection={(adminSettings?.target === "platform" ? adminSettings.section : "tenants") as PlatformSection}
                onSettingsSectionChange={(section) => setAdminSettingsSection(section)}
                onSettingsClose={closeAdminSettings}
                headerControlsPlacement="none"
              />
            </Suspense>
          </div>
        )}

        {adminSettings?.target === "tenant" && (
          <Suspense fallback={null}>
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
              settingsOpen
              settingsOnly
              settingsSection={adminSettings.section as TenantSection}
              onSettingsSectionChange={(section) => setAdminSettingsSection(section)}
              onSettingsClose={closeAdminSettings}
            />
          </Suspense>
        )}
        {adminSettings?.target === "platform" && (
          <Suspense fallback={null}>
            <PlatformAdminShell
              renderTenants={() => <TenantManager />}
              renderSignupConfig={() => <SignupConfigManagerPanel />}
              renderModels={() => <ModelManagerPanel />}
              renderRemoteHands={() => <TenantRemoteHandsManagerPanel />}
              renderToolControls={() => <ToolControlsManagerPanel />}
              renderMcp={() => <McpAdminCatalogPanel />}
              renderSkills={() => <SkillManagerPanel mode="platform" />}
              renderEfficiency={() => <EfficiencyViewPanel />}
              activeSection={platformAdminSection}
              entityId={platformAdminEntityId}
              onSectionChange={setPlatformAdminRoute}
              settingsOpen
              settingsOnly
              settingsSection={adminSettings.section as PlatformSection}
              onSettingsSectionChange={(section) => setAdminSettingsSection(section)}
              onSettingsClose={closeAdminSettings}
            />
          </Suspense>
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
        {activeTab === "chat" && roleKitV2Enabled && roleKitConfig.firstDayGuideBar.enabled && (
          <FirstDayGuideBar
            activeScenario={lastTriedScenario ?? undefined}
            onOpenCronWizard={handleOpenCronWizard}
            onOpenExampleDemo={handleViewAllScenarios}
            stageTimeoutMs={roleKitConfig.firstDayGuideBar.stageTimeoutMs}
          />
        )}
        {roleKitV2Enabled && (
          <CronCreationWizard
            open={cronWizardOpen}
            scenario={cronWizardScenario}
            onOpenChange={setCronWizardOpen}
          />
        )}
        <FilePreviewDialog
          open={!!previewFilePath && previewMode === "dialog"}
          filePath={previewFilePath}
          owner={previewFileOwner}
          onClose={closeFilePreview}
          onDock={dockFilePreview}
        />
        <Suspense fallback={null}>
          <SettingsModal
            open={settingsOpen}
            section={settingsSection}
            onSectionChange={setSettingsSection}
            onClose={closeSettings}
            renderAllAgents={() => <AllAgentsListPanel />}
            renderMemory={() => <MemorySectionPanel />}
            renderSkills={() => <SkillsSectionPanel />}
            renderCron={() => <CronManager onJobCountChange={handleCronJobCountChange} />}
            renderMcp={() => <McpAdminCatalogPanel />}
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
            renderTrash={() => (
              <TrashView
                onClose={closeSettings}
                onPreviewSession={(id) => previewTrashSession(id)}
                activePreviewId={trashPreviewSessionId}
                showHeader={false}
              />
            )}
          />
          {/*
            组织/平台管理弹窗可从任意页面打开：openAdminSettings 只推 settings URL，
            不切 activeTab；弹窗统一由 settingsOnly shell 承载，关闭后回到原页面。
          */}
        </Suspense>
      </div>
    </div>
  );
}
