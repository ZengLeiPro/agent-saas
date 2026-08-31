import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppLifecycle } from "@/hooks/useAppLifecycle";
import { useActivityReporter } from "@/hooks/useActivityReporter";

import { refreshAll } from "@/lib/refreshBus";
import { saveSessionMessages } from "@/lib/messageCache";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useChatAppState } from "@/hooks/useChatAppState";
import { useTtsPlayer } from "@/hooks/useTtsPlayer";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { useAuth } from "@/contexts/AuthContext";
import { FilePreviewProvider, type ArtifactPreviewTarget } from "@/contexts/FilePreviewContext";
import { MessageFeedbackProvider } from "@/contexts/MessageFeedbackContext";
import { SubagentTranscriptProvider, type SubagentTranscriptTarget } from "@/contexts/SubagentTranscriptContext";
import { useOrgAgents } from "@/hooks/useOrgAgents";
import { DeleteSessionDialog } from "@/components/chat/DeleteSessionDialog";
import { OrgAgentPickerDialog } from "@/components/OrgAgentPickerDialog";
import {
  resolveNewSessionAgentTarget,
  resolveTargetSessionAction,
  type AgentTarget,
  type AgentTargetUnavailableReason,
} from "@agent/shared";

import { DesktopLayout } from "@/layouts/DesktopLayout";
import { MobileLayout } from "@/layouts/MobileLayout";
import { NotificationToastStack, MemoryRecallBanner, PluginInstallBanner } from "@/components/SdkSystemBanners";
import type { TtsProps } from "@/components/MessageItem";
import type { ApiSessionListItem } from "@/lib/sessionsApi";
import type { LayoutProps } from "@/layouts/types";
import type { AgentProfile, SessionRuntimeStatus } from "@agent/shared";

/** 将 API 会话列表转换为 sidebar 所需的格式 */
function toSidebarSessions(
  sessions: ApiSessionListItem[],
  runningSessionIds: ReadonlySet<string>,
  runtimeStatuses: ReadonlyMap<string, SessionRuntimeStatus>,
  currentAgent?: AgentProfile | null,
) {
  return sessions.map((s) => ({
    id: s.sessionId,
    title: s.title || "New chat",
    createdAt: s.createdAtMs || s.updatedAtMs,
    updatedAt: s.updatedAtMs,
    preview: s.preview,
    hasUnreadAiReply: s.hasUnreadAiReply === true,
    isRunning: runningSessionIds.has(s.sessionId),
    runtimeStatus: runtimeStatuses.get(s.sessionId),
    source: s.source,
    owner: s.owner,
    agent: s.agent ?? (currentAgent && (!s.owner || s.owner.username === currentAgent.username) ? currentAgent : undefined),
    cronJobId: s.cronJobId,
    cronJobName: s.cronJobName,
    orgAgentId: s.orgAgentId,
    orgAgentName: s.orgAgentName,
    orgAgentAvailable: s.orgAgentAvailable,
    agentTarget: s.agentTarget,
    agentTargetUnavailableReason: s.agentTargetUnavailableReason,
  }));
}

