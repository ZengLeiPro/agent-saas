import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { ChevronLeft, Volume2, VolumeX, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SwipeDrawer } from "@/components/mobile/SwipeDrawer";
import { SlidePanel } from "@/components/SlidePanel";
import { MarkdownPreviewPanel } from "@/components/MarkdownPreviewPanel";
import { HtmlPreviewPanel } from "@/components/HtmlPreviewPanel";
import { CodePreviewPanel } from "@/components/CodePreviewPanel";
import { PdfPreviewPanel } from "@/components/PdfPreviewPanel";
import { VideoPreviewPanel } from "@/components/VideoPreviewPanel";
import { ChatTabContent } from "@/components/chat/ChatTabContent";
import { MobileSessionList } from "@/components/MobileSessionList";
import { TokenUsageDisplay } from "@/components/TokenUsageDisplay";
import { BillingMiniBadge } from "@/components/BillingMiniBadge";
import { getPreviewFileType } from "@agent/shared";
import { useAuth } from "@/contexts/AuthContext";
import { useScenarioDeepLink } from "@/components/scenarios/useScenarioDeepLink";
import type { LayoutProps } from "./types";

const CronManager = lazy(() => import("@/components/CronManager").then(m => ({ default: m.CronManager })));
const UserManager = lazy(() => import("@/components/UserManager").then(m => ({ default: m.UserManager })));
const TenantManager = lazy(() => import("@/components/TenantManager").then(m => ({ default: m.TenantManager })));
const FileBrowserLazy = lazy(() => import("@/components/FileBrowser").then(m => ({ default: m.FileBrowser })));
const AgentProfilePanel = lazy(() => import("@/components/AgentProfile").then(m => ({ default: m.AgentProfile })));
const AllAgentsListPanel = lazy(() => import("@/components/AgentProfile").then(m => ({ default: m.AllAgentsList })));
const SkillsSectionPanel = lazy(() => import("@/components/AgentProfile").then(m => ({ default: m.SkillsSection })));
const MemorySectionPanel = lazy(() => import("@/components/AgentProfile").then(m => ({ default: m.MemorySection })));
const SkillManagerPanel = lazy(() => import("@/components/SkillManager").then(m => ({ default: m.SkillManager })));
const McpManagerPanel = lazy(() => import("@/components/McpManager").then(m => ({ default: m.McpManager })));
const McpAdminCatalogPanel = lazy(() => import("@/components/McpManager").then(m => ({ default: m.McpAdminCatalog })));
const UsageDashboard = lazy(() => import("@/components/UsageDashboard").then(m => ({ default: m.UsageDashboard })));
const EfficiencyViewPanel = lazy(() => import("@/components/UsageDashboard/EfficiencyView").then(m => ({ default: m.EfficiencyView })));
const ModelManagerPanel = lazy(() => import("@/components/ModelManager").then(m => ({ default: m.ModelManager })));
const TenantRemoteHandsManagerPanel = lazy(() => import("@/components/TenantRemoteHandsManager").then(m => ({ default: m.TenantRemoteHandsManager })));
const ToolControlsManagerPanel = lazy(() => import("@/components/ToolControlsManager").then(m => ({ default: m.ToolControlsManager })));
const SignupConfigManagerPanel = lazy(() => import("@/components/SignupConfigManager").then(m => ({ default: m.SignupConfigManager })));
const SettingsModal = lazy(() => import("@/components/SettingsCenter").then(m => ({ default: m.SettingsModal })));
import type { TenantSection, PlatformSection } from "@/components/AdminShells";
const TenantAdminShell = lazy(() => import("@/components/AdminShells").then(m => ({ default: m.TenantAdminShell })));
const CompanyInfoSectionPanel = lazy(() => import("@/components/CompanyInfoEditor").then(m => ({ default: m.CompanyInfoSection })));
const PlatformAdminShell = lazy(() => import("@/components/AdminShells").then(m => ({ default: m.PlatformAdminShell })));

const SuspenseFallback = (
  <div className="flex flex-1 items-center justify-center">
    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
  </div>
);

