import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppLifecycle } from "@/hooks/useAppLifecycle";
import { useActivityReporter } from "@/hooks/useActivityReporter";

import { refreshAll } from "@/lib/refreshBus";
import { saveSessionMessages } from "@/lib/messageCache";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useChatAppState } from "@/hooks/useChatAppState";
import { useTtsPlayer } from "@/hooks/useTtsPlayer";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { useAuth } from "@/contexts/AuthContext";
import { FilePreviewProvider } from "@/contexts/FilePreviewContext";
import { MessageFeedbackProvider } from "@/contexts/MessageFeedbackContext";
import { useOrgAgents } from "@/hooks/useOrgAgents";
import { DeleteSessionDialog } from "@/components/chat/DeleteSessionDialog";
import { OrgAgentPickerDialog } from "@/components/OrgAgentPickerDialog";
import { resolveNewSessionTarget } from "@/lib/orgAgentSessionRouting";

import { DesktopLayout } from "@/layouts/DesktopLayout";
import { MobileLayout } from "@/layouts/MobileLayout";
import { NotificationToastStack, MemoryRecallBanner, PluginInstallBanner } from "@/components/SdkSystemBanners";
import type { TtsProps } from "@/components/MessageItem";
import type { ApiSessionListItem } from "@/lib/sessionsApi";
import type { LayoutProps } from "@/layouts/types";
import type { AgentProfile } from "@agent/shared";

