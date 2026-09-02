import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Alert, AppState, type AppStateStatus } from "react-native";
import { File } from "expo-file-system";
import type {
  MessageItem,
  AskUserAnswers,
  UploadedFile,
  ApiSessionListItem,
  TokenUsage,
  ContextUsageData,
  ModelList,
  WsEvent,
  WsEnvelope,
  WsProcessingContext,
  WsBlockState,
  ChatQueueSnapshot,
  ChatQueueItem,
  CanonicalVoiceSubmission,
  AgentTarget,
  AgentTargetCatalog,
  AgentTargetUnavailableReason,
  OrgAgentSummary,
} from "@agent/shared";
import {
  wsClient,
  authFetch,
  processWsEvent,
  finalizeRunningSubagents,
  getPlatform,
  useConnectionState,
  fetchAgentProfile,
  INPUT_DRAFT_KEY,
  createChatClientState,
  createInteractionRequestId,
  reduceChatClientState,
  selectChatClientQueueItems,
  cacheKeyForIdentity,
  adaptAgentTargetCatalogResponse,
  resolveNewSessionAgentTarget,
} from "@agent/shared";
import type {
  ConnectionState,
  AgentProfile,
  SessionParticipants,
} from "@agent/shared";
import { useMessages } from "./useMessages";
import { useSession } from "./useSession";
import { useFileUpload } from "./useFileUpload";
import { useAuth } from "../contexts/AuthContext";
import { useLocalAppLock } from "../contexts/LocalAppLockContext";
import { isCompactionStatusEvent } from "../lib/compaction";
import { acknowledgedInteractionResponse } from "./interactionResponseAck";
import type { MessageItemInput } from "@agent/shared";
import { canonicalChatAttachmentToDisplay } from "@agent/shared";
import {
  buildMobileChatSubmission,
  toMobileChatWireMessage,
  validateMobileUploadedFiles,
} from "../lib/chatSubmissionAdapter";
import { markChatAck, markChatSubmit, observeChatEvent } from '../telemetry/chatTelemetry';
import { telemetryClient } from '../telemetry/runtime';
import { shouldProjectInteractionEvent } from '../lib/interactionProjectionFence';
import { replaceRetryBubble } from '../lib/retryBubbleTransition';

/** A response write is not an ACK; expire it so the interaction remains retryable. */
const INTERACTION_RESPONSE_ACK_TIMEOUT_MS = 15_000;

function voiceFailureAction(code: string): string {
  switch (code.toLowerCase()) {
    case 'upload_failed': return '语音上传失败，请重录；也可改用文字发送。';
    case 'stt_silence': return '未识别到有效语音，请重录或改用文字发送。';
    case 'stt_timeout': return '语音识别超时，请重试录音或改用文字发送。';
    case 'stt_not_configured': return '语音识别暂不可用，请改用文字发送。';
    default: return '语音处理失败，请重录；仍失败时可改用文字发送。';
  }
}

function createVoiceId(): string {
  const id = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.();
  if (!id) throw new Error('设备安全随机数能力不可用');
  return id;
}

function pendingInteractionKey(sessionId: string, interactionId: string): string {
  return `${sessionId}\u0000${interactionId}`;
}

type PendingInteractionResponse = {
  sessionId: string;
  interactionId: string;
  type: "permission_request" | "ask_user";
  response: Record<string, unknown>;
  version: number;
  generation: number;
  attemptId: string;
  ackTimer?: ReturnType<typeof setTimeout>;
};

export interface ChatAppState {
  messages: MessageItem[];
  /** Server-authoritative queue/runtime projection for queue UI and cold recovery. */
  chatQueueItems: ChatQueueItem[];
  input: string;
  loading: boolean;
  sessionId: string | null;
  sessions: ApiSessionListItem[];
  connectionState: ConnectionState;
  tokenUsage: TokenUsage | null;
  contextUsage: ContextUsageData | null;
  modelList: ModelList | null;
  selectedModel: string | null;
  hasMoreSessions: boolean;
  isLoadingMoreSessions: boolean;
  isLoadingSessions: boolean;
  sessionsHydrated: boolean;
  isLoadingMessages: boolean;
  hasMoreHistory: boolean;
  isLoadingEarlier: boolean;
  loadEarlierMessages: () => Promise<void>;
  // File upload
  uploadedFiles: UploadedFile[];
  uploading: boolean;
  uploadError: string | null;
  dismissUploadError: () => void;
  // Setters & actions
  setInput: (value: string) => void;
  newSession: () => void;
  startAgentTargetSession: (target: AgentTarget) => void;
  selectSession: (id: string) => void;
  agentTargetCatalog: AgentTargetCatalog<OrgAgentSummary> | null;
  agentTargetCatalogReason: AgentTargetUnavailableReason | null;
  agentTargetCatalogLoading: boolean;
  activeAgentTarget: AgentTarget | null;
  activeAgentTargetUnavailableReason: AgentTargetUnavailableReason | null;
  sendMessage: () => Promise<void>;
  stopping: boolean;
  stopGeneration: () => void;
  /** Cancel queued work for Agent switching; true means transport accepted, terminal state still comes from canonical events. */
  cancelAgentSwitchQueue: () => Promise<boolean>;
  retryMessage: (message: MessageItem) => void;
  forkFromMessage: (message: MessageItem) => Promise<string | null>;
  handlePermissionResponse: (
    interactionId: string,
    allow: boolean,
  ) => Promise<void>;
  handleAskUserResponse: (
    interactionId: string,
    answers: AskUserAnswers,
  ) => Promise<void>;
  onModelChange: (ref: string) => void;
  loadMoreSessions: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  confirmDeleteSession: (id: string) => void;
  cancelDeleteSession: () => void;
  handleDeleteSession: (id?: string) => Promise<void>;
  deleteSessionId: string | null;
  renameSession: (sessionId: string, newTitle: string) => Promise<boolean>;
  autoTitleSession: (sessionId: string) => Promise<boolean>;
  compactSession: () => Promise<void>;
  /** 上下文压缩进行中（服务端黑箱压缩，配合 loading 显示状态条） */
  compacting: boolean;
  /** 压缩轻提示（skipped 时的 note 文案），4s 自动消失 */
  compactionNotice: string | null;
  shouldScrollRef: React.MutableRefObject<boolean>;
  isNearBottomRef: React.MutableRefObject<boolean>;
  // File
  pickFile: () => Promise<void>;
  pickImage: () => Promise<void>;
  takePhoto: () => Promise<void>;
  removeFile: (index: number) => void;
  /** 系统级分享流程：把已上传成功的文件灌入当前输入框附件区 */
  addUploadedFiles: (files: UploadedFile[]) => void;
  // Voice
  sendVoiceMessage: (fileUri: string, durationMs: number) => Promise<void>;
  // Voice callback for TTS auto-play
  voiceCallbackRef: React.MutableRefObject<
    | ((key: string, text: string, voice?: string, speed?: number) => void)
    | undefined
  >;
  refreshCurrentSession: () => void;
  markCurrentSessionRead: () => Promise<void>;
  // Agent profile and target catalog
  agentProfile: AgentProfile | null;
  // Session participants (admin 查看他人会话时的身份信息)
  sessionParticipants: SessionParticipants | null;
  // Admin owner filter
  ownerFilter: string | null;
  setOwnerFilter: (filter: string | null) => void;
}

