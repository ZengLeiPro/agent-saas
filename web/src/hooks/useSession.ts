import React, { useState, useRef, useCallback, useEffect } from "react";
import type {
  ApiSessionListItem,
  ApiSessionDetail,
  TokenUsage,
} from "@/lib/sessionsApi";
import type { AgentProfile, ContextUsageData } from "@agent/shared";
import { formatRuntimeFailureMessage } from "@agent/shared";
import { mapSessionDetailToMessages } from "@/lib/sessionsApi";
import { mergeServerMessagesWithLocalTail } from "@agent/shared";
import { authFetch } from "@/lib/authFetch";
import { SESSION_STORAGE_KEY } from "@/lib/constants";
import { sessionsPreload } from "@/lib/preload";
import { registerRefresh, unregisterRefresh } from "@/lib/refreshBus";
import {
  saveSessionMessages,
  loadSessionMessages,
  clearSessionMessages,
} from "@/lib/messageCache";
import {
  saveSessionListCache,
  loadSessionListCache,
} from "@/lib/sessionListCache";
import { fetchGroupSessions } from "@agent/shared";
import type { SessionOwnerInfo } from "@agent/shared";
import type { MessageItem } from "@/components/types";

export interface SessionCallbacks {
  resetMessages: () => void;
  setMessages: (
    msgs: MessageItem[],
    options?: { scrollToBottom?: boolean },
  ) => void;
  /** 返回当前本地消息列表引用（用于 refresh 时保留本地流式尾部，见 mergeServerMessagesWithLocalTail） */
  getMessages?: () => MessageItem[];
  triggerScroll: () => void;
  cancelActiveStream: () => void;
  clearComposer: () => void;
  onLastRunState?: (
    sessionId: string,
    lastRunState: NonNullable<ApiSessionDetail["lastRunState"]>,
  ) => void;
}

