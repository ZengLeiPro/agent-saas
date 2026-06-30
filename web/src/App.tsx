import { useCallback, useMemo } from "react";
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
import { DeleteSessionDialog } from "@/components/chat/DeleteSessionDialog";

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
  }));
}

function App() {
  const { isAdmin, isPlatformAdmin } = useAuth();
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
    messages, input, loading, sessionId, sessions, activeTab, settingsOpen, settingsSection,
    uploadedFiles, uploading, uploadError, dismissUploadError, isDragging, isLoadingSessions, isLoadingMessages,
    deleteSessionId, deleteSessionCount, lastMessageRef, scrollContainerRef, isNearBottomRef,
    setInput, setActiveTab, pushActiveTab, openSettings, closeSettings, setSettingsSection,
    adminSettings, openAdminSettings, closeAdminSettings, setAdminSettingsSection,
    newSession, selectSession,
    confirmDeleteSession, confirmDeleteSessions, cancelDeleteSession, handleDeleteSession, renameSession, autoTitleSession, compactSession,
    removeFile, handleFileSelect, handlePaste, sendMessage, sendVoiceMessage, stopping, stopGeneration, retryMessage, forkFromMessage,
    handleDragOver, handleDragLeave, handleDrop,
    handlePermissionResponse, handleAskUserResponse,
    modelList, selectedModel, onModelChange, autoApproveRunShell, setAutoApproveRunShell,
    tokenUsage, contextUsage, connectionState, refreshCurrentSession,
    notifications, dismissNotification,
    lastMemoryRecall, dismissMemoryRecall, pluginInstallStatus,
    unreadAiReplySessionIds,
    hasMoreSessions, isLoadingMoreSessions, loadMoreSessions, loadGroupSessions,
    agentProfile, sessionParticipants,
    previewFilePath, previewFileOwner, openFilePreview, closeFilePreview,
    fileBrowserOpen, toggleFileBrowser, closeFileBrowser,
    isTrashPreview, previewTrashSession, trashPreviewSessionId,
  } = useChatAppState({ onVoiceEvent: handleVoiceEvent });

  // iOS PWA 生命周期：后台恢复时刷新数据，进入后台时保存状态
  const onResume = useCallback(() => {
    void refreshAll();
    if (!loading) {
      refreshCurrentSession();
    }
  }, [loading, refreshCurrentSession]);

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
    sidebarSessions, unreadAiReplySessionIds, sessionId, selectSession, newSession, confirmDeleteSession, confirmDeleteSessions, renameSession, autoTitleSession, compactSession,
    isLoadingSessions, activeTab, setActiveTab, pushActiveTab, settingsOpen, settingsSection, openSettings, closeSettings, setSettingsSection,
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
    previewFilePath, previewFileOwner, openFilePreview, closeFilePreview,
    fileBrowserOpen, toggleFileBrowser, closeFileBrowser,
    isTrashPreview, previewTrashSession, trashPreviewSessionId,
  };

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
        {isMobile ? <MobileLayout {...layoutProps} /> : <DesktopLayout {...layoutProps} />}
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
    </div>
  );
}

export default App;