export function useChatAppStateCore(): ChatAppState {
  const { user, identity } = useAuth();
  const localAppLock = useLocalAppLock();
  const isAdmin = user?.role === "admin";
  const [agentTargetCatalog, setAgentTargetCatalog] = useState<AgentTargetCatalog<OrgAgentSummary> | null>(null);
  const [agentTargetCatalogReason, setAgentTargetCatalogReason] = useState<AgentTargetUnavailableReason | null>(null);
  const [agentTargetCatalogLoading, setAgentTargetCatalogLoading] = useState(true);
  const agentTargetCatalogOwnerKey = user ? `${user.tenantId}:${user.id}` : 'anonymous';
  const agentTargetCatalogOwnerKeyRef = useRef(agentTargetCatalogOwnerKey);
  agentTargetCatalogOwnerKeyRef.current = agentTargetCatalogOwnerKey;
  const [pendingAgentTarget, setPendingAgentTargetState] = useState<AgentTarget | null>(null);
  const pendingAgentTargetRef = useRef<AgentTarget | null>(null);
  const setPendingAgentTarget = useCallback((target: AgentTarget | null) => {
    pendingAgentTargetRef.current = target;
    setPendingAgentTargetState(target);
  }, []);

  const refreshAgentTargetCatalog = useCallback(async () => {
    const requestOwnerKey = agentTargetCatalogOwnerKey;
    if (!user) {
      setAgentTargetCatalog(null);
      setAgentTargetCatalogReason(null);
      setAgentTargetCatalogLoading(false);
      return;
    }
    setAgentTargetCatalogLoading(true);
    try {
      const response = await authFetch('/api/org-agents/mine');
      if (!response.ok) throw new Error('target_catalog_unavailable');
      const adapted = adaptAgentTargetCatalogResponse<OrgAgentSummary>(await response.json(), user.tenantId);
      if (agentTargetCatalogOwnerKeyRef.current !== requestOwnerKey) return;
      if (adapted.kind === 'catalog') {
        setAgentTargetCatalog(adapted.catalog);
        setAgentTargetCatalogReason(null);
      } else {
        setAgentTargetCatalog(null);
        setAgentTargetCatalogReason(adapted.reason);
      }
    } catch {
      if (agentTargetCatalogOwnerKeyRef.current !== requestOwnerKey) return;
      setAgentTargetCatalog(null);
      setAgentTargetCatalogReason({ code: 'target_catalog_unavailable', message: 'Agent 目录加载失败，暂时无法发送。', contactAdmin: true });
    } finally {
      if (agentTargetCatalogOwnerKeyRef.current === requestOwnerKey) setAgentTargetCatalogLoading(false);
    }
  }, [agentTargetCatalogOwnerKey, user]);

  useEffect(() => {
    setPendingAgentTarget(null);
    void refreshAgentTargetCatalog();
  }, [refreshAgentTargetCatalog, setPendingAgentTarget]);

  // M20-04: drafts are account + tenant + generation scoped.
  const draftStorageKey = (() => { try { return cacheKeyForIdentity(identity, 'draft-text', 'new'); } catch { return null; } })();
  const [input, setInputRaw] = useState("");
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftLatestRef = useRef<string>("");
  const draftHydratedRef = useRef(false);

  const flushDraft = useCallback((value: string) => {
    try {
      if (value) {
        void Promise.resolve(
          draftStorageKey ? getPlatform().storage.setItem(draftStorageKey, value) : Promise.resolve(),
        ).catch(() => {});
      } else {
        void Promise.resolve(
          draftStorageKey ? getPlatform().storage.removeItem(draftStorageKey) : Promise.resolve(),
        ).catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }, [draftStorageKey]);

  const setInput = useCallback(
    (value: string) => {
      setInputRaw(value);
      draftLatestRef.current = value;
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
      if (!draftHydratedRef.current) return; // 初始加载期间不要反向覆盖草稿
      if (value) {
        draftTimerRef.current = setTimeout(() => {
          flushDraft(value);
        }, 2000);
      } else {
        // 清空：立即移除
        flushDraft("");
      }
    },
    [flushDraft],
  );

  // 首次加载 + AppState 变化 flush
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await getPlatform().storage.removeItem(INPUT_DRAFT_KEY);
        const saved = draftStorageKey ? await getPlatform().storage.getItem(draftStorageKey) : null;
        if (!cancelled && saved) {
          setInputRaw(saved);
          draftLatestRef.current = saved;
        }
      } catch {
        /* ignore */
      }
      draftHydratedRef.current = true;
    })();
    const sub = AppState.addEventListener("change", (state: AppStateStatus) => {
      // 前台→后台/非活跃：立即 flush 当前草稿
      if (state === "background" || state === "inactive") {
        if (draftTimerRef.current) {
          clearTimeout(draftTimerRef.current);
          draftTimerRef.current = null;
        }
        flushDraft(draftLatestRef.current);
      }
    });
    return () => {
      cancelled = true;
      sub.remove();
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    };
  }, [flushDraft]);

  const [loading, setLoading] = useState(false);
  const [stopping, setStopping] = useState(false);

  // ─── /compact v2：服务端黑箱压缩状态（2026-07-03）───
  // compacting 仅在 loading 期间有意义（UI 渲染条件 compacting && loading）；
  // compactionNotice 为 skipped 时的轻提示文案，定时自动清除。
  const [compacting, setCompacting] = useState(false);
  const [compactionNotice, setCompactionNotice] = useState<string | null>(null);
  const compactionNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const showCompactionNotice = useCallback((text: string) => {
    setCompactionNotice(text);
    if (compactionNoticeTimerRef.current) {
      clearTimeout(compactionNoticeTimerRef.current);
    }
    compactionNoticeTimerRef.current = setTimeout(() => {
      compactionNoticeTimerRef.current = null;
      setCompactionNotice(null);
    }, 4000);
  }, [draftStorageKey, flushDraft]);
  useEffect(() => {
    return () => {
      if (compactionNoticeTimerRef.current) {
        clearTimeout(compactionNoticeTimerRef.current);
      }
    };
  }, []);

  const streamNonceRef = useRef(0);
  const streamIdRef = useRef<string | null>(null);
  const lastEventIdRef = useRef<number | null>(null);
  const lastEventCursorRef = useRef<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const handledTerminalKeysRef = useRef(new Set<string>());

  interface SessionRuntimeState {
    streamId: string | null;
    runId: string | null;
    lastEventId: number | null;
    lastEventCursor: string | null;
    blockState: WsBlockState;
    latestSessionId: string | null;
    userMsgIndex: number;
    attached: boolean;
    loading: boolean;
    stopping: boolean;
  }
  const sessionRuntimeRef = useRef<Map<string, SessionRuntimeState>>(new Map());

  // ─── 消息可靠性：outbox 队列 + ACK 超时跟踪（2026-04-18）───
  interface OutboxEntry {
    clientMsgId: string;
    input: string;
    attachments: UploadedFile[];
    voice?: CanonicalVoiceSubmission;
    sessionId?: string;
    state: "sending" | "verifying" | "acked";
    createdAt: number;
  }
  const outboxRef = useRef<OutboxEntry[]>([]);
  const pendingVoiceRef = useRef<{ base: CanonicalVoiceSubmission; serverText: string } | null>(null);
  const ackTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const ACK_TIMEOUT_MS = 15_000;

  /** 生成新的 clientMsgId（使用 globalThis.crypto，RN 0.72+ 支持；缺失时回退） */
  const genClientMsgId = useCallback((): string => {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c?.randomUUID) return c.randomUUID();
    return `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }, []);

  const [modelList, setModelList] = useState<ModelList | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const selectedModelRef = useRef(selectedModel);
  selectedModelRef.current = selectedModel;

  const voiceCallbackRef = useRef<
    | ((key: string, text: string, voice?: string, speed?: number) => void)
    | undefined
  >(undefined);

  const [ownerFilter, setOwnerFilter] = useState<string | null>(
    isAdmin && user?.username ? user.username : null,
  );
  const ownerFilterInitRef = useRef(false);
  useEffect(() => {
    if (!ownerFilterInitRef.current && isAdmin && user?.username) {
      ownerFilterInitRef.current = true;
      setOwnerFilter(user.username);
    }
  }, [isAdmin, user?.username]);

  // ---- Agent Profile / owner projection ----
  const [agentProfile, setAgentProfile] = useState<AgentProfile | null>(null);
  useEffect(() => {
    if (!user) {
      setAgentProfile(null);
      return;
    }
    const targetUser =
      ownerFilter && ownerFilter !== "__others__" ? ownerFilter : user.username;
    fetchAgentProfile(targetUser)
      .then(setAgentProfile)
      .catch(() => setAgentProfile(null));
  }, [user, ownerFilter]);

  // ---- Session participants（admin 查看他人会话时的身份信息）----
  const [sessionParticipants, setSessionParticipants] =
    useState<SessionParticipants | null>(null);

  // Fetch model list with retry (re-fetch after login, on WS reconnect)
  const modelListRef = useRef(modelList);
  modelListRef.current = modelList;
  const fetchModelList = useCallback(() => {
    authFetch("/api/models")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const d = data as ModelList | null;
        if (d) {
          setModelList(d);
          setSelectedModel((prev) => prev || d.default);
        }
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!user) return;
    fetchModelList();
  }, [user?.username, fetchModelList]);

  const msg = useMessages();
  // M40-01: Mobile and Web share one queue/interaction lifecycle reducer. This hook only
  // keeps composer/upload presentation and unacknowledged transport intents locally.
  const chatClientStateRef = useRef(createChatClientState(identity));
  const [chatQueueItems, setChatQueueItems] = useState<ChatQueueItem[]>([]);
  const refreshSelectedQueue = useCallback(() => {
    setChatQueueItems(selectChatClientQueueItems(chatClientStateRef.current, sessionIdRef.current));
  }, []);
  const applyAuthoritativeWsEvent = useCallback((event: WsEvent, fallbackSessionId?: string) => {
    chatClientStateRef.current = reduceChatClientState(chatClientStateRef.current, {
      type: 'ws', event, fallbackSessionId, generation: chatClientStateRef.current.generation,
    });
    const authoritativeIds = new Set(Object.values(chatClientStateRef.current.queues)
      .flatMap((queue) => Object.keys(queue.items)));
    if (authoritativeIds.size > 0) {
      outboxRef.current = outboxRef.current.filter((entry) => !authoritativeIds.has(entry.clientMsgId));
      for (const clientMsgId of authoritativeIds) {
        const timer = ackTimersRef.current.get(clientMsgId);
        if (timer) { clearTimeout(timer); ackTimersRef.current.delete(clientMsgId); }
      }
    }
    refreshSelectedQueue();
  }, [refreshSelectedQueue]);
  const applyQueueSnapshot = useCallback((sessionId: string, snapshot: ChatQueueSnapshot) => {
    if (snapshot.sessionId !== sessionId) return;
    chatClientStateRef.current = reduceChatClientState(chatClientStateRef.current, {
      type: 'queue', sessionId, event: { type: 'snapshot', snapshot }, generation: chatClientStateRef.current.generation,
    });
    refreshSelectedQueue();
  }, [refreshSelectedQueue]);
  useEffect(() => {
    chatClientStateRef.current = reduceChatClientState(chatClientStateRef.current, { type: 'identity_boundary', identity });
    refreshSelectedQueue();
  }, [identity, refreshSelectedQueue]);
  const { connectionState, dispatchConnection } = useConnectionState();
  const fileUpload = useFileUpload({
    available: !localAppLock.locked && !localAppLock.offlineShell && connectionState !== 'disconnected',
    identityKey: identity ? `${identity.tenantId}:${identity.userId}:${identity.generation}` : 'anonymous',
  });

  const voiceIdentityKey = identity ? `${identity.tenantId}:${identity.userId}:${identity.generation}` : 'anonymous';
  const voiceIdentityRef = useRef(voiceIdentityKey);
  useEffect(() => {
    if (voiceIdentityRef.current !== voiceIdentityKey) {
      pendingVoiceRef.current = null;
      voiceIdentityRef.current = voiceIdentityKey;
    }
  }, [voiceIdentityKey]);

  const loadingRef = useRef(loading);
  loadingRef.current = loading;
  const stoppingRef = useRef(stopping);
  stoppingRef.current = stopping;
  const msgRef = useRef(msg);
  msgRef.current = msg;
  // 交互回复以服务端 ACK 为准；同一 interaction 在 ACK 到达前只允许一次提交。
  const pendingInteractionResponsesRef = useRef(new Map<string, PendingInteractionResponse>());
  const interactionResponseGenerationRef = useRef(new Map<string, number>());
  const sessionIdRef = useRef<string | null>(null);
  const releaseInteractionResponse = useCallback((key: string, generation: number, error: string) => {
    const pending = pendingInteractionResponsesRef.current.get(key);
    if (!pending || pending.generation !== generation) return;
    if (pending.ackTimer) clearTimeout(pending.ackTimer);
    pendingInteractionResponsesRef.current.delete(key);
    if (sessionIdRef.current !== pending.sessionId) return;
    // Keep the card pending, so its normal UI is immediately retryable.
    msgRef.current.addMessage({
      type: "system-error",
      severity: "error",
      content: `回复未确认：${error}。请重试。`,
      timestamp: Date.now(),
    });
  }, []);
  const releaseAllInteractionResponses = useCallback((error: string) => {
    for (const [key, pending] of [...pendingInteractionResponsesRef.current]) {
      releaseInteractionResponse(key, pending.generation, error);
    }
  }, [releaseInteractionResponse]);
  const settleInteractionResponse = useCallback((sessionId: string, interactionId: string) => {
    const key = pendingInteractionKey(sessionId, interactionId);
    const pending = pendingInteractionResponsesRef.current.get(key);
    if (!pending) return;
    if (pending.ackTimer) clearTimeout(pending.ackTimer);
    pendingInteractionResponsesRef.current.delete(key);
  }, []);
  // 同步更新的 sessionId ref（解决 React 批量更新时 sessionIdRef 延迟问题）
  const immediateSessionIdRef = useRef<string | null>(null);
  const refreshTokenUsageRef = useRef<() => void>(() => {});

  const wsBlockRef = useRef<WsBlockState>({
    currentBlockIndex: -1,
    currentBlockType: null,
  });
  const wsLatestSessionIdRef = useRef<{ value: string | null }>(null!);
  const wsUserMsgIndexRef = useRef(-1);
  /** 是否已挂载到某个流（detach 后为 false，发起/订阅流时为 true） */
  const wsAttachedRef = useRef(false);
  const saveRuntimeForSession = useCallback(
    (sid: string | null = sessionIdRef.current) => {
      if (!sid) return;
      sessionRuntimeRef.current.set(sid, {
        streamId: streamIdRef.current,
        runId: runIdRef.current,
        lastEventId: lastEventIdRef.current,
        lastEventCursor: lastEventCursorRef.current,
        blockState: { ...wsBlockRef.current },
        latestSessionId: wsLatestSessionIdRef.current?.value ?? null,
        userMsgIndex: wsUserMsgIndexRef.current,
        attached: wsAttachedRef.current,
        loading: loadingRef.current,
        stopping: stoppingRef.current,
      });
    },
    [],
  );

  const restoreRuntimeForSession = useCallback((sid: string) => {
    const state = sessionRuntimeRef.current.get(sid);
    if (!state) {
      streamIdRef.current = null;
      runIdRef.current = null;
      lastEventIdRef.current = null;
      lastEventCursorRef.current = null;
      wsBlockRef.current = { currentBlockIndex: -1, currentBlockType: null };
      wsLatestSessionIdRef.current = { value: sid };
      wsUserMsgIndexRef.current = -1;
      wsAttachedRef.current = false;
      setLoading(false);
      setStopping(false);
      return;
    }
    streamIdRef.current = state.streamId;
    runIdRef.current = state.runId;
    lastEventIdRef.current = state.lastEventId;
    lastEventCursorRef.current = state.lastEventCursor;
    wsBlockRef.current = { ...state.blockState };
    wsLatestSessionIdRef.current = { value: state.latestSessionId || sid };
    wsUserMsgIndexRef.current = state.userMsgIndex;
    wsAttachedRef.current = state.attached;
    setLoading(state.loading);
    setStopping(state.stopping);
  }, []);

  const clearRuntimeForSession = useCallback(
    (sid: string | null = sessionIdRef.current) => {
      if (sid) sessionRuntimeRef.current.delete(sid);
    },
    [],
  );

  const makeResumeMessage = useCallback(
    (sid: string, skipReplay = false) => ({
      action: "resume" as const,
      sessionId: sid,
      lastEventId: lastEventIdRef.current ?? 0,
      ...(lastEventCursorRef.current
        ? { lastEventCursor: lastEventCursorRef.current }
        : {}),
      skipReplay,
    }),
    [],
  );

  /** 用户点击"停止"按钮：发送 abort，等 done 到达后才恢复 UI */
  const cancelActiveStream = useCallback(() => {
    const sid = streamIdRef.current;
    const rid = runIdRef.current;
    if (!sid && !rid) return;
    void wsClient.ensureConnectedSend({
      action: "abort",
      ...(rid ? { runId: rid } : { streamId: sid || undefined }),
    });
    setStopping(true);
    // 停止时：丢弃 queued 但保留已发送的条目（让 ACK/rejected/done 继续处理）

    const nonceAtAbort = streamNonceRef.current;
    setTimeout(() => {
      if (
        streamNonceRef.current === nonceAtAbort &&
        streamIdRef.current === sid
      ) {
        streamIdRef.current = null;
        streamNonceRef.current += 1;
        lastEventIdRef.current = null;
        lastEventCursorRef.current = null;
        runIdRef.current = null;
        finalizeRunningSubagents(msgRef.current);
        setLoading(false);
        setStopping(false);
        setCompacting(false);
      }
    }, 10_000);
  }, []);

  /** 会话切换时：保存当前会话运行态并取消当前 WS 订阅，不发 abort */
  const detachFromStream = useCallback(() => {
    saveRuntimeForSession();
    streamIdRef.current = null;
    runIdRef.current = null;
    streamNonceRef.current += 1;
    wsBlockRef.current = { currentBlockIndex: -1, currentBlockType: null };
    wsLatestSessionIdRef.current = { value: null };
    wsUserMsgIndexRef.current = -1;
    wsAttachedRef.current = false;
    finalizeRunningSubagents(msgRef.current);
    setLoading(false);
    setStopping(false);
    setCompacting(false);
    // 切会话：清 outbox 中 queued（未发）条目；清所有 ACK 超时定时器
    for (const t of ackTimersRef.current.values()) clearTimeout(t);
    ackTimersRef.current.clear();
    // 立即通知服务端取消当前订阅，防止旧会话事件串流；服务端 run 不会被 abort
    wsClient.send({ action: "detach" });
  }, [saveRuntimeForSession]);

  const clearComposer = useCallback(() => {
    setInput("");
    fileUpload.clearFiles();
  }, [fileUpload]);

  const sessionCallbacks = useMemo(
    () => ({
      resetMessages: msg.resetMessages,
      setMessages: msg.setMessages,
      getMessages: () => msg.messagesRef.current,
      triggerScroll: msg.triggerScroll,
      cancelActiveStream: detachFromStream,
      clearComposer,
      onQueueSnapshot: applyQueueSnapshot,
    }),
    [
      msg.resetMessages,
      msg.setMessages,
      msg.messagesRef,
      msg.triggerScroll,
      detachFromStream,
      clearComposer,
      applyQueueSnapshot,
    ],
  );

  const session = useSession(sessionCallbacks, {
    ownerFilter,
    isAdmin,
    identity,
  });
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const currentSessionItem = session.sessionId
    ? session.sessions.find(item => item.sessionId === session.sessionId)
    : undefined;
  const activeAgentTarget = currentSessionItem?.agentTarget ?? pendingAgentTarget;
  const activeAgentTargetUnavailableReason: AgentTargetUnavailableReason | null = currentSessionItem
    ? currentSessionItem.agentTargetUnavailableReason ?? (!currentSessionItem.agentTarget && !pendingAgentTarget
      ? { code: 'legacy_binding_unproven', message: '该历史会话缺少可证明的 Agent 目标，仅支持查看', contactAdmin: true }
      : null)
    : agentTargetCatalogReason;
  const sessionOwner = useMemo(() => {
    if (!session.sessionId) return undefined;
    return session.sessions.find((s) => s.sessionId === session.sessionId)
      ?.owner?.username;
  }, [session.sessionId, session.sessions]);
  const sessionOwnerRef = useRef(sessionOwner);
  sessionOwnerRef.current = sessionOwner;

  // ---- sessionParticipants: 监听 session owner 变化，加载对应 Agent Profile ----
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
      .then((agent) => {
        if (!cancelled) setSessionParticipants({ owner, agent });
      })
      .catch(() => {
        // agent 已为 null，无需额外处理
      });
    return () => {
      cancelled = true;
    };
  }, [session.sessionOwner, user?.username]);

  sessionIdRef.current = session.sessionId;
  refreshTokenUsageRef.current = session.refreshTokenUsage;

  const handleModelChange = useCallback(
    (ref: string) => {
      setSelectedModel(ref);
      if (session.sessionId) {
        void getPlatform().storage.setItem(
          `agentChat.model.${session.sessionId}`,
          ref,
        );
      }
    },
    [session.sessionId],
  );

  // ---- Loading watchdog ----
  const watchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastStreamEventAtRef = useRef(0);

  const clearWatchdog = useCallback(() => {
    if (watchdogTimerRef.current) {
      clearTimeout(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
    }
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
      if (sid) {
        try {
          const res = await authFetch(`/api/sessions/${sid}/stream-status`);
          if (res.ok) {
            const { active } = (await res.json()) as { active: boolean };
            if (active) {
              resetWatchdog();
              return;
            }
          }
        } catch {
          /* proceed */
        }
      }
      finalizeRunningSubagents(msgRef.current);
      wsAttachedRef.current = false;
      setLoading(false);
      setStopping(false);
      setCompacting(false);
      dispatchConnection("complete");
      sessionRef.current.refreshCurrentSession();
    }, timeout);
  }, [dispatchConnection]);

  // ---- Sync 序列号（当前仅进程内，不持久化 generation/cursor） ----
  const lastUserSeqRef = useRef(0);

  // WS connection (reference-counted for multi-screen safety; recovery cursor stays process-local)
  useEffect(() => {
    let releaseRef: (() => void) | null = null;
    let unmounted = false;
    wsClient
      .acquire()
      .then((release) => {
        if (unmounted) release();
        else releaseRef = release;
      })
      .catch(() => {});
    const unsubState = wsClient.onStateChange((state) => {
      if (state === "connected") {
        dispatchConnection("connect");
        if (!modelListRef.current) fetchModelList();

        // 发送 sync 请求恢复漏掉的元数据事件；overflow 可内联当前会话权威快照。
        wsClient.setSyncSessionId?.(sessionIdRef.current);
        wsClient.send({ action: "sync", lastSeq: lastUserSeqRef.current, ...(sessionIdRef.current ? { sessionId: sessionIdRef.current } : {}) });

        if (loadingRef.current && sessionIdRef.current) {
          const targetSid = sessionIdRef.current;

          wsBlockRef.current = {
            currentBlockIndex: -1,
            currentBlockType: null,
          };
          const msgs = msgRef.current.messagesRef.current;
          const cleaned = msgs.filter(
            (m) => !("streaming" in m && m.streaming),
          );
          if (cleaned.length !== msgs.length) {
            msgRef.current.setMessages(cleaned);
          }

          const handleReconnectStream = (envelope: WsEnvelope) => {
            const d = envelope.data as WsEvent;
            if (d.type !== "active_stream") return;
            if (d.sessionId !== targetSid) return;
            unsubReconnect();
            if (!d.active) {
              wsAttachedRef.current = false;
              setLoading(false);
              sessionRef.current.refreshCurrentSession();
            } else if (d.streamId) {
              streamIdRef.current = d.streamId;
              runIdRef.current = d.runId ?? runIdRef.current;
              wsAttachedRef.current = true;
            }
          };
          let reconnectConfirmed = false;
          const unsubReconnect = wsClient.onMessage((envelope: WsEnvelope) => {
            const d = envelope.data as WsEvent;
            if (d.type !== "active_stream" || d.sessionId !== targetSid) return;
            reconnectConfirmed = true;
            handleReconnectStream(envelope);
          });
          wsClient
            .ensureConnectedSend(makeResumeMessage(targetSid, false))
            .then((ok) => {
              if (!ok) {
                unsubReconnect();
                wsAttachedRef.current = false;
                streamIdRef.current = null;
                runIdRef.current = null;
                setLoading(false);
                setStopping(false);
                sessionRef.current.refreshCurrentSession();
              }
            });
          setTimeout(() => {
            unsubReconnect();
            if (
              !reconnectConfirmed &&
              sessionIdRef.current === targetSid &&
              loadingRef.current
            ) {
              wsAttachedRef.current = false;
              streamIdRef.current = null;
              runIdRef.current = null;
              setLoading(false);
              setStopping(false);
              sessionRef.current.refreshCurrentSession();
            }
          }, 30000);
        } else {
          // sync 协议恢复元数据，仅刷新当前会话内容
          if (sessionIdRef.current) {
            sessionRef.current.refreshCurrentSession();
          }
        }
      } else if (state === "reconnecting") {
        releaseAllInteractionResponses("连接已断开");
        if (loadingRef.current) dispatchConnection("drop");
      } else if (state === "disconnected") {
        releaseAllInteractionResponses("连接已断开");
        if (loadingRef.current) dispatchConnection("reconnect_fail");
      }
    });
    return () => {
      unmounted = true;
      unsubState();
      releaseRef?.();
      // 清 ACK 超时定时器
      for (const t of ackTimersRef.current.values()) clearTimeout(t);
      ackTimersRef.current.clear();
      for (const pending of pendingInteractionResponsesRef.current.values()) {
        if (pending.ackTimer) clearTimeout(pending.ackTimer);
      }
      pendingInteractionResponsesRef.current.clear();
    };
  }, [dispatchConnection, makeResumeMessage, releaseAllInteractionResponses]);

  /** 按 clientMsgId 或 fallbackIndex 把 bubble 翻 failed */
  const markBubbleFailed = useCallback(
    (
      clientMsgId: string | undefined,
      fallbackIndex: number,
      reason: string,
    ) => {
      const msgs = msgRef.current.messagesRef.current;
      let idx = -1;
      if (clientMsgId) {
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (
            (m.type === "user" || m.type === "user-voice") &&
            "clientMsgId" in m &&
            m.clientMsgId === clientMsgId
          ) {
            idx = i;
            break;
          }
        }
      }
      if (idx < 0) idx = fallbackIndex;
      if (idx < 0) return;
      msgRef.current.updateMessageAt(idx, (m) => {
        if (m.type === "user")
          return { ...m, status: "failed" as const, failedReason: reason };
        if (m.type === "user-voice")
          return { ...m, status: "failed" as const, failedReason: reason };
        return m;
      });
    },
    [],
  );

  /** ACK 超时只代表结果未知：保留原 intent/clientMsgId，人工 retry 必须复用。 */
  const armAckTimeout = useCallback(
    (clientMsgId: string) => {
      const existing = ackTimersRef.current.get(clientMsgId);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        ackTimersRef.current.delete(clientMsgId);
        const entry = outboxRef.current.find((item) => item.clientMsgId === clientMsgId);
        if (entry) entry.state = "verifying";
        console.warn(`[chat] ACK timeout for ${clientMsgId}`);
        markBubbleFailed(clientMsgId, -1, "发送超时，请重试");
        if (
          loadingRef.current &&
          outboxRef.current.every((e) => e.state !== "acked")
        ) {
          wsAttachedRef.current = false;
          clearRuntimeForSession();
          setLoading(false);
        }
      }, ACK_TIMEOUT_MS);
      ackTimersRef.current.set(clientMsgId, timer);
    },
    [markBubbleFailed, clearRuntimeForSession],
  );

  // Send chat via WS
  const sendChatViaWs = useCallback(
    async (
      inputText: string,
      attachments: UploadedFile[],
      showBubble: boolean,
      voice?: CanonicalVoiceSubmission,
      existingClientMsgId?: string,
      retryMessageId?: string,
    ): Promise<boolean> => {
      if (localAppLock.locked || localAppLock.offlineShell || connectionState === 'disconnected') {
        Alert.alert('无法发送', localAppLock.locked ? '请先解锁应用' : '当前离线，消息未发送');
        return false;
      }
      const activeSessionId = sessionIdRef.current;
      const agentTarget = activeSessionId
        ? sessionRef.current.sessions.find(item => item.sessionId === activeSessionId)?.agentTarget
          ?? pendingAgentTargetRef.current
        : pendingAgentTargetRef.current;
      const unavailableReason = activeSessionId
        ? sessionRef.current.sessions.find(item => item.sessionId === activeSessionId)?.agentTargetUnavailableReason
        : agentTargetCatalogReason;
      if (!agentTarget || unavailableReason) {
        Alert.alert('仅支持查看', unavailableReason?.message ?? '该会话缺少可证明的 Agent 目标，请联系组织管理员。');
        return false;
      }
      const clientMsgId = existingClientMsgId || genClientMsgId();
      const normalized = buildMobileChatSubmission({
        text: inputText,
        clientMsgId,
        target: { ...(activeSessionId ? { sessionId: activeSessionId } : {}), agentTarget },
        deliveryMode: 'queue',
        model: selectedModelRef.current ?? undefined,
        attachments,
        ...(voice ? { voice } : {}),
      });
      if (!normalized.ok) {
        fileUpload.reportUploadError(`附件不可发送：${normalized.issue.message}`);
        return false;
      }
      const submission = normalized.value;
      markChatSubmit(clientMsgId, activeSessionId ?? undefined);

      wsLatestSessionIdRef.current = { value: activeSessionId };
      wsBlockRef.current = { currentBlockIndex: -1, currentBlockType: null };
      lastEventIdRef.current = null;
      streamNonceRef.current += 1;
      wsAttachedRef.current = true;

      if (showBubble) {
        msgRef.current.triggerScroll();
        const nextBubble: MessageItemInput = {
          type: "user",
          content: inputText,
          ...(submission.attachments.length > 0
            ? { attachments: submission.attachments.map(canonicalChatAttachmentToDisplay) }
            : {}),
          status: "pending",
          timestamp: Date.now(),
          clientMsgId,
        };
        const retryTransition = retryMessageId
          ? replaceRetryBubble(msgRef.current.messagesRef.current, retryMessageId, nextBubble)
          : null;
        if (retryTransition) {
          wsUserMsgIndexRef.current = retryTransition.index;
          msgRef.current.setMessages(retryTransition.messages);
        } else {
          wsUserMsgIndexRef.current = msgRef.current.addMessage(nextBubble);
        }
        if (activeSessionId) {
          sessionRef.current.updateSessionMeta(activeSessionId, {
            preview: inputText.slice(0, 200),
            updatedAtMs: Date.now(),
          });
        }
      } else {
        // 排队/语音消息：绑定 clientMsgId 到最近的 pending user/user-voice bubble
        const msgs = msgRef.current.messagesRef.current;
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (
            (m.type === "user" && m.status === "pending") ||
            (m.type === "user-voice" &&
              (m.status === "transcribing" || m.status === "uploading" || m.status === "ready"))
          ) {
            wsUserMsgIndexRef.current = i;
            msgRef.current.updateMessageAt(i, (prev) => {
              if (prev.type === "user") return { ...prev, clientMsgId };
              if (prev.type === "user-voice") return { ...prev, clientMsgId };
              return prev;
            });
            break;
          }
        }
      }

      const nextOutboxEntry: OutboxEntry = {
        clientMsgId,
        input: inputText,
        sessionId: activeSessionId ?? undefined,
        attachments: submission.attachments.map((attachment) => ({
          attachmentId: attachment.attachmentId,
          originalName: attachment.display.originalName,
          relativePath: '',
          size: attachment.display.size ?? 0,
          mimeType: attachment.display.mimeType ?? 'application/octet-stream',
          isImage: attachment.display.isImage ?? false,
        })),
        ...(submission.voice ? { voice: submission.voice } : {}),
        state: "sending",
        createdAt: Date.now(),
      };
      const existingOutboxIndex = outboxRef.current.findIndex((entry) => entry.clientMsgId === clientMsgId);
      if (existingOutboxIndex >= 0) outboxRef.current[existingOutboxIndex] = nextOutboxEntry;
      else outboxRef.current.push(nextOutboxEntry);

      setLoading(true);
      setCompacting(false); // 普通消息轮：清掉可能残留的压缩状态
      resetWatchdog();
      dispatchConnection("connect");

      const ok = await wsClient.ensureConnectedSend({
        ...toMobileChatWireMessage(submission),
      });

      if (!ok) {
        outboxRef.current = outboxRef.current.filter(
          (e) => e.clientMsgId !== clientMsgId,
        );
        markBubbleFailed(
          clientMsgId,
          wsUserMsgIndexRef.current,
          "网络连接失败，请重试",
        );
        wsAttachedRef.current = false;
        setLoading(false);
        return false;
      }
      armAckTimeout(clientMsgId);
      return true;
    },
    [dispatchConnection, armAckTimeout, markBubbleFailed, genClientMsgId, localAppLock.locked, localAppLock.offlineShell, connectionState, agentTargetCatalogReason],
  );


  const resolveInteractionResponse = useCallback((data: Extract<WsEvent, { type: "respond_ok" | "respond_error" }>) => {
    const ackAttemptId = data.clientAttemptId;
    const candidates = [...pendingInteractionResponsesRef.current.entries()].filter(([, pending]) =>
      pending.interactionId === data.interactionId
      && (!data.sessionId || pending.sessionId === data.sessionId)
      && (!ackAttemptId || pending.attemptId === ackAttemptId),
    );
    const matched = candidates.length === 1 ? candidates[0] : undefined;
    if (!matched) return;
    const [key, pending] = matched;
    if (ackAttemptId === undefined && pending.generation > 1) return;
    if (data.version !== undefined && data.version !== pending.version) return;

    if (pending.ackTimer) clearTimeout(pending.ackTimer);
    if (data.type === 'respond_ok' && data.status === 'accepted') return; // accepted is non-terminal; wait for canonical outcome
    pendingInteractionResponsesRef.current.delete(key);

    if (data.type === "respond_ok") {
      sessionRef.current.applySessionInteractionEvent?.({
        type: 'resolved',
        sessionId: pending.sessionId,
        interactionId: pending.interactionId,
      });
    }
    // ACK 归属原会话；用户已切到其他会话时不得修改当前消息投影。
    if (sessionIdRef.current !== pending.sessionId) return;

    const idx = msgRef.current.messagesRef.current.findIndex((m) =>
      m.type === pending.type && m.interactionId === pending.interactionId,
    );
    if (idx < 0) return;

    if (data.type === "respond_ok") {
      const canonicalResponse = acknowledgedInteractionResponse(data, pending.response);
      msgRef.current.updateMessageAt(idx, (m) => {
        if (m.type !== pending.type || m.interactionId !== pending.interactionId || m.status !== "pending") return m;
        return m.type === "permission_request"
          ? { ...m, status: canonicalResponse.allow ? "allowed" as const : "denied" as const }
          : { ...m, status: "answered" as const, answers: canonicalResponse.answers as AskUserAnswers };
      });
      return;
    }

    // 失败时卡片始终保持 pending，用户可直接重试；错误另以系统消息可见地呈现。
    msgRef.current.updateMessageAt(idx, (m) =>
      m.type === pending.type && m.interactionId === pending.interactionId
        ? { ...m, status: "pending" as const }
        : m,
    );
    const reason = data.error || "服务端拒绝了该回复";
    Alert.alert("回复未提交", `${reason}。请重试。`);
    msgRef.current.addMessage({
      type: "system-error",
      severity: "error",
      content: `回复未提交：${reason}。请重试。`,
      timestamp: Date.now(),
    });
  }, []);

  // WS message handler (wsClient already fences old epochs, gaps, and duplicate callbacks)
  useEffect(() => {
    const projectSessionListInteraction = (event: WsEvent) => {
      const fallbackSessionId = immediateSessionIdRef.current ?? sessionIdRef.current;
      if (event.type === 'pending_interactions' && event.sessionId) {
        const authoritativeSessionId = event.sessionId;
        sessionRef.current.applySessionInteractionEvent?.({ type: 'terminal', sessionId: authoritativeSessionId });
        event.interactions.forEach((interaction, index) => {
          sessionRef.current.applySessionInteractionEvent?.({
            type: 'requested', sessionId: authoritativeSessionId,
            interaction: {
              interactionId: interaction.interactionId,
              type: interaction.type,
              version: interaction.version ?? 0,
              order: interaction.order ?? interaction.version ?? index,
            },
          });
        });
      } else if ((event.type === 'permission_request' || event.type === 'ask_user') && fallbackSessionId) {
        sessionRef.current.applySessionInteractionEvent?.({
          type: 'requested', sessionId: fallbackSessionId,
          interaction: { interactionId: event.interactionId, type: event.type, version: event.version ?? 0, order: event.order ?? event.version ?? 0 },
        });
      } else if (event.type === 'interaction_resolved') {
        settleInteractionResponse(event.sessionId, event.interactionId);
        sessionRef.current.applySessionInteractionEvent?.({ type: 'resolved', sessionId: event.sessionId, interactionId: event.interactionId });
      } else if (event.type === 'session_status' && ['idle', 'completed', 'failed', 'cancelled', 'orphaned'].includes(event.status)) {
        sessionRef.current.applySessionInteractionEvent?.({ type: 'terminal', sessionId: event.sessionId });
      }
    };
    const projectRecoveredInteraction = (event: Extract<WsEvent, { type: 'pending_interactions' | 'permission_request' | 'ask_user' | 'interaction_resolved' }>) => {
      const selectedSessionId = immediateSessionIdRef.current ?? sessionIdRef.current;
      // Test harnesses and teardown may expose an empty stream ref; keep the fence fail closed.
      if (!shouldProjectInteractionEvent(event, selectedSessionId, wsLatestSessionIdRef.current?.value)) return;
      const ctx: WsProcessingContext = {
        msg: msgRef.current,
        session: sessionRef.current,
        selectedModelRef,
        voiceCallbackRef,
        streamIdRef,
        runIdRef,
        handledTerminalKeysRef,
        lastEventIdRef,
        userMsgIndex: wsUserMsgIndexRef.current,
        sessionOwnerRef,
      };
      processWsEvent(
        event,
        ctx,
        wsBlockRef.current,
        wsLatestSessionIdRef.current,
        immediateSessionIdRef.current ?? sessionIdRef.current,
      );
    };
    const unsub = wsClient.onMessage((envelope: WsEnvelope) => {
      const data = envelope.data as WsEvent;
      observeChatEvent(data, sessionIdRef.current ?? undefined);
      if (!data || !data.type) return;
      projectSessionListInteraction(data);
      if (data.type === 'queue_snapshot' || data.type === 'queue_item_updated' || data.type === 'message_queued'
        || data.type === 'session_status' || data.type === 'done' || data.type === 'interjection_applied'
        || data.type === 'steering_cancelled' || data.type === 'cancel_queued_result') {
        applyAuthoritativeWsEvent(data, sessionIdRef.current ?? undefined);
      }

      if (envelope.eventId != null) {
        lastEventIdRef.current = envelope.eventId;
      }
      if (envelope.eventCursor != null) {
        lastEventCursorRef.current = envelope.eventCursor;
      }
      if (data.type === "stream_id") {
        streamIdRef.current = data.streamId;
        runIdRef.current = data.runId ?? null;
      } else if (data.type === "session_status" && data.runId) {
        runIdRef.current = data.runId;
      }

      if (data.type === "respond_ok" || data.type === "respond_error") {
        resolveInteractionResponse(data);
        return;
      }
      if (data.type === "abort_ok" || data.type === "active_stream") {
        return;
      }

      // ── sync 协议响应 ──
      if (data.type === "sync_ok") {
        lastUserSeqRef.current = (data as any).seq;
        wsClient.setLastSeq((data as any).seq);
        for (const { event } of (data as any).events || []) {
          const e = event as WsEvent;
          projectSessionListInteraction(e);
          applyAuthoritativeWsEvent(e, sessionIdRef.current ?? undefined);
          if (e.type === "session_status" && e.sessionId === sessionIdRef.current) {
            runIdRef.current = e.runId ?? null;
            streamIdRef.current = e.streamId ?? null;
            const active = !["idle", "completed", "failed", "cancelled", "orphaned"].includes(e.status);
            wsAttachedRef.current = active;
            setLoading(active);
          }
          if (e.type === "pending_interactions" || e.type === "permission_request"
            || e.type === "ask_user" || e.type === "interaction_resolved") {
            projectRecoveredInteraction(e);
          }
          if (e.type === "title_updated")
            sessionRef.current.updateSessionTitle(e.sessionId, e.title);
          else if (e.type === "session_updated") {
            if ((e as any).isNew && sessionRef.current.upsertSession) {
              sessionRef.current.upsertSession({
                sessionId: e.sessionId,
                preview: e.preview,
                updatedAtMs: e.updatedAtMs,
                title: (e as any).title,
                model: (e as any).model,
                username: (e as any).username,
              });
            } else {
              sessionRef.current.updateSessionMeta(e.sessionId, {
                preview: e.preview,
                updatedAtMs: e.updatedAtMs,
                ...((e as any).title !== undefined
                  ? { title: (e as any).title }
                  : {}),
              });
            }
          } else if (e.type === "session_deleted")
            sessionRef.current.removeSession(e.sessionId);
        }
        return;
      }
      if (data.type === "sync_overflow") {
        lastUserSeqRef.current = data.seq;
        wsClient.setLastSeq(data.seq);
        const inline = data.recovery?.session;
        if (inline?.queueSnapshot) {
          applyQueueSnapshot(inline.sessionId, inline.queueSnapshot);
        }
        if (inline?.runtime && inline.sessionId === sessionIdRef.current) {
          runIdRef.current = inline.runtime.runId ?? null;
          streamIdRef.current = inline.runtime.streamId ?? null;
          wsAttachedRef.current = inline.runtime.active;
          setLoading(inline.runtime.active);
        }
        if (inline?.pendingInteractions) {
          projectRecoveredInteraction({
            type: "pending_interactions",
            sessionId: inline.sessionId,
            interactions: inline.pendingInteractions,
          });
        }
        if (!inline?.queueSnapshot || !inline.runtime || !inline.pendingInteractions) {
          void sessionRef.current.loadSessions(true, { fresh: true });
          sessionRef.current.refreshCurrentSession();
        }
        return;
      }

      // ── session_status（Agent busy/terminal）──
      // 兜底：服务端会广播 completed/failed/cancelled/idle 到同用户所有连接。
      // 用于多设备/断线场景下原发起 WS 收不到 done 时，独立清掉 loading 并显式展示失败原因。
      if (data.type === "session_status") {
        const d = data as Extract<WsEvent, { type: "session_status" }>;
        const terminalStatuses = new Set([
          "idle",
          "completed",
          "failed",
          "cancelled",
          "orphaned",
        ]);
        if (
          terminalStatuses.has(d.status) &&
          d.sessionId === sessionIdRef.current &&
          loadingRef.current
        ) {
          clearWatchdog();
          finalizeRunningSubagents(msgRef.current);
          if ((d.status === "failed" || d.status === "orphaned") && d.reason) {
            const msgs = msgRef.current.messagesRef.current;
            const last = msgs[msgs.length - 1];
            const content = `运行失败：${d.reason}`;
            if (!(last?.type === "text" && last.content === content)) {
              msgRef.current.addMessage({
                type: "text",
                content,
                timestamp: Date.now(),
              });
            }
          }
          wsAttachedRef.current = false;
          setLoading(false);
          setStopping(false);
          setCompacting(false);
          outboxRef.current = [];
          dispatchConnection("complete");
          sessionRef.current.refreshCurrentSession();
        }
        return;
      }

      // ── groups_changed（由 useGroups WS 监听器处理）──
      if (data.type === "groups_changed") return;

      // 其他设备发起的流
      if (data.type === "stream_started") {
        const currentSid =
          immediateSessionIdRef.current ?? sessionIdRef.current;
        if (data.sessionId === currentSid && !loadingRef.current) {
          streamIdRef.current = data.streamId;
          wsLatestSessionIdRef.current = { value: data.sessionId };
          wsBlockRef.current = {
            currentBlockIndex: -1,
            currentBlockType: null,
          };
          wsUserMsgIndexRef.current = -1;
          lastEventIdRef.current = null;
          lastEventCursorRef.current = null;
          runIdRef.current = data.runId ?? null;
          wsAttachedRef.current = true;
          setLoading(true);
          dispatchConnection("connect");
          void wsClient.ensureConnectedSend(
            makeResumeMessage(data.sessionId, false),
          );
        }
        // 刷新会话列表，使其他设备的新会话立即可见
        void sessionRef.current.loadSessions(true, { fresh: true });
        return;
      }

      // 防串流守卫
      if (!wsAttachedRef.current) {
        // stream_id 必须放行：插话回退为独立 run 时，目标 run 的 done 已把 attached 清掉，
        // 服务端补发的接管 stream_id 若被挡在这里，整条回退流的内容与 done 都会丢失。
        const isMetadata =
          data.type === "title_updated" ||
          data.type === "session_updated" ||
          data.type === "session_deleted" ||
          data.type === "interaction_resolved" ||
          data.type === "pending_interactions" ||
          data.type === "voice_transcribed" ||
          data.type === "stream_id";
        if (!isMetadata) return;
      }

      // 流式事件到达 → 重置 loading watchdog
      if (
        wsAttachedRef.current &&
        data.type !== "title_updated" &&
        data.type !== "session_updated" &&
        data.type !== "session_deleted" &&
        data.type !== "interaction_resolved" &&
        data.type !== "pending_interactions" &&
        data.type !== "voice_transcribed"
      ) {
        lastStreamEventAtRef.current = Date.now();
        resetWatchdog();
      }

      if (data.type === "context_usage") {
        sessionRef.current.setContextUsage(data.contextUsage);
        return;
      }

      // ── /compact v2：压缩状态事件（黑箱，shared WsEvent 联合类型暂未收录，
      // 经 unknown 走类型守卫，在 processWsEvent 之前本地拦截处理）──
      const rawEvent: unknown = data;
      if (isCompactionStatusEvent(rawEvent)) {
        if (rawEvent.phase === "started") {
          setCompacting(true);
        } else if (rawEvent.phase === "completed") {
          setCompacting(false);
          const c = rawEvent.compaction;
          if (c?.skipped) {
            showCompactionNotice(c.note || "会话历史较短，无需压缩");
          } else if (c) {
            // 幂等：断线重连 replay 时同一事件会重放，用 eventId 生成稳定 id，
            // 已存在同 id 分界线则跳过（同一次压缩只渲染一条分界线）。
            const stableId =
              envelope.eventId != null
                ? `compaction-evt-${envelope.eventId}`
                : `compaction-${
                    wsLatestSessionIdRef.current?.value ||
                    sessionIdRef.current ||
                    "live"
                  }-${c.coveredEventCount}`;
            const exists = msgRef.current.messagesRef.current.some(
              (m) => m.id === stableId,
            );
            if (!exists) {
              msgRef.current.addMessage({
                id: stableId,
                type: "compaction",
                ...(c.summary ? { summary: c.summary } : {}),
                coveredEventCount: c.coveredEventCount,
                timestamp: Date.now(),
              } as unknown as MessageItemInput);
              msgRef.current.triggerScroll();
            }
          }
        }
        return;
      }

      const ctx: WsProcessingContext = {
        msg: msgRef.current,
        session: sessionRef.current,
        selectedModelRef,
        voiceCallbackRef,
        streamIdRef,
        runIdRef,
        handledTerminalKeysRef,
        lastEventIdRef,
        userMsgIndex: wsUserMsgIndexRef.current,
        sessionOwnerRef,
        onModelPersist: (sid, model) => {
          void getPlatform().storage.setItem(`agentChat.model.${sid}`, model);
        },
        // ─── 消息可靠性回调 ───
        onActiveUserMsgIndexChange: (index) => {
          // 插话回退为独立 run 的接管：把防串校验的归属索引切到接管消息的气泡
          wsUserMsgIndexRef.current = index;
        },
        onStreamAttached: () => {
          // 接管场景：目标 run 的 done 已清掉 attached，这里恢复，后续流式内容才能过守卫
          wsAttachedRef.current = true;
        },
        onChatAck: (clientMsgId, event) => {
          markChatAck(clientMsgId, event);
          const t = ackTimersRef.current.get(clientMsgId);
          if (t) {
            clearTimeout(t);
            ackTimersRef.current.delete(clientMsgId);
          }
          const entry = outboxRef.current.find(
            (e) => e.clientMsgId === clientMsgId,
          );
          if (entry) entry.state = "acked";
        },
        onChatRejected: (clientMsgId) => {
          const t = ackTimersRef.current.get(clientMsgId);
          if (t) {
            clearTimeout(t);
            ackTimersRef.current.delete(clientMsgId);
          }
          outboxRef.current = outboxRef.current.filter(
            (e) => e.clientMsgId !== clientMsgId,
          );
          if (
            outboxRef.current.every(
              (e) => e.state !== "acked" && e.state !== "sending",
            )
          ) {
            wsAttachedRef.current = false;
            setLoading(false);
          }
        },
        onChatDone: (clientMsgId) => {
          if (!clientMsgId) return;
          const t = ackTimersRef.current.get(clientMsgId);
          if (t) {
            clearTimeout(t);
            ackTimersRef.current.delete(clientMsgId);
          }
          outboxRef.current = outboxRef.current.filter(
            (e) => e.clientMsgId !== clientMsgId,
          );
        },
      };

      if (
        (data.type === 'pending_interactions' || data.type === 'permission_request'
          || data.type === 'ask_user' || data.type === 'interaction_resolved')
        && !shouldProjectInteractionEvent(
          data,
          immediateSessionIdRef.current ?? sessionIdRef.current,
          wsLatestSessionIdRef.current?.value,
        )
      ) {
        return;
      }

      const result = processWsEvent(
        data,
        ctx,
        wsBlockRef.current,
        wsLatestSessionIdRef.current,
        immediateSessionIdRef.current ?? sessionIdRef.current,
      );

      if (data.type === "session" && "sessionId" in data) {
        immediateSessionIdRef.current = data.sessionId;
      }

      if (result === "buffer_overflow") {
        telemetryClient()?.capture('sync_overflow', { correlationId: 'ws-sync-overflow', ...(sessionIdRef.current ? { sessionId: sessionIdRef.current } : {}) });
        wsBlockRef.current = { currentBlockIndex: -1, currentBlockType: null };
        sessionRef.current.refreshCurrentSession();
        const overflowSid = sessionIdRef.current;
        if (overflowSid) {
          const detailPromise = sessionRef.current.loadDetailPromiseRef.current;
          void (async () => {
            try {
              await detailPromise;
            } catch {
              /* ignore */
            }
            if (sessionIdRef.current !== overflowSid) return;
            wsClient
              .ensureConnectedSend({
                ...makeResumeMessage(overflowSid, true),
              })
              .catch(() => {});
          })();
        }
        return;
      }

      if (result === "done") {
        // 已 detach（切换会话后）或 loading 已被其他路径清掉：
        // 仍需清理本轮 acked/sending，并推进排队消息。
        if (!loadingRef.current) {
          outboxRef.current = outboxRef.current.filter((e) => e.state !== "sending" && e.state !== "acked");
          return;
        }
        clearWatchdog();
        dispatchConnection("complete");
        const latestSid =
          wsLatestSessionIdRef.current?.value || sessionIdRef.current;
        if (latestSid) {
          // 即时 patch：从本地消息提取最后一条文本作为 preview
          const msgs = msgRef.current.messagesRef.current;
          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m.type === "text" && m.content) {
              sessionRef.current.updateSessionMeta(latestSid, {
                preview: (m.content as string).slice(0, 200),
                updatedAtMs: Date.now(),
              });
              break;
            }
          }
          void sessionRef.current.loadSessions(true);
          void refreshTokenUsageRef.current();
          getPlatform().messageCache.save(
            latestSid,
            msgRef.current.messagesRef.current,
          );
        }
        finalizeRunningSubagents(msgRef.current);
        wsAttachedRef.current = false;
        clearRuntimeForSession(latestSid);
        setLoading(false);
        setStopping(false);
        setCompacting(false);

        // M20-02: done only settles presentation; it never dispatches business work.
      }
    });
    return unsub;
  }, [
    dispatchConnection,
    sendChatViaWs,
    makeResumeMessage,
    clearRuntimeForSession,
    showCompactionNotice,
    settleInteractionResponse,
  ]);

  // Subscribe to active stream on session change
  useEffect(() => {
    if (!session.sessionId) return;
    const targetId = session.sessionId;

    const checkActiveStream = async () => {
      if (loadingRef.current) return;
      await sessionRef.current.loadDetailPromiseRef.current;
      if (sessionIdRef.current !== targetId || loadingRef.current) return;

      if (sessionIdRef.current !== targetId || loadingRef.current) return;

      restoreRuntimeForSession(targetId);
      // 恢复 cursor/runId 作为 resume 线索，但 attached 必须等服务端 active_stream 重新确认。
      wsAttachedRef.current = false;

      // 乐观设置 loading：是否活跃以后端 active_stream 为准，不再因 HTTP inactive 跳过 replay
      setLoading(true);
      dispatchConnection("connect");

      wsLatestSessionIdRef.current = { value: targetId };
      wsBlockRef.current = { currentBlockIndex: -1, currentBlockType: null };
      wsUserMsgIndexRef.current = -1;

      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      const handleActiveStream = (envelope: WsEnvelope) => {
        const data = envelope.data as WsEvent;
        if (data.type !== "active_stream" || data.sessionId !== targetId)
          return;
        unsub();
        if (timeoutId) clearTimeout(timeoutId);

        if (sessionIdRef.current !== targetId) {
          // 会话已切换，回退（仅在未被其他流程接管时）
          if (!wsAttachedRef.current) {
            setLoading(false);
          }
          return;
        }
        if (!data.active) {
          // 服务端确认不活跃 → 清掉陈旧运行态并回退乐观状态
          wsAttachedRef.current = false;
          streamIdRef.current = null;
          runIdRef.current = null;
          setLoading(false);
          setStopping(false);
          clearRuntimeForSession(targetId);
          sessionRef.current.refreshCurrentSession();
          return;
        }
        // 确认活跃 → 完成订阅
        if (data.streamId) streamIdRef.current = data.streamId;
        runIdRef.current = data.runId ?? runIdRef.current;
        wsAttachedRef.current = true;
        // loading 已经是 true，无需重复设置
      };

      const unsub = wsClient.onMessage(handleActiveStream);

      const ok = await wsClient.ensureConnectedSend(
        makeResumeMessage(targetId, false),
      );

      if (!ok) {
        unsub();
        setLoading(false); // 回退
        return;
      }

      // 安全超时：30 秒内若 active_stream 未到达，回退 loading
      timeoutId = setTimeout(() => {
        unsub();
        if (loadingRef.current && sessionIdRef.current === targetId) {
          wsAttachedRef.current = false;
          streamIdRef.current = null;
          runIdRef.current = null;
          setLoading(false);
          setStopping(false);
          clearRuntimeForSession(targetId);
          sessionRef.current.refreshCurrentSession();
        }
      }, 30_000);
    };

    if (wsClient.currentState === "connected") {
      void checkActiveStream();
    }
    const unsubscribe = wsClient.onStateChange((state) => {
      if (state === "connected") void checkActiveStream();
    });
    return unsubscribe;
  }, [
    session.sessionId,
    dispatchConnection,
    makeResumeMessage,
    restoreRuntimeForSession,
    clearRuntimeForSession,
  ]);

  // Model restore on session change
  // 仅在 sessionId 实际切换时才重置/恢复；避免 sessions 列表刷新（WS 重连、
  // session_updated 广播等）触发 effect 重跑、把用户在新会话期间的选择悄悄
  // 覆盖回默认模型。AsyncStorage 异步读取还需 cancel flag 防止过期回调写回。
  const prevSessionIdForModelRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!modelList) return;
    const prev = prevSessionIdForModelRef.current;
    prevSessionIdForModelRef.current = session.sessionId;

    // sessionId 没变（仅 sessions 数组引用刷新），不动 selectedModel
    if (prev === session.sessionId) return;

    if (session.sessionId) {
      let cancelled = false;
      void (async () => {
        const stored = await getPlatform().storage.getItem(
          `agentChat.model.${session.sessionId}`,
        );
        if (cancelled) return;
        if (stored) {
          setSelectedModel(stored as string);
        } else {
          const serverModel = session.sessions.find(
            (s) => s.sessionId === session.sessionId,
          )?.model;
          setSelectedModel(serverModel || modelList.default);
        }
      })();
      return () => {
        cancelled = true;
      };
    } else if (prev !== undefined) {
      // 仅"由有→null"时（用户主动新会话）重置；首挂载 prev===undefined 时
      // 让 selectedModel 的初始化逻辑处理，不在此处覆盖
      setSelectedModel(modelList.default);
    }
  }, [session.sessionId, session.sessions, modelList]);

  // ---- 压缩当前会话上下文（同样走 canonical V1 chat boundary）----
  const compactSession = useCallback(async () => {
    const activeSessionId = sessionIdRef.current;
    if (!activeSessionId || loadingRef.current) return;

    wsLatestSessionIdRef.current = { value: activeSessionId };
    wsBlockRef.current = { currentBlockIndex: -1, currentBlockType: null };
    lastEventIdRef.current = null;
    streamNonceRef.current += 1;
    wsAttachedRef.current = true;

    setLoading(true);
    // 乐观显示「正在压缩上下文…」状态条；服务端 compaction_status started 会再次确认
    setCompacting(true);
    resetWatchdog();
    dispatchConnection("connect");

    const agentTarget = sessionRef.current.sessions.find(item => item.sessionId === activeSessionId)?.agentTarget;
    if (!agentTarget) {
      Alert.alert('仅支持查看', '该会话缺少可证明的 Agent 目标，请联系组织管理员。');
      wsAttachedRef.current = false;
      setLoading(false);
      setCompacting(false);
      return;
    }
    const compactSubmission = buildMobileChatSubmission({
      text: "/compact",
      clientMsgId: genClientMsgId(),
      target: { sessionId: activeSessionId, agentTarget },
      deliveryMode: "queue",
      attachments: [],
    });
    if (!compactSubmission.ok) {
      wsAttachedRef.current = false;
      setLoading(false);
      setCompacting(false);
      return;
    }
    const ok = await wsClient.ensureConnectedSend(toMobileChatWireMessage(compactSubmission.value));

    if (!ok) {
      wsAttachedRef.current = false;
      setLoading(false);
      setCompacting(false);
    }
  }, [dispatchConnection, genClientMsgId]);

  // Send message (text + files)
  const sendMessage = useCallback(async () => {
    if (!activeAgentTarget || activeAgentTargetUnavailableReason) {
      Alert.alert('无法发送', activeAgentTargetUnavailableReason?.message ?? '没有可用的 Agent 目标，请联系组织管理员。');
      return;
    }
    const trimmedInput = input.trim();
    const pendingFiles = fileUpload.uploadedFiles;
    if (!trimmedInput && pendingFiles.length === 0) return;
    const attachmentValidation = validateMobileUploadedFiles(pendingFiles);
    if (!attachmentValidation.ok) {
      fileUpload.reportUploadError(`附件不可发送：${attachmentValidation.issue.message}`);
      // Fail closed before consuming attachments or clearing the text draft.
      return;
    }
    const capturedFiles = fileUpload.consumeFiles();
    const pendingVoice = pendingVoiceRef.current;
    const voice = pendingVoice && capturedFiles.some((file) => file.attachmentId === pendingVoice.base.attachmentId)
      ? { ...pendingVoice.base, transcript: { ...pendingVoice.base.transcript, text: trimmedInput, edited: trimmedInput !== pendingVoice.serverText } }
      : undefined;
    pendingVoiceRef.current = null;
    if (voice) {
      const voiceIndex = msg.messagesRef.current.findIndex((message) => message.type === 'user-voice' && message.attachmentId === voice.attachmentId);
      if (voiceIndex >= 0) msg.updateMessageAt(voiceIndex, (message) => message.type === 'user-voice'
        ? { ...message, transcribedText: voice.transcript.text }
        : message);
    }
    setInput("");

    // Voice reaches chat only after the user reviews/edits the authoritative transcript and presses Send.
    void sendChatViaWs(trimmedInput, capturedFiles, !voice, voice);
  }, [activeAgentTarget, activeAgentTargetUnavailableReason, input, fileUpload, msg, sendChatViaWs]);

  // Record -> controlled M50-03 upload -> authoritative STT -> editable draft. No automatic dispatch.
  const sendVoiceMessage = useCallback(async (fileUri: string, durationMs: number) => {
    const voiceIntentId = createVoiceId();
    const uploadRequestId = createVoiceId();
    const transcriptionRequestId = createVoiceId();
    const durationSec = Math.round(durationMs / 1000);
    const voiceMsgIndex = msg.addMessage({
      type: "user-voice", audioUrl: "", duration: durationSec, status: "uploading", timestamp: Date.now(),
    });
    msg.triggerScroll();
    try {
      const formData = new FormData();
      formData.append("files", { uri: fileUri, name: `voice_${voiceIntentId}.wav`, type: "audio/wav" } as unknown as Blob);
      const uploadRes = await authFetch("/api/upload", {
        method: "POST", body: formData, headers: { "X-Upload-Request-Id": uploadRequestId },
      });
      const uploadData = await uploadRes.json() as { success?: boolean; files?: Array<{ attachmentId?: string; originalName?: string; size?: number; mimeType?: string; isImage?: boolean }> };
      const uploaded = uploadData.files?.[0];
      if (!uploadRes.ok || !uploadData.success || !uploaded?.attachmentId) throw new Error("upload_failed");
      const audioUrl = `/api/attachments/${encodeURIComponent(uploaded.attachmentId)}/content`;
      msg.updateMessageAt(voiceMsgIndex, (m) => m.type === "user-voice"
        ? { ...m, audioUrl, attachmentId: uploaded.attachmentId, voiceIntentId, uploadRequestId, status: "transcribing" as const }
        : m);
      const sttRes = await authFetch('/api/voice/transcriptions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: transcriptionRequestId, attachmentId: uploaded.attachmentId, durationMs }),
      });
      const sttData = await sttRes.json() as { success?: boolean; result?: { transcriptionId: string; text: string; durationMs: number }; error?: { code?: string; message?: string } };
      if (!sttRes.ok || !sttData.success || !sttData.result) throw new Error(sttData.error?.code || 'stt_provider_error');
      const base: CanonicalVoiceSubmission = {
        voiceIntentId, uploadRequestId, attachmentId: uploaded.attachmentId,
        transcriptionId: sttData.result.transcriptionId, durationMs: sttData.result.durationMs,
        transcript: { status: 'ready', text: sttData.result.text, edited: false, source: 'server_stt' },
      };
      pendingVoiceRef.current = { base, serverText: sttData.result.text };
      fileUpload.addUploadedFiles([{
        attachmentId: uploaded.attachmentId, originalName: uploaded.originalName || '语音.wav', relativePath: '',
        size: uploaded.size ?? 0, mimeType: uploaded.mimeType || 'audio/wav', isImage: false,
      }]);
      setInput(sttData.result.text);
      msg.updateMessageAt(voiceMsgIndex, (m) => m.type === "user-voice"
        ? { ...m, transcribedText: sttData.result!.text, transcriptionId: sttData.result!.transcriptionId, status: "ready" as const }
        : m);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'stt_provider_error';
      const reasonCode = ['upload_failed', 'stt_provider_error', 'transcription_failed'].includes(code.toLowerCase()) ? code.toLowerCase() : 'voice_failed';
      telemetryClient()?.capture('voice_error', { correlationId: voiceIntentId, measurements: { reasonCode } });
      msg.updateMessageAt(voiceMsgIndex, (m) => m.type === "user-voice"
        ? { ...m, status: "failed" as const, failedReason: voiceFailureAction(code) }
        : m);
    } finally {
      try { new File(fileUri).delete(); } catch {}
    }
  }, [fileUpload, msg]);

  const retryMessage = useCallback(
    (message: MessageItem) => {
      if (message.type !== "user" || message.status !== "failed") return;
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
      const retryValidation = validateMobileUploadedFiles(retryFiles);
      if ((message.attachments?.length ?? 0) !== retryFiles.length || !retryValidation.ok) {
        fileUpload.reportUploadError('附件标识已失效，请保留文字并重新上传附件');
        setInput(typeof message.content === 'string' ? message.content : '');
        return;
      }
      const retryOutboxEntry = message.clientMsgId
        ? outboxRef.current.find((entry) => entry.clientMsgId === message.clientMsgId)
        : undefined;
      if (retryOutboxEntry?.sessionId && retryOutboxEntry.sessionId !== sessionIdRef.current) {
        Alert.alert('无法重试', '该消息属于另一个会话，请返回原会话后重试。');
        return;
      }
      if (message.clientMsgId) {
        const t = ackTimersRef.current.get(message.clientMsgId);
        if (t) {
          clearTimeout(t);
          ackTimersRef.current.delete(message.clientMsgId);
        }
      }
      const text = retryOutboxEntry?.input ?? (typeof message.content === "string" ? message.content : "");
      if (!text && retryFiles.length === 0) {
        setInput(text);
        return;
      }
      // 结果未知时复用原 clientMsgId，服务端幂等键保持不变；只有进入发送 attempt 后才原位替换气泡。
      setInput("");
      void sendChatViaWs(
        text,
        retryOutboxEntry?.attachments ?? retryFiles,
        true,
        retryOutboxEntry?.voice,
        message.clientMsgId,
        message.id,
      );
    },
    [msg, sendChatViaWs, fileUpload],
  );

  const respondToInteraction = useCallback(
    async (
      interactionId: string,
      type: "permission_request" | "ask_user",
      response: Record<string, unknown>,
    ) => {
      const currentSessionId = sessionIdRef.current;
      if (!currentSessionId) return;
      const key = pendingInteractionKey(currentSessionId, interactionId);
      // A live attempt owns the submit slot only inside its canonical session.
      if (pendingInteractionResponsesRef.current.has(key)) return;
      const generation = (interactionResponseGenerationRef.current.get(key) ?? 0) + 1;
      const interactionMessage = msgRef.current.messagesRef.current.find((message) =>
        (message.type === 'permission_request' || message.type === 'ask_user') && message.interactionId === interactionId,
      ) as Extract<MessageItem, { type: 'permission_request' | 'ask_user' }> | undefined;
      const version = interactionMessage?.interactionVersion;
      if (!Number.isSafeInteger(version)) return; // fail closed until authoritative interaction detail is hydrated
      interactionResponseGenerationRef.current.set(key, generation);
      const attemptId = createInteractionRequestId(currentSessionId, interactionId, response);
      pendingInteractionResponsesRef.current.set(key, {
        sessionId: currentSessionId,
        interactionId,
        type,
        response,
        version: version!,
        generation,
        attemptId,
      });

      let ok = false;
      try {
        ok = await wsClient.ensureConnectedSend({
          action: "respond",
          interactionId,
          sessionId: currentSessionId,
          version,
          requestId: attemptId,
          clientAttemptId: attemptId,
          response,
          ...response,
        });
      } catch {
        // A transport exception has the same retry semantics as a negative ACK.
      }
      const pending = pendingInteractionResponsesRef.current.get(key);
      if (!pending || pending.generation !== generation) return;
      if (!ok) {
        releaseInteractionResponse(key, generation, "网络连接失败");
        return;
      }
      pending.ackTimer = setTimeout(() => {
        releaseInteractionResponse(key, generation, "等待服务端确认超时");
      }, INTERACTION_RESPONSE_ACK_TIMEOUT_MS);
    },
    [releaseInteractionResponse],
  );

  const handlePermissionResponse = useCallback(
    async (interactionId: string, allow: boolean) => {
      await respondToInteraction(interactionId, "permission_request", {
        allow,
        message: allow ? undefined : "User denied",
      });
    },
    [respondToInteraction],
  );

  const handleAskUserResponse = useCallback(
    async (interactionId: string, answers: AskUserAnswers) => {
      await respondToInteraction(interactionId, "ask_user", { answers });
    },
    [respondToInteraction],
  );

  // 包装 selectSession/newSession 以同步更新 immediateSessionIdRef
  const selectSessionWrapped = useCallback(
    (id: string) => {
      immediateSessionIdRef.current = id;
      setPendingAgentTarget(null);
      session.selectSession(id);
    },
    [session.selectSession, setPendingAgentTarget],
  );

  const startAgentTargetSession = useCallback((target: AgentTarget) => {
    if (!user || target.tenantId !== user.tenantId) {
      Alert.alert('无法新建会话', 'Agent 目标与当前组织不一致。');
      return;
    }
    immediateSessionIdRef.current = null;
    setPendingAgentTarget(target);
    session.newSession({ preserveComposer: true });
  }, [session.newSession, setPendingAgentTarget, user]);

  const cancelAgentSwitchQueue = useCallback(async (): Promise<boolean> => {
    const queued = chatQueueItems.filter(item => item.status === 'queued');
    const results = await Promise.all(queued.map(item => wsClient.ensureConnectedSend({
      action: 'cancel_queued',
      sourceRunId: item.sourceRunId,
    }).catch(() => false)));
    return results.every(Boolean);
  }, [chatQueueItems]);

  const newSessionWrapped = useCallback(() => {
    if (!agentTargetCatalog) {
      Alert.alert('无法新建会话', agentTargetCatalogReason?.message ?? 'Agent 目录仍在加载，请稍后重试。');
      return;
    }
    const selection = resolveNewSessionAgentTarget({ catalog: agentTargetCatalog, activeTarget: activeAgentTarget });
    if (selection.kind === 'selected') startAgentTargetSession(selection.target);
    else if (selection.kind === 'picker') Alert.alert('请选择 Agent', '请从会话列表的新建入口选择要使用的企业专家。');
    else Alert.alert('无法新建会话', selection.reason.message);
  }, [activeAgentTarget, agentTargetCatalog, agentTargetCatalogReason, startAgentTargetSession]);

  // ---- Fork from message (从此编辑) ----
  const forkFromMessage = useCallback(
    async (message: MessageItem): Promise<string | null> => {
      if (message.type !== "user") return null;
      const sourceSessionId = sessionIdRef.current;
      if (!sourceSessionId) return null;

      try {
        const res = await authFetch(
          `/api/sessions/${encodeURIComponent(sourceSessionId)}/fork`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ blockId: message.id }),
          },
        );
        if (!res.ok) return null;
        const { newSessionId, forkMessage } = (await res.json()) as {
          newSessionId: string;
          forkMessage: string;
        };

        selectSessionWrapped(newSessionId);
        await sessionRef.current.loadDetailPromiseRef.current;
        setInput(forkMessage);
        // 刷新会话列表，确保新会话出现在侧边栏
        void sessionRef.current.loadSessions(true, { fresh: true });
        return newSessionId;
      } catch (err) {
        console.error("Fork failed:", err);
        return null;
      }
    },
    [setInput, selectSessionWrapped],
  );

  return {
    messages: msg.messages,
    chatQueueItems,
    input,
    loading,
    sessionId: session.sessionId,
    sessions: session.sessions,
    connectionState,
    tokenUsage: session.tokenUsage,
    contextUsage: session.contextUsage,
    modelList,
    selectedModel,
    hasMoreSessions: session.hasMore, // session-list pager, distinct from history pager
    isLoadingMoreSessions: session.isLoadingMore,
    isLoadingSessions: session.isLoadingSessions,
    sessionsHydrated: session.sessionsHydrated,
    isLoadingMessages: session.isLoadingMessages,
    hasMoreHistory: session.hasMoreHistory,
    isLoadingEarlier: session.isLoadingEarlier,
    loadEarlierMessages: session.loadEarlierMessages,
    uploadedFiles: fileUpload.uploadedFiles,
    uploading: fileUpload.uploading,
    uploadError: fileUpload.uploadError,
    dismissUploadError: fileUpload.dismissUploadError,
    setInput,
    newSession: newSessionWrapped,
    startAgentTargetSession,
    selectSession: selectSessionWrapped,
    agentTargetCatalog,
    agentTargetCatalogReason,
    agentTargetCatalogLoading,
    activeAgentTarget,
    activeAgentTargetUnavailableReason,
    sendMessage,
    stopping,
    stopGeneration: cancelActiveStream,
    cancelAgentSwitchQueue,
    retryMessage,
    forkFromMessage,
    handlePermissionResponse,
    handleAskUserResponse,
    onModelChange: handleModelChange,
    loadMoreSessions: session.loadMoreSessions,
    refreshSessions: async () => {
      await Promise.all([session.loadSessions(false, { fresh: true }), refreshAgentTargetCatalog()]);
    },
    confirmDeleteSession: session.confirmDeleteSession,
    cancelDeleteSession: session.cancelDeleteSession,
    handleDeleteSession: session.handleDeleteSession,
    deleteSessionId: session.deleteSessionId,
    renameSession: session.renameSession,
    autoTitleSession: session.autoTitleSession,
    compactSession,
    compacting,
    compactionNotice,
    shouldScrollRef: msg.shouldScrollRef,
    isNearBottomRef: msg.isNearBottomRef, // canonical viewport authority for unread
    pickFile: fileUpload.pickFile,
    pickImage: fileUpload.pickImage,
    takePhoto: fileUpload.takePhoto,
    removeFile: fileUpload.removeFile,
    addUploadedFiles: fileUpload.addUploadedFiles,
    sendVoiceMessage,
    voiceCallbackRef,
    refreshCurrentSession: session.refreshCurrentSession,
    markCurrentSessionRead: () => session.sessionId ? session.markSessionRead(session.sessionId) : Promise.resolve(),
    agentProfile,
    sessionParticipants,
    ownerFilter,
    setOwnerFilter,
  };
}