export function MobileLayout(props: LayoutProps) {
  const {
    sidebarSessions, unreadAiReplySessionIds, sessionId, selectSession, newSession, confirmDeleteSession, renameSession, autoTitleSession,
    isLoadingSessions, activeTab, platformAdminSection, platformAdminEntityId, setActiveTab, pushActiveTab, setPlatformAdminRoute, settingsOpen, settingsSection, openSettings, closeSettings, setSettingsSection,
    adminSettings, openAdminSettings, closeAdminSettings, setAdminSettingsSection,
    isAdmin, isPlatformAdmin, isOnline, connectionState,
    messages, loading, isLoadingMessages, retryMessage, forkFromMessage, lastMessageRef, scrollContainerRef, isNearBottomRef,
    handlePermissionResponse, handleAskUserResponse,
    uploadedFiles, removeFile, input, uploading, uploadError, dismissUploadError, setInput,
    sendMessage, sendVoiceMessage, stopping, stopGeneration, handleFileSelect, handlePaste, ttsProps, ttsStateMap, modelList,
    selectedModel, onModelChange, autoApproveRunShell, setAutoApproveRunShell, ttsPlayer, tokenUsage, contextUsage,
    hasMoreSessions, isLoadingMoreSessions, loadMoreSessions, loadGroupSessions,
    previewFilePath, previewFileOwner, openFilePreview, closeFilePreview,
    isTrashPreview, previewTrashSession, trashPreviewSessionId,
    agentProfile, sessionParticipants,
  } = props;
  const { user: authUser } = useAuth();
  const authorizationModeEnabled = authUser?.preferences?.authorizationModeEnabled === true;

  const [sheetOpen, setSheetOpen] = useState(false);
  const closeDrawer = useCallback(() => {
    setSheetOpen(false);
    setActiveTab("chat");
  }, [setActiveTab]);

  // 场景直达：消费 ?scenario=<id>（官网注册落地 / 销售场景链接），预填起手指令
  const handleScenarioPrefill = useCallback((prompt: string) => {
    setInput(prompt);
  }, [setInput]);
  useScenarioDeepLink(handleScenarioPrefill);

  useEffect(() => {
    if (!isAdmin && (activeTab === "skills" || activeTab === "usage" || activeTab === "tenant-admin")) {
      setActiveTab("chat");
    }
    if (!isPlatformAdmin && (activeTab === "tenants" || activeTab === "models" || activeTab === "platform-admin")) {
      setActiveTab("chat");
    }
  }, [isAdmin, isPlatformAdmin, activeTab, setActiveTab]);

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

  return (
    <>
      <header
        className={cn("shrink-0 bg-background", previewFilePath && "border-b", sheetOpen && "hidden")}
        style={{ paddingTop: "var(--sat)" }}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("button, a, [role=button]")) return;
          if (!previewFilePath) {
            (scrollContainerRef as React.RefObject<HTMLDivElement>)?.current?.scrollTo({ top: 0, behavior: "smooth" });
          }
        }}
      >
        <div className="mx-auto flex h-12 max-w-5xl items-center justify-between gap-3 px-4">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              onClick={() => previewFilePath ? closeFilePreview() : setSheetOpen(true)}
            >
              <ChevronLeft className="!h-6 !w-6" />
            </Button>
            {previewFilePath ? (
              <span className="min-w-0 truncate text-sm font-medium">
                {previewFilePath.split("/").pop() || previewFilePath}
              </span>
            ) : (
              <>
                <div className="truncate text-base font-semibold">KY Agent</div>
                {sessionId ? (
                  <Badge variant="secondary" className="hidden sm:inline-flex">
                    {sessionId.slice(0, 8)}
                  </Badge>
                ) : null}
              </>
            )}
          </div>
          {!previewFilePath && (
            <div className="flex items-center gap-2">
              {modelList?.showContextTokens !== false && (
                <TokenUsageDisplay tokenUsage={tokenUsage} contextUsage={contextUsage} />
              )}
              <BillingMiniBadge sessionId={sessionId} />
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
            </div>
          )}
        </div>
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

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <SwipeDrawer
          open={sheetOpen}
          onOpenChange={(open) => { if (!open) closeDrawer(); else setSheetOpen(true); }}
          listPanel={
            <MobileSessionList
              sessions={sidebarSessions}
              unreadAiReplySessionIds={unreadAiReplySessionIds}
              activeSessionId={sessionId}
              onSelect={(id) => {
                closeDrawer();
                setTimeout(() => { selectSession(id); }, 370);
              }}
              onNew={() => { newSession(); closeDrawer(); }}
              onDelete={confirmDeleteSession}
              onRename={renameSession}
              onAutoTitle={autoTitleSession}
              isLoading={isLoadingSessions}
              activeTab={activeTab}
              onTabChange={setActiveTab}
              onPushTab={pushActiveTab}
              onOpenSettings={openSettings}
              onOpenAdminSettings={openAdminSettings}
              isAdmin={isAdmin}
              className="w-full border-r-0"
              onClose={closeDrawer}
              hasMore={hasMoreSessions}
              isLoadingMore={isLoadingMoreSessions}
              onLoadMore={loadMoreSessions}
              onLoadGroupSessions={loadGroupSessions}
              onPreviewTrashSession={(id) => { if (id) closeDrawer(); previewTrashSession(id); }}
              trashPreviewSessionId={trashPreviewSessionId}
              renderCronManager={() => <Suspense fallback={SuspenseFallback}><CronManager /></Suspense>}
              renderTenantManager={() => <Suspense fallback={SuspenseFallback}><TenantManager /></Suspense>}
              renderTenantAdmin={() => (
                <Suspense fallback={SuspenseFallback}>
                  <TenantAdminShell
                    renderUsers={(tenantId, tenantName) => <UserManager tenantIdScope={tenantId} tenantName={tenantName} />}
                    renderSkills={(tenantId, tenantName) => <SkillManagerPanel mode="tenant" tenantIdScope={tenantId} tenantName={tenantName} />}
                    renderMcp={() => <McpAdminCatalogPanel />}
                    renderUsage={(tenantId) => <UsageDashboard tenantId={tenantId} scope="tenant" />}
                    renderFiles={() => <FileBrowserLazy onPreviewFile={openFilePreview} owner={authUser?.username} fullPage reserveCloseButtonSpace />}
                    renderCompanyInfo={(tenantId, tenantName) => <CompanyInfoSectionPanel tenantId={tenantId} tenantName={tenantName} />}
                    settingsOpen={adminSettings?.target === "tenant"}
                    settingsSection={(adminSettings?.target === "tenant" ? adminSettings.section : "users") as TenantSection}
                    onSettingsSectionChange={(section) => setAdminSettingsSection(section)}
                    onSettingsClose={closeAdminSettings}
                  />
                </Suspense>
              )}
              renderPlatformAdmin={() => (
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
                  />
                </Suspense>
              )}
              renderFileBrowser={() => (
                <Suspense fallback={SuspenseFallback}>
                  <FileBrowserLazy
                    onPreviewFile={(path, owner) => { closeDrawer(); openFilePreview(path, owner); }}
                    owner={authUser?.username}
                    fullPage
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
              readOnly={isTrashPreview}
              agentProfile={agentProfile}
              sessionParticipants={sessionParticipants}
            />
          }
        />

        {/* 预览面板：覆盖内容区（header 以下），与 SwipeDrawer 同级 */}
        <SlidePanel open={!!previewFilePath} onClose={closeFilePreview}>
          {previewFilePath && (() => {
            const previewType = getPreviewFileType(previewFilePath);
            if (previewType === 'html') return <HtmlPreviewPanel filePath={previewFilePath} owner={previewFileOwner} onBack={closeFilePreview} hideHeader />;
            if (previewType === 'pdf') return <PdfPreviewPanel filePath={previewFilePath} owner={previewFileOwner} onBack={closeFilePreview} hideHeader />;
            if (previewType === 'video') return <VideoPreviewPanel filePath={previewFilePath} owner={previewFileOwner} onBack={closeFilePreview} hideHeader />;
            if (previewType === 'code') return <CodePreviewPanel filePath={previewFilePath} owner={previewFileOwner} onBack={closeFilePreview} hideHeader />;
            return <MarkdownPreviewPanel filePath={previewFilePath} owner={previewFileOwner} onBack={closeFilePreview} hideHeader />;
          })()}
        </SlidePanel>
      </div>
      <Suspense fallback={null}>
        <SettingsModal
          open={settingsOpen}
          section={settingsSection}
          onSectionChange={setSettingsSection}
          onClose={closeSettings}
          renderAllAgents={() => <AllAgentsListPanel />}
          renderMemory={() => <MemorySectionPanel />}
          renderSkills={() => <SkillsSectionPanel />}
          renderCron={() => <CronManager />}
          renderMcp={() => <McpAdminCatalogPanel />}
          renderFiles={() => (
            <FileBrowserLazy
              onPreviewFile={openFilePreview}
              owner={authUser?.username}
              fullPage
              reserveCloseButtonSpace
            />
          )}
        />

        {adminSettings?.target === "tenant" && (
          <TenantAdminShell
            renderUsers={(tenantId, tenantName) => <UserManager tenantIdScope={tenantId} tenantName={tenantName} />}
            renderSkills={(tenantId, tenantName) => <SkillManagerPanel mode="tenant" tenantIdScope={tenantId} tenantName={tenantName} />}
            renderMcp={() => <McpAdminCatalogPanel />}
            renderUsage={(tenantId) => <UsageDashboard tenantId={tenantId} scope="tenant" />}
            renderFiles={() => <FileBrowserLazy onPreviewFile={openFilePreview} owner={authUser?.username} fullPage reserveCloseButtonSpace />}
            renderCompanyInfo={(tenantId, tenantName) => <CompanyInfoSectionPanel tenantId={tenantId} tenantName={tenantName} />}
            settingsOpen
            settingsOnly
            settingsSection={adminSettings.section as TenantSection}
            onSettingsSectionChange={(section) => setAdminSettingsSection(section)}
            onSettingsClose={closeAdminSettings}
          />
        )}
        {adminSettings?.target === "platform" && (
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
        )}
        {/*
          组织/平台管理弹窗可从任意页面打开：openAdminSettings 只推 settings URL，
          不切 activeTab；弹窗统一由 settingsOnly shell 承载，关闭后回到原页面。
        */}
      </Suspense>
    </>
  );
}
