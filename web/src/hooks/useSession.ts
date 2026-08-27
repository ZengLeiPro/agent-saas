import React, { useState, useRef, useCallback, useEffect } from "react";
import type {
  ApiSessionListItem,
  ApiSessionDetail,
  TokenUsage,
} from "@/lib/sessionsApi";
import type { AgentProfile, ContextUsageData, SessionOwnerInfo } from "@agent/shared";
import { formatRuntimeFailureMessage, isInsufficientCreditsFailure } from "@agent/shared";
import {
  mergeServerMessagesWithLocalTail,
  mergeSessionMessageDelta,
  mergeSessionMessagePage,
} from "@agent/shared";
import { authFetch } from "@/lib/authFetch";
import { SESSION_STORAGE_KEY } from "@/lib/constants";
import { sessionsPreload } from "@/lib/preload";
import { registerRefresh, unregisterRefresh } from "@/lib/refreshBus";
import {
  saveSessionMessages,
  loadSessionMessageSnapshot,
  clearSessionMessages,
} from "@/lib/messageCache";
import {
  saveSessionListCache,
  loadSessionListCache,
} from "@/lib/sessionListCache";
import { fetchGroupSessions } from "@agent/shared";
import type { MessageItem } from "@/components/types";
import {
  appendPendingInteractions,
  recordPerformanceMeasure,
  type PendingInteraction,
} from "./sessionMessageHelpers";

export interface SessionCallbacks {
  resetMessages: () => void;
  setMessages: (
    msgs: MessageItem[],
    options?: { scrollToBottom?: boolean },
  ) => void;
  /** 返回当前本地消息列表引用（用于 refresh 时保留本地流式尾部，见 mergeServerMessagesWithLocalTail） */
  getMessages?: () => MessageItem[];
  /** 会话列表加载后，用服务端权威快照恢复所有可见会话的运行态。 */
  onSessionsLoaded?: (sessions: ApiSessionListItem[]) => void;
  triggerScroll: () => void;
  cancelActiveStream: () => void;
  onLastRunState?: (
    sessionId: string,
    lastRunState: NonNullable<ApiSessionDetail["lastRunState"]>,
  ) => void;
  /**
   * detail 加载后同步排队插话真源（2026-08-04 终态设计）：服务端仍在排队的插话
   * 重建队列区；每次 detail 都调用（含空数组），本地已消费/取消的条目由上层合并策略保留。
   */
  onQueuedMessages?: (
    sessionId: string,
    queued: NonNullable<ApiSessionDetail["queuedMessages"]>,
  ) => void;
  onSandboxProfile?: (sessionId: string, profile: ApiSessionDetail["sandboxProfile"], activate?: boolean) => void; onSessionInvalidated?: (sessionId: string, status: 403 | 404) => void; onNewSession?: () => void;
}
export interface SessionState {
  sessionId: string | null;
  sessions: ApiSessionListItem[];
  isLoadingSessions: boolean;
  isLoadingMessages: boolean;
  hasMoreHistory: boolean;
  isLoadingEarlier: boolean;
  loadEarlierMessages: () => Promise<void>;
  deleteSessionId: string | null;
  deleteSessionCount: number;
  isNewSession: boolean;
  tokenUsage: TokenUsage | null;
  /** SDK 实时推送的上下文用量细分（优先于 tokenUsage 展示）*/
  contextUsage: ContextUsageData | null;
  setContextUsage: (usage: ContextUsageData | null) => void;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadDetailPromiseRef: React.RefObject<Promise<void> | null>;
  /** 当前加载的会话 owner 信息 */
  sessionOwner: SessionOwnerInfo | null;
  setSessionId: (id: string | null) => void;
  loadSessions: (opts?: { fresh?: boolean; silent?: boolean; skipMerge?: boolean }) => Promise<void>;
  loadMoreSessions: () => Promise<void>;
  loadSessionDetail: (
    id: string,
    opts?: { scrollToBottom?: boolean; preserveTail?: boolean },
  ) => Promise<void>;
  newSession: () => void;
  selectSession: (id: string) => void;
  confirmDeleteSession: (id: string) => void;
  confirmDeleteSessions: (ids: string[]) => void;
  cancelDeleteSession: () => void;
  handleDeleteSession: () => Promise<void>;
  renameSession: (sessionId: string, newTitle: string) => Promise<boolean>;
  autoTitleSession: (sessionId: string) => Promise<boolean>;
  updateSessionTitle: (sessionId: string, title: string) => void;
  updateSessionMeta: (
    sessionId: string,
    patch: { preview?: string; updatedAtMs?: number; hasUnreadAiReply?: boolean },
  ) => void;
  removeSession: (sessionId: string) => void;
  upsertSession: (session: {
    sessionId: string;
    title?: string;
    preview?: string;
    createdAtMs?: number;
    updatedAtMs: number;
    model?: string;
    username?: string;
    agent?: AgentProfile | null;
    orgAgentId?: string;
    orgAgentName?: string;
    orgAgentAvailable?: boolean;
  }) => void;
  refreshTokenUsage: () => Promise<void>;
  setIsNewSession: (v: boolean) => void;
  refreshCurrentSession: () => void;
  loadGroupSessions: (groupId: string) => Promise<void>;
}

