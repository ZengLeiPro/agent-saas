import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Volume2, VolumeX, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { resolveApprovalTier } from "@/lib/approvalTier";
import { Button } from "@/components/ui/button";
import { SwipeDrawer } from "@/components/mobile/SwipeDrawer";
import { SlidePanel } from "@/components/SlidePanel";
import { FilePreviewActions } from "@/components/FilePreviewActions";
import { useSubagentTranscript } from "@/contexts/SubagentTranscriptContext";
import { ChatTabContent } from "@/components/chat/ChatTabContent";
import { MobileSessionList } from "@/components/MobileSessionList";
import { TokenUsageDisplay } from "@/components/TokenUsageDisplay";
import { BillingMiniBadge } from "@/components/BillingMiniBadge";
import { getPreviewFileType } from "@agent/shared";
import { useAuth } from "@/contexts/AuthContext";
import { useManagementSettingsAccess } from "@/hooks/useManagementSettingsAccess";
import { useChatFontSize } from "@/hooks/useChatFontSize";
import { legacyRoleFallbackTab, managementAccessTarget } from "@/lib/managementAccessView";
import { EmptyChatRecommendCards } from "@/components/scenarios/EmptyChatRecommendCards";
import { EmptySessionScenarios } from "@/components/scenarios/EmptySessionScenarios";
import { useScenarioDeepLink } from "@/components/scenarios/useScenarioDeepLink";
import { useRoleKitConfig } from "@/components/scenarios/useRoleKitConfig";
import { FirstDayGuideBar } from "@/components/onboarding/FirstDayGuideBar";
import {
  sendWorkflowExperience,
  type WorkflowOnboardingContext,
} from "@/components/onboarding/workflowOnboarding";
import { ExpertWelcome } from "@/components/experts/ExpertWelcome";
import type { LayoutProps } from "./types";
import { hasSuccessfulFinalOutput } from "./firstDayGuideVisibility";
import type { ScenarioItem } from "@agent/shared";
import type { AppTab } from '@/types/sidebar';
import { managementPageForRoute, managementPagesFor, managementRouteForPage } from '@/lib/managementNavigation';
import { navigateGovernance } from '@/lib/urlSync';

const FileBrowserLazy = lazy(() => import("@/components/FileBrowser").then(m => ({ default: m.FileBrowser })));
const MarkdownPreviewPanel = lazy(() => import("@/components/MarkdownPreviewPanel").then(m => ({ default: m.MarkdownPreviewPanel })));
const HtmlPreviewPanel = lazy(() => import("@/components/HtmlPreviewPanel").then(m => ({ default: m.HtmlPreviewPanel })));
const CodePreviewPanel = lazy(() => import("@/components/CodePreviewPanel").then(m => ({ default: m.CodePreviewPanel })));
const PdfPreviewPanel = lazy(() => import("@/components/PdfPreviewPanel").then(m => ({ default: m.PdfPreviewPanel })));
const VideoPreviewPanel = lazy(() => import("@/components/VideoPreviewPanel").then(m => ({ default: m.VideoPreviewPanel })));
const SubagentTranscriptPanel = lazy(() => import("@/components/SubagentTranscriptPanel").then(m => ({ default: m.SubagentTranscriptPanel })));
const AgentProfilePanel = lazy(() => import("@/components/AgentProfile").then(m => ({ default: m.AgentProfile })));
const MemorySectionPanel = lazy(() => import("@/components/AgentProfile").then(m => ({ default: m.MemorySection })));
const MobileSettingsModal = lazy(() => import("@/components/SettingsCenter/MobileSettingsModal"));
const ManagementWorkspaceContent = lazy(() => import('@/components/ManagementShell/ManagementWorkspaceContent').then(m => ({ default: m.ManagementWorkspaceContent })));
const CapabilityCenterPanel = lazy(() => import("@/components/CapabilityCenter").then(m => ({ default: m.CapabilityCenter })));
import {
  CronManager, McpManagerPanel, ModelManagerPanel, SkillManagerPanel,
  TenantManager, UsageDashboard,
} from "./lazySettingsComponents";

const SuspenseFallback = (
  <div className="flex flex-1 items-center justify-center">
    <Loader2 className="size-6 animate-spin text-muted-foreground" />
  </div>
);