/** 将 API 会话列表转换为 sidebar 所需的格式 */
function toSidebarSessions(
  sessions: ApiSessionListItem[],
  unreadAiReplySessionIds: ReadonlySet<string>,
  currentAgent?: AgentProfile | null,
) {
  return sessions.map((s) => ({
    id: s.sessionId,
    title: s.title || "New chat",
    createdAt: s.createdAtMs || s.updatedAtMs,
    updatedAt: s.updatedAtMs,
    preview: s.preview,
    hasUnreadAiReply: unreadAiReplySessionIds.has(s.sessionId),
    source: s.source,
    owner: s.owner,
    agent: s.agent ?? (currentAgent && (!s.owner || s.owner.username === currentAgent.username) ? currentAgent : undefined),
    cronJobId: s.cronJobId,
    cronJobName: s.cronJobName,
    orgAgentId: s.orgAgentId,
    orgAgentName: s.orgAgentName,
    orgAgentAvailable: s.orgAgentAvailable,
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
    messages, input, loading, sessionId, sessions, activeTab, platformAdminSection, platformAdminEntityId, settingsOpen, settingsSection,
    uploadedFiles, uploading, uploadError, dismissUploadError, isDragging, isLoadingSessions, isLoadingMessages,
    deleteSessionId, deleteSessionCount, lastMessageRef, scrollContainerRef, isNearBottomRef,
    setInput, setActiveTab, pushActiveTab, setPlatformAdminRoute, openSettings, closeSettings, setSettingsSection,
    adminSettings, openAdminSettings, closeAdminSettings, setAdminSettingsSection,
    newSession: newPersonalSession, selectSession,
    confirmDeleteSession, confirmDeleteSessions, cancelDeleteSession, handleDeleteSession, renameSession, autoTitleSession, compactSession,
    removeFile, handleFileSelect, handlePaste, sendMessage, sendVoiceMessage, stopping, stopGeneration, retryMessage, forkFromMessage,
    handleDragOver, handleDragLeave, handleDrop,
    handlePermissionResponse, handleAskUserResponse,
    modelList, selectedModel, onModelChange, autoApproveRunShell, setAutoApproveRunShell,
    tokenUsage, contextUsage, connectionState, refreshCurrentSession, resumeCurrentStream,
    notifications, dismissNotification,
    lastMemoryRecall, dismissMemoryRecall, pluginInstallStatus,
    unreadAiReplySessionIds,
    hasMoreSessions, isLoadingMoreSessions, loadMoreSessions, loadGroupSessions,
    agentProfile, sessionParticipants,
    previewFilePath, previewFileOwner, previewMode, openFilePreview, dockFilePreview, closeFilePreview,
    fileBrowserOpen, toggleFileBrowser, closeFileBrowser,
    isTrashPreview, previewTrashSession, trashPreviewSessionId,
    startOrgAgentSession, pendingOrgAgentId,
  } = useChatAppState({ onVoiceEvent: handleVoiceEvent });

  // 专职 Agent（2026-07 唯恩批次）：当前会话绑定态 = 列表项 orgAgentId 或挂起态
  const { agents: myOrgAgents, loading: orgAgentsLoading } = useOrgAgents();
  const personalAgentEnabled = isAdmin || authUser?.tenantFeatures?.personalAgentEnabled !== false;
  const currentSessionItem = useMemo(
    () => sessionId ? sessions.find((s) => s.sessionId === sessionId) ?? null : null,
    [sessionId, sessions],
  );
  const activeOrgAgent = useMemo(() => {
    const orgAgentId = currentSessionItem?.orgAgentId ?? pendingOrgAgentId ?? null;
    if (!orgAgentId) return null;
    const mine = myOrgAgents.find((agent) => agent.id === orgAgentId);
    return {
      id: orgAgentId,
      name: mine?.name ?? currentSessionItem?.orgAgentName ?? "企业专家",
      ...(mine?.avatar ? { avatar: mine.avatar } : {}),
      description: mine?.description ?? "这位企业专家由组织统一配置。",
      starterPrompts: mine?.starterPrompts ?? [],
      skillCount: mine?.skillCount ?? 0,
    };
  }, [currentSessionItem, pendingOrgAgentId, myOrgAgents]);
  const activeOrgAgentReadOnly = currentSessionItem?.orgAgentId !== undefined
    && currentSessionItem.orgAgentAvailable === false;
  const orgAgentIdentityLoading = !personalAgentEnabled
    && !activeOrgAgent
    && (orgAgentsLoading || isLoadingSessions);
  const [orgAgentPickerOpen, setOrgAgentPickerOpen] = useState(false);
  const newSession = useCallback(() => {
    const target = resolveNewSessionTarget({
      activeOrgAgentId: activeOrgAgent?.id,
      availableOrgAgentIds: myOrgAgents.map((agent) => agent.id),
      personalAgentEnabled,
    });
    if (target.kind === "personal") {
      newPersonalSession();
    } else if (target.kind === "org-agent") {
      startOrgAgentSession(target.agentId);
    } else {
      setOrgAgentPickerOpen(true);
    }
  }, [activeOrgAgent?.id, myOrgAgents, newPersonalSession, personalAgentEnabled, startOrgAgentSession]);

  const handleOrgAgentPickerSelect = useCallback((agentId: string) => {
    setOrgAgentPickerOpen(false);
    startOrgAgentSession(agentId);
  }, [startOrgAgentSession]);

  // 关闭个人 Agent 且只有一位企业专家：空首页直接进入专家草稿，不创建服务端会话。
  useEffect(() => {
    if (orgAgentsLoading || personalAgentEnabled || myOrgAgents.length !== 1) return;
    if (activeTab !== "chat" || settingsOpen || adminSettings) return;
    if (sessionId || pendingOrgAgentId || messages.length > 0) return;
    startOrgAgentSession(myOrgAgents[0].id);
  }, [activeTab, adminSettings, messages.length, myOrgAgents, orgAgentsLoading, pendingOrgAgentId, personalAgentEnabled, sessionId, settingsOpen, startOrgAgentSession]);

  // iOS PWA 生命周期：后台恢复时刷新数据，进入后台时保存状态
  const onResume = useCallback(() => {
    void refreshAll();
    if (sessionId) {
      void resumeCurrentStream();
    }
    if (!loading) {
      refreshCurrentSession();
    }
  }, [loading, refreshCurrentSession, resumeCurrentStream, sessionId]);

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
    () => toSidebarSessions(sessions, unreadAiReplySessionIds, agentProfile),
    [sessions, unreadAiReplySessionIds, agentProfile],
  );

  const layoutProps: LayoutProps = {
    sidebarSessions, unreadAiReplySessionIds, sessionId, selectSession, newSession, newPersonalSession, confirmDeleteSession, confirmDeleteSessions, renameSession, autoTitleSession, compactSession,
    isLoadingSessions, activeTab, platformAdminSection, platformAdminEntityId, setActiveTab, pushActiveTab, setPlatformAdminRoute, settingsOpen, settingsSection, openSettings, closeSettings, setSettingsSection,
    adminSettings, openAdminSettings, closeAdminSettings, setAdminSettingsSection,
    isAdmin, isPlatformAdmin, isOnline, connectionState,
    messages, loading, isLoadingMessages, retryMessage, forkFromMessage, lastMessageRef, scrollContainerRef, isNearBottomRef,
    handlePermissionResponse, handleAskUserResponse,
    uploadedFiles, removeFile, input, uploading, uploadError, dismissUploadError, setInput,
    sendMessage, sendVoiceMessage, stopping, stopGeneration, handleFileSelect, handlePaste, ttsProps,
    ttsStateMap: ttsPlayer.ttsStateMap, modelList,
    selectedModel, onModelChange, autoApproveRunShell, setAutoApproveRunShell, ttsPlayer, tokenUsage, contextUsage,
    hasMoreSessions, isLoadingMoreSessions, loadMoreSessions, loadGroupSessions,
    agentProfile, sessionParticipants,
    previewFilePath, previewFileOwner, previewMode, openFilePreview, dockFilePreview, closeFilePreview,
    fileBrowserOpen, toggleFileBrowser, closeFileBrowser,
    isTrashPreview, previewTrashSession, trashPreviewSessionId,
    startOrgAgentSession, activeOrgAgent, activeOrgAgentReadOnly, myOrgAgents, personalAgentEnabled, orgAgentIdentityLoading,
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

      <FilePreviewProvider value={{ openPreview: openFilePreview, owner: previewFileOwner }}>
        <MessageFeedbackProvider sessionId={feedbackSessionId}>
          {layoutNode}
        </MessageFeedbackProvider>
      </FilePreviewProvider>

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
