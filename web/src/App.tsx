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
import { AgentSwitchConfirmationDialog } from "@/components/AgentSwitchConfirmationDialog";
import {
  evaluateAgentTargetTransition,
  resolveLandingAgentTarget,
  resolveNewSessionAgentTarget,
  type AgentTarget,
  type AgentTargetTransitionImpact,
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
    agentTargetSnapshot: s.agentTargetSnapshot,
    agentTargetUnavailableReason: s.agentTargetUnavailableReason,
  }));
}

function App() {
  const { isAdmin, isPlatformAdmin, user: authUser } = useAuth();
  const isOnline = useOnlineStatus(); // lifecycle-sensitive media remains fail-closed
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
    removeFile, handleFileSelect, handleAssetSelect, handlePaste, sendMessage, sendVoiceMessage, stopping, stopGeneration, retryMessage, forkFromMessage,
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
    startAgentTargetSession, pendingAgentTarget,
  } = useChatAppState({ onVoiceEvent: handleVoiceEvent });

  useEffect(() => ttsPlayer.stop, [sessionId, ttsPlayer.stop]);

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
      name: currentSessionItem?.agentTargetSnapshot?.name ?? (!currentSessionItem ? mine?.name : undefined) ?? "企业专家",
      ...(mine?.avatar ? { avatar: mine.avatar } : {}),
      description: mine?.description ?? "这位企业专家由组织统一配置。",
      starterPrompts: mine?.starterPrompts ?? [],
      skillCount: mine?.skillCount ?? 0,
    };
  }, [activeAgentTarget, currentSessionItem, myOrgAgents]);
  const unprovenSessionReason: AgentTargetUnavailableReason | undefined = currentSessionItem && !currentSessionItem.agentTarget && !pendingAgentTarget
    ? { code: 'legacy_binding_unproven', message: '该历史会话缺少可证明的 Agent 目标，仅支持查看', contactAdmin: true }
    : undefined;
  const activeAgentTargetUnavailableReason = currentSessionItem?.agentTargetUnavailableReason ?? unprovenSessionReason;
  const activeAgentTargetLabel = currentSessionItem
    ? currentSessionItem.agentTargetSnapshot?.name ?? '绑定不可验证'
    : activeAgentTarget?.kind === 'personal'
      ? '个人 Agent'
      : activeAgentTarget?.kind === 'org-agent' ? activeOrgAgent?.name ?? '企业专家' : undefined;
  const activeOrgAgentReadOnly = Boolean(activeAgentTargetUnavailableReason);
  const sessionReadOnly = Boolean(
    sessionId
    && sessionParticipants?.owner.userId
    && authUser?.id
    && sessionParticipants.owner.userId !== authUser.id,
  );
  const orgAgentIdentityLoading = !agentTargetCatalog && !compatibilityReason && (orgAgentsLoading || isLoadingSessions);
  const adminOwnerView = Boolean(isAdmin && currentSessionItem?.owner?.username && currentSessionItem.owner.username !== authUser?.username);
  const [orgAgentPickerOpen, setOrgAgentPickerOpen] = useState(false);
  const pendingPickerGroupIdRef = useRef<string | null>(null);
  const [pendingSwitch, setPendingSwitch] = useState<{
    target: AgentTarget;
    groupId: string | null;
    impacts: AgentTargetTransitionImpact[];
    cancelling: boolean;
    cancelError?: string;
  } | null>(null);
  const launchTarget = useCallback((target: AgentTarget, groupId: string | null = null) => {
    if (adminOwnerView) return;
    const targetOption = target.kind === 'personal'
      ? agentTargetCatalog?.personal
      : agentTargetCatalog?.orgAgents.find(option => option.target.kind === 'org-agent' && option.target.orgAgentId === target.orgAgentId);
    const runtimeStatus = sessionId ? sessionRuntimeStatuses.get(sessionId) : undefined;
    const currentQueue = sessionId ? queuedInterjections.filter(item => item.sessionId === sessionId && item.status === 'queued') : [];
    const decision = evaluateAgentTargetTransition({
      currentSession: sessionId && currentSessionItem?.agentTarget
        ? { sessionId, target: currentSessionItem.agentTarget, bindingVersion: currentSessionItem.agentTargetBindingVersion ?? 0 }
        : null,
      requestedTarget: target,
      runLiveness: runtimeStatus
        ? { state: runtimeStatus.startsWith('waiting_') ? 'waiting_interaction' : 'active', recoveryActions: ['cancel'], version: 1 }
        : { state: 'terminal', recoveryActions: [], version: 1 },
      queueSnapshot: sessionId && currentQueue.length ? {
        version: 1,
        sessionId,
        generatedAt: new Date().toISOString(),
        items: currentQueue.map((item, index) => ({
          sessionId,
          clientMsgId: item.clientMsgId,
          runId: item.sourceRunId ?? item.clientMsgId,
          sourceRunId: item.sourceRunId ?? item.clientMsgId,
          deliveryMode: item.deliveryMode,
          status: 'queued' as const,
          queuePosition: item.queuePosition ?? index + 1,
        })),
      } : null,
      pendingInteraction: currentSessionItem?.activeInteraction ?? null,
      availability: targetOption?.availability ?? {
        status: 'unavailable',
        reason: { code: 'no_available_target', message: '该 Agent 当前不可用', contactAdmin: true },
      },
      generation: 1,
      availabilityVersion: currentSessionItem?.agentTargetSnapshot?.version ?? 1,
    });
    if (decision.kind === 'blocked') { window.alert(decision.reason.message); return; }
    if (decision.kind === 'reuse') { selectSession(decision.sessionId); return; }
    if (decision.kind === 'new-session') { startAgentTargetSession(decision.target, groupId); return; }
    setPendingSwitch({ target, groupId, impacts: decision.impacts, cancelling: false });
  }, [adminOwnerView, agentTargetCatalog, currentSessionItem, queuedInterjections, selectSession, sessionId, sessionRuntimeStatuses, startAgentTargetSession]);

  const keepOldOpenAndSwitch = useCallback(() => {
    if (!pendingSwitch) return;
    const { target, groupId } = pendingSwitch;
    setPendingSwitch(null);
    startAgentTargetSession(target, groupId);
  }, [pendingSwitch, startAgentTargetSession]);

  const cancelActiveAndSwitch = useCallback(async () => {
    if (!pendingSwitch || pendingSwitch.cancelling) return;
    setPendingSwitch(current => current ? { ...current, cancelling: true, cancelError: undefined } : current);
    if (runningSessionIds.has(sessionId ?? '')) stopGeneration();
    const queued = queuedInterjections.filter(item => item.sessionId === sessionId && item.status === 'queued');
    const acknowledgements = await Promise.all(queued.map(item => cancelQueuedInterjection(item.clientMsgId)));
    if (acknowledgements.some(ok => !ok)) {
      setPendingSwitch(current => current ? { ...current, cancelling: false, cancelError: '服务端未确认全部排队消息已取消' } : current);
    }
  }, [cancelQueuedInterjection, pendingSwitch, queuedInterjections, runningSessionIds, sessionId, stopGeneration]);

  useEffect(() => {
    if (!pendingSwitch?.cancelling) return;
    const hasRunning = Boolean(sessionId && runningSessionIds.has(sessionId));
    const hasQueue = queuedInterjections.some(item => item.sessionId === sessionId && item.status === 'queued');
    const hasInteraction = Boolean(currentSessionItem?.activeInteraction);
    if (hasRunning || hasQueue || hasInteraction) return;
    const { target, groupId } = pendingSwitch;
    setPendingSwitch(null);
    startAgentTargetSession(target, groupId);
  }, [currentSessionItem?.activeInteraction, pendingSwitch, queuedInterjections, runningSessionIds, sessionId, startAgentTargetSession]);
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

  const startOrgAgentWithTransition = useCallback((agentId: string, groupId: string | null = null) => {
    const target = agentTargetCatalog?.selectableTargets.find(candidate => candidate.kind === 'org-agent' && candidate.orgAgentId === agentId);
    if (target) launchTarget(target, groupId);
  }, [agentTargetCatalog, launchTarget]);

  const handleOrgAgentPickerSelect = useCallback((agentId: string) => {
    setOrgAgentPickerOpen(false);
    const groupId = pendingPickerGroupIdRef.current;
    pendingPickerGroupIdRef.current = null;
    if (!agentTargetCatalog) return;
    const target = agentTargetCatalog.selectableTargets.find(candidate => candidate.kind === 'org-agent' && candidate.orgAgentId === agentId);
    if (target) launchTarget(target, groupId);
  }, [agentTargetCatalog, launchTarget]);

  // 着陆页的空对话同样必须先绑定 Agent 目标，否则首条消息会被「缺少可证明的 Agent 目标」门禁挡下。
  useEffect(() => {
    if (activeTab !== "chat" || settingsOpen || adminSettings) return;
    const target = resolveLandingAgentTarget({
      catalog: agentTargetCatalog,
      catalogLoading: orgAgentsLoading,
      hasSession: Boolean(sessionId),
      hasPendingTarget: Boolean(pendingAgentTarget),
      hasMessages: messages.length > 0,
    });
    if (target) startAgentTargetSession(target);
  }, [activeTab, adminSettings, agentTargetCatalog, messages.length, orgAgentsLoading, pendingAgentTarget, sessionId, settingsOpen, startAgentTargetSession]);

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
    sendMessage, sendVoiceMessage, stopping, stopGeneration, handleFileSelect, handleAssetSelect, handlePaste, ttsProps,
    queuedInterjections, cancelQueuedInterjection, editQueuedInterjection, resendQueuedInterjection, dismissQueuedInterjection,
    ttsStateMap: ttsPlayer.ttsStateMap, modelList,
    selectedModel, onModelChange, autoApproveRunShell, setAutoApproveRunShell, ttsPlayer, tokenUsage, contextUsage,
    hasMoreSessions, isLoadingMoreSessions, loadMoreSessions, loadGroupSessions,
    agentProfile, sessionParticipants,
    previewFilePath, previewFileOwner, previewMode, openFilePreview: openPreview, dockFilePreview, expandFilePreview, closeFilePreview,
    previewArtifact, closeArtifactPreview,
    fileBrowserOpen, toggleFileBrowser: toggleBrowser, closeFileBrowser,
    isTrashPreview, previewTrashSession, trashPreviewSessionId,
    startOrgAgentSession: startOrgAgentWithTransition, activeOrgAgent, activeOrgAgentReadOnly, sessionReadOnly, activeAgentTargetUnavailableReason, activeAgentTargetLabel, myOrgAgents, personalAgentEnabled, orgAgentIdentityLoading,
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
      <AgentSwitchConfirmationDialog
        open={Boolean(pendingSwitch)}
        targetName={!pendingSwitch || pendingSwitch.target.kind === 'personal'
          ? '个人 Agent'
          : myOrgAgents.find(agent => agent.id === (pendingSwitch.target as Extract<AgentTarget, { kind: 'org-agent' }>).orgAgentId)?.name ?? '企业专家'}
        impacts={pendingSwitch?.impacts ?? []}
        cancelling={pendingSwitch?.cancelling ?? false}
        cancelError={pendingSwitch?.cancelError}
        onKeepOldOpen={keepOldOpenAndSwitch}
        onCancelActive={() => { void cancelActiveAndSwitch(); }}
        onClose={() => setPendingSwitch(null)}
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
