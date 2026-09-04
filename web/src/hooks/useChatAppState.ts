import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import type { MessageItem, UploadedFile } from "@/components/types";
import type { ApiSessionListItem } from "@/lib/sessionsApi";
import type { AgentTarget, MemoryRecallData, NotificationData, PluginInstallData, RuntimeFailureKind, RuntimeRecoveryAction, SessionRuntimeStatus } from "@agent/shared";
import type { ModelList } from "@/types/models";
import type { AppTab } from "@/types/sidebar";
import type { CanonicalSettingsSectionId } from "@/types/settings";
import type { WsEvent } from "@/types/ws";
import type { WsEnvelope } from "@/lib/wsClient";
import { approvalPolicyPayloadForTier, resolveApprovalTier } from "@/lib/approvalTier";
import { useApprovalTierRunPolicy } from "./useApprovalTierRunPolicy";
import { useSessionReadTracking } from "./useSessionReadTracking";
import { useSandboxProfile } from "./useSandboxProfile";
import { wsClient } from "@/lib/wsClient";
import { authFetch } from "@/lib/authFetch";
import {
  buildWebChatSubmission,
  toWebChatWireMessage,
  validateWebUploadedFiles,
} from "@/lib/chatSubmissionAdapter";
import { canonicalChatAttachmentToDisplay, createChatClientState, interactionKey, reduceChatClientState, selectChatClientQueue, selectChatQueueItems, type ChatQueueReducerEvent, type ChatQueueSnapshot, type ChatQueueState } from "@agent/shared";
import { registerRefresh, unregisterRefresh } from "@/lib/refreshBus";
import { fetchAgentProfile, reportActivity } from "@agent/shared";
import type { AgentProfile, SessionParticipants } from "@agent/shared";
import { saveSessionMessages } from "@/lib/messageCache";
import {
  getComposerDraftScope,
  loadComposerAttachments,
  loadComposerText,
  saveComposerAttachments,
  saveComposerText,
} from "@/lib/composerDraftStorage";
import type { ApiSessionDetail } from "@/lib/sessionsApi";
import {
  asCompactionItem,
  compactionDoneReplacement,
  createCompactionDoneItem,
  createCompactionRunningItem,
} from "@/lib/compaction";
import type { CompactionMessageItem, CompactionStatusEvent } from "@/lib/compaction";
import {
  InterjectionConsumptionRegistry,
  projectAuthoritativeInterjections,
  reconcileQueuedInterjections,
} from "@/lib/interjectionConsumption";
import type { QueuedInterjection } from "@/lib/interjectionConsumption";
import {
  acquireMessageSubmissionSlot,
  finalizeNotFoundSubmission,
  markSteeringCancelledForStop,
  projectAuthoritativeSubmissionStatus,
  recoverQueueSnapshotAfterSyncOverflow,
  shouldAcceptSessionEvent,
} from "@/lib/queueConsistency";
export type { QueuedInterjection } from "@/lib/interjectionConsumption";
import { parseUrl, pushUrl, replaceUrl, buildUrl, buildSettingsUrl, replaceSettingsUrl, replaceAdminSettingsUrl, buildAdminSettingsUrl, buildPlatformAdminUrl, pushPlatformAdminUrl, replacePlatformAdminUrl, buildTenantAdminUrl, pushTenantAdminUrl, replaceTenantAdminUrl, normalizeTenantAdminSection, preserveScopeSearch, preserveSearchKeys, TENANT_ADMIN_SCOPE_KEYS, pushGovernanceUrl, replaceGovernanceUrl, analysisHistoryStateForNavigation } from "@/lib/urlSync";
import { buildGovernanceUrl, governanceRoute, type GovernanceRouteState } from "@/lib/governanceNavigation";
import { registerUpdateGuard, registerBeforeReloadHook, maybeReloadOnPopstate } from "@/lib/swUpdate";
import { runShellApprovalStorageKey } from "@/lib/runShellApprovalStorage";
import type { AdminSettingsState, PlatformAdminSection, TenantAdminSection } from "@/lib/urlSync";
import { useMessages } from "@/hooks/useMessages";
import { usePersonalSettingsNavigation } from "@/hooks/usePersonalSettingsNavigation";
import { useAdminSettingsNavigation } from "@/hooks/useAdminSettingsNavigation";
import { usePendingNewSessionTarget } from "@/hooks/usePendingNewSessionTarget";
import { useAuth } from "@/contexts/AuthContext";
import { useSession } from "@/hooks/useSession";
import { useFileUpload } from "@/hooks/useFileUpload";
import { useConnectionState } from "@/hooks/useConnectionState";
import {
  processWsEvent,
  finalizeStreamingMessages,
  finalizeRunningSubagents,
  formatRuntimeFailureMessage, isSameRunMessage,
  isInsufficientCreditsFailure,
  removeRuntimeStatusMessages,
  upsertRuntimeStatusMessage,
  type WsProcessingContext,
  type WsBlockState,
} from '@agent/shared';
import {
  activeRuntimePatchFromStreamStatus, fetchSessionStreamStatus, isActiveRuntimeStatus, isTerminalRuntimeStatus,
  reconnectAfterServerDrain, runtimeStatusFromSessionStatus, sessionlessDoneBelongsToRuntime, type LastRunState, type TerminalRuntimeStatus } from "./chatRuntimeHelpers";