export interface SessionState {
  sessionId: string | null;
  sessions: ApiSessionListItem[];
  isLoadingSessions: boolean;
  isLoadingMessages: boolean;
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
    patch: { preview?: string; updatedAtMs?: number },
  ) => void;
  removeSession: (sessionId: string) => void;
  upsertSession: (session: {
    sessionId: string;
    title?: string;
    preview?: string;
    updatedAtMs: number;
    model?: string;
    username?: string;
    agent?: AgentProfile | null;
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
  const [sessionOwner, setSessionOwner] = useState<SessionOwnerInfo | null>(
    null,
  );

  const isNewSessionRef = useRef(false);
  const hasInitialLoadRef = useRef(false);
  const loadDetailPromiseRef = useRef<Promise<void> | null>(null);
  const loadNonceRef = useRef(0);

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

      // silent 模式（后台恢复、WS 重连等）不显示 loading 指示器
      if (!opts?.silent) setIsLoadingMessages(true);

      // preserveTail 场景（done 后同会话刷新）：本地内存里已有最新尾部，cached 反而是更旧的快照，
      // 跳过以免闪回。
      if (!opts?.preserveTail) {
        // 先尝试展示本地缓存（冷启动 / 后台恢复时瞬间可见）
        const cached = await loadSessionMessages(id);
        if (isStale()) return;
        if (cached) {
          cbRef.current.setMessages(cached, opts);
          setSessionId(id);
        }
      }

      try {
        const silentParam = opts?.silent ? "?silent=1" : "";
        const response = await authFetch(
          `/api/sessions/${encodeURIComponent(id)}${silentParam}`,
        );
        if (isStale()) return;
        if (response.ok) {
          const data: ApiSessionDetail = await response.json();
          if (isStale()) return;
          const sessionOwner =
            data.owner?.username ??
            sessionsRef.current.find((s) => s.sessionId === id)?.owner
              ?.username;
          const msgs = mapSessionDetailToMessages(data, sessionOwner);

          // a-2 对账：根据 lastRunState 在消息尾追加 system-error banner,
          // 解决"后端已 failed/cancelled,但用户进会话仍以为 AI 在转/没回复" 的鬼状态。
          // 旧 transcript 无 lastRunState 字段会跳过；已经追过则按 content dedupe。
          // 用户侧通俗文案;原始 lrs.error 仅留在 server.log + PG runtime_events。
          if (data.lastRunState) {
            const lrs = data.lastRunState;
            let alertContent: string | null = null;
            let severity: 'error' | 'cancelled' = 'error';
            if (lrs.status === 'failed' || lrs.status === 'orphaned') {
              alertContent = formatRuntimeFailureMessage(lrs.error);
            } else if (lrs.status === 'cancelled') {
              alertContent = '会话已停止';
              severity = 'cancelled';
            }
            if (alertContent) {
              const last = msgs[msgs.length - 1];
              if (!(last?.type === 'system-error' && last.content === alertContent)) {
                msgs.push({
                  id: `system-error-${lrs.runId}`,
                  type: 'system-error',
                  content: alertContent,
                  severity,
                  ...(lrs.finishedAt ? { timestamp: Date.parse(lrs.finishedAt) || Date.now() } : {}),
                });
              }
            }
            cbRef.current.onLastRunState?.(id, lrs);
          }

          // 检查是否有 pending 交互（SSE 断开后存活的 ask_user / plan mode）
          try {
            const pendingRes = await authFetch(
              `/api/chat/interactions/pending?sessionId=${encodeURIComponent(id)}`,
            );
            if (!isStale() && pendingRes.ok) {
              const pendingList: Array<{
                interactionId: string;
                type: "ask_user" | "permission_request";
                questions?: Array<{
                  question: string;
                  header: string;
                  options: Array<{ label: string; description: string }>;
                  multiSelect: boolean;
                }>;
                toolId?: string;
                toolName?: string;
                displayName?: string;
                toolInput?: Record<string, unknown>;
                planContent?: string;
              }> = await pendingRes.json();

              const PLAN_LABELS: Record<
                string,
                { name: string; fallback: string }
              > = {
                EnterPlanMode: {
                  name: "进入规划模式",
                  fallback:
                    "Agent 请求进入规划模式，将在只读模式下探索代码库并设计实现方案。",
                },
                ExitPlanMode: {
                  name: "规划方案审批",
                  fallback: "Agent 已完成方案规划，请审阅后决定是否批准执行。",
                },
              };

              // interactionId 去重：避免与 transcript 中已有的交互重复
              const existingIds = new Set(
                msgs
                  .filter((m) => "interactionId" in m && m.interactionId)
                  .map((m) => (m as any).interactionId as string),
              );
              for (const p of pendingList) {
                if (existingIds.has(p.interactionId)) continue;
                if (p.type === "ask_user" && p.questions) {
                  msgs.push({
                    id: `pending-${p.interactionId}`,
                    type: "ask_user",
                    interactionId: p.interactionId,
                    questions: p.questions,
                    status: "pending",
                  });
                } else if (p.type === "permission_request" && p.toolName) {
                  const label = PLAN_LABELS[p.toolName] ?? {
                    name: p.toolName,
                    fallback: "",
                  };
                  msgs.push({
                    id: `pending-${p.interactionId}`,
                    type: "permission_request",
                    interactionId: p.interactionId,
                    toolName: p.displayName || label.name,
                    toolInput:
                      p.planContent ||
                      (p.toolInput
                        ? JSON.stringify(p.toolInput, null, 2)
                        : label.fallback),
                    status: "pending",
                  });
                }
              }
            }
          } catch {
            // silent fail — pending check is best-effort
          }

          if (isStale()) return;
          // preserveTail：refresh 时服务端 transcript 可能尚未写入最后一条 assistant text，
          // 合并保留本地尾部，避免消息瞬间消失。
          let finalMsgs = msgs;
          if (opts?.preserveTail && cbRef.current.getMessages) {
            const localMsgs = cbRef.current.getMessages();
            finalMsgs = mergeServerMessagesWithLocalTail(msgs, localMsgs);
          }
          cbRef.current.setMessages(finalMsgs, opts);
          setSessionId(id);
          setSessionOwner(data.owner ?? null);
          void fetchTokenUsage(id);
          saveSessionMessages(id, finalMsgs);
        } else {
          console.error("加载会话详情失败:", response.statusText);
          if (response.status === 404 || response.status === 403) {
            removeSession(id);
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
        await loadSessionDetail(remainingSessions[0].sessionId);
      } else {
        setSessionId(null);
        localStorage.removeItem(SESSION_STORAGE_KEY);
        cbRef.current.resetMessages();
      }
    } catch (err) {
      console.error("删除会话失败:", err);
      alert("删除失败");
    }
  }, [deleteSessionIds, loadSessionDetail, loadSessions, sessionId, sessions]);

  const updateSessionTitle = useCallback((targetId: string, title: string) => {
    setSessions((prev) =>
      prev.map((s) => (s.sessionId === targetId ? { ...s, title } : s)),
    );
  }, []);

  const updateSessionMeta = useCallback(
    (
      targetId: string,
      patch: { preview?: string; updatedAtMs?: number; title?: string },
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
      cbRef.current.resetMessages();
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
      updatedAtMs: number;
      model?: string;
      username?: string;
      agent?: AgentProfile | null;
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
                }
              : s,
          );
        } else {
          const entry: ApiSessionListItem = {
            sessionId: newSession.sessionId,
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
    cbRef.current.cancelActiveStream();
    cbRef.current.clearComposer();
    cbRef.current.resetMessages();
    isNewSessionRef.current = true;
    setSessionId(null);
    setSessionOwner(null);
    setTokenUsage(null);
    setContextUsage(null);
    setIsLoadingMessages(false);
    localStorage.removeItem(SESSION_STORAGE_KEY);
  }, []);

  const selectSession = useCallback(
    (id: string) => {
      if (id === sessionId) {
        return;
      }

      cbRef.current.cancelActiveStream();
      cbRef.current.clearComposer();
      // 立即清空旧消息并切换 sessionId，避免短暂显示前一个会话的内容
      cbRef.current.resetMessages();
      setSessionId(id);
      setSessionOwner(null);
      setTokenUsage(null);
      setContextUsage(null);
      isNewSessionRef.current = false;
      loadDetailPromiseRef.current = loadSessionDetail(id);
    },
    [loadSessionDetail, sessionId],
  );

  const refreshTokenUsage = useCallback(async () => {
    if (sessionId) void fetchTokenUsage(sessionId);
  }, [fetchTokenUsage, sessionId]);

  const setIsNewSession = useCallback((v: boolean) => {
    isNewSessionRef.current = v;
  }, []);

  /** 从服务端刷新当前 session 的消息（用于后台恢复等场景） */
  const refreshCurrentSession = useCallback(() => {
    if (sessionId) {
      loadDetailPromiseRef.current = loadSessionDetail(sessionId, {
        scrollToBottom: false,
        silent: true,
        preserveTail: true,
      });
    }
  }, [sessionId, loadSessionDetail]);

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
    }

    // Step 2: 消费预取结果或发起 API 请求
    sessionsPreload.then((preloaded) => {
      if (cancelled) return;
      if (preloaded) {
        const freshSessions = preloaded.sessions as ApiSessionListItem[];
        const freshHasMore = preloaded.hasMore;
        setSessions(freshSessions);
        setHasMore(freshHasMore);
        setIsLoadingSessions(false);
      } else {
        // 有缓存时静默加载，避免 loading 状态闪烁
        void loadSessions({ silent: !!cached });
      }
    });
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