export function MobileLayout(props: LayoutProps) {
  const {
    sidebarSessions, sessionId, selectSession, newSession, newPersonalSession, confirmDeleteSession, renameSession, autoTitleSession,
    isLoadingSessions, activeTab, governanceRoute, platformAdminSection, platformAdminEntityId, setActiveTab, setPlatformAdminRoute, settingsOpen, settingsSection, openSettings, closeSettings, setSettingsSection,
    adminSettings,
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
    previewFilePath, previewFileOwner, openFilePreview, closeFilePreview,
    isTrashPreview, previewTrashSession, trashPreviewSessionId,
    agentProfile, sessionParticipants,
    startOrgAgentSession, activeOrgAgent, activeOrgAgentReadOnly, sessionReadOnly, activeAgentTargetUnavailableReason, activeAgentTargetLabel, myOrgAgents, personalAgentEnabled, orgAgentIdentityLoading,
  } = props;
  const { user: authUser, isLoading: authLoading, authEnabled } = useAuth();
  const { isLarge: chatFontLarge, setIsLarge: setChatFontLarge } = useChatFontSize();
  const accessTarget = managementAccessTarget({
    settingsOpen,
    adminSettingsTarget: adminSettings?.target,
    activeTab,
    governanceArea: governanceRoute?.area,
  });
  const managementAccess = useManagementSettingsAccess({
    user: authUser, authLoading, authEnabled, active: accessTarget !== null,
  });
  const handleReturnPersonalSettings = useCallback(() => {
    openSettings(settingsSection);
  }, [openSettings, settingsSection]);
  const subagentTranscriptContext = useSubagentTranscript();
  const subagentTranscript = subagentTranscriptContext?.transcript ?? null;
  const closeSubagentTranscript = subagentTranscriptContext?.closeTranscript;
  const { config: roleKitConfig } = useRoleKitConfig();
  // TASK-256：统一三档 tier 语义（缺失字段默认全部授权，与服务端一致）。
  const approvalTier = resolveApprovalTier(authUser?.preferences);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [businessStepPanelOpen, setBusinessStepPanelOpen] = useState(false);
  const [activeUsageCard, setActiveUsageCard] = useState<"context" | "billing" | null>(null);
  const handleContextCardOpenChange = useCallback((open: boolean) => {
    setActiveUsageCard((current) => open ? "context" : current === "context" ? null : current);
  }, []);
  const handleBillingCardOpenChange = useCallback((open: boolean) => {
    setActiveUsageCard((current) => open ? "billing" : current === "billing" ? null : current);
  }, []);
  const [activeWorkflow, setActiveWorkflow] = useState<WorkflowOnboardingContext | null>(null);
  const [lastTriedScenario, setLastTriedScenario] = useState<ScenarioItem | null>(null);
  const [roleDetailId, setRoleDetailId] = useState<string | null>(null);
  const organizationSettingsTargetId = useRef<string | null>(null);
  if (governanceRoute?.area === "organization") organizationSettingsTargetId.current = governanceRoute.orgId;
  const closeDrawer = useCallback(() => {
    setSheetOpen(false);
    setActiveTab("chat");
  }, [setActiveTab]);
  const handleMobileTabChange = useCallback((tab: AppTab) => {
    // §10：定制软件（iframe 嵌入 + 握手）第一期只在桌面壳提供，移动端显式排除。
    // 移动端的 pill tabs 只来自 `getSidebarNavItems`，`apps` 不在 `baseNavItems` 里，
    // 正常路径下走不到这里；这条早退是防「以后有人从别处塞进来」的兜底。
    if (tab === 'apps') return;
    if (tab === 'tenant-admin' || tab === 'platform-admin') {
      const area = tab === 'platform-admin' ? 'platform' : 'organization';
      const page = managementPagesFor('analytics', area)[0];
      setActiveTab(tab);
      if (page) navigateGovernance(managementRouteForPage(page, governanceRoute, organizationSettingsTargetId.current));
      return;
    }
    setActiveTab(tab);
  }, [governanceRoute, setActiveTab]);
  const handleBusinessStepPanelOpenChange = useCallback((open: boolean) => {
    setBusinessStepPanelOpen(open);
  }, []);
  const handleOpenFilePreview = useCallback((
    path: string,
    owner?: string,
    options?: { mode?: "dialog" | "side" },
  ) => {
    setBusinessStepPanelOpen(false);
    openFilePreview(path, owner, options);
  }, [openFilePreview]);
  const handleCloseFilePreview = useCallback(() => {
    closeFilePreview();
  }, [closeFilePreview]);

  useEffect(() => {
    closeSubagentTranscript?.();
    setBusinessStepPanelOpen(false);
  }, [closeSubagentTranscript, sessionId]);

  useEffect(() => {
    if (subagentTranscript || previewFilePath || sheetOpen) setBusinessStepPanelOpen(false);
  }, [previewFilePath, sheetOpen, subagentTranscript?.childSessionId]);

  // 一级页面实际渲染在移动端抽屉中：直达 URL 与浏览器前进/后退时必须同步打开。
  useEffect(() => {
    if (activeTab !== "chat") setSheetOpen(true);
  }, [activeTab]);

  // 场景直达：消费 ?scenario=<id>（官网注册落地 / 销售场景链接），预填起手指令
  const handleScenarioPrefill = useCallback((prompt: string, scenario?: ScenarioItem) => {
    if (!personalAgentEnabled || loading) return;
    setActiveWorkflow(null);
    setLastTriedScenario(scenario ?? null);
    setInput(prompt);
  }, [loading, personalAgentEnabled, setInput]);
  useScenarioDeepLink(handleScenarioPrefill, () => {
    setActiveTab("capabilities");
    setSheetOpen(true);
  });

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
    closeDrawer();
  }, [closeDrawer, loading, newPersonalSession, personalAgentEnabled, setInput]);

  const handlePrefillWorkflow = useCallback((
    message: string,
    scenario: WorkflowOnboardingContext["scenario"],
  ) => {
    if (!personalAgentEnabled || loading) return;
    setActiveWorkflow({ scenario });
    setInput(message);
  }, [loading, personalAgentEnabled, setInput]);

  const handleViewAllScenarios = useCallback(() => {
    setRoleDetailId(null);
    setActiveTab("capabilities");
    setSheetOpen(true);
  }, [setActiveTab]);

  const chatEmptySlot = useMemo(() => (
    roleKitConfig.roleKitV2Enabled ? (
      <EmptyChatRecommendCards
        onTryScenario={handleScenarioPrefill}
        onStartWorkflow={handlePrefillWorkflow}
        onViewAll={handleViewAllScenarios}
      />
    ) : (
      <EmptySessionScenarios
        onTryScenario={handleScenarioPrefill}
        onStartWorkflow={handlePrefillWorkflow}
        onViewAll={handleViewAllScenarios}
      />
    )
  ), [handlePrefillWorkflow, handleScenarioPrefill, handleViewAllScenarios, roleKitConfig.roleKitV2Enabled]);

  const handleSendMessage = useCallback(async () => {
    await sendWorkflowExperience(sendMessage, input, activeWorkflow);
  }, [activeWorkflow, input, sendMessage]);

  useEffect(() => {
    if (orgAgentIdentityLoading) return;
    const fallback = legacyRoleFallbackTab({ activeTab, personalAgentEnabled, isAdmin, isPlatformAdmin });
    if (fallback) setActiveTab(fallback);
  }, [isAdmin, isPlatformAdmin, personalAgentEnabled, orgAgentIdentityLoading, activeTab, setActiveTab]);

  // iOS 键盘适配
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.getElementById("root");
    if (!root) return;

    let wasKeyboard = false;
    let fightRafId = 0;

    const resetScroll = () => {
      window.scrollTo(0, 0);
    };

    const sync = () => {
      resetScroll();
      const isKeyboard = vv.height < window.innerHeight - 100;

      if (isKeyboard) {
        root.style.top = `${vv.offsetTop}px`;
        root.style.height = `${vv.height}px`;
      } else if (wasKeyboard) {
        root.style.top = "";
        root.style.height = "";
      }

      wasKeyboard = isKeyboard;
    };

    const onFocusIn = (e: FocusEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag !== "TEXTAREA" && tag !== "INPUT") return;
      cancelAnimationFrame(fightRafId);
      const deadline = Date.now() + 500;
      const fight = () => {
        resetScroll();
        if (Date.now() < deadline) fightRafId = requestAnimationFrame(fight);
      };
      fightRafId = requestAnimationFrame(fight);
    };

    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    window.addEventListener("scroll", resetScroll);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
      window.removeEventListener("scroll", resetScroll);
      document.removeEventListener("focusin", onFocusIn);
      cancelAnimationFrame(fightRafId);
      root.style.top = "";
      root.style.height = "";
    };
  }, []);

  if (governanceRoute && managementPageForRoute(governanceRoute)) {
    return (
      <Suspense fallback={SuspenseFallback}>
        <ManagementWorkspaceContent
          route={governanceRoute}
          access={managementAccess}
          onReturnPersonal={handleReturnPersonalSettings}
          platformAdminSection={platformAdminSection}
          platformAdminEntityId={platformAdminEntityId}
          setPlatformAdminRoute={setPlatformAdminRoute}
        />
      </Suspense>
    );
  }

  return (
    <>
      <header
        className={cn("shrink-0 bg-card", (subagentTranscript || previewFilePath) && "border-b", sheetOpen && "hidden")}
        style={{ paddingTop: "var(--sat)" }}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("button, a, [role=button]")) return;
          if (!subagentTranscript && !previewFilePath) {
            (scrollContainerRef as React.RefObject<HTMLDivElement>)?.current?.scrollTo({ top: 0, behavior: "smooth" });
          }
        }}
      >
        <div className="mx-auto flex h-12 max-w-5xl items-center justify-between gap-3 px-4">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="size-9"
              onClick={() => subagentTranscript
                ? closeSubagentTranscript?.()
                : previewFilePath ? handleCloseFilePreview() : setSheetOpen(true)}
            >
              <ChevronLeft className="size-6" />
            </Button>
            {subagentTranscript ? (
              <span className="min-w-0 truncate text-sm font-medium">
                子任务完整过程 · {subagentTranscript.title}
              </span>
            ) : previewFilePath ? (
              <span className="min-w-0 truncate text-sm font-medium">
                {previewFilePath.split("/").pop() || previewFilePath}
              </span>
            ) : (
              <div className="truncate text-base font-semibold">{activeAgentTargetLabel || activeOrgAgent?.name || (orgAgentIdentityLoading ? "企业专家" : agentProfile?.name) || "KY Agent"}</div>
            )}
          </div>
          {subagentTranscript ? null : previewFilePath ? (
            <FilePreviewActions filePath={previewFilePath} owner={previewFileOwner} />
          ) : (
            <div className="flex items-center gap-2">
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
            </div>
          )}
        </div>
      </header>

      {isOnline === false && (
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

      <div className={cn("relative flex min-h-0 flex-1 overflow-hidden", chatFontLarge && "chat-font-large")}>
        <SwipeDrawer
          open={sheetOpen}
          onOpenChange={(open) => { if (!open) closeDrawer(); else setSheetOpen(true); }}
          listPanel={
            <MobileSessionList
              sessions={sidebarSessions}
              activeSessionId={sessionId}
              onSelect={(id) => {
                closeDrawer();
                setTimeout(() => { selectSession(id); }, 370);
              }}
              onNew={(groupId) => { newSession(groupId); closeDrawer(); }}
              onDelete={confirmDeleteSession}
              onRename={renameSession}
              onAutoTitle={autoTitleSession}
              isLoading={isLoadingSessions}
              activeTab={activeTab}
              onTabChange={handleMobileTabChange}
              onOpenSettings={openSettings}
              isAdmin={isAdmin}
              className="w-full border-r-0"
              onClose={closeDrawer}
              hasMore={hasMoreSessions}
              isLoadingMore={isLoadingMoreSessions}
              onLoadMore={loadMoreSessions}
              onLoadGroupSessions={loadGroupSessions}
              onPreviewTrashSession={(id) => { if (id) closeDrawer(); previewTrashSession(id); }}
              trashPreviewSessionId={trashPreviewSessionId}
              personalAgentEnabled={personalAgentEnabled || orgAgentIdentityLoading}
              renderCronManager={() => <Suspense fallback={SuspenseFallback}><CronManager /></Suspense>}
              renderTenantManager={() => <Suspense fallback={SuspenseFallback}><TenantManager /></Suspense>}
              renderFileBrowser={() => (
                <Suspense fallback={SuspenseFallback}>
                  <FileBrowserLazy
                    onPreviewFile={(path, owner) => { closeDrawer(); handleOpenFilePreview(path, owner); }}
                    owner={authUser?.username}
                    fullPage
                  />
                </Suspense>
              )}
              renderCapabilities={() => (
                <Suspense fallback={SuspenseFallback}>
                  <CapabilityCenterPanel
                    experts={myOrgAgents}
                    personalAgentEnabled={personalAgentEnabled}
                    actionsDisabled={loading}
                    onStartExpert={(expertId) => {
                      startOrgAgentSession(expertId);
                      closeDrawer();
                    }}
                    onTryScenario={(prompt: string, scenario: ScenarioItem) => {
                      if (!personalAgentEnabled || loading) return;
                      setActiveWorkflow(null);
                      setLastTriedScenario(scenario);
                      newPersonalSession();
                      setInput(prompt);
                      closeDrawer();
                    }}
                    onStartWorkflow={handleStartWorkflow}
                    onRequestDiagnosis={handleStartWorkflow}
                    onWorkflowSelected={(scenario) => setActiveWorkflow({ scenario })}
                    roleDetailId={roleDetailId}
                    onOpenRoleDetail={setRoleDetailId}
                    onCloseRoleDetail={() => setRoleDetailId(null)}
                  />
                </Suspense>
              )}
              renderAgentProfile={() => <Suspense fallback={SuspenseFallback}><AgentProfilePanel /></Suspense>}
              renderSkillManager={() => <Suspense fallback={SuspenseFallback}><SkillManagerPanel mode={isPlatformAdmin ? "platform" : "tenant"} tenantIdScope={isPlatformAdmin ? undefined : authUser?.tenantId} /></Suspense>}
              renderMcpManager={() => <Suspense fallback={SuspenseFallback}><McpManagerPanel /></Suspense>}
              renderUsageDashboard={() => (
                <Suspense fallback={SuspenseFallback}>
                  <UsageDashboard tenantId={isPlatformAdmin ? undefined : authUser?.tenantId} scope={isPlatformAdmin ? "platform" : "tenant"} />
                </Suspense>
              )}
              renderModelManager={() => <Suspense fallback={SuspenseFallback}><ModelManagerPanel /></Suspense>}
            />
          }
          detailPanel={
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
              input={input}
              sandboxProfile={sandboxProfile}
              onSandboxProfileChange={setSandboxProfile}
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
              businessStepDetailMode="mobile"
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
              emptySlot={activeOrgAgent
                ? <ExpertWelcome expert={activeOrgAgent} onPrefill={setInput} />
                : (orgAgentIdentityLoading ? (
                  <div className="px-6 py-16 text-center">
                    <div className="font-semibold">正在加载企业专家</div>
                    <p className="mt-2 text-sm text-muted-foreground">正在同步组织配置。</p>
                  </div>
                ) : (!personalAgentEnabled ? (
                  <div className="px-6 py-16 text-center">
                    <div className="font-semibold">当前没有可用的企业专家</div>
                    <p className="mt-2 text-sm text-muted-foreground">请联系组织管理员完成专家指派。</p>
                  </div>
                ) : chatEmptySlot))}
              initialComposer={!isTrashPreview && !sessionReadOnly && !orgAgentIdentityLoading && !activeOrgAgentReadOnly && (Boolean(activeOrgAgent) || personalAgentEnabled)}
              orgAgent={isTrashPreview ? null : activeOrgAgent}
              onNewOrgAgentConversation={activeOrgAgent && !activeOrgAgentReadOnly && !loading
                ? () => { startOrgAgentSession(activeOrgAgent.id); }
                : undefined}
              onSwitchOrgAgent={activeOrgAgent && myOrgAgents.length > 1 && !loading
                ? () => { setActiveTab("capabilities"); setSheetOpen(true); }
                : undefined}
            />
          }
        />

        {/* 详情面板：移动端沿用文件预览的 SlidePanel，桌面端则进入统一右侧 slot。 */}
        <SlidePanel
          open={!!subagentTranscript || !!previewFilePath}
          onClose={subagentTranscript ? () => closeSubagentTranscript?.() : handleCloseFilePreview}
        >
          {subagentTranscript ? (
            <Suspense fallback={SuspenseFallback}>
              <SubagentTranscriptPanel
                childSessionId={subagentTranscript.childSessionId}
                title={subagentTranscript.title}
                onClose={() => closeSubagentTranscript?.()}
                hideHeader
              />
            </Suspense>
          ) : previewFilePath ? (
            <Suspense fallback={SuspenseFallback}>
              {(() => {
                const previewType = getPreviewFileType(previewFilePath);
                if (previewType === 'html') return <HtmlPreviewPanel filePath={previewFilePath} owner={previewFileOwner} onBack={handleCloseFilePreview} hideHeader />;
                if (previewType === 'pdf') return <PdfPreviewPanel filePath={previewFilePath} owner={previewFileOwner} onBack={handleCloseFilePreview} hideHeader />;
                if (previewType === 'video') return <VideoPreviewPanel filePath={previewFilePath} owner={previewFileOwner} onBack={handleCloseFilePreview} hideHeader />;
                if (previewType === 'code') return <CodePreviewPanel filePath={previewFilePath} owner={previewFileOwner} onBack={handleCloseFilePreview} hideHeader />;
                return <MarkdownPreviewPanel filePath={previewFilePath} owner={previewFileOwner} onBack={handleCloseFilePreview} hideHeader />;
              })()}
            </Suspense>
          ) : null}
        </SlidePanel>
      </div>
      {personalAgentEnabled
        && !activeOrgAgent
        && activeTab === "chat"
        && roleKitConfig.roleKitV2Enabled
        && roleKitConfig.firstDayGuideBar.enabled
        && roleKitConfig.firstDayGuideBar.showOnMobile ? (
          <FirstDayGuideBar
            visible={hasSuccessfulFinalOutput(messages)}
            activeScenario={lastTriedScenario ?? undefined}
            activeWorkflow={activeWorkflow ?? undefined}
            onOpenCronWizard={() => { setActiveTab("cron"); setSheetOpen(true); }}
            onOpenExampleDemo={() => { setActiveTab("capabilities"); setSheetOpen(true); }}
            onStartWorkflow={(message, context) => handleStartWorkflow(message, context.scenario)}
            onConnectWorkflow={(context) => {
              setActiveWorkflow(context);
              setActiveTab("capabilities");
              setSheetOpen(true);
              const params = new URLSearchParams({ returnToWorkflowId: context.scenario.workflowId });
              window.history.replaceState({}, "", `/capabilities/connectors?${params.toString()}`);
            }}
            onRequestDiagnosis={(context) => handleStartWorkflow(
              `我想为「${context.scenario.title}」预约落地诊断，请先确认业务边界、现有系统和所需人审。`,
              context.scenario,
            )}
            onViewWorkflow={(context) => {
              setActiveWorkflow(context);
              setActiveTab("capabilities");
              setSheetOpen(true);
              const params = new URLSearchParams({ workflow: context.scenario.id, intent: "view" });
              window.history.replaceState({}, "", `/capabilities/templates?${params.toString()}`);
            }}
            stageTimeoutMs={roleKitConfig.firstDayGuideBar.stageTimeoutMs}
            showOnMobile
          />
        ) : null}
      <Suspense fallback={null}>
        <MobileSettingsModal
          open={settingsOpen}
          section={settingsSection}
          onSectionChange={setSettingsSection}
          onClose={closeSettings}
          renderMemory={() => <MemorySectionPanel />}
          renderFiles={() => (
            <FileBrowserLazy
              onPreviewFile={handleOpenFilePreview}
              owner={authUser?.username}
              fullPage
              reserveCloseButtonSpace
            />
          )}
          chatFontLarge={chatFontLarge}
          onChatFontSizeChange={setChatFontLarge}
          personalAgentEnabled={personalAgentEnabled}
          governanceRoute={governanceRoute}
          managementStatus={managementAccess.status}
          tenantEntryAllowed={managementAccess.tenantEntryAllowed}
          platformEntryAllowed={managementAccess.platformEntryAllowed}
          organizationTargetId={organizationSettingsTargetId.current}
        />
      </Suspense>
    </>
  );
}