export type { ChatAppState, ChatAppStateOptions } from "./useChatAppStateTypes";
import type {
  ChatAppState, ChatAppStateOptions, OutboxEntry,
  SessionRuntime, SessionRuntimePatch,
} from "./useChatAppStateTypes";
import {
  cancelQueuedEntry, createQueueConsistencyCallbacks, dismissQueuedEntry,
  resendQueuedEntry, restoreQueuedEntryForEdit,
} from "./useChatAppStateQueueConsistency";
import { useChatNotificationState, useChatStreamCorrelation } from "./useChatRuntimeState";
import { useInteractionResponseController, webPendingInteractionsEvent } from './useInteractionResponseController';
export function useChatAppState(options?: ChatAppStateOptions): ChatAppState {
  const { user, identity } = useAuth();
  // 授权模式对所有用户生效（2026-07-02 起），用户在账户设置中自行切换。
  // TASK-256：统一走三档 tier（与服务端 ?? true 默认一致），低风险档向活跃 run 发送 lowRiskOnly。
  const approvalTier = resolveApprovalTier(user?.preferences);
  // 从 URL 解析初始状态（仅执行一次）
  const [urlState] = useState(() => parseUrl());

  // ---- Agent Profile ----
  const [agentProfile, setAgentProfile] = useState<AgentProfile | null>(null);
  useEffect(() => {
    if (!user) { setAgentProfile(null); return; }
    fetchAgentProfile(user.username)
      .then(setAgentProfile)
      .catch(() => setAgentProfile(null));
  }, [user]);

  // ---- Session Participants ----
  const [sessionParticipants, setSessionParticipants] = useState<SessionParticipants | null>(null);

  // ---- File preview ----
  const [previewFilePath, setPreviewFilePath] = useState<string | null>(null);
  const [explicitPreviewOwner, setExplicitPreviewOwner] = useState<string | undefined>(undefined);
  const [previewMode, setPreviewMode] = useState<"dialog" | "side">("dialog");
  const openFilePreview = useCallback((path: string, owner?: string, options?: { mode?: "dialog" | "side" }) => {
    setPreviewFilePath(path);
    setExplicitPreviewOwner(owner);
    // md/PDF 附件卡默认走 "side"（右侧面板），让用户可以边预览边继续对话；
    // FileBrowser、代码块内联路径等调用点保持默认 "dialog" 弹窗行为。
    setPreviewMode(options?.mode ?? "dialog");
  }, []);
  const dockFilePreview = useCallback(() => {
    setPreviewMode("side");
  }, []);
  const expandFilePreview = useCallback(() => {
    setPreviewMode("dialog");
  }, []);
  const closeFilePreview = useCallback(() => {
    setPreviewFilePath(null);
    setExplicitPreviewOwner(undefined);
    setPreviewMode("dialog");
  }, []);

  // ---- File browser ----
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const toggleFileBrowser = useCallback(() => setFileBrowserOpen(v => !v), []);
  const closeFileBrowser = useCallback(() => setFileBrowserOpen(false), []);

  // ---- Trash preview (admin only) ----
  const [trashPreviewSessionId, setTrashPreviewSessionId] = useState<string | null>(null);
  const isTrashPreview = trashPreviewSessionId !== null;

  // ---- Input state（按用户 + 会话保存浏览器本地草稿）----
  const initialComposerScope = getComposerDraftScope(identity, urlState.sessionId);
  const composerScopeRef = useRef(initialComposerScope);
  const [input, setInputRaw] = useState(() => loadComposerText(initialComposerScope, true));
  const draftTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const setInput = useCallback((value: string) => {
    setInputRaw(value);
    clearTimeout(draftTimerRef.current);
    const scope = composerScopeRef.current;
    if (value) {
      draftTimerRef.current = setTimeout(() => saveComposerText(scope, value), 500);
    } else {
      saveComposerText(scope, "");
    }
  }, []);

  // ---- Loading / stream control ----
  const [loading, setLoading] = useState(false);
  const [stopping, setStopping] = useState(false);

  const { notifications, dismissNotification, pushNotification,
    lastMemoryRecall, dismissMemoryRecall, showMemoryRecall, pluginInstallStatus,
    showPluginInstallStatus, resetChatNotifications } = useChatNotificationState();

  const [activeTab, setActiveTabRaw] = useState<AppTab>(urlState.tab);
  const [governanceRouteState, setGovernanceRouteRaw] = useState<GovernanceRouteState | null>(urlState.governanceRoute);
  const [platformAdminSection, setPlatformAdminSectionRaw] = useState<PlatformAdminSection>(urlState.adminSection ?? 'overview');
  const [platformAdminEntityId, setPlatformAdminEntityIdRaw] = useState<string | null>(urlState.adminEntityId);
  const [tenantAdminSection, setTenantAdminSectionRaw] = useState<TenantAdminSection>(urlState.tenantAdminSection ?? 'overview');
  const [pendingCanonicalPath, setPendingCanonicalPath] = useState<string | null>(urlState.canonicalPath);
  const [settingsOpen, setSettingsOpen] = useState(() => urlState.settingsSection !== null);
  const [settingsSection, setSettingsSectionRaw] = useState<CanonicalSettingsSectionId>(urlState.settingsSection ?? 'account-security');
  const [adminSettings, setAdminSettingsRaw] = useState<AdminSettingsState | null>(() => urlState.adminSettings);
  const activeTabRef = useRef<AppTab>(activeTab);
  activeTabRef.current = activeTab;
  const governanceRouteRef = useRef<GovernanceRouteState | null>(governanceRouteState);
  governanceRouteRef.current = governanceRouteState;
  const platformAdminRouteRef = useRef<{ section: PlatformAdminSection; entityId: string | null }>({
    section: platformAdminSection,
    entityId: platformAdminEntityId,
  });
  platformAdminRouteRef.current = { section: platformAdminSection, entityId: platformAdminEntityId };
  const tenantAdminSectionRef = useRef<TenantAdminSection>(tenantAdminSection);
  tenantAdminSectionRef.current = tenantAdminSection;
  const adminSettingsRef = useRef<AdminSettingsState | null>(adminSettings);
  adminSettingsRef.current = adminSettings;
  const streamNonceRef = useRef(0);
  const streamIdRef = useRef<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const handledTerminalKeysRef = useRef(new Set<string>());
  const resolvedInteractionIdsRef = useRef(new Set<string>());
  const interactionRuntimeSyncRef = useRef<(sessionId: string) => void>(() => {});
  const lastEventIdRef = useRef<number | null>(null);
  const lastEventCursorRef = useRef<string | null>(null);

  /**
   * Per-session 运行态快照（架构升级,2026-06-25）。
   *
   * 替代单一全局 ref 模型（streamIdRef/runIdRef/lastEventIdRef/lastEventCursorRef/wsAttachedRef/loadingRef）,
   * 让"切走会话 → 切回会话"链路不再丢状态。原模型在 detachFromStream 时清光全部 ref,
   * 切回后只能靠 HTTP /stream-status 二次判活;原 stream-status 又只看 EventBuffer
   * (buffer 一丢即误报 inactive),同时全局 handler 直接吞掉 active_stream 事件。
   * 最终症状：切会话后看不到积压消息、停止按钮消失、必须刷新页面才能恢复。
   *
   * 新模型：activeRunsBySession 是 per-session 持久状态(单 hook 实例内存),
   * 全局 ref 退化为"当前选中会话的 active 镜像"。事件 reducer 总是写 Map,
   * 当 sessionId 匹配当前会话才 sync 到 ref;切走时 dump ref 到 Map,切回时 load Map 到 ref。
   */
  const activeRunsBySession = useRef<Map<string, SessionRuntime>>(new Map());
  /** 每次实时 runtime 事件递增；批量 HTTP 快照不得覆盖请求发出后的新事件。 */
  const runtimeVersionBySessionRef = useRef<Map<string, number>>(new Map());
  const [runningSessionIds, setRunningSessionIds] = useState<ReadonlySet<string>>(() => new Set());
  const [sessionRuntimeStatuses, setSessionRuntimeStatuses] = useState<ReadonlyMap<string, SessionRuntimeStatus>>(() => new Map());

  // ─── 消息可靠性：outbox 队列 + ACK 超时跟踪（2026-04-18）───
  /**
   * Outbox：用户已提交但尚未到达"服务端已处理"终态的消息队列。
   * - sending: 已 ensureConnectedSend，等 ACK
   * - acked: 收到 chat_ack，等 done
   * 替代旧的 pendingMessageRef 单槽设计：旧设计在用户快速连发时会静默覆盖。
   * 2026-08-04 终态设计删除本地 'queued' 双轨：运行中发送一律直发服务端做 durable
   * steering（进队列区），不再本地扣留等 done 后 flush——两套排队语义并存造成
   * 后发先至、气泡串号（P2-10）与停止丢消息（P2-5）。
   */
  const outboxRef = useRef<OutboxEntry[]>([]);
  /** 首条新会话消息确认 session 前阻止后续发送；客户端绝不排队或自动派发下一条。 */
  /** 每个 inflight 消息的 ACK 超时定时器（收到 ack 清除） */
  const ackTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const messageSubmissionGateRef = useRef(false);
  const ACK_TIMEOUT_MS = 15_000;
  /** cancel_queued 请求的等待器：sourceRunId → resolve(ok)（2026-08-04 终态设计） */
  const cancelWaitersRef = useRef<Map<string, (ok: boolean) => void>>(new Map());

  // ─── 插话队列区（2026-08-04 终态设计）───
  const queuedSessionIdRef = useRef<string | null>(urlState.sessionId);
  // 运行中发送的消息不进时间线，在输入框上方的队列区排队，被目标 run 消费
  //（user_message 投影）或回退接管（非 queued stream_id）时才进时间线。
  const [queuedInterjections, setQueuedInterjectionsState] = useState<QueuedInterjection[]>([]);
  // M40-01: Web consumes the same cross-platform authority reducer as Mobile. Local state is
  // limited to unacknowledged transport intents; no queue/runtime dispatch policy lives here.
  const chatClientStateRef = useRef(createChatClientState(identity));
  const applyAuthoritativeQueueEvent = useCallback((sessionId: string, event: ChatQueueReducerEvent) => {
    chatClientStateRef.current = reduceChatClientState(chatClientStateRef.current, {
      type: 'queue', sessionId, event, generation: chatClientStateRef.current.generation,
    });
    return selectChatClientQueue(chatClientStateRef.current, sessionId);
  }, []);
  const applyAuthoritativeWsEvent = useCallback((event: WsEvent, fallbackSessionId?: string) => {
    chatClientStateRef.current = reduceChatClientState(chatClientStateRef.current, {
      type: 'ws', event, fallbackSessionId, generation: chatClientStateRef.current.generation,
    });
    const eventSessionId = event.type === 'queue_snapshot' ? event.snapshot.sessionId
      : event.type === 'queue_item_updated' ? event.item.sessionId
        : ('sessionId' in event && typeof event.sessionId === 'string' ? event.sessionId : fallbackSessionId);
    return selectChatClientQueue(chatClientStateRef.current, eventSessionId);
  }, []);
  useEffect(() => {
    chatClientStateRef.current = reduceChatClientState(chatClientStateRef.current, { type: 'identity_boundary', identity });
  }, [identity]);
  const queuedInterjectionsRef = useRef<QueuedInterjection[]>([]);
  const consumedInterjectionsRef = useRef(new InterjectionConsumptionRegistry());
  const mutateQueuedInterjections = useCallback(
    (updater: (prev: QueuedInterjection[]) => QueuedInterjection[]) => {
      const next = updater(queuedInterjectionsRef.current);
      queuedInterjectionsRef.current = next;
      const currentSessionId = queuedSessionIdRef.current;
      setQueuedInterjectionsState(next.filter((entry) => (
        currentSessionId ? entry.sessionId === currentSessionId : !entry.sessionId
      )));
    },
    [],
  );
  const projectAuthoritativeQueue = useCallback((state: ChatQueueState) => {
    const authoritativeItems = selectChatQueueItems(state);
    // Any ACK/snapshot item immediately replaces the matching local intent. Transport bookkeeping
    // cannot remain a second queue truth source or hold the update/reload guard indefinitely.
    for (const item of authoritativeItems) {
      const timer = ackTimersRef.current.get(item.clientMsgId);
      if (timer) { clearTimeout(timer); ackTimersRef.current.delete(item.clientMsgId); }
      outboxRef.current = outboxRef.current.filter((entry) => entry.clientMsgId !== item.clientMsgId);
      newSessionClientMsgIdsRef.current.delete(item.clientMsgId);
    }
    mutateQueuedInterjections((previous) => projectAuthoritativeInterjections(
      authoritativeItems, previous, consumedInterjectionsRef.current,
    ));
  }, [mutateQueuedInterjections]);
  // Detail 快照与消费标记的对账保持稳定引用，供 session callbacks 复用。
  const reconcileServerInterjections = useCallback(
    (sessionId: string, serverQueued: NonNullable<ApiSessionDetail["queuedMessages"]>) => {
      mutateQueuedInterjections((prev) => [
        ...prev.filter((entry) => entry.sessionId && entry.sessionId !== sessionId),
        ...reconcileQueuedInterjections(
          prev.filter((entry) => !entry.sessionId || entry.sessionId === sessionId),
          serverQueued,
          consumedInterjectionsRef.current,
          sessionId,
        ),
      ]);
    },
    [mutateQueuedInterjections],
  );
  const voiceCallbackRef = useRef(options?.onVoiceEvent);
  voiceCallbackRef.current = options?.onVoiceEvent;
  // ---- Model selection (with retry on WS reconnect) ----
  const [modelList, setModelList] = useState<ModelList | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [autoApproveRunShell, setAutoApproveRunShellState] = useState(false);
  // full / low-risk 档本身已自动批准工具；ask 档由会话级开关决定。
  const effectiveAutoApproveRunShell = approvalTier !== "ask" || autoApproveRunShell;
  const modelListRef = useRef(modelList);
  modelListRef.current = modelList;
  const fetchModelList = useCallback(() => {
    authFetch("/api/models")
      .then((r) => {
        if (r.ok) return r.json();
        return null;
      })
      .then((data: ModelList | null) => {
        if (data) {
          setModelList(data);
          setSelectedModel((prev) => sessionIdRef.current ? (prev || data.default) : data.default);
        }
      })
      .catch(() => { });
  }, []);
  useEffect(() => {
    fetchModelList();
  }, [fetchModelList]);
  useEffect(() => {
    const handleDefaultModelChanged = () => { fetchModelList(); };
    window.addEventListener("agent:default-model-changed", handleDefaultModelChanged);
    return () => window.removeEventListener("agent:default-model-changed", handleDefaultModelChanged);
  }, [fetchModelList]);
  useEffect(() => {
    registerRefresh("models", async () => { fetchModelList(); });
    return () => unregisterRefresh("models");
  }, [fetchModelList]);

  // ---- Sub-hooks ----
  const msg = useMessages();
  const uploadSessionIdRef = useRef<string | null>(urlState.sessionId); const getUploadSessionId = useCallback(() => uploadSessionIdRef.current, []);
  const { connectionState, dispatchConnection } = useConnectionState();
  const fileUpload = useFileUpload(activeTab, getUploadSessionId, {
    online: connectionState !== 'disconnected',
    identityKey: identity ? `${identity.tenantId}:${identity.userId}:${identity.generation}` : 'anonymous',
  });

  // ---- Refs for unstable values ----
  const inputRef = useRef(input); inputRef.current = input;
  const loadingRef = useRef(loading);
  const stoppingRef = useRef(stopping); stoppingRef.current = stopping;
  const uploadedFilesRef = useRef(fileUpload.uploadedFiles); uploadedFilesRef.current = fileUpload.uploadedFiles;
  const uploadingRef = useRef(fileUpload.uploading); uploadingRef.current = fileUpload.uploading;
  const selectedModelRef = useRef(selectedModel); selectedModelRef.current = selectedModel;
  const autoApproveRunShellRef = useRef(effectiveAutoApproveRunShell); autoApproveRunShellRef.current = effectiveAutoApproveRunShell;
  const approvalTierRef = useRef(approvalTier); approvalTierRef.current = approvalTier;
  const msgRef = useRef(msg); msgRef.current = msg;
  const sessionIdRef = useRef<string | null>(null);
  // 同步更新的 sessionId ref（解决 React 批量更新时 sessionIdRef 延迟问题）
  const immediateSessionIdRef = useRef<string | null>(urlState.sessionId);
  const getCurrentSessionId = useCallback(() => immediateSessionIdRef.current ?? sessionIdRef.current, []);
  const currentRuntimeSessionId = immediateSessionIdRef.current ?? sessionIdRef.current;
  const effectiveLoading = loading || Boolean(currentRuntimeSessionId && runningSessionIds.has(currentRuntimeSessionId)); loadingRef.current = effectiveLoading;
  const effectiveRunningSessionIds = effectiveLoading && currentRuntimeSessionId && !runningSessionIds.has(currentRuntimeSessionId) ? new Set(runningSessionIds).add(currentRuntimeSessionId) : runningSessionIds;
  const effectiveSessionRuntimeStatuses = effectiveLoading && currentRuntimeSessionId && !sessionRuntimeStatuses.has(currentRuntimeSessionId) ? new Map(sessionRuntimeStatuses).set(currentRuntimeSessionId, 'running') : sessionRuntimeStatuses;
  const { sandboxProfile, sandboxProfileRef, setSandboxProfile, startNewSandboxProfile, hydrateSandboxProfile } = useSandboxProfile(immediateSessionIdRef, sessionIdRef, loadingRef, urlState.sessionId ? "coding" : "daily");
  const trashPreviewSessionIdRef = useRef<string | null>(trashPreviewSessionId);
  trashPreviewSessionIdRef.current = trashPreviewSessionId;
  const refreshTokenUsageRef = useRef<() => void>(() => { });
  const loadSessionDetailRef = useRef<(id: string) => Promise<void>>(async () => { });
  // ---- SW 更新协作（lib/swUpdate.ts）----
  // 上传/outbox/当前会话 active 时不强刷；后台 run 不阻塞更新，回来后继续 resume。
  useEffect(() => {
    const unregisterGuard = registerUpdateGuard(() => {
      if (uploadingRef.current) return true;
      if (outboxRef.current.length > 0) return true;
      // 草稿会话首条消息在途时 sessionId 仍为 null，靠 loading 兜住。
      if (loadingRef.current) return true;
      const currentSessionId = immediateSessionIdRef.current ?? sessionIdRef.current;
      if (!currentSessionId) return false;
      return isActiveRuntimeStatus(activeRunsBySession.current.get(currentSessionId)?.status);
    });
    // 刷新前同步 flush 当前会话草稿：debounce 窗口内的输入不丢
    const unregisterHook = registerBeforeReloadHook(() => {
      clearTimeout(draftTimerRef.current);
      saveComposerText(composerScopeRef.current, inputRef.current);
    });
    return () => {
      unregisterGuard();
      unregisterHook();
    };
  }, []);

  // ---- WS event processing state ----
  const wsBlockRef = useRef<WsBlockState>({ currentBlockIndex: -1, currentBlockType: null });
  const wsLatestSessionIdRef = useRef<{ value: string | null }>(null!);
  const wsUserMsgIndexRef = useRef(-1);
  /** 是否已挂载到某个流（detach 后为 false，发起/订阅流时为 true） */
  const wsAttachedRef = useRef(false);
  /** 新会话首条消息与服务端 session 事件的关联键；切换草稿后迟到事件不得接管当前页面。 */
  const pendingNewSessionClientMsgIdRef = useRef<string | null>(null);
  /** 标记所有尚未收到 session 事件的新会话消息；即使浏览器导航清掉当前草稿，也能识别迟到事件。 */
  const newSessionClientMsgIdsRef = useRef<Set<string>>(new Set());
  /** 记录其他连接发起的流，等 idle 到达时标为 AI 回复未读 */
  const trackedAiReplyStreamsRef = useRef<Set<string>>(new Set());
  /** 引用 sendChatViaWs（定义在下面），用于在它之前定义的 callback 中 flush 排队消息 */
  const submissionBelongsToCurrentSession = useCallback((entry: OutboxEntry, authoritativeSessionId?: string) => {
    const currentSessionId = immediateSessionIdRef.current ?? sessionIdRef.current;
    const expectedSessionId = authoritativeSessionId ?? entry.sessionId;
    if (expectedSessionId) return currentSessionId === expectedSessionId;
    return !currentSessionId && pendingNewSessionClientMsgIdRef.current === entry.clientMsgId;
  }, []);
  const confirmAuthoritativeSession = useCallback((clientMsgId: string, authoritativeSessionId: string) => {
    const currentSessionId = immediateSessionIdRef.current ?? sessionIdRef.current;
    if (currentSessionId && currentSessionId !== authoritativeSessionId) return;
    if (!currentSessionId && pendingNewSessionClientMsgIdRef.current !== clientMsgId) return;
    immediateSessionIdRef.current = authoritativeSessionId;
    queuedSessionIdRef.current = authoritativeSessionId;
    replaceUrl('chat', authoritativeSessionId);
    pendingNewSessionClientMsgIdRef.current = null;
    newSessionClientMsgIdsRef.current.delete(clientMsgId);
    outboxRef.current = outboxRef.current.map((entry) => entry.clientMsgId === clientMsgId
      ? { ...entry, sessionId: authoritativeSessionId }
      : entry);
  }, []);
  const reconcileLastRunStateRef = useRef<(sessionId: string, lastRunState: LastRunState) => void>(() => {});

  /** Partial patch Map.get(sid)；若 sid === current,同步 ref（不动 setState 状态） */
  const patchSessionRuntime = useCallback((sid: string, patch: SessionRuntimePatch, opts?: { silent?: boolean }) => {
    // silent：dump 类 ref->Map 同步不是 run 生命周期变化，不递增 version（TASK-312：否则切换会话会让在途终态探活误判失效）。
    if (!opts?.silent) runtimeVersionBySessionRef.current.set(sid, (runtimeVersionBySessionRef.current.get(sid) ?? 0) + 1);
    const existing = activeRunsBySession.current.get(sid) ?? { status: 'idle' as const, attached: false };
    const next: SessionRuntime = { ...existing };
    if (patch.status !== undefined) next.status = patch.status; if (patch.source !== undefined) next.source = patch.source;
    if (patch.attached !== undefined) next.attached = patch.attached;
    if (patch.streamId !== undefined) {
      if (patch.streamId === null) delete next.streamId;
      else next.streamId = patch.streamId;
    }
    if (patch.runId !== undefined) {
      if (patch.runId === null) delete next.runId;
      else next.runId = patch.runId;
    }
    if (patch.lastEventId !== undefined) {
      if (patch.lastEventId === null) delete next.lastEventId;
      else next.lastEventId = patch.lastEventId;
    }
    if (patch.lastEventCursor !== undefined) {
      if (patch.lastEventCursor === null) delete next.lastEventCursor;
      else next.lastEventCursor = patch.lastEventCursor;
    }
    activeRunsBySession.current.set(sid, next);
    setRunningSessionIds((current) => {
      const isRunning = isActiveRuntimeStatus(next.status);
      if (current.has(sid) === isRunning) return current;
      const updated = new Set(current);
      if (isRunning) updated.add(sid);
      else updated.delete(sid);
      return updated;
    });
    setSessionRuntimeStatuses((current) => {
      const activeStatus = isActiveRuntimeStatus(next.status)
        ? next.status as SessionRuntimeStatus
        : null;
      if (activeStatus ? current.get(sid) === activeStatus : !current.has(sid)) return current;
      const updated = new Map(current);
      if (activeStatus) updated.set(sid, activeStatus);
      else updated.delete(sid);
      return updated;
    });
    // immediateSessionIdRef 在点击切换时同步更新，是当前会话的权威值。
    // sessionIdRef 要等 React 提交；同帧迟到的旧会话 active_stream 不能借它污染全局 refs。
    if (sid === immediateSessionIdRef.current) {
      if (patch.streamId !== undefined) streamIdRef.current = patch.streamId;
      if (patch.runId !== undefined) runIdRef.current = patch.runId;
      if (patch.lastEventId !== undefined) lastEventIdRef.current = patch.lastEventId;
      if (patch.lastEventCursor !== undefined) lastEventCursorRef.current = patch.lastEventCursor;
      if (patch.attached !== undefined) wsAttachedRef.current = patch.attached;
    }
    return next;
  }, []);

  const runtimeHydrationNonceRef = useRef(0);
  const hydrateSessionRuntimeSnapshot = useCallback(async (sessions: ApiSessionListItem[]) => {
    const nonce = ++runtimeHydrationNonceRef.current;
    const sessionIds = [...new Set(sessions.map((item) => item.sessionId).filter(Boolean))];
    const requestedVersions = new Map(
      sessionIds.map((sessionId) => [sessionId, runtimeVersionBySessionRef.current.get(sessionId) ?? 0]),
    );
    if (sessionIds.length === 0) { setRunningSessionIds(new Set()); setSessionRuntimeStatuses(new Map()); return; }
    try {
      const batches: string[][] = [];
      for (let offset = 0; offset < sessionIds.length; offset += 100) {
        batches.push(sessionIds.slice(offset, offset + 100));
      }
      const responses = await Promise.all(batches.map(async (batch) => {
        const response = await authFetch('/api/sessions/active-streams', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionIds: batch }),
        });
        if (!response.ok) throw new Error(`active-streams ${response.status}`);
        return response.json() as Promise<{
          sessions?: Array<{ sessionId: string; active: boolean; streamId?: string; runId?: string; status?: string }>;
        }>;
      }));
      if (runtimeHydrationNonceRef.current !== nonce) return;

      const snapshotStatus = new Map<string, boolean>();
      const snapshotRuntimeStatuses = new Map<string, SessionRuntimeStatus>();
      for (const data of responses) {
        for (const item of data.sessions ?? []) {
          if ((runtimeVersionBySessionRef.current.get(item.sessionId) ?? 0) !== requestedVersions.get(item.sessionId)) {
            continue;
          }
          snapshotStatus.set(item.sessionId, item.active);
          if (!item.active) {
            const existing = activeRunsBySession.current.get(item.sessionId);
            // 快照滞后时，不得清掉 WS 已确认但尚未收到终态的会话。
            if (existing?.source === 'ws' && isActiveRuntimeStatus(existing.status)) {
              snapshotStatus.set(item.sessionId, true); snapshotRuntimeStatuses.set(item.sessionId, existing.status as SessionRuntimeStatus); continue;
            }
            if (existing?.lastEventCursor) {
              activeRunsBySession.current.set(item.sessionId, {
                status: 'idle',
                lastEventCursor: existing.lastEventCursor,
                attached: false,
              });
            } else {
              activeRunsBySession.current.delete(item.sessionId);
            }
            continue;
          }
          const existing = activeRunsBySession.current.get(item.sessionId);
          const runtimeStatus = isActiveRuntimeStatus(item.status)
            ? item.status as SessionRuntimeStatus
            : 'running';
          snapshotRuntimeStatuses.set(item.sessionId, runtimeStatus);
          activeRunsBySession.current.set(item.sessionId, {
            ...(existing ?? { attached: false }),
            status: runtimeStatus, source: existing?.source === 'ws' && (!item.runId || !existing.runId || item.runId === existing.runId) && (!item.streamId || !existing.streamId || item.streamId === existing.streamId) ? 'ws' : 'snapshot',
            streamId: item.streamId ?? existing?.streamId,
            runId: item.runId ?? existing?.runId,
            attached: existing?.attached ?? false,
          });
        }
      }
      setRunningSessionIds((current) => {
        const next = new Set(current);
        for (const [sessionId, active] of snapshotStatus) {
          if (active) next.add(sessionId);
          else next.delete(sessionId);
        }
        return next;
      });
      setSessionRuntimeStatuses((current) => {
        const next = new Map(current);
        for (const [sessionId, active] of snapshotStatus) {
          if (active) next.set(sessionId, snapshotRuntimeStatuses.get(sessionId) ?? 'running');
          else next.delete(sessionId);
        }
        return next;
      });
    } catch {
      // 会话列表仍可正常展示；WS session_status 与当前会话探活继续兜底。
    }
  }, []);

  /** 用户点击"停止"按钮：发送 abort，等 done 到达后才恢复 UI */
  const cancelActiveStream = useCallback(() => {
    const targetSessionId = sessionIdRef.current;
    const sid = streamIdRef.current;
    const rid = runIdRef.current;
    if ((!sid && !rid) || stoppingRef.current) return;
    stoppingRef.current = true;
    void wsClient.ensureConnectedSend({ action: 'abort', ...(rid ? { runId: rid } : {}), ...(sid ? { streamId: sid } : {}) });
    setStopping(true);
    // 服务端 stop 只撤销 steering_inputs；普通 queue 仍会在当前 run 终态后串行执行。
    // steer 乐观撤销，最终以 steering_cancelled/detail 快照为准。
    mutateQueuedInterjections(markSteeringCancelledForStop);

    const nonceAtAbort = streamNonceRef.current;
    setTimeout(() => {
      const existingRuntime = targetSessionId ? activeRunsBySession.current.get(targetSessionId) : undefined;
      const shouldClearRuntime = Boolean(
        targetSessionId
        && (!existingRuntime || isActiveRuntimeStatus(existingRuntime.status))
        && (
          !existingRuntime
          || ((!rid || existingRuntime.runId === rid) && (!sid || existingRuntime.streamId === sid))
        ),
      );
      if (shouldClearRuntime && targetSessionId) {
        patchSessionRuntime(targetSessionId, {
          status: 'cancelled',
          streamId: null,
          runId: null,
          lastEventId: null,
          attached: false,
        });
      }
      if (streamNonceRef.current === nonceAtAbort && (!sid || streamIdRef.current === sid) && (!rid || runIdRef.current === rid)) {
        streamIdRef.current = null;
        runIdRef.current = null;
        streamNonceRef.current += 1;
        lastEventIdRef.current = null;
        finalizeRunningSubagents(msgRef.current);
        removeRuntimeStatusMessages(msgRef.current);
        setLoading(false);
        setStopping(false);
      }
    }, 10_000);
  }, [patchSessionRuntime, mutateQueuedInterjections]);

  /** 把当前 ref（current session 的运行态镜像）dump 进 Map,保留 cursor 等持久字段 */
  const dumpCurrentSessionRuntime = useCallback(() => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const existing = activeRunsBySession.current.get(sid);
    // status 字段：只优先保留 Map 已有的 active 状态（如 running/waiting_*),
    // 否则按 loadingRef 推断（loadingRef=true → running,false → idle）。
    // 这样 dump 不会盲目把"我在跑"覆盖成 idle,也不会把 completed/failed/cancelled 等终态当 active 保护。
    const inferredStatus: SessionRuntime['status'] =
      existing?.status && isActiveRuntimeStatus(existing.status)
        ? existing.status
        : (loadingRef.current ? 'running' : 'idle');
    // silent：dump 保留 Map 已有 active binding 字段（streamId/runId/cursor），不重置、不递增 version。
    patchSessionRuntime(sid, {
      status: inferredStatus,
      streamId: streamIdRef.current,
      runId: runIdRef.current,
      lastEventId: lastEventIdRef.current,
      lastEventCursor: lastEventCursorRef.current,
      attached: wsAttachedRef.current,
    }, { silent: true });
  }, [patchSessionRuntime]);

  /** 从 Map 加载 sid 的 runtime 到当前 ref（不调 setState,UI 由调用方决定） */
  const loadSessionRuntimeToRef = useCallback((sid: string): SessionRuntime | undefined => {
    const cached = activeRunsBySession.current.get(sid);
    streamIdRef.current = cached?.streamId ?? null;
    runIdRef.current = cached?.runId ?? null;
    lastEventIdRef.current = cached?.lastEventId ?? null;
    lastEventCursorRef.current = cached?.lastEventCursor ?? null;
    return cached;
  }, []);

  /**
   * 会话切换时：立即清理本地 ref 状态，不发 abort（避免误终止其他设备的流）。
   *
   * ⚠️ 关键变更（2026-06-25）：先 dump 当前 ref 到 Map,保留 streamId/runId/cursor 等
   * 持久化字段。原实现清光所有 ref 是切会话丢状态的根因之一——切回时只能靠 HTTP
   * /stream-status + skipReplay:true 兜底，导致积压消息丢、停止按钮消失、必须刷新页面。
   */
  const detachFromStream = useCallback(() => {
    dumpCurrentSessionRuntime();
    streamIdRef.current = null;
    runIdRef.current = null;
    streamNonceRef.current += 1;
    lastEventIdRef.current = null;
    lastEventCursorRef.current = null;
    wsBlockRef.current = { currentBlockIndex: -1, currentBlockType: null };
    wsLatestSessionIdRef.current = { value: null };
    wsUserMsgIndexRef.current = -1;
    wsAttachedRef.current = false;
    finalizeRunningSubagents(msgRef.current);
    removeRuntimeStatusMessages(msgRef.current);
    setLoading(false);
    setStopping(false);
    // outbox/timer 属于 submission，不属于当前流。切会话后继续后台核验，队列状态按
    // sessionId 隔离存储。consumedInterjectionsRef 保留（TASK-70）：它是「已进入时间线」的
    // 全局消费事实，切回会话时旧 detail 快照不得把已发送的消息复活到队列区；clientMsgId
    // 全局唯一，跨会话保留不会误拦截真实仍在排队的新消息。服务端 buffer 仍保留，resume 时可用 cursor 增量回放。
    wsClient.send({ action: 'detach' });
  }, [dumpCurrentSessionRuntime]);

  const sessionCallbacks = useMemo(() => ({
    resetMessages: msg.resetMessages,
    setMessages: msg.setMessages,
    getMessages: () => msg.messagesRef.current,
    getResolvedInteractionIds: () => resolvedInteractionIdsRef.current,
    onInteractionsChanged: (sessionId: string) => interactionRuntimeSyncRef.current(sessionId),
    onSessionsLoaded: hydrateSessionRuntimeSnapshot,
    triggerScroll: msg.triggerScroll,
    cancelActiveStream: detachFromStream,
    onLastRunState: (sessionId: string, lastRunState: LastRunState) => {
      reconcileLastRunStateRef.current(sessionId, lastRunState);
    },
    // 队列区真源同步（2026-08-04 终态设计）：以服务端仍在排队的插话为基底重建；
    // 本地 sending（未 ACK）与 cancelled/failed（展示态）条目保留，其余以服务端为准。
    onQueueSnapshot: (sessionId: string, snapshot: ChatQueueSnapshot) => {
      const sid = immediateSessionIdRef.current ?? sessionIdRef.current;
      if (!sid || sessionId !== sid) return;
      projectAuthoritativeQueue(applyAuthoritativeQueueEvent(sessionId, { type: 'snapshot', snapshot }));
    },
    onQueuedMessages: (sessionId: string, serverQueued: NonNullable<ApiSessionDetail["queuedMessages"]>) => {
      const sid = immediateSessionIdRef.current ?? sessionIdRef.current;
      if (!sid || sessionId !== sid) return;
      reconcileServerInterjections(sessionId, serverQueued);
    }, onSandboxProfile: hydrateSandboxProfile, onSessionInvalidated: (id: string) => { const current = immediateSessionIdRef.current === id || sessionIdRef.current === id; if (immediateSessionIdRef.current === id) immediateSessionIdRef.current = null; if (sessionIdRef.current === id) sessionIdRef.current = null; if (queuedSessionIdRef.current === id) queuedSessionIdRef.current = null; if (wsLatestSessionIdRef.current?.value === id) wsLatestSessionIdRef.current = { value: null }; if (current) { mutateQueuedInterjections((prev) => prev); startNewSandboxProfile(); } }, onNewSession: startNewSandboxProfile,
  }), [msg.resetMessages, msg.setMessages, msg.messagesRef, msg.triggerScroll, detachFromStream, hydrateSessionRuntimeSnapshot, reconcileServerInterjections, projectAuthoritativeQueue, hydrateSandboxProfile, mutateQueuedInterjections, startNewSandboxProfile]);

  const session = useSession(sessionCallbacks, { initialSessionId: urlState.sessionId, identity });
  // Delegated contract: selectSessionUnread({ visible: visible, atBottom: msg.isNearBottomRef.current }).
  // The hook preserves `if (!unread.shouldMarkSeen) return;` before authenticated `/read`.
  const markSessionRead = useSessionReadTracking({
    session,
    messagesRef: msg.messagesRef,
    isNearBottomRef: msg.isNearBottomRef,
    immediateSessionIdRef,
    activeTabRef,
    trashPreviewSessionIdRef,
  });
  const sessionRef = useRef(session); sessionRef.current = session;
  const {
    releaseAllResponses: releaseAllInteractionResponses,
    resolveInteractionResponse, syncInteractionRuntime, finalizeInteractionProjection,
    handlePermissionResponse, handleAskUserResponse,
  } = useInteractionResponseController({
    messages: msg,
    currentSessionId: getCurrentSessionId,
    activeRunsBySession, patchSessionRuntime, handledTerminalKeysRef, resolvedInteractionIdsRef,
    interactionRuntimeSyncRef,
    loadSessions: () => { void sessionRef.current.loadSessions({ fresh: true, silent: true }); },
    markSessionRead,
  });
  const {
    streamBindingGenerationRef, advanceStreamBindingGenerationIfChanged,
    sendCorrelatedResume, invalidateResumeRequests, shouldApplyActiveStreamResponse,
  } = useChatStreamCorrelation({ streamIdRef, runIdRef, immediateSessionIdRef, wsAttachedRef, loadingRef, sessionRef });
  const attachmentsHydratedRef = useRef(false);
  const attachmentScopeRef = useRef<string | null>(null);
  const composerScopeInitializedRef = useRef(false);

  // 会话切换时先保存旧草稿，再恢复目标会话的文字和附件。
  useEffect(() => {
    const previousScope = composerScopeRef.current;
    clearTimeout(draftTimerRef.current);
    if (composerScopeInitializedRef.current) {
      saveComposerText(previousScope, inputRef.current);
      if (attachmentsHydratedRef.current && attachmentScopeRef.current === previousScope) {
        void saveComposerAttachments(previousScope, uploadedFilesRef.current);
      }
    } else {
      composerScopeInitializedRef.current = true;
    }

    const nextScope = getComposerDraftScope(identity, session.sessionId);
    composerScopeRef.current = nextScope;
    attachmentsHydratedRef.current = false;
    attachmentScopeRef.current = null;
    setInputRaw(loadComposerText(nextScope));
    fileUpload.replaceFiles([]);

    let cancelled = false;
    void loadComposerAttachments(nextScope).then((files) => {
      if (!cancelled && composerScopeRef.current === nextScope) {
        attachmentScopeRef.current = nextScope;
        attachmentsHydratedRef.current = true;
        fileUpload.replaceFiles(files);
      }
    });
    return () => { cancelled = true; };
  }, [session.sessionId, user?.id, fileUpload.replaceFiles]);

  useEffect(() => {
    const scope = composerScopeRef.current;
    if (!attachmentsHydratedRef.current || attachmentScopeRef.current !== scope) return;
    void saveComposerAttachments(scope, fileUpload.uploadedFiles);
  }, [fileUpload.uploadedFiles]);

  const previewFileOwner = useMemo(() => {
    if (explicitPreviewOwner) return explicitPreviewOwner;
    if (!session.sessionId) return undefined;
    return session.sessions.find(s => s.sessionId === session.sessionId)?.owner?.username;
  }, [explicitPreviewOwner, session.sessionId, session.sessions]);
  const sessionOwnerRef = useRef(previewFileOwner); sessionOwnerRef.current = previewFileOwner;

  // ---- sessionParticipants: 监听 sessionOwner 变化，加载对应 Agent Profile ----
  useEffect(() => {
    const owner = session.sessionOwner;
    if (!owner || owner.username === user?.username) {
      setSessionParticipants(null);
      return;
    }
    // 立即设置 owner 信息（头像/名字可用），agent 异步加载后补充
    setSessionParticipants({ owner, agent: null });
    let cancelled = false;
    fetchAgentProfile(owner.username)
      .then(agent => {
        if (!cancelled) setSessionParticipants({ owner, agent });
      })
      .catch(() => {
        // agent 已为 null，无需额外处理
      });
    return () => { cancelled = true; };
  }, [session.sessionOwner, user?.username]);

  sessionIdRef.current = session.sessionId; uploadSessionIdRef.current = immediateSessionIdRef.current ?? session.sessionId;
  refreshTokenUsageRef.current = session.refreshTokenUsage; loadSessionDetailRef.current = session.loadSessionDetail;

  useEffect(() => {
    if (activeTab === 'chat' && session.sessionId && !trashPreviewSessionId) {
      markSessionRead(session.sessionId);
    }
  }, [activeTab, msg.messages, session.sessionId, trashPreviewSessionId, markSessionRead]);

  useEffect(() => {
    const attempt = () => markSessionRead(sessionIdRef.current);
    const container = msg.scrollContainerRef.current;
    container?.addEventListener('scroll', attempt, { passive: true });
    document.addEventListener('visibilitychange', attempt);
    return () => {
      container?.removeEventListener('scroll', attempt);
      document.removeEventListener('visibilitychange', attempt);
    };
  }, [markSessionRead, msg.scrollContainerRef, session.sessionId]);

  // 切换会话时清理 SDK 新 state，避免跨会话串扰
  // - notifications 是 user scope（跨会话保留？业务含义说是 REPL 级，切会话应该清）
  // - lastMemoryRecall / pluginInstallStatus 是 session scope，必须清
  useEffect(() => {
    resetChatNotifications();
  }, [session.sessionId, resetChatNotifications]);

  const handleModelChange = useCallback((ref: string) => {
    setSelectedModel(ref);
    if (session.sessionId) {
      localStorage.setItem(`agentChat.model.${session.sessionId}`, ref);
    }
  }, [session.sessionId]);

  // TASK-256：三档策略向活跃 run 的传播（含 lowRiskOnly 语义）抽出为 useApprovalTierRunPolicy。
  const { setAutoApproveRunShell } = useApprovalTierRunPolicy({
    approvalTier, sessionIdRef, activeRunsBySession, setAutoApproveRunShellState,
  });

  const prevSessionIdForShellApprovalRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const prev = prevSessionIdForShellApprovalRef.current;
    prevSessionIdForShellApprovalRef.current = session.sessionId;
    if (prev === session.sessionId) return;

    if (!session.sessionId) {
      setAutoApproveRunShellState(false);
      return;
    }

    if (approvalTier !== "ask") {
      setAutoApproveRunShellState(true);
      return;
    }

    const stored = localStorage.getItem(runShellApprovalStorageKey(session.sessionId));
    if (stored !== null) {
      setAutoApproveRunShellState(stored === 'true');
      return;
    }

    setAutoApproveRunShellState((current) => {
      const carryNewSessionChoice = prev === null && current;
      if (carryNewSessionChoice) {
        localStorage.setItem(runShellApprovalStorageKey(session.sessionId!), 'true');
      }
      return carryNewSessionChoice;
    });
  }, [approvalTier, session.sessionId]);

  // ---- URL 路由同步 ----
  const TAB_LABELS: Partial<Record<AppTab, string>> = {
    cron: '任务中心', files: '文件管理', scenarios: '任务模板', capabilities: '能力中心',
  };
  const setActiveTab = useCallback((tab: AppTab) => {
    setSettingsOpen(false);
    setAdminSettingsRaw(null);
    setActiveTabRaw(tab);
    if (tab === 'platform-admin') {
      const next = governanceRoute('platform.overview.overview');
      setGovernanceRouteRaw(next);
      setPlatformAdminSectionRaw('overview');
      setPlatformAdminEntityIdRaw(null);
      replaceGovernanceUrl(next);
    } else if (tab === 'tenant-admin') {
      const current = governanceRouteRef.current?.area === 'organization' ? governanceRouteRef.current : null;
      const next = current ?? governanceRoute('organization.overview.overview');
      setGovernanceRouteRaw(next);
      replaceGovernanceUrl(next);
    } else {
      setGovernanceRouteRaw(null);
      replaceUrl(tab, tab === 'chat' ? immediateSessionIdRef.current : null);
    }
    // 上报非 chat/profile 的 tab 切换（profile 由 AgentProfile 组件自行上报）
    const label = TAB_LABELS[tab];
    if (label) reportActivity('page_viewed', { detail: label });
  }, []);

  /** push 版本的 setActiveTab：用 pushState 创建历史记录，供 user menu 跳转使用（浏览器后退可回到原页面） */
  const pushActiveTab = useCallback((tab: AppTab) => {
    setSettingsOpen(false);
    setAdminSettingsRaw(null);
    setActiveTabRaw(tab);
    if (tab === 'platform-admin') {
      const next = governanceRoute('platform.overview.overview');
      setGovernanceRouteRaw(next);
      setPlatformAdminSectionRaw('overview');
      setPlatformAdminEntityIdRaw(null);
      pushGovernanceUrl(next);
    } else if (tab === 'tenant-admin') {
      const current = governanceRouteRef.current?.area === 'organization' ? governanceRouteRef.current : null;
      const next = current ?? governanceRoute('organization.overview.overview');
      setGovernanceRouteRaw(next);
      pushGovernanceUrl(next);
    } else {
      setGovernanceRouteRaw(null);
      pushUrl(tab, tab === 'chat' ? immediateSessionIdRef.current : null);
    }
    const label = TAB_LABELS[tab];
    if (label) reportActivity('page_viewed', { detail: label });
  }, []);

  const setPlatformAdminRoute = useCallback((section: PlatformAdminSection, entityId: string | null = null) => {
    setSettingsOpen(false);
    setAdminSettingsRaw(null);
    setActiveTabRaw('platform-admin');
    setPlatformAdminSectionRaw(section);
    setPlatformAdminEntityIdRaw(entityId);
    // 改造前这里丢弃整串 query：从 sessions 筛了某组织再点侧栏「执行记录」，组织筛选没了。
    // 现在按白名单透传作用域筛选（tenantId / userId）——section 私有筛选（kind/phase/cursor…）
    // 跨 section 无意义，仍然丢弃。
    pushPlatformAdminUrl({ section, entityId, search: preserveScopeSearch() });
  }, []);

  /** 切换组织分析页签：进路径 + push 历史（后退回上一个页签，而不是退出整个组织分析） */
  const setTenantAdminRoute = useCallback((section: string) => {
    const next = normalizeTenantAdminSection(section);
    setSettingsOpen(false);
    setAdminSettingsRaw(null);
    setActiveTabRaw('tenant-admin');
    setTenantAdminSectionRaw(next);
    // 切页签丢弃页内私有筛选，但带着组织作用域走
    pushTenantAdminUrl({ section: next, search: preserveSearchKeys(TENANT_ADMIN_SCOPE_KEYS) });
  }, []);

  const { openSettings, closeSettings, setSettingsSection } = usePersonalSettingsNavigation({
    getActiveTab: () => activeTabRef.current,
    getPlatformRoute: () => platformAdminRouteRef.current,
    getTenantSection: () => tenantAdminSectionRef.current,
    getSessionId: () => immediateSessionIdRef.current,
    openState: (section, route) => {
      setAdminSettingsRaw(null); setGovernanceRouteRaw(route); setSettingsOpen(true); setSettingsSectionRaw(section);
    },
    closeState: () => { setSettingsOpen(false); setGovernanceRouteRaw(null); },
  });

  const { openAdminSettings, closeAdminSettings, setAdminSettingsSection } = useAdminSettingsNavigation({
    getActiveTab: () => activeTabRef.current,
    getPlatformRoute: () => platformAdminRouteRef.current,
    getTenantSection: () => tenantAdminSectionRef.current,
    getSessionId: () => immediateSessionIdRef.current,
    getCurrentSettings: () => adminSettingsRef.current,
    openState: (target, section) => {
      setSettingsOpen(false);
      setGovernanceRouteRaw(null);
      setAdminSettingsRaw({ target, section });
    },
    closeState: () => setAdminSettingsRaw(null),
  });

  // ---- 企业专家草稿态（2026-07 唯恩批次）----
  // ref：sendChatViaWs 首条消息（无 sessionId）时带上 orgAgentId，收到 'session' 事件
  //（会话真实建立、服务端已写 meta）后清除——ACK 只代表入队，rejected 后重发仍要带上（2026-07 审查 F9）；
  // state：新会话空白态的顶部 banner 展示（会话入列表带 orgAgentId 后由列表接管）。
  const { pendingAgentTargetRef, pendingNewSessionGroupIdRef, pendingAgentTarget, pendingOrgAgentId, setPendingAgentTarget, clearPendingOrgAgent, assignPendingGroup } = usePendingNewSessionTarget();
  const authOwnerKey = user ? `${user.tenantId}:${user.id}` : "anonymous";
  const selectSessionWithUrl = useCallback((id: string) => {
    setTrashPreviewSessionId(null);
    clearPendingOrgAgent(); // 切换既有会话 = 放弃挂起的专职 Agent 新会话
    pendingNewSessionClientMsgIdRef.current = null;
    pendingNewSessionGroupIdRef.current = null;
    markSessionRead(id);
    immediateSessionIdRef.current = id;
    queuedSessionIdRef.current = id;
    mutateQueuedInterjections((prev) => prev);
    // 与 immediateSessionIdRef 同帧同语义：清掉上一个发过消息的会话，避免终态守卫回退值失效。
    wsLatestSessionIdRef.current = { value: id };
    session.selectSession(id);
    if (isActiveRuntimeStatus(loadSessionRuntimeToRef(id)?.status)) {
      setLoading(true); dispatchConnection('connect');
    }
    pushUrl('chat', id);
  }, [clearPendingOrgAgent, dispatchConnection, loadSessionRuntimeToRef, markSessionRead, mutateQueuedInterjections, session.selectSession]);
  const startAgentTargetSession = useCallback((target: AgentTarget, groupId: string | null = null): void => {
    if (!user || target.tenantId !== user.tenantId) return;
    setTrashPreviewSessionId(null); startNewSandboxProfile();
    immediateSessionIdRef.current = null;
    queuedSessionIdRef.current = null;
    mutateQueuedInterjections((prev) => prev);
    wsLatestSessionIdRef.current = { value: null };
    session.newSession();
    pendingNewSessionClientMsgIdRef.current = null;
    pendingNewSessionGroupIdRef.current = groupId;
    setPendingAgentTarget(target);
    pushUrl('chat', null);
    if (activeTabRef.current !== 'chat') setActiveTab('chat');
  }, [mutateQueuedInterjections, session.newSession, setActiveTab, setPendingAgentTarget, startNewSandboxProfile, user]);

  const newSessionWithUrl = useCallback((groupId: string | null = null) => {
    if (!user) return;
    startAgentTargetSession({ kind: 'personal', tenantId: user.tenantId }, groupId);
  }, [startAgentTargetSession, user]);

  const startOrgAgentSession = useCallback((agentId: string, groupId: string | null = null): void => {
    const normalizedAgentId = agentId.trim();
    if (!normalizedAgentId || !user) return;
    startAgentTargetSession({ kind: 'org-agent', tenantId: user.tenantId, orgAgentId: normalizedAgentId }, groupId);
  }, [startAgentTargetSession, user]);

  useEffect(() => {
    clearPendingOrgAgent();
    pendingNewSessionGroupIdRef.current = null;
  }, [authOwnerKey, clearPendingOrgAgent]);

  const previewTrashSession = useCallback(async (id: string | null) => {
    if (id) {
      msg.resetMessages();
      setTrashPreviewSessionId(id);
      try {
        const res = await authFetch(`/api/sessions/${encodeURIComponent(id)}?includeDeleted=1`);
        if (res.ok) {
          const data: ApiSessionDetail = await res.json();
          const sessionOwnerName = data.owner?.username;
          const msgs = (await import("@/lib/sessionMessageMapper")).mapSessionDetailToMessages(data, sessionOwnerName);
          msg.setMessages(msgs, { scrollToBottom: false });

          // 设置 sessionParticipants 供 MessageList 使用
          if (data.owner && data.owner.username !== user?.username) {
            try {
              const agent = await fetchAgentProfile(data.owner.username);
              setSessionParticipants({ owner: data.owner, agent });
            } catch {
              setSessionParticipants({ owner: data.owner, agent: null });
            }
          } else {
            setSessionParticipants(null);
          }
        }
      } catch (err) {
        console.error("加载回收站会话失败:", err);
      }
    } else {
      setTrashPreviewSessionId(null);
      setSessionParticipants(null);
      msg.resetMessages();
      if (session.sessionId) {
        void session.loadSessionDetail(session.sessionId);
      }
    }
  }, [msg, session.sessionId, session.loadSessionDetail, user?.username]);

  // Popstate refs（保持最新引用避免 effect 重注册）
  const selectSessionRawRef = useRef(session.selectSession);
  selectSessionRawRef.current = session.selectSession;
  const newSessionRawRef = useRef(session.newSession);
  newSessionRawRef.current = session.newSession;

  // 浏览器前进/后退 → 解析 URL → 更新状态（不操作 URL）
  useEffect(() => {
    const handler = (event: PopStateEvent) => {
      // 只有用户真实触发的前进/后退才允许借导航应用 SW 更新；应用内部派发的
      // synthetic popstate 只是让 SPA 重读 URL，强刷会造成管理菜单随机闪屏。
      if (maybeReloadOnPopstate(event)) return;
      const {
        tab,
        sessionId: urlSessionId,
        settingsSection: urlSettingsSection,
        adminSection: urlAdminSection,
        adminEntityId: urlAdminEntityId,
        tenantAdminSection: urlTenantAdminSection,
        adminSettings: urlAdminSettings,
        governanceRoute: urlGovernanceRoute,
        canonicalPath,
      } = parseUrl();
      setGovernanceRouteRaw(urlGovernanceRoute);
      setPendingCanonicalPath(canonicalPath);
      if (urlAdminSettings) {
        // 统一设置工作区覆盖在当前产品页上；页内前进/后退只切设置叶子，不改动来源 tab。
        setSettingsOpen(false);
        setAdminSettingsRaw(urlAdminSettings);
        return;
      }
      if (urlSettingsSection) {
        setAdminSettingsRaw(null);
        setSettingsOpen(true);
        setSettingsSectionRaw(urlSettingsSection);
        return;
      }
      setSettingsOpen(false);
      setAdminSettingsRaw(null);
      if (tab === 'platform-admin') {
        setPlatformAdminSectionRaw(urlAdminSection ?? 'overview');
        setPlatformAdminEntityIdRaw(urlAdminEntityId);
      }
      if (tab === 'tenant-admin' && urlTenantAdminSection) {
        setTenantAdminSectionRaw(urlTenantAdminSection);
      }
      immediateSessionIdRef.current = urlSessionId;
      queuedSessionIdRef.current = urlSessionId;
      mutateQueuedInterjections((prev) => prev);
      setActiveTabRaw(tab);
      if (tab === 'chat') {
        if (urlSessionId && urlSessionId !== sessionIdRef.current) {
          markSessionRead(urlSessionId);
          selectSessionRawRef.current(urlSessionId);
        } else if (!urlSessionId && sessionIdRef.current) {
          newSessionRawRef.current();
        }
      }
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, [markSessionRead, mutateQueuedInterjections]);

  // 兜底：确保 URL 始终与 state 一致（覆盖 delete fallback 等间接变更）
  useEffect(() => {
    if (pendingCanonicalPath) {
      const current = `${window.location.pathname}${window.location.search}`;
      if (current !== pendingCanonicalPath) {
        window.history.replaceState(analysisHistoryStateForNavigation('replace', pendingCanonicalPath), '', pendingCanonicalPath);
      }
      setPendingCanonicalPath(null);
      return;
    }
    const expectedUrl = buildUrl(
      activeTab,
      activeTab === 'chat' ? session.sessionId : null,
    );
    if (governanceRouteState) {
      const governanceUrl = buildGovernanceUrl(governanceRouteState);
      if (governanceUrl !== `${window.location.pathname}${window.location.search}`) {
        replaceGovernanceUrl(governanceRouteState);
      }
      return;
    }
    if (adminSettings) {
      const adminUrl = buildAdminSettingsUrl(adminSettings.target, adminSettings.section);
      if (adminUrl !== window.location.pathname) {
        replaceAdminSettingsUrl(adminSettings.target, adminSettings.section);
      }
      return;
    }
    if (settingsOpen) {
      const settingsUrl = buildSettingsUrl(settingsSection);
      if (settingsUrl !== window.location.pathname) {
        replaceSettingsUrl(settingsSection);
      }
      return;
    }
    if (activeTab === 'platform-admin') {
      const expectedPath = buildPlatformAdminUrl({
        section: platformAdminSection,
        entityId: platformAdminEntityId,
      });
      if (expectedPath !== window.location.pathname) {
        replacePlatformAdminUrl({
          section: platformAdminSection,
          entityId: platformAdminEntityId,
          search: window.location.search,
        });
      }
      return;
    }
    if (activeTab === 'tenant-admin') {
      // 与 platform-admin 完全对称：路径带页签，search（筛选）原样保留
      const expectedPath = buildTenantAdminUrl({ section: tenantAdminSection });
      if (expectedPath !== window.location.pathname) {
        replaceTenantAdminUrl({ section: tenantAdminSection, search: window.location.search });
      }
      return;
    }
    if (expectedUrl !== window.location.pathname) {
      immediateSessionIdRef.current = session.sessionId;
      queuedSessionIdRef.current = session.sessionId;
      mutateQueuedInterjections((prev) => prev);
      replaceUrl(activeTab, activeTab === 'chat' ? session.sessionId : null);
    }
  }, [session.sessionId, activeTab, settingsOpen, settingsSection, adminSettings, governanceRouteState, platformAdminSection, platformAdminEntityId, tenantAdminSection, pendingCanonicalPath, mutateQueuedInterjections]);

  // ---- 运行态 watchdog：防止 done 丢失时 loading 永久锁定 ----
  const watchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastStreamEventAtRef = useRef(0);

  const clearWatchdog = useCallback(() => {
    if (watchdogTimerRef.current) { clearTimeout(watchdogTimerRef.current); watchdogTimerRef.current = null; }
    lastStreamEventAtRef.current = 0;
  }, []);

  const resetWatchdog = useCallback(() => {
    if (watchdogTimerRef.current) clearTimeout(watchdogTimerRef.current);
    if (!loadingRef.current) return;
    const timeout = lastStreamEventAtRef.current > 0 ? 45_000 : 60_000;
    watchdogTimerRef.current = setTimeout(async () => {
      watchdogTimerRef.current = null;
      if (!loadingRef.current) return;
      const sid = sessionIdRef.current;
      const watchdogNonce = streamNonceRef.current;
      const watchdogRuntimeVersion = sid ? runtimeVersionBySessionRef.current.get(sid) ?? 0 : 0;
      const watchdogIsStale = () => sessionIdRef.current !== sid || streamNonceRef.current !== watchdogNonce || Boolean(sid && (runtimeVersionBySessionRef.current.get(sid) ?? 0) !== watchdogRuntimeVersion);
      if (sid) {
        try {
          const res = await authFetch(`/api/sessions/${sid}/stream-status`);
          if (watchdogIsStale()) return;
          if (res.ok) {
            const { active } = await res.json() as { active: boolean };
            if (watchdogIsStale()) return;
            if (active) { resetWatchdog(); return; } // Agent 还活着
          }
        } catch {
          if (watchdogIsStale()) return;
        }
      }
      if (watchdogIsStale()) return;
      if (sid) patchSessionRuntime(sid, { status: 'idle', streamId: null, runId: null, lastEventId: null, attached: false });
      finalizeStreamingMessages(msgRef.current);
      finalizeRunningSubagents(msgRef.current);
      wsAttachedRef.current = false;
      setLoading(false);
      setStopping(false);
      dispatchConnection('complete');
      sessionRef.current.refreshCurrentSession();
    }, timeout);
  }, [dispatchConnection, patchSessionRuntime]);

  const finalizeTerminalRuntime = useCallback((args: {
    sessionId: string;
    status: TerminalRuntimeStatus;
    runId?: string;
    streamId?: string;
    reason?: string; failureKind?: RuntimeFailureKind; recoveryAction?: RuntimeRecoveryAction;
    refresh?: boolean;
  }) => {
    patchSessionRuntime(args.sessionId, {
      status: args.status,
      streamId: null,
      runId: null,
      lastEventId: null,
      attached: false,
    });

    if (args.sessionId !== immediateSessionIdRef.current) return;

    clearWatchdog();
    finalizeStreamingMessages(msgRef.current);
    finalizeRunningSubagents(msgRef.current);

    let alertContent: string | null = null;
    let severity: 'error' | 'cancelled' | 'billing' = 'error';
    if (args.status === 'failed' || args.status === 'orphaned') {
      alertContent = formatRuntimeFailureMessage(args.reason, args.failureKind);
      if (isInsufficientCreditsFailure(args.reason)) severity = 'billing';
    } else if (args.status === 'cancelled') {
      alertContent = '会话已停止';
      severity = 'cancelled';
    }
    if (alertContent) {
      const msgs = msgRef.current.messagesRef.current;
      const last = msgs[msgs.length - 1];
      if (!(last?.type === 'system-error' && isSameRunMessage(last, args.runId, alertContent) && last.failureKind === args.failureKind && last.recoveryAction === args.recoveryAction)) {
        msgRef.current.addMessage({ type: 'system-error', content: alertContent, severity, runId: args.runId, ...(args.failureKind ? { failureKind: args.failureKind } : {}), ...(args.recoveryAction ? { recoveryAction: args.recoveryAction } : {}), timestamp: Date.now() });
      }
    }

    wsAttachedRef.current = false;
    streamIdRef.current = null;
    runIdRef.current = null;
    lastEventIdRef.current = null;
    setLoading(false);
    setStopping(false);
    sessionRef.current.setContextUsage(null);

    // run 终态不拥有随后提交的传输；ACK 丢失时 outbox/timer 仍由 chat_ack、chat_rejected 或权威查询收敛。

    dispatchConnection('complete');
    if (args.refresh !== false) {
      sessionRef.current.refreshCurrentSession();
    }
  }, [clearWatchdog, dispatchConnection, patchSessionRuntime]);
  const terminalProbeVersionBySessionRef = useRef(new Map<string, number>());
  const scheduleTerminalRuntimeProbe = useCallback((args: Parameters<typeof finalizeTerminalRuntime>[0]) => {
    const version = runtimeVersionBySessionRef.current.get(args.sessionId) ?? 0;
    if (terminalProbeVersionBySessionRef.current.get(args.sessionId) === version) return;
    terminalProbeVersionBySessionRef.current.set(args.sessionId, version);
    setTimeout(() => {
      if (version !== (runtimeVersionBySessionRef.current.get(args.sessionId) ?? 0)) return;
      void (async () => {
        const runtime = activeRunsBySession.current.get(args.sessionId);
        const idMismatched = Boolean((args.runId && runtime?.runId && args.runId !== runtime.runId) || (args.streamId && runtime?.streamId && args.streamId !== runtime.streamId));
        const status = await fetchSessionStreamStatus(args.sessionId);
        if (version !== (runtimeVersionBySessionRef.current.get(args.sessionId) ?? 0)) return;
        if (status?.active) {
          invalidateResumeRequests(args.sessionId); if (args.sessionId === immediateSessionIdRef.current) advanceStreamBindingGenerationIfChanged({ streamId: status.streamId, runId: status.runId });
          patchSessionRuntime(args.sessionId, { ...activeRuntimePatchFromStreamStatus(status), attached: true });
          if (args.sessionId === immediateSessionIdRef.current) { stoppingRef.current = false; setLoading(true); setStopping(false); dispatchConnection('connect'); resetWatchdog(); }
          return;
        }
        if (idMismatched && status?.active !== false) { terminalProbeVersionBySessionRef.current.delete(args.sessionId); return; }
        finalizeTerminalRuntime(args);
      })();
    }, 750);
  }, [advanceStreamBindingGenerationIfChanged, dispatchConnection, finalizeTerminalRuntime, invalidateResumeRequests, patchSessionRuntime, resetWatchdog]);
  const reconcileLastRunState = useCallback(async (sessionId: string, lastRunState: LastRunState) => {
    if (!isTerminalRuntimeStatus(lastRunState.status)) return;
    if (sessionId !== immediateSessionIdRef.current) {
      patchSessionRuntime(sessionId, {
        status: lastRunState.status,
        ...(lastRunState.runId ? { runId: lastRunState.runId } : {}),
        attached: false,
      });
      return;
    }

    const existingRuntime = activeRunsBySession.current.get(sessionId);
    // 详情历史终态不能结束已确认 active；实时 session_status / 关联 resume 负责收口。
    if (isActiveRuntimeStatus(existingRuntime?.status)) return;
    const requestedRuntimeVersion = runtimeVersionBySessionRef.current.get(sessionId) ?? 0;
    const status = await fetchSessionStreamStatus(sessionId);
    if (!status || requestedRuntimeVersion !== (runtimeVersionBySessionRef.current.get(sessionId) ?? 0)) return;
    if (status.active) {
      patchSessionRuntime(sessionId, activeRuntimePatchFromStreamStatus(status));
      return;
    }

    finalizeTerminalRuntime({
      sessionId,
      status: lastRunState.status,
      runId: lastRunState.runId,
      reason: lastRunState.error, failureKind: lastRunState.failureKind, recoveryAction: lastRunState.recoveryAction,
      refresh: false,
    });
  }, [finalizeTerminalRuntime, patchSessionRuntime]);

  reconcileLastRunStateRef.current = (sessionId, lastRunState) => {
    void reconcileLastRunState(sessionId, lastRunState);
  };

  // ---- Sync 序列号与服务端日志代际（用于断线重连恢复元数据事件）----
  const lastUserSeqRef = useRef(0);
  const lastUserEpochRef = useRef<string | null>(null);

  // ---- WS 连接管理 ----
  useEffect(() => {
    // 建立 WS 连接
    wsClient.connect().catch(() => { });

    // WS 状态同步到 connectionState
    const unsubState = wsClient.onStateChange((state) => {
      switch (state) {
        case 'connected':
          dispatchConnection('connect');
          // WS 连接成功时，如果 modelList 仍为空则重新获取
          if (!modelListRef.current) fetchModelList();

          // 发送 sync 请求恢复漏掉的元数据事件；overflow 可内联当前会话权威快照。
          wsClient.setSyncSessionId?.(immediateSessionIdRef.current ?? sessionIdRef.current);
          wsClient.send({
            action: 'sync',
            lastSeq: lastUserSeqRef.current,
            ...(lastUserEpochRef.current ? { epoch: lastUserEpochRef.current } : {}),
          });

          // WS 重连时自动恢复活跃流
          if (loadingRef.current && sessionIdRef.current) {
            const targetSid = sessionIdRef.current;

            // 重连前清理断线遗留的半截消息
            wsBlockRef.current = { currentBlockIndex: -1, currentBlockType: null };
            const msgs = msgRef.current.messagesRef.current;
            const cleaned = msgs.filter(m => !('streaming' in m && m.streaming));
            if (cleaned.length !== msgs.length) {
              msgRef.current.setMessages(cleaned, { scrollToBottom: false });
            }

            // 2026-08-04 P1：只有持有增量游标（buffer eventId 或 durable cursor）才请求
            // replay；两者皆无时 replay 语义退化为「从头全量重放」，会把 transcript 快照
            // 已展示的内容整段叠加一遍（实证 fc3bf95a）。无游标改走 refreshCurrentSession
            // 补断线期间内容（transcript 投影是实时的）。
            const hasReplayCursor = lastEventIdRef.current !== null
              || Boolean(lastEventCursorRef.current);
            const handleReconnectStream = (envelope: WsEnvelope) => {
              const d = envelope.data as WsEvent;
              if (d.type !== 'active_stream') return;
              if (d.sessionId !== targetSid) return;
              // selectSession 同帧先更新 immediate ref；临时重连 handler 在任何 refs/UI
              // mutation 前必须再校验，避免迟到的旧会话 active_stream 串入新会话。
              if (immediateSessionIdRef.current !== targetSid) {
                unsubReconnect();
                return;
              }
              if (!shouldApplyActiveStreamResponse(d)) {
                unsubReconnect();
                return;
              }
              unsubReconnect();
              // refs/UI 由全局 active_stream reducer 统一修改。临时 handler 只补无 replay
              // cursor 时的 transcript 刷新，避免两条 handler 产生不同相关性判定。
              if (d.active && !hasReplayCursor) {
                sessionRef.current.refreshCurrentSession();
              }
            };
            const unsubReconnect = wsClient.onMessage(handleReconnectStream);
            sendCorrelatedResume({
              action: 'resume',
              sessionId: targetSid,
              lastEventId: lastEventIdRef.current ?? 0,
              lastEventCursor: lastEventCursorRef.current,
              skipReplay: !hasReplayCursor,
            }).then(ok => {
              if (!ok) unsubReconnect();
            });
            setTimeout(() => unsubReconnect(), 30000);
          } else {
            // 非活跃状态断线重连：sync 协议会恢复元数据，仅刷新当前会话内容
            if (sessionIdRef.current) {
              sessionRef.current.refreshCurrentSession();
            }
          }
          break;
        case 'reconnecting':
          releaseAllInteractionResponses('连接已断开');
          if (loadingRef.current) {
            dispatchConnection('drop');
          }
          break;
        case 'disconnected':
          releaseAllInteractionResponses('连接已断开');
          if (loadingRef.current) {
            dispatchConnection('reconnect_fail');
          }
          break;
      }
    });

    return () => {
      unsubState();
      wsClient.disconnect();
    };
  }, [dispatchConnection, releaseAllInteractionResponses]);
  // ---- WS 消息处理（wsClient 已完成 epoch/seq 接受边界） ----
  useEffect(() => {
    const projectRecoveredInteraction = (event: Extract<WsEvent, { type: 'pending_interactions' | 'permission_request' | 'ask_user' | 'interaction_resolved' }>) => {
      const ctx: WsProcessingContext = {
        msg: msgRef.current,
        session: sessionRef.current,
        selectedModelRef,
        voiceCallbackRef,
        streamIdRef,
        runIdRef,
        handledTerminalKeysRef,
        resolvedInteractionIdsRef, onInteractionResolved: finalizeInteractionProjection, onInteractionsChanged: syncInteractionRuntime,
        lastEventIdRef,
        userMsgIndex: wsUserMsgIndexRef.current,
        sessionOwnerRef,
      };
      processWsEvent(event, ctx, wsBlockRef.current, wsLatestSessionIdRef.current, immediateSessionIdRef.current ?? sessionIdRef.current);
    };
    const unsub = wsClient.onMessage((envelope: WsEnvelope) => {
      const data = envelope.data as WsEvent;
      if (!data || !data.type) return;
      // M20-02 thin path consumes structured V1 frames. Legacy frames stay on the existing
      // N-1 projector below so they cannot reintroduce local dispatch authority.
      const isQueueLifecycleFrame = data.type === 'queue_snapshot' || data.type === 'queue_item_updated'
        || data.type === 'message_queued' || data.type === 'session_status' || data.type === 'done' || data.type === 'interjection_applied'
        || data.type === 'steering_cancelled' || data.type === 'cancel_queued_result';
      if (isQueueLifecycleFrame) {
        const nextQueueState = applyAuthoritativeWsEvent(
          data, immediateSessionIdRef.current ?? sessionIdRef.current ?? undefined,
        );
        const sid = immediateSessionIdRef.current ?? sessionIdRef.current;
        if (sid && nextQueueState.sessionId === sid) projectAuthoritativeQueue(nextQueueState);
      }

      // 追踪 eventId / cursor。元数据事件可能属于后台会话，不能写进当前 UI 会话；
      // 无 sessionId 的流事件则归属当前已 attach 的会话。
      const eventSessionId = 'sessionId' in data && typeof data.sessionId === 'string'
        ? data.sessionId
        : wsLatestSessionIdRef.current?.value ?? sessionIdRef.current;
      if (envelope.eventId != null && eventSessionId) {
        const existing = activeRunsBySession.current.get(eventSessionId);
        activeRunsBySession.current.set(eventSessionId, {
          ...(existing ?? { status: 'idle' as const, attached: false }),
          lastEventId: envelope.eventId,
        });
        if (eventSessionId === sessionIdRef.current) {
          lastEventIdRef.current = envelope.eventId;
        }
      }
      if (envelope.eventCursor && eventSessionId) {
        const existing = activeRunsBySession.current.get(eventSessionId);
        activeRunsBySession.current.set(eventSessionId, {
          ...(existing ?? { status: 'idle' as const, attached: false }),
          lastEventCursor: envelope.eventCursor,
        });
        if (eventSessionId === sessionIdRef.current) {
          lastEventCursorRef.current = envelope.eventCursor;
        }
      }

      if (data.type === 'respond_ok' || data.type === 'respond_error') {
        resolveInteractionResponse(data);
        return;
      }

      if (data.type === 'session') {
        const currentSessionId = immediateSessionIdRef.current ?? sessionIdRef.current;
        if (!shouldAcceptSessionEvent(data, currentSessionId, pendingNewSessionClientMsgIdRef.current)) {
          if (data.client_msg_id) newSessionClientMsgIdsRef.current.delete(data.client_msg_id);
          console.warn(`[chat] ignored stale session event for ${data.client_msg_id ?? data.sessionId}`);
          return;
        }
        if (data.client_msg_id) newSessionClientMsgIdsRef.current.delete(data.client_msg_id);
      }
      if (data.type === 'abort_ok') {
        if ((data.runId && data.runId === runIdRef.current) || (data.streamId && data.streamId === streamIdRef.current)) {
          setStopping(true);
        }
        return;
      }

      if (data.type === 'active_stream') {
        const a = data as Extract<WsEvent, { type: 'active_stream' }>;
        const sessionRuntime = activeRunsBySession.current.get(a.sessionId);
        if (!a.requestId && a.sessionId !== immediateSessionIdRef.current && isActiveRuntimeStatus(sessionRuntime?.status) && (!a.active || Boolean((a.streamId && sessionRuntime?.streamId && a.streamId !== sessionRuntime.streamId) || (a.runId && sessionRuntime?.runId && a.runId !== sessionRuntime.runId)))) return;
        if (!shouldApplyActiveStreamResponse(a)) return;
        const activeStreamBindingChanged = a.active && a.sessionId === immediateSessionIdRef.current && ((a.streamId && a.streamId !== streamIdRef.current) || (a.runId && a.runId !== runIdRef.current));
        patchSessionRuntime(
          a.sessionId,
          a.active
            ? {
                status: isActiveRuntimeStatus(a.status) ? a.status as SessionRuntimeStatus : 'running', source: 'ws',
                ...(a.streamId ? { streamId: a.streamId } : {}),
                ...(a.runId ? { runId: a.runId } : {}),
                attached: true,
              }
            : {
                status: 'idle',
                streamId: null,
                runId: null,
                attached: false,
              },
        );
        if (a.sessionId === immediateSessionIdRef.current) {
          if (a.active) {
            if (activeStreamBindingChanged && stoppingRef.current) { stoppingRef.current = false; setStopping(false); }
            if (a.streamId) streamIdRef.current = a.streamId;
            if (a.runId) runIdRef.current = a.runId;
            wsAttachedRef.current = true;
            wsLatestSessionIdRef.current = { value: a.sessionId };
            upsertRuntimeStatusMessage(msgRef.current, runtimeStatusFromSessionStatus(a.status || 'running') ?? 'running', {
              ...(a.streamId ? { streamId: a.streamId } : {}),
              ...(a.runId ? { runId: a.runId } : {}),
            });
            if (!loadingRef.current) {
              setLoading(true);
              dispatchConnection('connect');
            }
          } else {
            streamIdRef.current = null;
            runIdRef.current = null;
            wsAttachedRef.current = false;
            wsLatestSessionIdRef.current = { value: null };
            if (loadingRef.current) {
              setLoading(false);
              setStopping(false);
              dispatchConnection('complete');
            }
            sessionRef.current.refreshCurrentSession();
          }
        }
        return;
      }

      // ── sync 协议响应 ──
      if (data.type === 'sync_ok') {
        lastUserSeqRef.current = (data as any).seq;
        wsClient.setLastSeq((data as any).seq);
        if (typeof (data as any).epoch === 'string') {
          lastUserEpochRef.current = (data as any).epoch;
          wsClient.setEpoch((data as any).epoch);
        }
        for (const { event } of (data as any).events || []) {
          const e = event as WsEvent;
          const recoveredQueue = applyAuthoritativeWsEvent(
            e, immediateSessionIdRef.current ?? sessionIdRef.current ?? undefined,
          );
          if (recoveredQueue.sessionId) projectAuthoritativeQueue(recoveredQueue);
          if (e.type === 'session_status') {
            patchSessionRuntime(e.sessionId, {
              status: e.status, source: 'ws',
              ...(e.streamId ? { streamId: e.streamId } : {}),
              ...(e.runId ? { runId: e.runId } : {}),
              attached: !['idle', 'completed', 'failed', 'cancelled', 'orphaned'].includes(e.status),
            });
          }
          if (e.type === 'pending_interactions' || e.type === 'permission_request'
            || e.type === 'ask_user' || e.type === 'interaction_resolved') {
            projectRecoveredInteraction(e);
          }
          if (e.type === 'title_updated') sessionRef.current.updateSessionTitle(e.sessionId, e.title);
          else if (e.type === 'session_updated') {
            if ((e as any).isNew && sessionRef.current.upsertSession) {
              sessionRef.current.upsertSession({ sessionId: e.sessionId, preview: e.preview, updatedAtMs: e.updatedAtMs, title: (e as any).title, model: (e as any).model, username: (e as any).username });
            } else {
              sessionRef.current.updateSessionMeta(e.sessionId, {
                preview: e.preview,
                updatedAtMs: e.updatedAtMs,
                ...((e as any).title !== undefined ? { title: (e as any).title } : {}),
              });
            }
          }
          else if (e.type === 'session_deleted') {
            if ((immediateSessionIdRef.current ?? sessionIdRef.current) === e.sessionId) {
              immediateSessionIdRef.current = null; sessionIdRef.current = null; queuedSessionIdRef.current = null; wsLatestSessionIdRef.current = { value: null };
            }
            sessionRef.current.removeSession(e.sessionId);
          }
          // Queue lifecycle frames are projected exclusively by the shared M40-01 reducer above.
          // SDK 0.2.112+ REPL 通知（user scope 事件也会进 UserEventLog，断线重连必须回放）
          else if (e.type === 'notification') {
            pushNotification((e as { notification: NotificationData }).notification);
          }
        }
        return;
      }
      if (data.type === 'sync_overflow') {
        lastUserSeqRef.current = (data as any).seq;
        wsClient.setLastSeq((data as any).seq);
        if (typeof (data as any).epoch === 'string') {
          lastUserEpochRef.current = (data as any).epoch;
          wsClient.setEpoch((data as any).epoch);
        }
        const inline = data.recovery?.session;
        if (inline?.queueSnapshot) {
          projectAuthoritativeQueue(applyAuthoritativeQueueEvent(inline.sessionId, {
            type: 'snapshot', snapshot: inline.queueSnapshot,
          }));
        }
        if (inline?.runtime) {
          patchSessionRuntime(inline.sessionId, {
            status: inline.runtime.active ? (inline.runtime.status as SessionRuntimeStatus || 'running') : 'idle',
            source: 'ws',
            ...(inline.runtime.streamId ? { streamId: inline.runtime.streamId } : {}),
            ...(inline.runtime.runId ? { runId: inline.runtime.runId } : {}),
            attached: inline.runtime.active,
          });
        }
        if (inline?.pendingInteractions) {
          projectRecoveredInteraction(webPendingInteractionsEvent(inline));
        }
        if (!inline?.queueSnapshot || !inline.runtime || !inline.pendingInteractions) {
          void recoverQueueSnapshotAfterSyncOverflow(sessionRef.current);
        }
        return;
      }

      if (
        data.type === 'session_read_state_changed'
        && data.hasUnreadAiReply
        && activeTabRef.current === 'chat'
        && !trashPreviewSessionIdRef.current
        && immediateSessionIdRef.current === data.sessionId
        && msgRef.current.isNearBottomRef.current
        && document.visibilityState === 'visible'
      ) {
        // Only a visible bottom viewport may consume unread; receipt/open alone is insufficient.
        // processWsEvent，它会在 markSessionRead 的乐观更新之后又把红点写回 true；
        // 服务端状态已是 read 时不会再广播 false，红点就会一直残留。
        markSessionRead(data.sessionId);
        return;
      }

      // ── session_status（Agent/run 生命周期）──
      // 后台会话同样写入 activeRunsBySession，切回时直接派生 UI。
      if (data.type === 'session_status') {
        const d = data as Extract<WsEvent, { type: 'session_status' }>;

        const lifecycleSessionId = immediateSessionIdRef.current ?? sessionIdRef.current;
        const previousRuntime = activeRunsBySession.current.get(d.sessionId);
        const lifecycleBindingChanged = Boolean((d.streamId && d.streamId !== previousRuntime?.streamId) || (d.runId && d.runId !== previousRuntime?.runId));
        // 后台会话迟到的旧终态不得覆盖已知的新 active binding。
        const staleTerminalBinding = isTerminalRuntimeStatus(d.status) && isActiveRuntimeStatus(previousRuntime?.status) && Boolean((d.streamId && previousRuntime?.streamId && d.streamId !== previousRuntime.streamId) || (d.runId && previousRuntime?.runId && d.runId !== previousRuntime.runId));
        if (staleTerminalBinding) return;
        const currentActiveBindingChanged = isActiveRuntimeStatus(d.status) && d.sessionId === lifecycleSessionId && lifecycleBindingChanged;
        if (lifecycleBindingChanged) invalidateResumeRequests(d.sessionId);
        if (d.sessionId === lifecycleSessionId
          && (isActiveRuntimeStatus(d.status) || isTerminalRuntimeStatus(d.status))) {
          streamBindingGenerationRef.current += 1;
        }

        const deferCurrentTerminal = isTerminalRuntimeStatus(d.status)
          && d.sessionId === immediateSessionIdRef.current
          && loadingRef.current;
        if (!deferCurrentTerminal) {
          patchSessionRuntime(d.sessionId, {
            status: d.status, source: 'ws',
            ...(d.streamId ? { streamId: d.streamId } : {}),
            ...(d.runId ? { runId: d.runId } : {}),
            attached: isActiveRuntimeStatus(d.status),
          });
        }

        if (isActiveRuntimeStatus(d.status)) {
          trackedAiReplyStreamsRef.current.add(d.sessionId);
        } else if (isTerminalRuntimeStatus(d.status)) {
          trackedAiReplyStreamsRef.current.delete(d.sessionId);
        }

        if (isActiveRuntimeStatus(d.status) && d.sessionId === sessionIdRef.current) {
          if (stoppingRef.current && currentActiveBindingChanged) { stoppingRef.current = false; setStopping(false); }
          if (d.streamId) streamIdRef.current = d.streamId;
          if (d.runId) runIdRef.current = d.runId;
          wsAttachedRef.current = true;
          const visibleStatus = runtimeStatusFromSessionStatus(d.status);
          if (visibleStatus) {
            upsertRuntimeStatusMessage(msgRef.current, visibleStatus, {
              ...(d.streamId ? { streamId: d.streamId } : {}),
              ...(d.runId ? { runId: d.runId } : {}),
            });
          }
          if (!loadingRef.current) {
            setLoading(true);
            dispatchConnection('connect');
          }
          resetWatchdog();
        }

        if (isTerminalRuntimeStatus(d.status) && d.sessionId === sessionIdRef.current && loadingRef.current) {
          scheduleTerminalRuntimeProbe({
            sessionId: d.sessionId, status: d.status,
            ...(d.runId ? { runId: d.runId } : {}), ...(d.streamId ? { streamId: d.streamId } : {}),
            ...(d.reason ? { reason: d.reason } : {}), ...(d.failureKind ? { failureKind: d.failureKind } : {}), ...(d.recoveryAction ? { recoveryAction: d.recoveryAction } : {}),
          });
        }
        return;
      }

      // ── groups_changed（由 useGroups WS 监听器处理）──
      if (data.type === 'groups_changed') return;

      // ── SDK 0.2.112+ 新事件（直接 setState，不走 processWsEvent）──
      if (data.type === 'context_usage') {
        sessionRef.current.setContextUsage((data as any).contextUsage);
        return;
      }
      if (data.type === 'notification') {
        pushNotification((data as { notification: NotificationData }).notification);
        return;
      }
      if (data.type === 'memory_recall') {
        showMemoryRecall((data as { memoryRecall: MemoryRecallData }).memoryRecall);
        return;
      }
      if (data.type === 'plugin_install') {
        showPluginInstallStatus((data as { pluginInstall: PluginInstallData }).pluginInstall);
        return;
      }

      if (data.type === 'stream_started') {
        trackedAiReplyStreamsRef.current.add(data.sessionId);
        const currentSid = immediateSessionIdRef.current;
        const bindingChanged = data.sessionId === currentSid
          ? advanceStreamBindingGenerationIfChanged({ streamId: data.streamId, runId: data.runId })
          : false;
        const runtimeBindingChanged = data.streamId !== activeRunsBySession.current.get(data.sessionId)?.streamId || Boolean(data.runId && data.runId !== activeRunsBySession.current.get(data.sessionId)?.runId); if (runtimeBindingChanged) invalidateResumeRequests(data.sessionId);
        if (bindingChanged && stoppingRef.current) { stoppingRef.current = false; setStopping(false); }
        patchSessionRuntime(data.sessionId, {
          status: 'running', source: 'ws',
          streamId: data.streamId,
          ...(data.runId ? { runId: data.runId } : {}),
          attached: false, // 下方 resume 前尚未真正订阅这条流
        });
        // loading 只说明旧绑定仍活跃；不同的新 binding 仍必须 attach + resume。
        if (data.sessionId === currentSid && (!loadingRef.current || bindingChanged)) {
          streamIdRef.current = data.streamId;
          if (data.runId) runIdRef.current = data.runId;
          wsLatestSessionIdRef.current = { value: data.sessionId };
          wsBlockRef.current = { currentBlockIndex: -1, currentBlockType: null };
          wsUserMsgIndexRef.current = -1;
          lastEventIdRef.current = null;
          wsAttachedRef.current = true;
          if (!loadingRef.current) setLoading(true);
          dispatchConnection('connect');
          void sendCorrelatedResume({
            action: 'resume',
            sessionId: data.sessionId,
            lastEventId: 0,
            lastEventCursor: lastEventCursorRef.current,
            skipReplay: false,
          });
        }
        // 先本地占位，再刷新服务端真值；避免 enqueue-only 会话尚未投影 .jsonl 时被 fresh 覆盖抹掉。
        sessionRef.current.upsertSession({
          sessionId: data.sessionId,
          updatedAtMs: Date.now(),
        });
        void sessionRef.current.loadSessions({ fresh: true });
        return;
      }

      // 防串流守卫：未挂载到流时，只放行会话元数据事件，过滤所有流式内容事件
      if (!wsAttachedRef.current) {
        // stream_id 必须放行：插话回退为独立 run 时，目标 run 的 done 已把 attached 清掉，
        // 服务端补发的接管 stream_id 若被挡在这里，整条回退流的内容与 done 都会丢失。
        // 串会话风险由 processWsEvent 内的 sessionId 校验兜底。
        const isMetadata = data.type === 'title_updated' || data.type === 'session_updated'
          || data.type === 'session_deleted' || data.type === 'interaction_resolved'
          || data.type === 'pending_interactions' || data.type === 'voice_transcribed'
          || data.type === 'stream_id'
          // 插话队列区事件（2026-08-04 P2-13 修复）：均为元数据语义，被守卫吞掉会
          // 造成永久「已排队」+ outbox 泄漏锁死 SW 更新；串会话由 processWsEvent
          // 内的 sessionId 校验兜底。
          || data.type === 'interjection_applied' || data.type === 'steering_queued'
          || data.type === 'message_queued' || data.type === 'chat_ack' || data.type === 'chat_rejected'
          || data.type === 'steering_cancelled' || data.type === 'cancel_queued_result'
          || data.type === 'user_message';
        if (!isMetadata) return;
      }

      // 流式事件到达 → 重置 loading watchdog
      if (wsAttachedRef.current && data.type !== 'title_updated' && data.type !== 'session_updated'
        && data.type !== 'session_deleted' && data.type !== 'interaction_resolved'
        && data.type !== 'pending_interactions') {
        lastStreamEventAtRef.current = Date.now();
        resetWatchdog();
      }

      // ── 上下文压缩黑箱化（2026-07）：compaction_status 专用事件，不进 processWsEvent ──
      // started → 消息流插入「正在压缩上下文…」状态条（先清掉 sending/running 等 runtime 状态行）；
      // completed → 状态条就地落定为分界线（skipped 走轻提示 toast，不入消息流——
      //   done 后的 refreshCurrentSession 会立即用 transcript 重建消息，流内临时项会被抹掉）。
      // 幂等（断线重连 / 切会话回来 replay）：running 条最多一条；completed 重放时
      //   若已有等值分界线则跳过。loading 解除仍由后续 done 事件的既有路径处理。
      // 撤回排队插话的请求响应（2026-08-04 终态设计）：解锁等待中的 cancelQueuedInterjection
      if (data.type === 'cancel_queued_result') {
        const waiter = cancelWaitersRef.current.get(data.sourceRunId);
        if (waiter) {
          cancelWaitersRef.current.delete(data.sourceRunId);
          waiter(data.ok);
        }
        return;
      }

      if ((data as { type?: string }).type === 'compaction_status') {
        const evt = data as unknown as CompactionStatusEvent;
        const currentMsgs = msgRef.current.messagesRef.current;
        let runningIdx = -1;
        for (let i = currentMsgs.length - 1; i >= 0; i--) {
          if (asCompactionItem(currentMsgs[i])?.status === 'running') {
            runningIdx = i;
            break;
          }
        }

        if (evt.phase === 'started') {
          if (runningIdx < 0) {
            removeRuntimeStatusMessages(msgRef.current);
            msgRef.current.addMessage(createCompactionRunningItem());
            msgRef.current.triggerScroll();
          }
          return;
        }

        // phase === 'completed'
        const outcome = evt.compaction;
        if (outcome?.skipped) {
          // 历史太短未压缩：撤掉状态条 + 轻提示（timeoutMs 后自动消失）
          if (runningIdx >= 0) {
            msgRef.current.setMessages(
              currentMsgs.filter((_, i) => i !== runningIdx),
              { scrollToBottom: false },
            );
          }
          pushNotification({
            key: 'compaction_skipped',
            text: outcome.note || '当前会话历史很短，无需压缩',
            priority: 'medium',
            timeoutMs: 8000,
          });
          return;
        }

        // replay 幂等：消息流中已有等值 done 分界线（如切会话回来时 transcript 已含
        // compaction block，事件 buffer 又重放同一次 started+completed）则不再新增/转换，
        // 只撤掉多余的 running 状态条，保证同一次压缩只有一条分界线。
        let lastDone: CompactionMessageItem | null = null;
        for (let i = currentMsgs.length - 1; i >= 0; i--) {
          const comp = asCompactionItem(currentMsgs[i]);
          if (comp?.status === 'done') {
            lastDone = comp;
            break;
          }
        }
        const isDupe = !!lastDone
          && lastDone.summary === outcome?.summary
          && lastDone.coveredEventCount === outcome?.coveredEventCount;
        if (isDupe) {
          if (runningIdx >= 0) {
            msgRef.current.setMessages(
              currentMsgs.filter((_, i) => i !== runningIdx),
              { scrollToBottom: false },
            );
          }
          return;
        }

        if (runningIdx >= 0) {
          msgRef.current.updateMessageAt(runningIdx, (m) => compactionDoneReplacement(m.id, outcome));
        } else {
          msgRef.current.addMessage(createCompactionDoneItem(outcome));
          msgRef.current.triggerScroll();
        }
        return;
      }

      // 非 queued stream_id 会在 processWsEvent 内建立当前流绑定；先推进 generation，
      // 让更早 resume 的 active_stream 即使随后到达也无法拆掉这条新 run。
      if (data.type === 'stream_id' && !data.queued) {
        const expectedSessionId = immediateSessionIdRef.current ?? wsLatestSessionIdRef.current.value;
        const belongsToCurrent = !data.sessionId || !expectedSessionId || data.sessionId === expectedSessionId;
        if (belongsToCurrent) {
          // processWsEvent 会把缺省 runId 规范化为 null，因此比较同样的实际写入值。
          const bindingChanged = advanceStreamBindingGenerationIfChanged({
            streamId: data.streamId,
            runId: data.runId ?? null,
          });
          if (bindingChanged && stoppingRef.current) { stoppingRef.current = false; setStopping(false); }
          const runtimeSessionId = data.sessionId ?? expectedSessionId;
          if (runtimeSessionId) patchSessionRuntime(runtimeSessionId, { status: 'running', streamId: data.streamId, runId: data.runId ?? null, attached: true });
        }
      }

      // 构建处理上下文
      const ctx: WsProcessingContext = {
        msg: msgRef.current,
        session: sessionRef.current,
        selectedModelRef,
        voiceCallbackRef,
        streamIdRef,
        runIdRef,
        handledTerminalKeysRef,
        resolvedInteractionIdsRef, onInteractionResolved: finalizeInteractionProjection, onInteractionsChanged: syncInteractionRuntime,
        lastEventIdRef,
        userMsgIndex: wsUserMsgIndexRef.current,
        sessionOwnerRef,
        onModelPersist: (sessionId, model) => {
          localStorage.setItem(`agentChat.model.${sessionId}`, model);
        },
        // ─── 消息可靠性回调 ───
        ...createQueueConsistencyCallbacks({
          ackTimersRef, activeRunsBySession, confirmAuthoritativeSession, consumedInterjectionsRef,
          immediateSessionIdRef, markBubbleFailed, msgRef, mutateQueuedInterjections,
          newSessionClientMsgIdsRef, outboxRef, pendingNewSessionClientMsgIdRef, queuedInterjectionsRef,
          sessionIdRef, sessionRef, setLoading, submissionBelongsToCurrentSession, wsAttachedRef,
          wsBlockRef, wsUserMsgIndexRef,
        }),
      };

      let currentDoneBelongsToRuntime = true;
      if (data.type === 'done' && loadingRef.current) {
        const currentSid = immediateSessionIdRef.current ?? sessionIdRef.current;
        const runtime = currentSid ? activeRunsBySession.current.get(currentSid) : undefined;
        const currentUser = wsUserMsgIndexRef.current >= 0 ? msgRef.current.messagesRef.current[wsUserMsgIndexRef.current] : undefined;
        const activeSubmission = outboxRef.current.find((entry) => !entry.preserveActiveStream && submissionBelongsToCurrentSession(entry));
        const currentClientMsgId = currentUser?.type === 'user' || currentUser?.type === 'user-voice' ? currentUser.clientMsgId : activeSubmission?.clientMsgId;
        currentDoneBelongsToRuntime = sessionlessDoneBelongsToRuntime(data, { streamId: streamIdRef.current ?? runtime?.streamId, runId: runIdRef.current ?? runtime?.runId, clientMsgId: currentClientMsgId });
        if (!currentDoneBelongsToRuntime) { if (data.error && data.client_msg_id) ctx.onChatRejected?.(data.client_msg_id, 'enqueue_failed', data.error); else ctx.onChatDone?.(data.client_msg_id, data.error); return; }
      }

      if ((data.type === 'permission_request' || data.type === 'ask_user') && sessionIdRef.current
        && !resolvedInteractionIdsRef.current.has(interactionKey(sessionIdRef.current, data.interactionId))) {
        patchSessionRuntime(sessionIdRef.current, {
          status: data.type === 'permission_request' ? 'waiting_approval' : 'waiting_user', source: 'ws',
          attached: true,
        });
      }

      const result = processWsEvent(
        data, ctx, wsBlockRef.current,
        wsLatestSessionIdRef.current,
        immediateSessionIdRef.current ?? sessionIdRef.current,
      );
      if (data.type === 'chat_rejected' && data.reason_code === 'server_draining') reconnectAfterServerDrain();
      // 新建会话 → replaceState（不创建历史记录）
      if (data.type === 'session' && 'sessionId' in data) {
        const authoritativeSessionId = (data as any).sessionId as string;
        if (data.client_msg_id) confirmAuthoritativeSession(data.client_msg_id, authoritativeSessionId); if (data.sandboxProfile) hydrateSandboxProfile(authoritativeSessionId, data.sandboxProfile);
        // 自己发起的新会话流：id 确定后纳入未读追踪，确保切走后流完成（idle）时能标记未读
        trackedAiReplyStreamsRef.current.add((data as any).sessionId);
        // 专职 Agent 挂起 ref 此时才清（2026-07 审查 F9）：会话真实建立、
        // 服务端已写 meta 绑定 orgAgentId，后续 resume 以 meta 为准
        // Keep the canonical target until the session list projection carries the persisted binding.
        pendingNewSessionClientMsgIdRef.current = null;
        assignPendingGroup(authoritativeSessionId);
      }

      if (data.type === 'session_updated' && !data.isNew) {
        trackedAiReplyStreamsRef.current.delete(data.sessionId);
      }

      if (result === 'buffer_overflow') {
        wsBlockRef.current = { currentBlockIndex: -1, currentBlockType: null };
        sessionRef.current.refreshCurrentSession();
        const overflowSid = sessionIdRef.current;
        if (overflowSid) {
          const detailPromise = sessionRef.current.loadDetailPromiseRef.current;
          void (async () => {
            try { await detailPromise; } catch { /* ignore */ }
            if (sessionIdRef.current !== overflowSid) return;
            sendCorrelatedResume({
              action: 'resume',
              sessionId: overflowSid,
              lastEventId: 0,
              lastEventCursor: null,
              skipReplay: true,
            }).catch(() => {});
          })();
        }
        return;
      }

      if (result === 'done') {
        const doneEvent = data as Extract<WsEvent, { type: 'done' }>;
        const latestSid = wsLatestSessionIdRef.current.value || sessionIdRef.current;
        if (latestSid === sessionIdRef.current) {
          sessionRef.current.setContextUsage(null);
        }
        // 已 detach（切换会话后）或 loading 已被其他路径（watchdog/reject）清掉：
        // 本轮 outbox 条目已由 onChatDone 清理；已 ACK 的插话由服务端消费或回退执行。
        if (!loadingRef.current) {
          return;
        }
        clearWatchdog();
        const runtimeStillActive = Boolean(latestSid && isActiveRuntimeStatus(activeRunsBySession.current.get(latestSid)?.status));
        if (!runtimeStillActive) dispatchConnection('complete');
        if (latestSid) {
          trackedAiReplyStreamsRef.current.delete(latestSid);
          if (doneEvent.error) {
            // done.error：本轮 run 失败,必须把失败明确地呈现给用户,而不是只静默清 loading。
            // 用户侧通俗文案;原始 doneEvent.error（model error）仅保留在 server.log + PG runtime_events。
            // 协调：shared/wsEventProcessor 在 done 时若所有 user 气泡都已 failed,会注入一条同样
            //   通俗的 text 兜底（mobile 等不支持 system-error 的客户端也能看到）。
            //   web 端要升级成红边 system-error,所以扫尾 N 条找那条 text,有则就地替换、无则追加。
            // dedupe：若最末已是相同 content 的 system-error（重复 done 事件）则跳过。
            const alertContent = formatRuntimeFailureMessage(doneEvent.error, doneEvent.failureKind);
            const alertSeverity = isInsufficientCreditsFailure(doneEvent.error) ? 'billing' : 'error';
            const msgs = msgRef.current.messagesRef.current;
            const last = msgs[msgs.length - 1];
            if (!(last?.type === 'system-error' && isSameRunMessage(last, doneEvent.runId, alertContent) && last.failureKind === doneEvent.failureKind && last.recoveryAction === doneEvent.recoveryAction)) {
              // 扫最末 3 条找 wsEventProcessor 刚注入的同内容 text 兜底消息,就地升级
              let upgradeIdx = -1;
              for (let i = msgs.length - 1; i >= Math.max(0, msgs.length - 3); i--) {
                const m = msgs[i];
                if (m.type === 'text' && m.content === alertContent) {
                  upgradeIdx = i;
                  break;
                }
              }
              if (upgradeIdx >= 0) {
                msgRef.current.updateMessageAt(upgradeIdx, (m) => ({
                  id: m.id,
                  type: 'system-error',
                  content: alertContent,
                  severity: alertSeverity, runId: doneEvent.runId, ...(doneEvent.failureKind ? { failureKind: doneEvent.failureKind } : {}), ...(doneEvent.recoveryAction ? { recoveryAction: doneEvent.recoveryAction } : {}),
                  timestamp: Date.now(),
                }));
              } else {
                msgRef.current.addMessage({
                  type: 'system-error',
                  content: alertContent,
                  severity: alertSeverity, runId: doneEvent.runId, ...(doneEvent.failureKind ? { failureKind: doneEvent.failureKind } : {}), ...(doneEvent.recoveryAction ? { recoveryAction: doneEvent.recoveryAction } : {}),
                  timestamp: Date.now(),
                });
              }
            }
          }
          // 即时 patch：从本地消息提取最后一条文本作为 preview
          const msgs = msgRef.current.messagesRef.current;
          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m.type === 'text' && m.content) {
              sessionRef.current.updateSessionMeta(latestSid, {
                preview: (m.content as string).slice(0, 200),
                updatedAtMs: Date.now(),
              });
              break;
            }
          }
          void sessionRef.current.loadSessions();
          void refreshTokenUsageRef.current();
          saveSessionMessages(latestSid, msgRef.current.messagesRef.current);
          // 从 API 刷新：服务端 transcript 解析会做额外转换（如 task-notification → tool_use），
          // 实时流构建的消息可能缺少这些转换，需要用服务端数据替换。
          sessionRef.current.refreshCurrentSession();
        }
        if (latestSid && runtimeStillActive && currentDoneBelongsToRuntime) {
          scheduleTerminalRuntimeProbe({ sessionId: latestSid, status: doneEvent.error ? 'failed' : stoppingRef.current ? 'cancelled' : 'completed', ...(doneEvent.runId ? { runId: doneEvent.runId } : {}), ...(doneEvent.streamId ? { streamId: doneEvent.streamId } : {}), ...(doneEvent.error ? { reason: doneEvent.error } : {}), ...(doneEvent.failureKind ? { failureKind: doneEvent.failureKind } : {}), ...(doneEvent.recoveryAction ? { recoveryAction: doneEvent.recoveryAction } : {}) });
        }
        finalizeRunningSubagents(msgRef.current);
        wsAttachedRef.current = false;
        setLoading(false);
        setStopping(false);

        // onChatDone 只移除本轮 entry；其他 acked 条目是服务端持久化插话，不能随本轮 done 丢弃。
        // 2026-08-04 终态设计：本地不再扣留排队消息，无需 done 后续发。
      }
    });

    return unsub;
  }, [dispatchConnection, scheduleTerminalRuntimeProbe]);

  /** 内部：标记 bubble 为 failed（按 clientMsgId 或回退到 userMsgIndex） */
  const markBubbleFailed = useCallback((clientMsgId: string | undefined, fallbackIndex: number, reason: string) => {
    const msgs = msgRef.current.messagesRef.current;
    let idx = -1;
    if (clientMsgId) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if ((m.type === 'user' || m.type === 'user-voice') && 'clientMsgId' in m && m.clientMsgId === clientMsgId) {
          idx = i;
          break;
        }
      }
    }
    if (idx < 0) idx = fallbackIndex;
    if (idx < 0) return;
    msgRef.current.updateMessageAt(idx, (m) => {
      if (m.type === 'user') return { ...m, status: 'failed' as const, failedReason: reason };
      if (m.type === 'user-voice') return { ...m, status: 'failed' as const, failedReason: reason };
      return m;
    });
  }, []);

  /** ACK 超时后查询服务端权威状态；网络不明时保持 verifying，绝不直接开放重试。 */
  const armAckTimeout = useCallback((clientMsgId: string) => {
    const existing = ackTimersRef.current.get(clientMsgId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      ackTimersRef.current.delete(clientMsgId);
      const entry = outboxRef.current.find((candidate) => candidate.clientMsgId === clientMsgId);
      if (!entry) return;
      console.warn(`[chat] ACK timeout for ${clientMsgId}; verifying durable status`);
      if (submissionBelongsToCurrentSession(entry)) {
        mutateQueuedInterjections((prev) => prev.map((item) => (
          item.clientMsgId === clientMsgId
            ? { ...item, status: 'verifying' as const, reason: '正在核验服务端接收状态' }
            : item
        )));
      }
      void authFetch(`/api/messages/${encodeURIComponent(clientMsgId)}/status`)
        .then(async (response) => {
          if (response.status === 404) return { status: 'not_found' as const };
          if (!response.ok) throw new Error(`status lookup failed: ${response.status}`);
          return response.json() as Promise<{
            status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
            runId: string;
            sessionId: string;
            deliveryMode: 'queue' | 'steer';
            queuePosition?: number;
            reason?: string;
          }>;
        })
        .then((status) => {
          const currentEntry = outboxRef.current.find((candidate) => candidate.clientMsgId === clientMsgId);
          if (!currentEntry || currentEntry.state === 'acked') return;
          if (status.status === 'not_found') {
            outboxRef.current = outboxRef.current.filter((candidate) => candidate.clientMsgId !== clientMsgId);
            const belongsToCurrentSession = submissionBelongsToCurrentSession(currentEntry);
            const reason = '服务端未收到该消息，请重试';
            const queuedEntry = queuedInterjectionsRef.current.some((item) => item.clientMsgId === clientMsgId);
            if (queuedEntry || currentEntry.sessionId) {
              mutateQueuedInterjections((prev) => queuedEntry
                ? prev.map((item) => item.clientMsgId === clientMsgId
                  ? { ...item, status: 'failed' as const, reason }
                  : item)
                : [...prev, {
                  clientMsgId,
                  sessionId: currentEntry.sessionId!,
                  deliveryMode: currentEntry.deliveryMode,
                  content: currentEntry.input,
                  ...(currentEntry.attachments.length ? { uploadedFiles: currentEntry.attachments } : {}),
                  status: 'failed' as const,
                  reason,
                  createdAt: currentEntry.createdAt,
                }]);
            }
            if (!belongsToCurrentSession) return;
            finalizeNotFoundSubmission({
              preserveActiveStream: currentEntry.preserveActiveStream,
              markFailed: () => {
                if (!queuedEntry && !currentEntry.sessionId) markBubbleFailed(clientMsgId, -1, reason);
              },
              clearPendingSession: () => {
                if (pendingNewSessionClientMsgIdRef.current === clientMsgId) {
                  pendingNewSessionClientMsgIdRef.current = null;
                }
                newSessionClientMsgIdsRef.current.delete(clientMsgId);
              },
              releaseTransport: () => {
                wsAttachedRef.current = false;
                setLoading(false);
              },
            });
            return;
          }

          confirmAuthoritativeSession(clientMsgId, status.sessionId);
          outboxRef.current = outboxRef.current.filter((candidate) => candidate.clientMsgId !== clientMsgId);
          const belongsToCurrentSession = submissionBelongsToCurrentSession(currentEntry, status.sessionId);
          if (status.status === 'queued') {
            const hasQueueEntry = queuedInterjectionsRef.current.some((item) => item.clientMsgId === clientMsgId);
            mutateQueuedInterjections((prev) => hasQueueEntry
              ? prev.map((item) => item.clientMsgId === clientMsgId ? {
                ...item,
                sessionId: status.sessionId,
                status: 'queued' as const,
                sourceRunId: status.runId,
                deliveryMode: status.deliveryMode,
                ...(status.queuePosition !== undefined ? { queuePosition: status.queuePosition } : {}),
                reason: undefined,
              } : item)
              : [...prev, {
                clientMsgId,
                sessionId: status.sessionId,
                sourceRunId: status.runId,
                deliveryMode: status.deliveryMode,
                ...(status.queuePosition !== undefined ? { queuePosition: status.queuePosition } : {}),
                content: currentEntry.input,
                ...(currentEntry.attachments.length ? {
                  attachments: currentEntry.attachments.flatMap((file) => file.attachmentId ? [{
                    name: file.originalName,
                    attachmentId: file.attachmentId,
                    mimeType: file.mimeType,
                    size: file.size,
                    isImage: file.isImage,
                  }] : []),
                  uploadedFiles: currentEntry.attachments,
                } : {}),
                status: 'queued' as const,
                createdAt: currentEntry.createdAt,
              }]);
            if (!hasQueueEntry && belongsToCurrentSession) {
              const messages = msgRef.current.messagesRef.current;
              const index = messages.findIndex((message) => (
                (message.type === 'user' || message.type === 'user-voice') && message.clientMsgId === clientMsgId
              ));
              if (index >= 0) {
                msgRef.current.setMessages(messages.filter((_, candidateIndex) => candidateIndex !== index), { scrollToBottom: false });
                if (wsBlockRef.current.currentBlockIndex > index) {
                  wsBlockRef.current = { ...wsBlockRef.current, currentBlockIndex: wsBlockRef.current.currentBlockIndex - 1 };
                } else if (wsBlockRef.current.currentBlockIndex === index) {
                  wsBlockRef.current = { currentBlockIndex: -1, currentBlockType: null };
                }
                if (wsUserMsgIndexRef.current > index) wsUserMsgIndexRef.current -= 1;
                else if (wsUserMsgIndexRef.current === index) wsUserMsgIndexRef.current = -1;
              }
            }
          } else {
            const projection = projectAuthoritativeSubmissionStatus(status.status);
            if (belongsToCurrentSession) {
              consumedInterjectionsRef.current.mark({ clientMsgId, sourceRunId: status.runId });
            }
            const queuedEntry = queuedInterjectionsRef.current.find((item) => item.clientMsgId === clientMsgId);
            const index = belongsToCurrentSession
              ? msgRef.current.messagesRef.current.findIndex((message) => (
                (message.type === 'user' || message.type === 'user-voice') && message.clientMsgId === clientMsgId
              ))
              : -1;
            if (projection === 'sent') {
              mutateQueuedInterjections((prev) => prev.filter((item) => item.clientMsgId !== clientMsgId));
              if (index >= 0) {
                msgRef.current.updateMessageAt(index, (message) => (
                  message.type === 'user' ? { ...message, status: 'sent' as const, failedReason: undefined } : message
                ));
              } else if (belongsToCurrentSession && queuedEntry) {
                msgRef.current.addMessage({
                  type: 'user',
                  content: queuedEntry.content,
                  ...(queuedEntry.attachments ? { attachments: queuedEntry.attachments } : {}),
                  status: 'sent',
                  timestamp: queuedEntry.createdAt,
                  clientMsgId,
                });
              }
            } else {
              const reason = status.reason
                || (projection === 'cancelled' ? '消息已取消，可重试' : '服务端执行失败，可重试');
              mutateQueuedInterjections((prev) => prev.map((item) => item.clientMsgId === clientMsgId
                ? { ...item, status: projection, reason }
                : item));
              if (index >= 0) markBubbleFailed(clientMsgId, index, reason);
              if (belongsToCurrentSession && !currentEntry.preserveActiveStream) {
                wsAttachedRef.current = false;
                setLoading(false);
              }
            }
            if (belongsToCurrentSession) sessionRef.current.refreshCurrentSession();
          }
        })
        .catch((error) => {
          // 无法核验不是发送失败。保留 outbox + verifying，重连/detail 快照会继续对账。
          console.warn(`[chat] authoritative status unavailable for ${clientMsgId}:`, error);
        });
    }, ACK_TIMEOUT_MS);
    ackTimersRef.current.set(clientMsgId, timer);
  }, [markBubbleFailed, mutateQueuedInterjections, submissionBelongsToCurrentSession]);

  // ---- 通过 WS 发送聊天消息 ----
  const sendChatViaWs = useCallback(async (
    inputText: string,
    attachments: UploadedFile[],
    showBubble: boolean,
    _voice?: never,
    existingClientMsgId?: string,
    autoApproveRunShellForMessage = autoApproveRunShellRef.current,
    preserveActiveStream = false,
    /** 用户消息默认尝试补充当前 run；无可绑定目标时由服务端作为独立 run 接续。 */
    deliveryMode: 'queue' | 'steer' = 'steer',
    /** provisional 队列只接受 session 事件给出的权威 id，避免等待 React ref 同步时再次建会话。 */
    authoritativeSessionId?: string,
  ) => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      fileUpload.reportUploadError('当前离线，消息未发送');
      return;
    }
    const activeSessionId = authoritativeSessionId
      ?? immediateSessionIdRef.current
      ?? sessionIdRef.current;
    // 自己发起的续聊流：纳入未读追踪，确保切走后流完成（idle）时能标记未读
    //（不依赖后端 busy 广播是否到达；新会话的 id 在 'session' 事件确定后再 add）
    if (activeSessionId) trackedAiReplyStreamsRef.current.add(activeSessionId);
    // 生成或复用 clientMsgId（vote 重试或 voice 二次调用时复用）
    const agentTarget = activeSessionId
      ? sessionRef.current.sessions.find(item => item.sessionId === activeSessionId)?.agentTarget
        ?? pendingAgentTargetRef.current
      : pendingAgentTargetRef.current;
    if (!agentTarget) {
      fileUpload.reportUploadError('该会话缺少可证明的 Agent 目标，仅支持查看，请联系组织管理员。');
      return;
    }
    const unavailableReason = activeSessionId
      ? sessionRef.current.sessions.find(item => item.sessionId === activeSessionId)?.agentTargetUnavailableReason
      : undefined;
    if (unavailableReason) {
      fileUpload.reportUploadError(`${unavailableReason.message}${unavailableReason.contactAdmin ? ' 请联系组织管理员。' : ''}`);
      return;
    }
    const clientMsgId = existingClientMsgId || (crypto.randomUUID?.() || `c-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const normalized = buildWebChatSubmission({
      text: inputText,
      clientMsgId,
      target: {
        ...(activeSessionId ? { sessionId: activeSessionId } : { sandboxProfile: sandboxProfileRef.current }),
        agentTarget,
      },
      deliveryMode,
      model: selectedModelRef.current ?? undefined,
      attachments,
    });
    if (!normalized.ok) {
      fileUpload.reportUploadError(`附件不可发送：${normalized.issue.message}`);
      if (preserveActiveStream) {
        mutateQueuedInterjections((prev) => prev.map((entry) => entry.clientMsgId === clientMsgId
          ? { ...entry, status: 'failed' as const, reason: normalized.issue.message }
          : entry));
      }
      return;
    }
    const submission = normalized.value;
    if (!activeSessionId) {
      pendingNewSessionClientMsgIdRef.current = clientMsgId;
      newSessionClientMsgIdsRef.current.add(clientMsgId);
    }

    if (!preserveActiveStream) {
      wsLatestSessionIdRef.current = { value: activeSessionId };
      wsBlockRef.current = { currentBlockIndex: -1, currentBlockType: null };
      lastEventIdRef.current = null;
      streamNonceRef.current += 1;
      wsAttachedRef.current = true;
    }

    let submittedUserMessageIndex = -1;
    if (showBubble) {
      msgRef.current.triggerScroll();
      submittedUserMessageIndex = msgRef.current.addMessage({
        type: "user",
        content: inputText,
        ...(submission.attachments.length > 0
          ? { attachments: submission.attachments.map(canonicalChatAttachmentToDisplay) }
          : {}),
        status: 'pending',
        timestamp: Date.now(),
        clientMsgId,
      });
      // 插话不能覆盖当前 run 的 userMsgIndex，否则目标 run 的 done 会被防串校验丢弃。
      if (!preserveActiveStream) wsUserMsgIndexRef.current = submittedUserMessageIndex;
      // 乐观更新会话列表：preview + 排序即时变化
      if (activeSessionId) {
        sessionRef.current.updateSessionMeta(activeSessionId, {
          preview: inputText.slice(0, 200),
          updatedAtMs: Date.now(),
        });
      }
    } else if (!preserveActiveStream) {
      // 语音消息：将 clientMsgId 绑定到最近那条 pending user/user-voice bubble。
      // 运行中排队消息绝不走这里：倒序猜「最近一条
      // pending」会与其他在途气泡张冠李戴，且终态设计下插话根本没有气泡。
      const msgs = msgRef.current.messagesRef.current;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if ((m.type === 'user' && m.status === 'pending')
          || (m.type === 'user-voice' && (m.status === 'transcribing' || m.status === 'uploading'))) {
          wsUserMsgIndexRef.current = i;
          // 补写 clientMsgId 到这条 bubble（之前 addMessage 时可能未带）
          msgRef.current.updateMessageAt(i, (prev) => {
            if (prev.type === 'user') return { ...prev, clientMsgId };
            if (prev.type === 'user-voice') return { ...prev, clientMsgId };
            return prev;
          });
          break;
        }
      }
    }

    // 入 outbox
    outboxRef.current.push({
      clientMsgId,
      ...(activeSessionId ? { sessionId: activeSessionId } : {}),
      deliveryMode,
      input: inputText,
      // Outbox is an in-memory UI/retry model. Keep local metadata here; the canonical adapter below
      // still strips every path from the durable/wire DTO.
      attachments: attachments.map((file) => ({ ...file })),
      ...(autoApproveRunShellForMessage ? { autoApproveRunShell: true } : {}),
      preserveActiveStream,
      state: 'sending',
      createdAt: Date.now(),
    });

    if (!preserveActiveStream) {
      upsertRuntimeStatusMessage(msgRef.current, 'sending');
      setLoading(true);
      resetWatchdog();
      dispatchConnection('connect');
    }

    const ok = await wsClient.ensureConnectedSend({
      ...toWebChatWireMessage(submission),
      // TASK-256：低风险档消息级显式携带 lowRiskOnly（与账户 tier 同一模型，不依赖
      // 服务端兜底）；ask 档会话开关开启时为全量自动批准（会话级升档）。
      ...(autoApproveRunShellForMessage ? {
        approvalPolicy: approvalPolicyPayloadForTier(approvalTierRef.current === "low-risk" ? "low-risk" : "full"),
      } : {}),
    });

    if (!ok) {
      // 传输层失败：从 outbox 移除，翻 failed
      outboxRef.current = outboxRef.current.filter(e => e.clientMsgId !== clientMsgId);
      if (preserveActiveStream) {
        // 运行中排队消息无气泡：只标队列区条目；当前流不受影响
        mutateQueuedInterjections((prev) => prev.map((entry) => (
          entry.clientMsgId === clientMsgId
            ? { ...entry, status: 'failed' as const, reason: '网络连接失败，可重试' }
            : entry
        )));
      } else {
        markBubbleFailed(
          clientMsgId,
          submittedUserMessageIndex >= 0 ? submittedUserMessageIndex : wsUserMsgIndexRef.current,
          '网络连接失败，请重试',
        );
      }
      if (!preserveActiveStream) {
        wsAttachedRef.current = false;
        setLoading(false);
      }
      if (pendingNewSessionClientMsgIdRef.current === clientMsgId) {
        pendingNewSessionClientMsgIdRef.current = null;
      }
      newSessionClientMsgIdsRef.current.delete(clientMsgId);
    } else {
      // 启动 ACK 超时定时器
      armAckTimeout(clientMsgId);
    }
  }, [dispatchConnection, armAckTimeout, markBubbleFailed, mutateQueuedInterjections, fileUpload.reportUploadError]);

  // ---- 压缩当前会话上下文（同样走 canonical V1 chat boundary）----
  const compactSession = useCallback(async () => {
    const activeSessionId = sessionIdRef.current;
    if (!activeSessionId || loadingRef.current) return;

    wsLatestSessionIdRef.current = { value: activeSessionId };
    wsBlockRef.current = { currentBlockIndex: -1, currentBlockType: null };
    lastEventIdRef.current = null;
    streamNonceRef.current += 1;
    wsAttachedRef.current = true;
    wsUserMsgIndexRef.current = -1;

    upsertRuntimeStatusMessage(msgRef.current, 'sending');
    setLoading(true);
    resetWatchdog();
    dispatchConnection('connect');

    const agentTarget = sessionRef.current.sessions.find(item => item.sessionId === activeSessionId)?.agentTarget;
    if (!agentTarget) {
      fileUpload.reportUploadError('该会话缺少可证明的 Agent 目标，仅支持查看，请联系组织管理员。');
      wsAttachedRef.current = false;
      setLoading(false);
      return;
    }
    const compactSubmission = buildWebChatSubmission({
      text: '/compact',
      clientMsgId: crypto.randomUUID?.() || `c-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      target: { sessionId: activeSessionId, agentTarget },
      deliveryMode: 'queue',
      attachments: [],
    });
    if (!compactSubmission.ok) {
      wsAttachedRef.current = false;
      setLoading(false);
      return;
    }
    const ok = await wsClient.ensureConnectedSend(toWebChatWireMessage(compactSubmission.value));

    if (!ok) {
      wsAttachedRef.current = false;
      setLoading(false);
    }
  }, [dispatchConnection]);

  const submitCurrentMessage = useCallback(async () => {
    if (!sessionRef.current.canInteractWithSession()) return; const trimmedInput = inputRef.current.trim();
    if (!trimmedInput && uploadedFilesRef.current.length === 0) return;
    if (stoppingRef.current) return;
    const releaseSubmissionSlot = acquireMessageSubmissionSlot(messageSubmissionGateRef);
    if (!releaseSubmissionSlot) return;

    try {
      const capturedInput = trimmedInput;
      const capturedAttachments = [...uploadedFilesRef.current];
      const attachmentValidation = validateWebUploadedFiles(capturedAttachments);
      if (!attachmentValidation.ok) {
        fileUpload.reportUploadError(`附件不可发送：${attachmentValidation.issue.message}`);
        return;
      }
      const capturedAttachmentDisplay = attachmentValidation.value.map(canonicalChatAttachmentToDisplay);
      if (loadingRef.current && !immediateSessionIdRef.current && !sessionIdRef.current
        && pendingNewSessionClientMsgIdRef.current) {
        fileUpload.reportUploadError('正在等待服务端确认新会话，请稍后再发送');
        return;
      }
      // React state 会批量提交；refs 必须同步清空，阻断同一帧重复点击复用旧内容。
      inputRef.current = "";
      uploadedFilesRef.current = [];
      setInput("");
      fileUpload.clearFiles();

      if (loadingRef.current) {
        const clientMsgId = crypto.randomUUID?.() || `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const queueSessionId = immediateSessionIdRef.current ?? sessionIdRef.current;
        mutateQueuedInterjections((prev) => [...prev, {
          clientMsgId,
          ...(queueSessionId ? { sessionId: queueSessionId } : {}),
          deliveryMode: 'steer',
          content: capturedInput,
          ...(capturedAttachments.length > 0 ? {
            attachments: capturedAttachmentDisplay,
            // Local queue editing keeps the complete UploadedFile; attachments above is the path-free DTO projection.
            uploadedFiles: capturedAttachments.map((file) => ({ ...file })),
          } : {}),
          status: 'sending' as const,
          createdAt: Date.now(),
        }]);
        await sendChatViaWs(
          capturedInput,
          capturedAttachments,
          false,
          undefined,
          clientMsgId,
          autoApproveRunShellRef.current,
          true,
          'steer',
        );
        return;
      }

      await sendChatViaWs(capturedInput, capturedAttachments, true, undefined, undefined, undefined, false, 'steer');
    } finally {
      releaseSubmissionSlot();
    }
  }, [setInput, fileUpload.clearFiles, fileUpload.reportUploadError, sendChatViaWs, mutateQueuedInterjections]);

  const sendMessage = useCallback(() => submitCurrentMessage(), [submitCurrentMessage]);

  // ---- 活跃会话事件流订阅 ----
  const subscribeToActiveStream = useCallback(async (
    targetSessionId: string,
    options?: { skipReplay?: boolean },
  ) => {
    await sessionRef.current.loadDetailPromiseRef.current;
    if (sessionIdRef.current !== targetSessionId) return;

    // ① 从 Map 恢复该 session 的运行态到 ref（streamId/runId/cursor）；attached 必须等本次 resume 确认
    loadSessionRuntimeToRef(targetSessionId);

    // ② HTTP /stream-status 探活（事实源已升级为 runStore,buffer 是兜底）
    let httpActive: boolean | null = null; // null = HTTP 失败,降级靠 active_stream
    let httpStreamId: string | undefined;
    let httpRunId: string | undefined;
    let httpStatus: SessionRuntimeStatus | undefined;
    const httpRequestGeneration = streamBindingGenerationRef.current;
    try {
      const statusRes = await authFetch(`/api/sessions/${targetSessionId}/stream-status`);
      if (statusRes.ok) {
        const json = await statusRes.json() as { active: boolean; streamId?: string; runId?: string; status?: string };
        httpActive = json.active;
        if (json.streamId) httpStreamId = json.streamId;
        if (json.runId) httpRunId = json.runId;
        if (isActiveRuntimeStatus(json.status)) httpStatus = json.status as SessionRuntimeStatus;
      }
    } catch { /* HTTP 失败 → httpActive 留 null,降级靠 active_stream */ }

    if (sessionIdRef.current !== targetSessionId) return;

    const httpResultStale = httpRequestGeneration !== streamBindingGenerationRef.current;
    if (!httpResultStale) {
      // HTTP 探活补回权威 runId / streamId；恢复不同 binding 时先切代，挡住旧 resume 响应。
      if (httpActive !== false && advanceStreamBindingGenerationIfChanged({ streamId: httpStreamId, runId: httpRunId }) && stoppingRef.current) { stoppingRef.current = false; setStopping(false); }
      const existingRuntime = activeRunsBySession.current.get(targetSessionId);
      if (httpActive === false && !isActiveRuntimeStatus(existingRuntime?.status)) {
        patchSessionRuntime(targetSessionId, { status: 'idle', streamId: null, runId: null, attached: false });
        streamIdRef.current = null;
        runIdRef.current = null;
        wsAttachedRef.current = false;
      } else {
        if (httpStreamId) {
          patchSessionRuntime(targetSessionId, { streamId: httpStreamId });
          streamIdRef.current = httpStreamId;
        }
        if (httpRunId) {
          patchSessionRuntime(targetSessionId, { runId: httpRunId });
          runIdRef.current = httpRunId;
        }
      }

      if (httpActive === true) {
        // HTTP 已确认活跃 → 先恢复精确状态，人工等待不能降级成“思考中”。
        const restoredStatus = httpStatus ?? 'running';
        patchSessionRuntime(targetSessionId, { status: restoredStatus, attached: false });
        wsAttachedRef.current = false;
        const visibleStatus = runtimeStatusFromSessionStatus(restoredStatus);
        if (visibleStatus) {
          upsertRuntimeStatusMessage(msgRef.current, visibleStatus, {
            ...(httpStreamId ? { streamId: httpStreamId } : {}),
            ...(httpRunId ? { runId: httpRunId } : {}),
          });
        }
        if (!loadingRef.current) {
          setLoading(true);
          dispatchConnection('connect');
        }
      }
    }

    wsLatestSessionIdRef.current = { value: targetSessionId };
    wsBlockRef.current = { currentBlockIndex: -1, currentBlockType: null };
    wsUserMsgIndexRef.current = -1;

    // 刚加载过完整 transcript 时必须跳过旧 cursor replay；否则 snapshot 与 replay 会重叠。
    // 纯 WS 断线重连不刷新 transcript，仍从 cursor 增量追帧。
    const shouldSkipReplay = options?.skipReplay === true
      || (lastEventIdRef.current === null && !lastEventCursorRef.current);

    // 不论 HTTP active 真假都发 resume：
    //   - 让服务端清理旧订阅,绑定新 ws → 当前 stream
    //   - 服务端通过 active_stream 给前端权威信号（全局 reducer 接管）
    //   - 即使 HTTP buffer 误报 inactive,runStore 仍 active 时 active_stream{active:true} 兜底
    const ok = await sendCorrelatedResume({
      action: 'resume',
      sessionId: targetSessionId,
      lastEventId: lastEventIdRef.current ?? 0,
      lastEventCursor: lastEventCursorRef.current,
      skipReplay: shouldSkipReplay,
    });

    if (!ok && !wsAttachedRef.current && sessionIdRef.current === targetSessionId) {
      patchSessionRuntime(targetSessionId, { status: 'idle', streamId: null, runId: null, attached: false });
      streamIdRef.current = null; runIdRef.current = null;
      stoppingRef.current = false; setStopping(false);
      setLoading(false);
    }

    const resumeRuntimeVersion = runtimeVersionBySessionRef.current.get(targetSessionId) ?? 0;
    setTimeout(() => {
      if (sessionIdRef.current !== targetSessionId || resumeRuntimeVersion !== (runtimeVersionBySessionRef.current.get(targetSessionId) ?? 0)) return;
      if (loadingRef.current && !wsAttachedRef.current) {
        patchSessionRuntime(targetSessionId, { status: 'idle', streamId: null, runId: null, attached: false });
        streamIdRef.current = null; runIdRef.current = null;
        stoppingRef.current = false; setStopping(false);
        setLoading(false);
        sessionRef.current.refreshCurrentSession();
      }
    }, 30_000);
  }, [dispatchConnection, loadSessionRuntimeToRef, patchSessionRuntime]);

  const subscribeToActiveStreamRef = useRef(subscribeToActiveStream);
  subscribeToActiveStreamRef.current = subscribeToActiveStream;

  const resumeCurrentStream = useCallback(async () => {
    const targetSessionId = sessionIdRef.current;
    if (!targetSessionId) return;
    if (loadingRef.current) {
      upsertRuntimeStatusMessage(msgRef.current, 'reconnecting');
    }
    try {
      await wsClient.forceReconnect();
    } catch {
      // subscribeToActiveStream 会通过 ensureConnectedSend 再尝试一次。
    }
    if (sessionIdRef.current !== targetSessionId) return;
    await subscribeToActiveStreamRef.current(targetSessionId);
  }, []);

  // WS 连接成功后或 sessionId 变化时，检测当前会话是否有活跃流（合并为单一 useEffect 避免重复触发）
  useEffect(() => {
    if (!session.sessionId) return;
    const targetId = session.sessionId;

    const checkActiveStream = () => {
      void subscribeToActiveStreamRef.current(targetId, { skipReplay: true });
    };

    // 如果当前已经是 connected 状态，立即检测
    if (wsClient.currentState === 'connected') {
      const raf = requestAnimationFrame(checkActiveStream);
      const unsubscribe = wsClient.onStateChange((state) => {
        if (state === 'connected') checkActiveStream();
      });
      return () => { cancelAnimationFrame(raf); unsubscribe(); };
    }

    const unsubscribe = wsClient.onStateChange((state) => {
      if (state === 'connected') checkActiveStream();
    });
    return unsubscribe;
  }, [session.sessionId]);

  // 切换会话时关闭文件预览面板
  useEffect(() => {
    setPreviewFilePath(null);
  }, [session.sessionId]);

  /**
   * 安全移除单条消息（2026-08-04 P1-4 修复）：流式写入按数组下标寻址
   *（wsBlockRef.currentBlockIndex / wsUserMsgIndexRef），直接 splice 会让后续
   * text 增量静默写偏、done 归属校验错位。移除后同步修正两处下标引用。
   */
  const removeMessageAtIndex = useCallback((idx: number) => {
    const msgs = msgRef.current.messagesRef.current;
    if (idx < 0 || idx >= msgs.length) return;
    msgRef.current.setMessages(msgs.filter((_, i) => i !== idx), { scrollToBottom: false });
    if (wsBlockRef.current.currentBlockIndex > idx) {
      wsBlockRef.current = { ...wsBlockRef.current, currentBlockIndex: wsBlockRef.current.currentBlockIndex - 1 };
    } else if (wsBlockRef.current.currentBlockIndex === idx) {
      wsBlockRef.current = { currentBlockIndex: -1, currentBlockType: null };
    }
    if (wsUserMsgIndexRef.current > idx) wsUserMsgIndexRef.current -= 1;
    else if (wsUserMsgIndexRef.current === idx) wsUserMsgIndexRef.current = -1;
  }, []);

  // ---- Retry failed message / continue interrupted reply ----
  // 运行时已经先做透明自动恢复；只有终态仍失败时才展示“继续生成”。点击后发送一条新的“继续”，
  // 不重放原始请求，避免工具已产生副作用时重复执行。
  const retryMessage = useCallback((message: MessageItem) => {
    if (message.type === 'system-error') {
      if (message.severity === 'billing' || message.severity === 'cancelled' || loadingRef.current) return;
      const msgs = msg.messagesRef.current;
      const idx = msgs.findIndex(m => m.id === message.id);
      if (idx >= 0) removeMessageAtIndex(idx);
      setInput("");
      void sendChatViaWs('继续', [], true);
      return;
    }

    if (message.type !== 'user' || message.status !== 'failed') return;
    const text = typeof message.content === 'string' ? message.content : '';
    const retryFiles: UploadedFile[] = (message.attachments ?? []).flatMap((attachment) => (
      attachment.attachmentId
        ? [{
          attachmentId: attachment.attachmentId,
          originalName: attachment.name,
          relativePath: '',
          size: attachment.size ?? 0,
          mimeType: attachment.mimeType ?? 'application/octet-stream',
          isImage: attachment.isImage ?? false,
        }]
        : []
    ));
    const retryValidation = validateWebUploadedFiles(retryFiles);
    if ((message.attachments?.length ?? 0) !== retryFiles.length || !retryValidation.ok) {
      fileUpload.reportUploadError('附件标识已失效，请保留文字并重新上传附件');
      setInput(text);
      return;
    }
    if (!text && retryFiles.length === 0) {
      setInput(text);
      return;
    }
    const msgs = msg.messagesRef.current;
    const idx = msgs.findIndex(m => m.id === message.id);
    if (idx >= 0) removeMessageAtIndex(idx);
    // 清理该 clientMsgId 的旧 ACK 定时器
    if (message.clientMsgId) {
      const t = ackTimersRef.current.get(message.clientMsgId);
      if (t) { clearTimeout(t); ackTimersRef.current.delete(message.clientMsgId); }
      outboxRef.current = outboxRef.current.filter(e => e.clientMsgId !== message.clientMsgId);
    }
    // 复用原 clientMsgId（2026-08-04 P2-9 修复）：「ACK 丢失但服务端已受理」是超时的
    // 最常见成因——重发同 id 命中服务端永久幂等键并返回原 run 当前 ACK，已处理完
    // 则回 completed/failed/cancelled 终态，真正未送达时仍以同 id 创建。换新 id 会让
    // 同一句话被入队/执行两次。
    const retryClientMsgId = message.clientMsgId
      || (crypto.randomUUID?.() || `c-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    if (loadingRef.current) {
      // 运行中重试仍按普通 queue；复用 clientMsgId，由服务端永久幂等键消除重复执行。
      setInput("");
      mutateQueuedInterjections((prev) => [
        ...prev.filter((entry) => entry.clientMsgId !== retryClientMsgId),
        {
          clientMsgId: retryClientMsgId,
          ...((immediateSessionIdRef.current ?? sessionIdRef.current)
            ? { sessionId: (immediateSessionIdRef.current ?? sessionIdRef.current)! }
            : {}),
          deliveryMode: 'queue' as const,
          content: text,
          ...(message.attachments?.length ? {
            attachments: message.attachments,
            uploadedFiles: retryFiles,
          } : {}),
          status: 'sending' as const,
          createdAt: Date.now(),
        },
      ]);
      void sendChatViaWs(text, retryFiles, false, undefined, retryClientMsgId, autoApproveRunShellRef.current, true, 'queue');
    } else {
      setInput("");
      void sendChatViaWs(text, retryFiles, true, undefined, retryClientMsgId);
    }
  }, [setInput, msg, sendChatViaWs, removeMessageAtIndex, mutateQueuedInterjections, fileUpload.reportUploadError]);

  // ---- 插话队列区操作（2026-08-04 终态设计）----
  const cancelQueuedInterjection = useCallback((clientMsgId: string) => cancelQueuedEntry({
    clientMsgId, queuedInterjectionsRef, cancelWaitersRef, mutateQueuedInterjections,
    sendCancel: (sourceRunId) => wsClient.ensureConnectedSend({ action: 'cancel_queued', sourceRunId }),
  }), [mutateQueuedInterjections]);

  const editQueuedInterjection = useCallback(async (clientMsgId: string): Promise<void> => {
    const entry = queuedInterjectionsRef.current.find((item) => item.clientMsgId === clientMsgId);
    if (!entry || !await cancelQueuedInterjection(clientMsgId)) return;
    restoreQueuedEntryForEdit({ entry, mutateQueuedInterjections, setInput, uploadedFilesRef,
      replaceFiles: fileUpload.replaceFiles });
  }, [cancelQueuedInterjection, mutateQueuedInterjections, setInput, fileUpload.replaceFiles]);

  const resendQueuedInterjection = useCallback((clientMsgId: string) => resendQueuedEntry({
    clientMsgId, queuedInterjectionsRef, mutateQueuedInterjections, loadingRef, autoApproveRunShellRef, sendChatViaWs,
  }), [mutateQueuedInterjections, sendChatViaWs]);

  const dismissQueuedInterjection = useCallback((clientMsgId: string) => {
    dismissQueuedEntry(clientMsgId, mutateQueuedInterjections);
  }, [mutateQueuedInterjections]);

  // ---- Fork from message (从此编辑) ----
  const forkFromMessage = useCallback(async (message: MessageItem) => {
    if (message.type !== 'user') return;
    const sourceSessionId = sessionIdRef.current;
    if (!sourceSessionId) return;

    try {
      const res = await authFetch(`/api/sessions/${encodeURIComponent(sourceSessionId)}/fork`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blockId: message.id }),
      });
      if (!res.ok) {
        console.error('Fork failed:', res.status);
        return;
      }
      const { newSessionId, forkMessage } = await res.json();

      selectSessionWithUrl(newSessionId);
      await sessionRef.current.loadDetailPromiseRef.current;
      setInput(forkMessage);
      // 刷新会话列表，确保新会话出现在侧边栏
      void sessionRef.current.loadSessions({ fresh: true });
    } catch (err) {
      console.error('Fork failed:', err);
    }
  }, [setInput, selectSessionWithUrl]);

  // ---- 会话切换时恢复模型选择 ----
  // 仅在 sessionId 实际切换时才重置/恢复，避免 sessions 列表刷新（WS 重连、
  // session_updated 广播等）触发 effect 重跑、把用户在新会话期间的选择悄悄
  // 覆盖回默认模型。
  const prevSessionIdForModelRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!modelList) return;
    const prev = prevSessionIdForModelRef.current;
    prevSessionIdForModelRef.current = session.sessionId;

    // sessionId 没变（仅 sessions 数组引用刷新），不动 selectedModel
    if (prev === session.sessionId) return;

    if (session.sessionId) {
      const stored = localStorage.getItem(`agentChat.model.${session.sessionId}`);
      const serverModel = session.sessions.find(
        (s) => s.sessionId === session.sessionId,
      )?.model;
      // 校验持久化的 model ref 是否仍在当前模型列表中。模型被删/改名
      // （如 opus 4.7→4.8）后旧 ref 失效，若直接塞给 <Select> 会找不到
      // 对应项显示空、逼用户手选。失效时回退到 default。
      const isValidRef = (ref: string | null | undefined): boolean =>
        !!ref && modelList.groups.some((g) =>
          g.models.some((m) => `${g.id}/${m.id}` === ref),
        );
      setSelectedModel(
        isValidRef(stored)
          ? stored!
          : isValidRef(serverModel)
            ? serverModel!
            : modelList.default,
      );
    } else if (prev !== undefined) {
      // 仅"由有→null"时（用户主动新会话）重置；首挂载 prev===undefined 时
      // 让 selectedModel 的初始化逻辑处理，不在此处覆盖
      setSelectedModel(modelList.default);
    }
  }, [session.sessionId, session.sessions, modelList]);

  useEffect(() => {
    return () => {
      for (const t of ackTimersRef.current.values()) clearTimeout(t);
      ackTimersRef.current.clear();
      wsClient.disconnect();
    };
  }, []);

  return {
    messages: msg.messages,
    input,
    loading: effectiveLoading, sandboxProfile, setSandboxProfile,
    sessionId: session.sessionId,
    sessions: session.sessions, sessionAccessMode: session.sessionAccessMode,
    activeTab,
    governanceRoute: governanceRouteState,
    platformAdminSection,
    platformAdminEntityId,
    tenantAdminSection,
    settingsOpen,
    settingsSection,
    uploadedFiles: fileUpload.uploadedFiles,
    uploading: fileUpload.uploading,
    uploadError: fileUpload.uploadError,
    dismissUploadError: fileUpload.dismissUploadError,
    isDragging: fileUpload.isDragging,
    isLoadingSessions: session.isLoadingSessions,
    isLoadingMessages: session.isLoadingMessages, sessionLoadError: session.sessionLoadError, retrySessionLoad: session.retrySessionLoad,
    hasMoreHistory: session.hasMoreHistory,
    isLoadingEarlier: session.isLoadingEarlier,
    loadEarlierMessages: session.loadEarlierMessages,
    deleteSessionId: session.deleteSessionId,
    deleteSessionCount: session.deleteSessionCount,
    lastMessageRef: msg.lastMessageRef,
    scrollContainerRef: msg.scrollContainerRef,
    isNearBottomRef: msg.isNearBottomRef,
    setInput,
    setActiveTab,
    pushActiveTab,
    setPlatformAdminRoute,
    setTenantAdminRoute,
    openSettings,
    closeSettings,
    setSettingsSection,
    adminSettings,
    openAdminSettings,
    closeAdminSettings,
    setAdminSettingsSection,
    newSession: newSessionWithUrl,
    selectSession: selectSessionWithUrl,
    startOrgAgentSession,
    startAgentTargetSession,
    pendingAgentTarget,
    pendingOrgAgentId,
    confirmDeleteSession: session.confirmDeleteSession,
    confirmDeleteSessions: session.confirmDeleteSessions,
    cancelDeleteSession: session.cancelDeleteSession,
    handleDeleteSession: session.handleDeleteSession,
    renameSession: session.renameSession,
    autoTitleSession: session.autoTitleSession,
    compactSession,
    removeFile: fileUpload.removeFile,
    handleFileSelect: fileUpload.handleFileSelect,
    handleAssetSelect: fileUpload.handleAssetSelect,
    handlePaste: fileUpload.handlePaste,
    sendMessage,
    stopping,
    stopGeneration: cancelActiveStream,
    queuedInterjections,
    cancelQueuedInterjection,
    editQueuedInterjection,
    resendQueuedInterjection,
    dismissQueuedInterjection,
    retryMessage,
    forkFromMessage,
    handleDragOver: fileUpload.handleDragOver,
    handleDragLeave: fileUpload.handleDragLeave,
    handleDrop: fileUpload.handleDrop,
    handlePermissionResponse,
    handleAskUserResponse,
    modelList,
    selectedModel,
    onModelChange: handleModelChange,
    autoApproveRunShell: effectiveAutoApproveRunShell,
    setAutoApproveRunShell,
    tokenUsage: session.tokenUsage,
    contextUsage: session.contextUsage,
    notifications,
    dismissNotification,
    lastMemoryRecall,
    dismissMemoryRecall,
    pluginInstallStatus,
    runningSessionIds: effectiveRunningSessionIds,
    sessionRuntimeStatuses: effectiveSessionRuntimeStatuses,
    connectionState,
    refreshCurrentSession: session.refreshCurrentSession,
    resumeCurrentStream,
    hasMoreSessions: session.hasMore,
    isLoadingMoreSessions: session.isLoadingMore,
    loadMoreSessions: session.loadMoreSessions,
    loadGroupSessions: session.loadGroupSessions,
    agentProfile,
    sessionParticipants,
    previewFilePath,
    previewFileOwner,
    previewMode,
    openFilePreview,
    dockFilePreview,
    expandFilePreview,
    closeFilePreview,
    fileBrowserOpen,
    toggleFileBrowser,
    closeFileBrowser,
    isTrashPreview,
    previewTrashSession: (id: string | null) => { void previewTrashSession(id); },
    trashPreviewSessionId,
    sendVoiceMessage: async (_wavBlob: Blob, _durationMs: number) => {
      fileUpload.reportUploadError('Web 端不新增录音；请使用 Mobile 录音，Web 可安全回放已有语音');
    },
  };
}