export interface SessionOptions {
  initialSessionId?: string | null;
}

const RECENT_LOCAL_SESSION_TTL_MS = 60_000;
const SESSION_DETAIL_PAGE_SIZE = 200;

// sessionsPreload 是模块级 Promise，只在页面加载时用当时的 token 拉了一次会话。
// 首次挂载消费它可以省一次 waterfall；但账号 A 登出 → 账号 B 登录时 <App/> 会重新
// 挂载，useSession 也随之重跑 mount effect——此时 sessionsPreload 里躺着 A 的数据，
// 直接 setSessions 会把 A 的会话列表灌进 B 的 UI。
// 用模块级 flag 保证 preload 只被"当前页面生命周期内的第一次挂载"消费一次；
// 之后所有重新挂载都改走 fresh fetch，从根上堵掉跨账号会话残留。
let sessionsPreloadConsumed = false;

export function useSession(
  callbacks: SessionCallbacks,
  options?: SessionOptions,
): SessionState {
  const [sessionId, setSessionId] = useState<string | null>(
    options?.initialSessionId ?? null,
  );
  const [sessions, setSessions] = useState<ApiSessionListItem[]>([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);
  const [deleteSessionIds, setDeleteSessionIds] = useState<string[]>([]);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const [contextUsage, setContextUsage] = useState<ContextUsageData | null>(
    null,
  );
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [isLoadingEarlier, setIsLoadingEarlier] = useState(false);
  const [sessionOwner, setSessionOwner] = useState<SessionOwnerInfo | null>(
    null,
  );

  const isNewSessionRef = useRef(false);
  const hasInitialLoadRef = useRef(false);
  const loadDetailPromiseRef = useRef<Promise<void> | null>(null);
  const loadNonceRef = useRef(0);
  const detailCursorRef = useRef<Map<string, {
    historyComplete: boolean;
    tailCursor?: string;
    oldestCursor?: string;
  }>>(new Map());
  // 历史分页锁按会话隔离：A 会话的慢请求不能卡住随后打开的 B 会话。
  const loadingEarlierSessionIdsRef = useRef<Set<string>>(new Set());

  const deleteSessionId = deleteSessionIds[0] ?? null;
  const deleteSessionCount = deleteSessionIds.length;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  // Keep callbacks ref fresh to avoid stale closures
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  // Refs for stable callback closures
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const hasMoreRef = useRef(hasMore);
  hasMoreRef.current = hasMore;
  const isLoadingMoreRef = useRef(isLoadingMore);
  isLoadingMoreRef.current = isLoadingMore;
  const recentLocalSessionIdsRef = useRef<Map<string, number>>(new Map());

  const markRecentLocalSession = useCallback((targetId: string) => {
    recentLocalSessionIdsRef.current.set(targetId, Date.now());
  }, []);

  // skipMerge: 视角切换时跳过合并逻辑，防止跨视角会话残留
  const loadSessions = useCallback(
    async (opts?: {
      fresh?: boolean;
      silent?: boolean;
      skipMerge?: boolean;
    }) => {
      try {
        if (!opts?.silent) setIsLoadingSessions(true);
        const freshParam = opts?.fresh ? "&fresh=1" : "";
        const response = await authFetch(
          `/api/sessions?limit=500${freshParam}`,
        );
        if (response.ok) {
          const data = await response.json();
          const freshSessions: ApiSessionListItem[] = data.sessions || [];
          const freshHasMore: boolean = data.hasMore ?? false;

          // 如果用户通过无限滚动已加载 >200 条，刷新时保留尾部数据防止列表收缩。
          // 同时保护当前 active / 最近本地 upsert 的会话：enqueue-only 会话在服务端
          // 暂时只有 meta 时，fresh reload 不能把本地已知的新会话抹掉。
          // 视角切换时（skipMerge）必须跳过，否则会混入其他视角的会话。
          const prev = sessionsRef.current;
          let merged = freshSessions;
          let finalHasMore = freshHasMore;

          if (!opts?.skipMerge) {
            const now = Date.now();
            const freshIds = new Set(freshSessions.map((s) => s.sessionId));
            const appendedIds = new Set(freshIds);
            const missingLocal: ApiSessionListItem[] = [];
            const shouldKeepTail = freshHasMore && prev.length > freshSessions.length;

            for (const session of prev) {
              if (appendedIds.has(session.sessionId)) continue;
              const markedAt = recentLocalSessionIdsRef.current.get(session.sessionId);
              const isRecent = markedAt !== undefined && now - markedAt <= RECENT_LOCAL_SESSION_TTL_MS;
              if (markedAt !== undefined && !isRecent) {
                recentLocalSessionIdsRef.current.delete(session.sessionId);
              }
              const isActive = session.sessionId === sessionIdRef.current;
              if (isActive || isRecent || shouldKeepTail) {
                missingLocal.push(session);
                appendedIds.add(session.sessionId);
              }
            }

            if (missingLocal.length > 0) {
              merged = [...freshSessions, ...missingLocal].sort(
                (a, b) => b.updatedAtMs - a.updatedAtMs,
              );
              if (shouldKeepTail) finalHasMore = hasMoreRef.current;
            }
          }

          setSessions(merged);
          setHasMore(finalHasMore);
          cbRef.current.onSessionsLoaded?.(merged);
        }
      } catch (err) {
        console.error("加载会话列表失败:", err);
      } finally {
        if (!opts?.silent) setIsLoadingSessions(false);
      }
    },
    [],
  );

  const loadMoreSessions = useCallback(async () => {
    if (!hasMoreRef.current || isLoadingMoreRef.current) return;
    const lastSession = sessionsRef.current[sessionsRef.current.length - 1];
    if (!lastSession) return;

    setIsLoadingMore(true);
    try {
      const response = await authFetch(
        `/api/sessions?limit=50&before=${lastSession.updatedAtMs}`,
      );
      if (response.ok) {
        const data = await response.json();
        const newSessions: ApiSessionListItem[] = data.sessions || [];
        const updated = [...sessionsRef.current, ...newSessions];
        setSessions(updated);
        setHasMore(data.hasMore ?? false);
        cbRef.current.onSessionsLoaded?.(updated);
      }
    } catch (err) {
      console.error("加载更多会话失败:", err);
    } finally {
      setIsLoadingMore(false);
    }
  }, []);

  const fetchTokenUsage = useCallback(async (id: string) => {
    try {
      const response = await authFetch(
        `/api/sessions/${encodeURIComponent(id)}/stats`,
      );
      if (response.ok) {
        const data = await response.json();
        const usage = data.tokenUsage
          ? { ...data.tokenUsage, totalCostUsd: data.totalCostUsd ?? null }
          : null;
        setTokenUsage(usage);
        setContextUsage(data.contextUsage ?? null);
      }
    } catch {
      // silent fail
    }
  }, []);

  const loadSessionDetail = useCallback(
    async (
      id: string,
      opts?: {
        scrollToBottom?: boolean;
        silent?: boolean;
        preserveTail?: boolean;
      },
    ) => {
      const nonce = ++loadNonceRef.current;
      const isStale = () => loadNonceRef.current !== nonce;
      const mapperPromise = import("@/lib/sessionMessageMapper");

      // silent 模式（后台恢复、WS 重连等）不显示 loading 指示器
      if (!opts?.silent) setIsLoadingMessages(true);

      let baseMessages: MessageItem[] | null = null;
      let requestCursor: string | undefined;
      let baseHistoryComplete = false;
      let baseOldestCursor: string | undefined;

      /**
       * getMessages() 返回的是**全局当前消息数组**（与 id 无关），所以 preserveTail 只有在
       * "目标会话恰好就是屏幕上正在显示的会话"时才成立。否则会把上一个会话的尾部
       * （含用户消息与失败提示）整段拼进另一个会话——2026-08-01 线上跨会话失败提示泄漏的根因。
       */
      const canPreserveTail = opts?.preserveTail === true && sessionIdRef.current === id;

      // preserveTail 场景（done 后同会话刷新）：本地内存里已有最新尾部，cached 反而是更旧的快照，
      // 跳过以免闪回。
      if (canPreserveTail && cbRef.current.getMessages) {
        const detailState = detailCursorRef.current.get(id);
        if (detailState?.tailCursor) {
          baseMessages = cbRef.current.getMessages();
          requestCursor = detailState.tailCursor;
          baseHistoryComplete = detailState.historyComplete;
          baseOldestCursor = detailState.oldestCursor;
        }
      } else {
        // 先尝试展示本地缓存（冷启动 / 后台恢复时瞬间可见）
        const cached = await loadSessionMessageSnapshot(id);
        if (isStale()) return;
        if (cached) {
          const cachedMessages = cached.messages.filter((message) => message.type !== "system-error");
          baseMessages = cachedMessages;
          requestCursor = cached.tailCursor;
          baseHistoryComplete = cached.historyComplete;
          baseOldestCursor = cached.oldestCursor;
          detailCursorRef.current.set(id, {
            historyComplete: cached.historyComplete,
            ...(cached.tailCursor ? { tailCursor: cached.tailCursor } : {}),
            ...(cached.oldestCursor ? { oldestCursor: cached.oldestCursor } : {}),
          });
          setHasMoreHistory(!cached.historyComplete);
          cbRef.current.setMessages(cachedMessages, opts);
          setSessionId(id);
        }
      }

      try {
        const requestStartedAt = performance.now();
        const params = new URLSearchParams();
        params.set("limit", String(SESSION_DETAIL_PAGE_SIZE));
        if (opts?.silent) params.set("silent", "1");
        if (requestCursor) params.set("after", requestCursor);
        const serializedParams = params.toString();
        const query = serializedParams ? `?${serializedParams}` : "";
        const response = await authFetch(
          `/api/sessions/${encodeURIComponent(id)}${query}`,
        );
        const responseReceivedAt = performance.now();
        recordPerformanceMeasure(
          "agent-saas:session-detail-fetch",
          requestStartedAt,
          responseReceivedAt,
        );
        if (isStale()) return;
        if (response.ok) {
          const data: ApiSessionDetail = await response.json();
          const responseParsedAt = performance.now();
          recordPerformanceMeasure(
            "agent-saas:session-detail-json",
            responseReceivedAt,
            responseParsedAt,
          );
          if (isStale()) return;
          const sessionOwner =
            data.owner?.username ??
            sessionsRef.current.find((s) => s.sessionId === id)?.owner
              ?.username;
          const mapper = await mapperPromise; if (isStale()) return; const incomingMsgs = mapper.mapSessionDetailToMessages(data, sessionOwner);
          let msgs = data.mode === "delta" && baseMessages
            ? mergeSessionMessageDelta(baseMessages, incomingMsgs)
            : incomingMsgs;
          const historyComplete = data.mode === "delta"
            ? baseHistoryComplete
            : data.historyComplete !== false;
          const oldestCursor = data.mode === "delta"
            ? baseOldestCursor
            : data.oldestCursor ?? incomingMsgs[0]?.id;

          // 增量基底里可能保留上一轮的临时状态；以本次 lastRunState / pending API
          // 为真源重建，避免已结束的交互或失败 banner 永久粘在历史里。
          msgs = msgs.filter((message) =>
            message.type !== "system-error" && !message.id.startsWith("pending-"),
          );

          // a-2 对账：根据 lastRunState 在消息尾追加 system-error banner,
          // 解决"后端已 failed/cancelled,但用户进会话仍以为 AI 在转/没回复" 的鬼状态。
          // 旧 transcript 无 lastRunState 字段会跳过；已经追过则按 content dedupe。
          // 用户侧通俗文案;原始 lrs.error 仅留在 server.log + PG runtime_events。
          if (data.lastRunState) {
            const lrs = data.lastRunState;
            let alertContent: string | null = null;
            let severity: 'error' | 'cancelled' | 'billing' = 'error';
            if (lrs.status === 'failed' || lrs.status === 'orphaned') {
              alertContent = formatRuntimeFailureMessage(lrs.error, lrs.failureKind);
              if (isInsufficientCreditsFailure(lrs.error)) severity = 'billing';
            } else if (lrs.status === 'cancelled') {
              alertContent = '会话已停止';
              severity = 'cancelled';
            }
            if (alertContent) {
              const last = msgs[msgs.length - 1];
              if (!(last?.type === 'system-error' && last.content === alertContent && last.failureKind === lrs.failureKind && last.recoveryAction === lrs.recoveryAction)) {
                msgs.push({
                  id: `system-error-${lrs.runId}`,
                  type: 'system-error',
                  content: alertContent,
                  severity, runId: lrs.runId, ...(lrs.failureKind ? { failureKind: lrs.failureKind } : {}), ...(lrs.recoveryAction ? { recoveryAction: lrs.recoveryAction } : {}),
                  ...(lrs.finishedAt ? { timestamp: Date.parse(lrs.finishedAt) || Date.now() } : {}),
                });
              }
            }
            cbRef.current.onLastRunState?.(id, lrs);
          }
          cbRef.current.onQueuedMessages?.(id, data.queuedMessages ?? []);
          cbRef.current.onSandboxProfile?.(id, data.sandboxProfile);

          if (isStale()) return;
          // preserveTail：refresh 时服务端 transcript 可能尚未写入最后一条 assistant text，
          // 合并保留本地尾部，避免消息瞬间消失。
          // 归属在请求前后各校验一次：飞行期间用户切走时，屏幕上已是别的会话的消息，不能再拼。
          let finalMsgs = msgs;
          if (canPreserveTail && sessionIdRef.current === id && cbRef.current.getMessages) {
            const localMsgs = cbRef.current.getMessages();
            finalMsgs = mergeServerMessagesWithLocalTail(msgs, localMsgs);
          }
          cbRef.current.setMessages(finalMsgs, opts);
          const messagesCommittedAt = performance.now();
          recordPerformanceMeasure(
            "agent-saas:session-detail-map-commit",
            responseParsedAt,
            messagesCommittedAt,
          );
          requestAnimationFrame(() => {
            recordPerformanceMeasure(
              "agent-saas:session-detail-visible",
              requestStartedAt,
              performance.now(),
            );
          });
          setSessionId(id);
          setSessionOwner(data.owner ?? null);
          setHasMoreHistory(!historyComplete);
          void fetchTokenUsage(id);
          detailCursorRef.current.set(id, {
            historyComplete,
            ...(data.cursor ? { tailCursor: data.cursor } : {}),
            ...(oldestCursor ? { oldestCursor } : {}),
          });
          saveSessionMessages(id, finalMsgs, {
            historyComplete,
            ...(data.cursor ? { tailCursor: data.cursor } : {}),
            ...(oldestCursor ? { oldestCursor } : {}),
          });

          // pending 交互不再阻塞首屏；详情一到就先渲染，再异步补入交互卡片。
          void authFetch(
            `/api/chat/interactions/pending?sessionId=${encodeURIComponent(id)}`,
          ).then(async (pendingRes) => {
            if (!pendingRes.ok) return null;
            return pendingRes.json() as Promise<PendingInteraction[]>;
          }).then((pendingList) => {
            if (!pendingList || isStale() || sessionIdRef.current !== id) return;
            const currentMessages = cbRef.current.getMessages?.() ?? finalMsgs;
            cbRef.current.setMessages(
              appendPendingInteractions(currentMessages, pendingList),
              { scrollToBottom: false },
            );
          }).catch(() => {
            // pending check is best-effort
          });
        } else {
          console.error("加载会话详情失败:", response.statusText);
          if (response.status === 404 || response.status === 403) {
            cbRef.current.onSessionInvalidated?.(id, response.status); removeSession(id);
            setSessionOwner(null);
            setTokenUsage(null);
            setContextUsage(null);
          }
        }
      } catch (err) {
        console.error("加载会话详情失败:", err);
      } finally {
        if (!isStale()) setIsLoadingMessages(false);
      }
    },
    [],
  );

  const loadEarlierMessages = useCallback(async () => {
    const id = sessionIdRef.current;
    const detailState = id ? detailCursorRef.current.get(id) : undefined;
    if (
      !id ||
      !detailState?.oldestCursor ||
      detailState.historyComplete ||
      loadingEarlierSessionIdsRef.current.has(id)
    ) return;

    loadingEarlierSessionIdsRef.current.add(id);
    setIsLoadingEarlier(true);
    try {
      const params = new URLSearchParams({
        before: detailState.oldestCursor,
        limit: String(SESSION_DETAIL_PAGE_SIZE),
        silent: "1",
      });
      const response = await authFetch(
        `/api/sessions/${encodeURIComponent(id)}?${params.toString()}`,
      );
      if (!response.ok) {
        console.error("加载更早消息失败:", response.status, response.statusText);
        return;
      }
      if (sessionIdRef.current !== id) return;
      const data: ApiSessionDetail = await response.json();
      if (sessionIdRef.current !== id) return;

      const owner = data.owner?.username ?? sessionOwner?.username;
      const incoming = (await import("@/lib/sessionMessageMapper")).mapSessionDetailToMessages(data, owner);
      const current = cbRef.current.getMessages?.() ?? [];
      const merged = data.mode === "before"
        ? mergeSessionMessagePage(current, incoming)
        : incoming;
      const historyComplete = data.historyComplete !== false;
      const oldestCursor = data.oldestCursor ?? incoming[0]?.id;
      const tailCursor = data.cursor ?? detailState.tailCursor;

      cbRef.current.setMessages(merged, { scrollToBottom: false });
      setHasMoreHistory(!historyComplete);
      detailCursorRef.current.set(id, {
        historyComplete,
        ...(tailCursor ? { tailCursor } : {}),
        ...(oldestCursor ? { oldestCursor } : {}),
      });
      saveSessionMessages(id, merged, {
        historyComplete,
        ...(tailCursor ? { tailCursor } : {}),
        ...(oldestCursor ? { oldestCursor } : {}),
      });
    } catch (err) {
      console.error("加载更早消息失败:", err);
    } finally {
      loadingEarlierSessionIdsRef.current.delete(id);
      if (sessionIdRef.current === id) setIsLoadingEarlier(false);
    }
  }, [sessionOwner?.username]);

  const selectSession = useCallback(
    (id: string) => {
      if (id === sessionId) return;
      cbRef.current.cancelActiveStream();
      cbRef.current.resetMessages();
      setSessionId(sessionIdRef.current = id);
      setSessionOwner(null);
      setTokenUsage(null);
      setContextUsage(null);
      setHasMoreHistory(false);
      setIsLoadingEarlier(false);
      isNewSessionRef.current = false;
      cbRef.current.onSandboxProfile?.(id, undefined, true);
      loadDetailPromiseRef.current = loadSessionDetail(id);
    },
    [loadSessionDetail, sessionId],
  );

  const confirmDeleteSessions = useCallback((ids: string[]) => {
    const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
    if (uniqueIds.length === 0) return;
    setDeleteSessionIds(uniqueIds);
  }, []);

  const confirmDeleteSession = useCallback((id: string) => {
    confirmDeleteSessions([id]);
  }, [confirmDeleteSessions]);

  const cancelDeleteSession = useCallback(() => {
    setDeleteSessionIds([]);
  }, []);

  const handleDeleteSession = useCallback(async () => {
    if (deleteSessionIds.length === 0) {
      return;
    }

    try {
      const deletedIds = new Set<string>();
      let failedCount = 0;

      for (const targetId of deleteSessionIds) {
        try {
          const response = await authFetch(
            `/api/sessions/${encodeURIComponent(targetId)}?deleteSidecar=true`,
            {
              method: "DELETE",
            },
          );

          if (!response.ok) {
            console.error("删除会话失败:", targetId, response.status);
            failedCount += 1;
            continue;
          }

          await clearSessionMessages(targetId);
          detailCursorRef.current.delete(targetId);
          localStorage.removeItem(`agentChat.model.${targetId}`);
          deletedIds.add(targetId);
        } catch (err) {
          console.error("删除会话失败:", targetId, err);
          failedCount += 1;
        }
      }

      if (deletedIds.size === 0) {
        alert("删除失败");
        return;
      }

      setDeleteSessionIds([]);
      await loadSessions({ fresh: true, skipMerge: true });

      if (failedCount > 0) {
        alert(`${failedCount} 个会话删除失败`);
      }

      if (!sessionId || !deletedIds.has(sessionId)) {
        return;
      }

      const remainingSessions = sessions.filter(
        (item) => !deletedIds.has(item.sessionId),
      );
      if (remainingSessions.length > 0) {
        selectSession(remainingSessions[0].sessionId); await loadDetailPromiseRef.current;
      } else {
        setSessionId(null);
        localStorage.removeItem(SESSION_STORAGE_KEY);
        cbRef.current.resetMessages(); cbRef.current.onNewSession?.();
      }
    } catch (err) {
      console.error("删除会话失败:", err);
      alert("删除失败");
    }
  }, [deleteSessionIds, loadSessions, selectSession, sessionId, sessions]);

  const updateSessionTitle = useCallback((targetId: string, title: string) => {
    setSessions((prev) =>
      prev.map((s) => (s.sessionId === targetId ? { ...s, title } : s)),
    );
  }, []);

  const updateSessionMeta = useCallback(
    (
      targetId: string,
      patch: { preview?: string; updatedAtMs?: number; title?: string; hasUnreadAiReply?: boolean },
    ) => {
      setSessions((prev) => {
        const updated = prev.map((s) =>
          s.sessionId === targetId
            ? {
                ...s,
                ...(patch.preview !== undefined
                  ? { preview: patch.preview }
                  : {}),
                ...(patch.updatedAtMs !== undefined
                  ? { updatedAtMs: patch.updatedAtMs }
                  : {}),
                ...(patch.title !== undefined ? { title: patch.title } : {}),
                ...(patch.hasUnreadAiReply !== undefined
                  ? { hasUnreadAiReply: patch.hasUnreadAiReply }
                  : {}),
              }
            : s,
        );
        updated.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
        return updated;
      });
    },
    [],
  );

  const removeSession = useCallback((targetId: string) => {
    setSessions((prev) => prev.filter((s) => s.sessionId !== targetId));
    void clearSessionMessages(targetId);
    localStorage.removeItem(`agentChat.model.${targetId}`);
    if (sessionIdRef.current === targetId) {
      cbRef.current.cancelActiveStream();
      cbRef.current.resetMessages(); cbRef.current.onNewSession?.();
      setSessionId(null);
      setTokenUsage(null);
      setContextUsage(null);
      localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  }, []);

  /** 插入或更新会话（其他设备创建的新会话无需 HTTP 请求） */
  const upsertSession = useCallback(
    (newSession: {
      sessionId: string;
      title?: string;
      preview?: string;
      createdAtMs?: number;
      updatedAtMs: number;
      model?: string;
      username?: string;
      agent?: AgentProfile | null;
      orgAgentId?: string;
      orgAgentName?: string;
      orgAgentAvailable?: boolean;
    }) => {
      markRecentLocalSession(newSession.sessionId);
      setSessions((prev) => {
        const idx = prev.findIndex((s) => s.sessionId === newSession.sessionId);
        let updated: ApiSessionListItem[];
        if (idx >= 0) {
          // 只用 defined 值覆盖，避免 sync 重放的 undefined title 冲掉已有标题
          updated = prev.map((s) =>
            s.sessionId === newSession.sessionId
              ? {
                  ...s,
                  updatedAtMs: newSession.updatedAtMs,
                  ...(newSession.title !== undefined
                    ? { title: newSession.title }
                    : {}),
                  ...(newSession.preview !== undefined
                    ? { preview: newSession.preview }
                    : {}),
                  ...(newSession.model !== undefined
                    ? { model: newSession.model }
                    : {}),
                  ...(newSession.username !== undefined
                    ? { owner: { userId: "", username: newSession.username } }
                    : {}),
                  ...(newSession.agent !== undefined
                    ? { agent: newSession.agent }
                    : {}),
                  ...(newSession.orgAgentId !== undefined
                    ? { orgAgentId: newSession.orgAgentId }
                    : {}),
                  ...(newSession.orgAgentName !== undefined
                    ? { orgAgentName: newSession.orgAgentName }
                    : {}),
                  ...(newSession.orgAgentAvailable !== undefined
                    ? { orgAgentAvailable: newSession.orgAgentAvailable }
                    : {}),
                }
              : s,
          );
        } else {
          const entry: ApiSessionListItem = {
            sessionId: newSession.sessionId,
            ...(newSession.createdAtMs !== undefined
              ? { createdAtMs: newSession.createdAtMs }
              : {}),
            updatedAtMs: newSession.updatedAtMs,
            title: newSession.title,
            preview: newSession.preview,
            source: { type: "web" as const, label: "WEB" },
            ...(newSession.model ? { model: newSession.model } : {}),
            ...(newSession.username
              ? { owner: { userId: "", username: newSession.username } }
              : {}),
            ...(newSession.agent !== undefined
              ? { agent: newSession.agent }
              : {}),
            ...(newSession.orgAgentId ? { orgAgentId: newSession.orgAgentId } : {}),
            ...(newSession.orgAgentName ? { orgAgentName: newSession.orgAgentName } : {}),
            ...(newSession.orgAgentAvailable !== undefined
              ? { orgAgentAvailable: newSession.orgAgentAvailable }
              : {}),
          };
          updated = [entry, ...prev];
        }
        updated.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
        return updated;
      });
    },
    [markRecentLocalSession],
  );

  const renameSession = useCallback(
    async (targetId: string, newTitle: string): Promise<boolean> => {
      try {
        const response = await authFetch(
          `/api/sessions/${encodeURIComponent(targetId)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: newTitle }),
          },
        );
        if (!response.ok) return false;
        // 乐观更新本地列表
        setSessions((prev) =>
          prev.map((s) =>
            s.sessionId === targetId
              ? { ...s, title: newTitle || undefined }
              : s,
          ),
        );
        return true;
      } catch (err) {
        console.error("重命名会话失败:", err);
        return false;
      }
    },
    [],
  );

  const autoTitleSession = useCallback(
    async (targetId: string): Promise<boolean> => {
      try {
        const response = await authFetch(
          `/api/sessions/${encodeURIComponent(targetId)}/auto-title`,
          {
            method: "POST",
          },
        );
        if (!response.ok) return false;
        const data = await response.json();
        if (data.title) {
          setSessions((prev) =>
            prev.map((s) =>
              s.sessionId === targetId ? { ...s, title: data.title } : s,
            ),
          );
        }
        return true;
      } catch (err) {
        console.error("自动命名失败:", err);
        return false;
      }
    },
    [],
  );

  const newSession = useCallback(() => {
    // 作废所有在飞的会话详情请求：否则旧请求返回后仍会 setMessages + setSessionId，
    // 把上一个会话的消息灌进刚清空的草稿页（selectSession 走 loadSessionDetail 会自然递增，
    // 只有新建会话这条路径原先漏了）。
    ++loadNonceRef.current;
    cbRef.current.cancelActiveStream();
    cbRef.current.resetMessages(); cbRef.current.onNewSession?.();
    isNewSessionRef.current = true;
    setSessionId(null);
    setSessionOwner(null);
    setTokenUsage(null);
    setContextUsage(null);
    setIsLoadingMessages(false);
    setHasMoreHistory(false);
    setIsLoadingEarlier(false);
    localStorage.removeItem(SESSION_STORAGE_KEY);
  }, []);

  const refreshTokenUsage = useCallback(async () => {
    if (sessionId) void fetchTokenUsage(sessionId);
  }, [fetchTokenUsage, sessionId]);

  const setIsNewSession = useCallback((v: boolean) => {
    isNewSessionRef.current = v;
  }, []);

  /**
   * 从服务端刷新当前 session 的消息（用于后台恢复等场景）。
   *
   * 必须读同帧的 sessionIdRef：切换会话时 setSessionId(id) 要等 loadSessionDetail 成功后才执行，
   * 期间 React state 仍是上一个会话，用它会把刷新打到旧会话上。
   */
  const refreshCurrentSession = useCallback(() => {
    const sid = sessionIdRef.current;
    if (sid) {
      loadDetailPromiseRef.current = loadSessionDetail(sid, {
        scrollToBottom: false,
        silent: true,
        preserveTail: true,
      });
    }
  }, [loadSessionDetail]);

  // 从 URL 加载初始会话详情
  useEffect(() => {
    if (options?.initialSessionId) {
      loadDetailPromiseRef.current = loadSessionDetail(
        options.initialSessionId,
      );
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist current session ID (only write when non-null to avoid clearing stored value during init)
  useEffect(() => {
    if (sessionId) {
      localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
    }
  }, [sessionId]);

  // Load sessions on mount — cache-first + 消费预取结果
  useEffect(() => {
    let cancelled = false;

    // Step 1: 先从本地缓存加载，实现即时展示
    const cached = loadSessionListCache();
    if (cached && cached.sessions.length > 0) {
      setSessions(cached.sessions);
      setHasMore(cached.hasMore);
      setIsLoadingSessions(false);
      cbRef.current.onSessionsLoaded?.(cached.sessions);
    }

    // Step 2: 消费预取结果或发起 API 请求
    // 只有首次挂载能吃 sessionsPreload 的红利；账号切换后重新挂载走 fresh fetch，
    // 避免把旧账号的 preload 结果灌到新账号的 sidebar。
    if (!sessionsPreloadConsumed) {
      sessionsPreloadConsumed = true;
      sessionsPreload.then((preloaded) => {
        if (cancelled) return;
        if (preloaded) {
          const freshSessions = preloaded.sessions as ApiSessionListItem[];
          const freshHasMore = preloaded.hasMore;
          setSessions(freshSessions);
          setHasMore(freshHasMore);
          setIsLoadingSessions(false);
          cbRef.current.onSessionsLoaded?.(freshSessions);
        } else {
          // 有缓存时静默加载，避免 loading 状态闪烁
          void loadSessions({ silent: !!cached });
        }
      });
    } else {
      // 二次挂载（如登出 → 换号登录）: 直接拉最新数据，
      // 缓存已在 logout 里清掉，此处显式 fresh 确保拿到当前账号的会话。
      void loadSessions({ silent: !!cached, fresh: true });
    }
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Initial load guard
  useEffect(() => {
    if (sessionId || sessions.length > 0) {
      return;
    }
    if (hasInitialLoadRef.current) {
      return;
    }
    hasInitialLoadRef.current = true;
  }, [sessionId, sessions]);

  // 注册 refreshBus
  useEffect(() => {
    registerRefresh("sessions", () => loadSessions({ fresh: true }));
    return () => unregisterRefresh("sessions");
  }, [loadSessions]);

  // 页面从后台恢复时刷新会话列表
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        void loadSessions({ fresh: true });
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [loadSessions]);

  // Debounced session list cache write — 统一写入通道
  // 无论来源（API / WS sync），sessions 变化后 5s 内无新变化则持久化
  const debounceSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (sessions.length === 0) return;
    if (debounceSaveRef.current) clearTimeout(debounceSaveRef.current);
    debounceSaveRef.current = setTimeout(() => {
      saveSessionListCache(sessions, hasMore);
      debounceSaveRef.current = null;
    }, 5000);
    return () => {
      if (debounceSaveRef.current) {
        clearTimeout(debounceSaveRef.current);
        debounceSaveRef.current = null;
      }
    };
  }, [sessions, hasMore]);

  // 展开分组时全量加载组内会话，将未在主列表中的会话合并进来
  const loadGroupSessions = useCallback(async (groupId: string) => {
    try {
      const groupSessions = await fetchGroupSessions(groupId);
      if (groupSessions.length === 0) return;
      setSessions((prev) => {
        const existingIds = new Set(prev.map((s) => s.sessionId));
        const newOnes = groupSessions.filter(
          (s) => !existingIds.has(s.sessionId),
        );
        if (newOnes.length === 0) return prev;
        return [...prev, ...newOnes];
      });
    } catch (err) {
      console.error("加载分组会话失败:", err);
    }
  }, []);

  // 冷启动时保持空白新会话页面（不自动加载上次会话）。
  // 仅在 SSE 流产生新 session 后，由 setSessionId 触发持久化。
  // sessionDetailPreload 不再消费 —— 冷启动即为新会话。

  return {
    sessionId,
    sessions,
    isLoadingSessions,
    isLoadingMessages,
    hasMoreHistory,
    isLoadingEarlier,
    deleteSessionId,
    deleteSessionCount,
    isNewSession: isNewSessionRef.current,
    tokenUsage,
    contextUsage,
    setContextUsage,
    hasMore,
    isLoadingMore,
    loadDetailPromiseRef,
    sessionOwner,
    setSessionId,
    loadSessions,
    loadMoreSessions,
    loadSessionDetail,
    loadEarlierMessages,
    newSession,
    selectSession,
    confirmDeleteSession,
    confirmDeleteSessions,
    cancelDeleteSession,
    handleDeleteSession,
    renameSession,
    autoTitleSession,
    updateSessionTitle,
    updateSessionMeta,
    removeSession,
    upsertSession,
    refreshTokenUsage,
    setIsNewSession,
    refreshCurrentSession,
    loadGroupSessions,
  };
}
