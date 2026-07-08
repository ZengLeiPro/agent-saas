import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { File } from "expo-file-system";
import type {
  MessageItem,
  AskUserAnswers,
  UploadedFile,
  ApiSessionListItem,
  TokenUsage,
  ModelList,
  WsEvent,
  WsEnvelope,
  WsProcessingContext,
  WsBlockState,
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
import { isCompactionStatusEvent } from "../lib/compaction";
import type { MessageItemInput } from "@agent/shared";

export interface ChatAppState {
  messages: MessageItem[];
  input: string;
  loading: boolean;
  sessionId: string | null;
  sessions: ApiSessionListItem[];
  connectionState: ConnectionState;
  tokenUsage: TokenUsage | null;
  modelList: ModelList | null;
  selectedModel: string | null;
  hasMoreSessions: boolean;
  isLoadingMoreSessions: boolean;
  isLoadingSessions: boolean;
  sessionsHydrated: boolean;
  isLoadingMessages: boolean;
  // File upload
  uploadedFiles: UploadedFile[];
  uploading: boolean;
  uploadError: string | null;
  dismissUploadError: () => void;
  // Setters & actions
  setInput: (value: string) => void;
  newSession: () => void;
  selectSession: (id: string) => void;
  sendMessage: () => Promise<void>;
  stopping: boolean;
  stopGeneration: () => void;
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
  // Agent profile
  agentProfile: AgentProfile | null;
  // Session participants (admin 查看他人会话时的身份信息)
  sessionParticipants: SessionParticipants | null;
  // Admin owner filter
  ownerFilter: string | null;
  setOwnerFilter: (filter: string | null) => void;
}

export function useChatAppStateCore(): ChatAppState {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  // ─── 输入草稿：AsyncStorage 持久化（2026-04-18）───
  // 与 web 共用 INPUT_DRAFT_KEY='agentChat.inputDraft'，全局共享草稿（不按 sessionId 分）
  const [input, setInputRaw] = useState("");
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftLatestRef = useRef<string>("");
  const draftHydratedRef = useRef(false);

  const flushDraft = useCallback((value: string) => {
    try {
      if (value) {
        void Promise.resolve(
          getPlatform().storage.setItem(INPUT_DRAFT_KEY, value),
        ).catch(() => {});
      } else {
        void Promise.resolve(
          getPlatform().storage.removeItem(INPUT_DRAFT_KEY),
        ).catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }, []);

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
        const saved = await getPlatform().storage.getItem(INPUT_DRAFT_KEY);
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
  }, []);
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
    voiceFile?: { savedPath: string; relativePath: string; duration: number };
    state: "queued" | "sending" | "acked";
    createdAt: number;
  }
  const outboxRef = useRef<OutboxEntry[]>([]);
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

  // ---- Agent Profile ----
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

  // ---- Session Participants (admin 查看他人会话时的身份信息) ----
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
  const fileUpload = useFileUpload();
  const { connectionState, dispatchConnection } = useConnectionState();

  const loadingRef = useRef(loading);
  loadingRef.current = loading;
  const stoppingRef = useRef(stopping);
  stoppingRef.current = stopping;
  const msgRef = useRef(msg);
  msgRef.current = msg;
  const sessionIdRef = useRef<string | null>(null);
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
  /** 引用 sendChatViaWs（定义在下面），用于在它之前定义的 callback 中 flush 排队消息 */
  const sendChatViaWsRef = useRef<
    | ((
        inputText: string,
        attachments: UploadedFile[],
        showBubble: boolean,
        voiceFile?: {
          savedPath: string;
          relativePath: string;
          duration: number;
        },
        existingClientMsgId?: string,
      ) => Promise<void>)
    | null
  >(null);

  /**
   * 在 loading reset 路径（ACK 超时 / chat_rejected / watchdog 后 done 到达）上推进
   * outbox 队列头部——若不调用，queued 消息会永远留在数组里 bubble pending。
   * stopping 状态下跳过（用户主动中止不自动续发）。
   */
  const flushQueuedHead = useCallback(() => {
    if (stoppingRef.current) return;
    const nextQueued = outboxRef.current.find((e) => e.state === "queued");
    if (!nextQueued) return;
    outboxRef.current = outboxRef.current.filter(
      (e) => e.clientMsgId !== nextQueued.clientMsgId,
    );
    void sendChatViaWsRef.current?.(
      nextQueued.input,
      nextQueued.attachments,
      false,
      nextQueued.voiceFile,
      nextQueued.clientMsgId,
    );
  }, []);

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
    outboxRef.current = outboxRef.current.filter((e) => e.state !== "queued");

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
    outboxRef.current = outboxRef.current.filter((e) => e.state !== "queued");
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
    }),
    [
      msg.resetMessages,
      msg.setMessages,
      msg.messagesRef,
      msg.triggerScroll,
      detachFromStream,
      clearComposer,
    ],
  );

  const session = useSession(sessionCallbacks, {
    ownerFilter,
    isAdmin,
  });
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const sessionOwner = useMemo(() => {
    if (!session.sessionId) return undefined;
    return session.sessions.find((s) => s.sessionId === session.sessionId)
      ?.owner?.username;
  }, [session.sessionId, session.sessions]);
  const sessionOwnerRef = useRef(sessionOwner);
  sessionOwnerRef.current = sessionOwner;

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

  // ---- Sync 序列号 ----
  const lastUserSeqRef = useRef(0);

  // WS connection (reference-counted for multi-screen safety)
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

        // 发送 sync 请求恢复漏掉的元数据事件
        wsClient.send({ action: "sync", lastSeq: lastUserSeqRef.current });

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
      } else if (state === "reconnecting" && loadingRef.current) {
        dispatchConnection("drop");
      } else if (state === "disconnected" && loadingRef.current) {
        dispatchConnection("reconnect_fail");
      }
    });
    return () => {
      unmounted = true;
      unsubState();
      releaseRef?.();
      // 清 ACK 超时定时器
      for (const t of ackTimersRef.current.values()) clearTimeout(t);
      ackTimersRef.current.clear();
    };
  }, [dispatchConnection, makeResumeMessage]);

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

  /** ACK 超时：15s 未收到 chat_ack → 翻 failed + 清 loading */
  const armAckTimeout = useCallback(
    (clientMsgId: string) => {
      const existing = ackTimersRef.current.get(clientMsgId);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        ackTimersRef.current.delete(clientMsgId);
        outboxRef.current = outboxRef.current.filter(
          (e) => e.clientMsgId !== clientMsgId,
        );
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
        // H-1 修复：ACK 超时路径必须主动推进排队消息
        flushQueuedHead();
      }, ACK_TIMEOUT_MS);
      ackTimersRef.current.set(clientMsgId, timer);
    },
    [markBubbleFailed, flushQueuedHead, clearRuntimeForSession],
  );

  // Send chat via WS
  const sendChatViaWs = useCallback(
    async (
      inputText: string,
      attachments: UploadedFile[],
      showBubble: boolean,
      voiceFile?: { savedPath: string; relativePath: string; duration: number },
      existingClientMsgId?: string,
    ) => {
      const activeSessionId = sessionIdRef.current;
      const clientMsgId = existingClientMsgId || genClientMsgId();

      wsLatestSessionIdRef.current = { value: activeSessionId };
      wsBlockRef.current = { currentBlockIndex: -1, currentBlockType: null };
      lastEventIdRef.current = null;
      streamNonceRef.current += 1;
      wsAttachedRef.current = true;

      if (showBubble) {
        msgRef.current.triggerScroll();
        wsUserMsgIndexRef.current = msgRef.current.addMessage({
          type: "user",
          content: inputText,
          ...(attachments.length > 0
            ? {
                attachments: attachments.map((f) => ({
                  name: f.originalName,
                  isImage: f.isImage,
                })),
              }
            : {}),
          status: "pending",
          timestamp: Date.now(),
          clientMsgId,
        });
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
              (m.status === "transcribing" || m.status === "uploading"))
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

      outboxRef.current.push({
        clientMsgId,
        input: inputText,
        attachments,
        ...(voiceFile ? { voiceFile } : {}),
        state: "sending",
        createdAt: Date.now(),
      });

      setLoading(true);
      setCompacting(false); // 普通消息轮：清掉可能残留的压缩状态
      resetWatchdog();
      dispatchConnection("connect");

      const ok = await wsClient.ensureConnectedSend({
        action: "chat",
        client_msg_id: clientMsgId,
        message: inputText || "Please check the attachments I uploaded",
        sessionId: activeSessionId || undefined,
        model: selectedModelRef.current || undefined,
        ...(attachments.length > 0
          ? {
              attachments: attachments.map((file) => ({
                originalName: file.originalName,
                savedPath: file.savedPath,
                relativePath: file.relativePath,
                size: file.size,
                mimeType: file.mimeType,
                isImage: file.isImage,
              })),
            }
          : {}),
        ...(voiceFile ? { voiceFile } : {}),
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
      } else {
        armAckTimeout(clientMsgId);
      }
    },
    [dispatchConnection, armAckTimeout, markBubbleFailed, genClientMsgId],
  );

  // 同步 sendChatViaWs 到 ref，让 flushQueuedHead 等前置 callback 可调用
  useEffect(() => {
    sendChatViaWsRef.current = sendChatViaWs;
  }, [sendChatViaWs]);

  // WS message handler
  useEffect(() => {
    const unsub = wsClient.onMessage((envelope: WsEnvelope) => {
      const data = envelope.data as WsEvent;
      if (!data || !data.type) return;

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

      if (
        data.type === "respond_ok" ||
        data.type === "respond_error" ||
        data.type === "abort_ok" ||
        data.type === "active_stream"
      ) {
        return;
      }

      // ── sync 协议响应 ──
      if (data.type === "sync_ok") {
        lastUserSeqRef.current = (data as any).seq;
        wsClient.setLastSeq((data as any).seq);
        for (const { event } of (data as any).events || []) {
          const e = event as WsEvent;
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
        lastUserSeqRef.current = (data as any).seq;
        wsClient.setLastSeq((data as any).seq);
        void sessionRef.current.loadSessions(true, { fresh: true });
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
          outboxRef.current = outboxRef.current.filter(
            (e) => e.state === "queued",
          );
          flushQueuedHead();
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
        const isMetadata =
          data.type === "title_updated" ||
          data.type === "session_updated" ||
          data.type === "session_deleted" ||
          data.type === "interaction_resolved" ||
          data.type === "pending_interactions" ||
          data.type === "voice_transcribed";
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
        lastEventIdRef,
        userMsgIndex: wsUserMsgIndexRef.current,
        sessionOwnerRef,
        onModelPersist: (sid, model) => {
          void getPlatform().storage.setItem(`agentChat.model.${sid}`, model);
        },
        // ─── 消息可靠性回调 ───
        onChatAck: (clientMsgId) => {
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
          // H-2 修复：rejected 后必须推进排队消息
          flushQueuedHead();
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

      const result = processWsEvent(
        data,
        ctx,
        wsBlockRef.current,
        wsLatestSessionIdRef.current,
        sessionIdRef.current,
      );

      if (data.type === "session" && "sessionId" in data) {
        immediateSessionIdRef.current = data.sessionId;
      }

      if (result === "buffer_overflow") {
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
          // H-3 修复：done 晚到路径也要排空 outbox 并推进队列
          outboxRef.current = outboxRef.current.filter(
            (e) => e.state === "queued",
          );
          flushQueuedHead();
          return;
        }
        clearWatchdog();
        dispatchConnection("complete");
        const latestSid =
          wsLatestSessionIdRef.current.value || sessionIdRef.current;
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

        // 从 outbox 移除已处理完的 acked/sending 条目
        outboxRef.current = outboxRef.current.filter(
          (e) => e.state === "queued",
        );

        // stopping 时不发排队消息，因为是用户主动中止
        if (!stoppingRef.current) {
          const nextQueued = outboxRef.current.find(
            (e) => e.state === "queued",
          );
          if (nextQueued) {
            outboxRef.current = outboxRef.current.filter(
              (e) => e.clientMsgId !== nextQueued.clientMsgId,
            );
            void sendChatViaWs(
              nextQueued.input,
              nextQueued.attachments,
              false,
              nextQueued.voiceFile,
              nextQueued.clientMsgId,
            );
          }
        }
      }
    });
    return unsub;
  }, [
    dispatchConnection,
    sendChatViaWs,
    makeResumeMessage,
    clearRuntimeForSession,
    showCompactionNotice,
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

  // ---- 压缩当前会话上下文 ----
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

    const ok = await wsClient.ensureConnectedSend({
      action: "chat",
      message: "/compact",
      sessionId: activeSessionId,
    });

    if (!ok) {
      wsAttachedRef.current = false;
      setLoading(false);
      setCompacting(false);
    }
  }, [dispatchConnection]);

  // Send message (text + files)
  const sendMessage = useCallback(async () => {
    const trimmedInput = input.trim();
    const capturedFiles = fileUpload.consumeFiles();
    if (!trimmedInput && capturedFiles.length === 0) return;
    setInput("");

    if (loadingRef.current) {
      // 排队：新一条消息入 outbox.queued + 渲染 pending bubble
      const queuedClientMsgId = genClientMsgId();
      outboxRef.current.push({
        clientMsgId: queuedClientMsgId,
        input: trimmedInput,
        attachments: capturedFiles,
        state: "queued",
        createdAt: Date.now(),
      });
      msgRef.current.triggerScroll();
      msgRef.current.addMessage({
        type: "user",
        content: trimmedInput,
        ...(capturedFiles.length > 0
          ? {
              attachments: capturedFiles.map((f) => ({
                name: f.originalName,
                isImage: f.isImage,
              })),
            }
          : {}),
        status: "pending",
        timestamp: Date.now(),
        clientMsgId: queuedClientMsgId,
      });
      return;
    }

    void sendChatViaWs(trimmedInput, capturedFiles, true);
  }, [input, fileUpload, sendChatViaWs, genClientMsgId]);

  // Send voice message
  const sendVoiceMessage = useCallback(
    async (fileUri: string, durationMs: number) => {
      const durationSec = Math.round(durationMs / 1000);
      const voiceMsgIndex = msg.addMessage({
        type: "user-voice",
        audioUrl: "",
        duration: durationSec,
        status: "uploading",
        timestamp: Date.now(),
      });
      msg.triggerScroll();

      let savedPath: string;
      let relativePath: string;
      try {
        const formData = new FormData();
        const filename = `voice_${Date.now()}_${Math.random().toString(36).slice(2, 10)}.wav`;
        formData.append("files", {
          uri: fileUri,
          name: filename,
          type: "audio/wav",
        } as unknown as Blob);

        const uploadRes = await authFetch("/api/upload", {
          method: "POST",
          body: formData,
        });
        if (!uploadRes.ok) throw new Error(`上传失败: ${uploadRes.status}`);
        const uploadData = (await uploadRes.json()) as {
          success: boolean;
          files?: Array<{ savedPath: string; relativePath: string }>;
        };
        if (!uploadData.success || !uploadData.files?.[0])
          throw new Error("上传响应无效");

        savedPath = uploadData.files[0].savedPath;
        relativePath = uploadData.files[0].relativePath;
      } catch (err) {
        console.error("Voice upload failed:", err);
        msg.updateMessageAt(voiceMsgIndex, (m) =>
          m.type === "user-voice" ? { ...m, status: "failed" as const } : m,
        );
        // Clean up temp file
        try {
          new File(fileUri).delete();
        } catch {}
        return;
      }

      // Update message with audio URL
      const audioUrl = `/api/voice/play?path=${encodeURIComponent(relativePath)}`;
      msg.updateMessageAt(voiceMsgIndex, (m) =>
        m.type === "user-voice"
          ? { ...m, audioUrl, status: "transcribing" as const }
          : m,
      );

      // Clean up temp file
      try {
        new File(fileUri).delete();
      } catch {}

      // Send via WS
      void sendChatViaWs("[voice message]", [], false, {
        savedPath,
        relativePath,
        duration: durationMs,
      });
    },
    [msg, sendChatViaWs],
  );

  const retryMessage = useCallback(
    (message: MessageItem) => {
      if (message.type !== "user" || message.status !== "failed") return;
      const msgs = msg.messagesRef.current;
      const idx = msgs.findIndex((m) => m.id === message.id);
      if (idx >= 0) {
        msgs.splice(idx, 1);
        msg.setMessages([...msgs]);
      }
      if (message.clientMsgId) {
        const t = ackTimersRef.current.get(message.clientMsgId);
        if (t) {
          clearTimeout(t);
          ackTimersRef.current.delete(message.clientMsgId);
        }
        outboxRef.current = outboxRef.current.filter(
          (e) => e.clientMsgId !== message.clientMsgId,
        );
      }
      const text = typeof message.content === "string" ? message.content : "";
      if (!text) {
        setInput(text);
        return;
      }
      // 用户手动 retry：生成新 clientMsgId（避免服务端幂等返回旧结果）
      if (loadingRef.current) {
        setInput("");
        const queuedClientMsgId = genClientMsgId();
        outboxRef.current.push({
          clientMsgId: queuedClientMsgId,
          input: text,
          attachments: [],
          state: "queued",
          createdAt: Date.now(),
        });
        msg.addMessage({
          type: "user",
          content: text,
          status: "pending",
          timestamp: Date.now(),
          clientMsgId: queuedClientMsgId,
        });
      } else {
        setInput("");
        void sendChatViaWs(text, [], true);
      }
    },
    [msg, sendChatViaWs, genClientMsgId],
  );

  const respondToInteraction = useCallback(
    async (interactionId: string, response: Record<string, unknown>) => {
      await wsClient.ensureConnectedSend({
        action: "respond",
        interactionId,
        ...response,
      });
    },
    [],
  );

  const handlePermissionResponse = useCallback(
    async (interactionId: string, allow: boolean) => {
      await respondToInteraction(interactionId, {
        allow,
        message: allow ? undefined : "User denied",
      });
      const idx = msg.messagesRef.current.findIndex(
        (m) =>
          m.type === "permission_request" && m.interactionId === interactionId,
      );
      if (idx >= 0) {
        msg.updateMessageAt(idx, (m) =>
          m.type === "permission_request"
            ? {
                ...m,
                status: allow ? ("allowed" as const) : ("denied" as const),
              }
            : m,
        );
      }
    },
    [respondToInteraction, msg.messagesRef, msg.updateMessageAt],
  );

  const handleAskUserResponse = useCallback(
    async (interactionId: string, answers: AskUserAnswers) => {
      await respondToInteraction(interactionId, { answers });
      const idx = msg.messagesRef.current.findIndex(
        (m) => m.type === "ask_user" && m.interactionId === interactionId,
      );
      if (idx >= 0) {
        msg.updateMessageAt(idx, (m) =>
          m.type === "ask_user"
            ? { ...m, status: "answered" as const, answers }
            : m,
        );
      }
    },
    [respondToInteraction, msg.messagesRef, msg.updateMessageAt],
  );

  // 包装 selectSession/newSession 以同步更新 immediateSessionIdRef
  const selectSessionWrapped = useCallback(
    (id: string) => {
      immediateSessionIdRef.current = id;
      session.selectSession(id);
    },
    [session.selectSession],
  );

  const newSessionWrapped = useCallback(() => {
    immediateSessionIdRef.current = null;
    session.newSession();
  }, [session.newSession]);

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
    input,
    loading,
    sessionId: session.sessionId,
    sessions: session.sessions,
    connectionState,
    tokenUsage: session.tokenUsage,
    modelList,
    selectedModel,
    hasMoreSessions: session.hasMore,
    isLoadingMoreSessions: session.isLoadingMore,
    isLoadingSessions: session.isLoadingSessions,
    sessionsHydrated: session.sessionsHydrated,
    isLoadingMessages: session.isLoadingMessages,
    uploadedFiles: fileUpload.uploadedFiles,
    uploading: fileUpload.uploading,
    uploadError: fileUpload.uploadError,
    dismissUploadError: fileUpload.dismissUploadError,
    setInput,
    newSession: newSessionWrapped,
    selectSession: selectSessionWrapped,
    sendMessage,
    stopping,
    stopGeneration: cancelActiveStream,
    retryMessage,
    forkFromMessage,
    handlePermissionResponse,
    handleAskUserResponse,
    onModelChange: handleModelChange,
    loadMoreSessions: session.loadMoreSessions,
    refreshSessions: () => session.loadSessions(false, { fresh: true }),
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
    isNearBottomRef: msg.isNearBottomRef,
    pickFile: fileUpload.pickFile,
    pickImage: fileUpload.pickImage,
    takePhoto: fileUpload.takePhoto,
    removeFile: fileUpload.removeFile,
    addUploadedFiles: fileUpload.addUploadedFiles,
    sendVoiceMessage,
    voiceCallbackRef,
    refreshCurrentSession: session.refreshCurrentSession,
    agentProfile,
    sessionParticipants,
    ownerFilter,
    setOwnerFilter,
  };
}