function App() {
  const { isAdmin, isPlatformAdmin, user: authUser } = useAuth();
  const isOnline = useOnlineStatus();
  const ttsPlayer = useTtsPlayer();
  const isMobile = useIsMobile();

  const handleVoiceEvent = useCallback(
    (key: string, text: string, voice?: string, speed?: number) => {
      if (ttsPlayer.autoPlay && ttsPlayer.available) {
        ttsPlayer.play(key, text, voice, speed);
      }
    },
    [ttsPlayer.autoPlay, ttsPlayer.available, ttsPlayer.play],
  );

  const {
    messages, input, sandboxProfile, setSandboxProfile, loading, sessionId, sessions, activeTab, governanceRoute, platformAdminSection, platformAdminEntityId, tenantAdminSection, settingsOpen, settingsSection,
    uploadedFiles, uploading, uploadError, dismissUploadError, isDragging, isLoadingSessions, isLoadingMessages,
    sessionLoadError, retrySessionLoad, hasMoreHistory, isLoadingEarlier, loadEarlierMessages,
    deleteSessionId, deleteSessionCount, lastMessageRef, scrollContainerRef, isNearBottomRef,
    setInput, setActiveTab, pushActiveTab, setPlatformAdminRoute, setTenantAdminRoute, openSettings, closeSettings, setSettingsSection,
    adminSettings, openAdminSettings, closeAdminSettings, setAdminSettingsSection,
    newSession: newPersonalSession, selectSession,
    confirmDeleteSession, confirmDeleteSessions, cancelDeleteSession, handleDeleteSession, renameSession, autoTitleSession, compactSession,
    removeFile, handleFileSelect, handleAssetSelect, handlePaste, sendMessage, interjectMessage, sendVoiceMessage, stopping, stopGeneration, retryMessage, forkFromMessage,
    queuedInterjections, cancelQueuedInterjection, editQueuedInterjection, resendQueuedInterjection, dismissQueuedInterjection,
    handleDragOver, handleDragLeave, handleDrop,
    handlePermissionResponse, handleAskUserResponse,
    modelList, selectedModel, onModelChange, autoApproveRunShell, setAutoApproveRunShell,
    tokenUsage, contextUsage, connectionState, resumeCurrentStream,
    notifications, dismissNotification,
    lastMemoryRecall, dismissMemoryRecall, pluginInstallStatus,
    runningSessionIds, sessionRuntimeStatuses,
    hasMoreSessions, isLoadingMoreSessions, loadMoreSessions, loadGroupSessions,
    agentProfile, sessionParticipants,
    previewFilePath, previewFileOwner, previewMode, openFilePreview, dockFilePreview, expandFilePreview, closeFilePreview,
    fileBrowserOpen, toggleFileBrowser, closeFileBrowser,
    isTrashPreview, previewTrashSession, trashPreviewSessionId,
    startOrgAgentSession, startAgentTargetSession, pendingAgentTarget,
  } = useChatAppState({ onVoiceEvent: handleVoiceEvent });

  const [subagentTranscript, setSubagentTranscript] = useState<SubagentTranscriptTarget | null>(null);
  const [previewArtifact, setPreviewArtifact] = useState<ArtifactPreviewTarget | null>(null);
  const closeSubagentTranscript = useCallback(() => setSubagentTranscript(null), []);
  const closeArtifactPreview = useCallback(() => setPreviewArtifact(null), []);
  const openSubagentTranscript = useCallback((target: SubagentTranscriptTarget) => {
    closeFilePreview();
    closeFileBrowser();
    closeArtifactPreview();
    setSubagentTranscript(target);
  }, [closeArtifactPreview, closeFileBrowser, closeFilePreview]);
  const openPreview = useCallback((path: string, owner?: string, options?: { mode?: "dialog" | "side" }) => {
    setSubagentTranscript(null);
    closeArtifactPreview();
    openFilePreview(path, owner, options);
  }, [closeArtifactPreview, openFilePreview]);
  const openArtifactPreview = useCallback((artifact: ArtifactPreviewTarget) => {
    setSubagentTranscript(null);
    closeFilePreview();
    closeFileBrowser();
    setPreviewArtifact(artifact);
  }, [closeFileBrowser, closeFilePreview]);
  const toggleBrowser = useCallback(() => {
    setSubagentTranscript(null);
    closeArtifactPreview();
    toggleFileBrowser();
  }, [closeArtifactPreview, toggleFileBrowser]);
  useEffect(() => {
    closeArtifactPreview();
  }, [closeArtifactPreview, sessionId]);

  const subagentTranscriptContextValue = useMemo(() => ({
    transcript: subagentTranscript,
    openTranscript: openSubagentTranscript,
    closeTranscript: closeSubagentTranscript,
  }), [closeSubagentTranscript, openSubagentTranscript, subagentTranscript]);

  // M20-06 selectors consume only the versioned tenant-scoped target catalog (never a legacy array).
  const { agents: myOrgAgents, catalog: agentTargetCatalog, compatibilityReason, loading: orgAgentsLoading } = useOrgAgents();
  const personalAgentEnabled = agentTargetCatalog?.personal.availability.status === 'available';
  const currentSessionItem = useMemo(
    () => sessionId ? sessions.find((s) => s.sessionId === sessionId) ?? null : null,
    [sessionId, sessions],
  );
  const activeAgentTarget = currentSessionItem?.agentTarget ?? pendingAgentTarget;
  const activeOrgAgent = useMemo(() => {
    if (activeAgentTarget?.kind !== 'org-agent') return null;
    const mine = myOrgAgents.find((agent) => agent.id === activeAgentTarget.orgAgentId);
    return {
      id: activeAgentTarget.orgAgentId,
      name: mine?.name ?? currentSessionItem?.orgAgentName ?? "企业专家",
      ...(mine?.avatar ? { avatar: mine.avatar } : {}),
      description: mine?.description ?? "这位企业专家由组织统一配置。",
      starterPrompts: mine?.starterPrompts ?? [],
      skillCount: mine?.skillCount ?? 0,
    };
  }, [activeAgentTarget, currentSessionItem?.orgAgentName, myOrgAgents]);
  const unprovenSessionReason: AgentTargetUnavailableReason | undefined = currentSessionItem && !currentSessionItem.agentTarget && !pendingAgentTarget
    ? { code: 'legacy_binding_unproven', message: '该历史会话缺少可证明的 Agent 目标，仅支持查看', contactAdmin: true }
    : undefined;
  const activeAgentTargetUnavailableReason = currentSessionItem?.agentTargetUnavailableReason ?? unprovenSessionReason;
  const activeAgentTargetLabel = activeAgentTarget?.kind === 'personal'
    ? '个人 Agent'
    : activeAgentTarget?.kind === 'org-agent' ? activeOrgAgent?.name ?? '企业专家'
      : currentSessionItem ? '绑定不可验证' : undefined;
  const activeOrgAgentReadOnly = Boolean(activeAgentTargetUnavailableReason);
  const orgAgentIdentityLoading = !agentTargetCatalog && !compatibilityReason && (orgAgentsLoading || isLoadingSessions);
  const adminOwnerView = Boolean(isAdmin && currentSessionItem?.owner?.username && currentSessionItem.owner.username !== authUser?.username);
  const [orgAgentPickerOpen, setOrgAgentPickerOpen] = useState(false);
  const pendingPickerGroupIdRef = useRef<string | null>(null);
  const launchTarget = useCallback((target: AgentTarget, groupId: string | null = null) => {
    const action = resolveTargetSessionAction({
      target,
      current: adminOwnerView || !sessionId ? null : { sessionId, target: currentSessionItem?.agentTarget },
    });
    if (action.kind === 'reuse') selectSession(action.sessionId);
    else startAgentTargetSession(action.target, groupId);
  }, [adminOwnerView, currentSessionItem?.agentTarget, selectSession, sessionId, startAgentTargetSession]);
  const newSession = useCallback((groupId: string | null = null) => {
    if (!agentTargetCatalog) {
      window.alert(compatibilityReason?.message ?? 'Agent 目录仍在加载，请稍后重试。');
      return;
    }
    const selection = resolveNewSessionAgentTarget({
      catalog: agentTargetCatalog,
      activeTarget: adminOwnerView ? null : activeAgentTarget,
    });
    if (selection.kind === 'selected') {
      // A new-conversation action is intentionally forced to a fresh session.
      startAgentTargetSession(selection.target, groupId);
    } else if (selection.kind === 'picker') {
      pendingPickerGroupIdRef.current = groupId;
      setOrgAgentPickerOpen(true);
    } else {
      window.alert(selection.reason.message);
    }
  }, [activeAgentTarget, adminOwnerView, agentTargetCatalog, compatibilityReason, startAgentTargetSession]);

  const handleOrgAgentPickerSelect = useCallback((agentId: string) => {
    setOrgAgentPickerOpen(false);
    const groupId = pendingPickerGroupIdRef.current;
    pendingPickerGroupIdRef.current = null;
    if (!agentTargetCatalog) return;
    const target = agentTargetCatalog.selectableTargets.find(candidate => candidate.kind === 'org-agent' && candidate.orgAgentId === agentId);
    if (target) launchTarget(target, groupId);
  }, [agentTargetCatalog, launchTarget]);

  useEffect(() => {
    if (orgAgentsLoading || !agentTargetCatalog || personalAgentEnabled || agentTargetCatalog.selectableTargets.length !== 1) return;
    if (activeTab !== "chat" || settingsOpen || adminSettings) return;
    if (sessionId || pendingAgentTarget || messages.length > 0) return;
    startAgentTargetSession(agentTargetCatalog.selectableTargets[0]!);
  }, [activeTab, adminSettings, agentTargetCatalog, messages.length, orgAgentsLoading, pendingAgentTarget, personalAgentEnabled, sessionId, settingsOpen, startAgentTargetSession]);

  // iOS PWA 生命周期：后台恢复时刷新数据，进入后台时保存状态
  const onResume = useCallback(() => {
    // 运行中的会话只走 cursor replay；空闲会话由 refreshAll 的 session refresh 拉取 snapshot。
    // 禁止同一时刻既刷新 transcript 又从旧 cursor replay，否则会重复追加同一批内容。
    if (loading && sessionId) {
      void resumeCurrentStream();
      return;
    }
    void refreshAll();
  }, [loading, resumeCurrentStream, sessionId]);

  const onSuspend = useCallback(() => {
    if (sessionId && messages.length > 0) {
      saveSessionMessages(sessionId, messages);
    }
  }, [sessionId, messages]);

  useAppLifecycle({ onResume, onSuspend });
  useActivityReporter();



  // ttsProps 只包含稳定的函数引用和 available 标志，引用极少变化。
  // ttsStateMap / activeKey 变化频繁，拆到 MessageList 独立 props 中，
  // 避免 ttsProps 引用变化导致中间组件（Layout → ChatTabContent）级联重渲染。
  const ttsProps: TtsProps | undefined = useMemo(
    () =>
      ttsPlayer.available
        ? {
          getState: ttsPlayer.getState,
          activeKey: ttsPlayer.activeKey,
          play: ttsPlayer.play,
          togglePause: ttsPlayer.togglePause,
          available: ttsPlayer.available,
        }
        : undefined,
    [ttsPlayer.available, ttsPlayer.getState, ttsPlayer.play, ttsPlayer.togglePause, ttsPlayer.activeKey],
  );

  const sidebarSessions = useMemo(
    () => toSidebarSessions(
      sessions,
      runningSessionIds,
      sessionRuntimeStatuses,
      agentProfile,
    ),
    [sessions, runningSessionIds, sessionRuntimeStatuses, agentProfile],
  );

  const layoutProps: LayoutProps = {
    sidebarSessions, sessionId, selectSession, newSession, newPersonalSession, confirmDeleteSession, confirmDeleteSessions, renameSession, autoTitleSession, compactSession,
    isLoadingSessions, activeTab, governanceRoute, platformAdminSection, platformAdminEntityId, tenantAdminSection, setTenantAdminRoute, setActiveTab, pushActiveTab, setPlatformAdminRoute, settingsOpen, settingsSection, openSettings, closeSettings, setSettingsSection,
    adminSettings, openAdminSettings, closeAdminSettings, setAdminSettingsSection,
    isAdmin, isPlatformAdmin, isOnline, connectionState,
    messages, loading, isLoadingMessages, sessionLoadError, retrySessionLoad, hasMoreHistory, isLoadingEarlier, loadEarlierMessages,
    retryMessage, forkFromMessage, lastMessageRef, scrollContainerRef, isNearBottomRef,
    handlePermissionResponse, handleAskUserResponse,
    uploadedFiles, removeFile, input, sandboxProfile, setSandboxProfile, uploading, uploadError, dismissUploadError, setInput,
    sendMessage, interjectMessage, sendVoiceMessage, stopping, stopGeneration, handleFileSelect, handleAssetSelect, handlePaste, ttsProps,
    queuedInterjections, cancelQueuedInterjection, editQueuedInterjection, resendQueuedInterjection, dismissQueuedInterjection,
    ttsStateMap: ttsPlayer.ttsStateMap, modelList,
    selectedModel, onModelChange, autoApproveRunShell, setAutoApproveRunShell, ttsPlayer, tokenUsage, contextUsage,
    hasMoreSessions, isLoadingMoreSessions, loadMoreSessions, loadGroupSessions,
    agentProfile, sessionParticipants,
    previewFilePath, previewFileOwner, previewMode, openFilePreview: openPreview, dockFilePreview, expandFilePreview, closeFilePreview,
    previewArtifact, closeArtifactPreview,
    fileBrowserOpen, toggleFileBrowser: toggleBrowser, closeFileBrowser,
    isTrashPreview, previewTrashSession, trashPreviewSessionId,
    startOrgAgentSession, activeOrgAgent, activeOrgAgentReadOnly, activeAgentTargetUnavailableReason, activeAgentTargetLabel, myOrgAgents, personalAgentEnabled, orgAgentIdentityLoading,
  };

  // 反馈 Provider 恒挂载（2026-07 审查 F8：条件包裹会让 Layout 卸载重挂丢 DOM 状态）；
  // 仅当前会话绑定专职 Agent 时提供实值，否则 context=null → 按钮零渲染
  const feedbackSessionId = sessionId && activeOrgAgent ? sessionId : null;
  const layoutNode = isMobile ? <MobileLayout {...layoutProps} /> : <DesktopLayout {...layoutProps} />;

  return (
    <div
      className="flex h-full flex-col"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragging ? (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-background/80">
          <div className="rounded-lg border border-dashed bg-background px-6 py-4 text-sm text-muted-foreground">
            Release to upload files
          </div>
        </div>
      ) : null}

      <SubagentTranscriptProvider value={subagentTranscriptContextValue}>
        <FilePreviewProvider value={{
          openPreview,
          openArtifactPreview: isMobile ? undefined : openArtifactPreview,
          owner: previewFileOwner,
        }}>
          <MessageFeedbackProvider sessionId={feedbackSessionId}>
            {layoutNode}
          </MessageFeedbackProvider>
        </FilePreviewProvider>
      </SubagentTranscriptProvider>

      {/* SDK 0.2.112+ REPL 通知（右上角悬浮，按 priority 色彩，timeoutMs 自动消失）*/}
      <NotificationToastStack notifications={notifications} onDismiss={dismissNotification} />

      {/* SDK 0.2.112+ supervisor 召回记忆 + 插件安装进度（底部悬浮）*/}
      {(lastMemoryRecall || pluginInstallStatus) && (
        <div className="pointer-events-none fixed bottom-16 right-4 z-40 flex w-80 flex-col gap-2">
          <div className="pointer-events-auto">
            <MemoryRecallBanner data={lastMemoryRecall} onDismiss={dismissMemoryRecall} />
          </div>
          <div className="pointer-events-auto">
            <PluginInstallBanner data={pluginInstallStatus} />
          </div>
        </div>
      )}



      <DeleteSessionDialog
        open={deleteSessionId !== null}
        onOpenChange={(open) => {
          if (!open) {
            cancelDeleteSession();
          }
        }}
        onConfirm={() => {
          void handleDeleteSession();
        }}
        isAdmin={isAdmin}
        count={deleteSessionCount}
      />
      <OrgAgentPickerDialog
        open={orgAgentPickerOpen}
        agents={myOrgAgents}
        onOpenChange={setOrgAgentPickerOpen}
        onSelect={handleOrgAgentPickerSelect}
      />
    </div>
  );
}

export default App;
