import { useState, useRef, useCallback, useEffect } from "react";
import type {
  ApiSessionListItem,
  ApiSessionDetail,
  TokenUsage,
  MessageItem,
  SessionOwnerInfo,
} from "@agent/shared";
import {
  authFetch,
  mapSessionDetailToMessages,
  mergeServerMessagesWithLocalTail,
  SESSION_STORAGE_KEY,
  registerRefresh,
  unregisterRefresh,
  getPlatform,
} from "@agent/shared";
import {
  saveSessionListCache,
  loadSessionListCache,
} from "../lib/sessionListCache";

export interface SessionCallbacks {
  resetMessages: () => void;
  setMessages: (msgs: MessageItem[]) => void;
  /** 返回当前本地消息列表引用（用于 refresh 时保留本地流式尾部，见 mergeServerMessagesWithLocalTail） */
  getMessages?: () => MessageItem[];
  triggerScroll: () => void;
  cancelActiveStream: () => void;
  clearComposer: () => void;
}

export interface SessionState {
  sessionId: string | null;
  sessions: ApiSessionListItem[];
  isLoadingSessions: boolean;
  sessionsHydrated: boolean;
  isLoadingMessages: boolean;
  deleteSessionId: string | null;
  isNewSession: boolean;
  tokenUsage: TokenUsage | null;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadDetailPromiseRef: React.RefObject<Promise<void> | null>;
  /** 当前加载的会话 owner 信息（仅 admin 查看他人会话时有值） */
  sessionOwner: SessionOwnerInfo | null;
  setSessionId: (id: string | null) => void;
  loadSessions: (
    silent?: boolean,
    opts?: { fresh?: boolean; skipMerge?: boolean },
  ) => Promise<void>;
  loadMoreSessions: () => Promise<void>;
  loadSessionDetail: (
    id: string,
    opts?: { silent?: boolean; preserveTail?: boolean },
  ) => Promise<void>;
  newSession: () => void;
  selectSession: (id: string) => void;
  confirmDeleteSession: (id: string) => void;
  cancelDeleteSession: () => void;
  handleDeleteSession: (id?: string) => Promise<void>;
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
  }) => void;
  refreshTokenUsage: () => Promise<void>;
  setIsNewSession: (v: boolean) => void;
  refreshCurrentSession: () => void;
}

export interface SessionOptions {
  ownerFilter?: string | null;
  isAdmin?: boolean;
  initialSessionId?: string | null;
}

export function useSession(
  callbacks: SessionCallbacks,
  options?: SessionOptions,
): SessionState {
  const [sessionId, setSessionId] = useState<string | null>(
    options?.initialSessionId ?? null,
  );
  const [sessions, setSessions] = useState<ApiSessionListItem[]>([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);
  const [sessionsHydrated, setSessionsHydrated] = useState(false);
  const [deleteSessionId, setDeleteSessionId] = useState<string | null>(null);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [sessionOwner, setSessionOwner] = useState<SessionOwnerInfo | null>(
    null,
  );

  const isNewSessionRef = useRef(false);
  const loadDetailPromiseRef = useRef<Promise<void> | null>(null);
  const loadNonceRef = useRef(0);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const viewAsParam = "";
  const viewAsParamRef = useRef(viewAsParam);
  viewAsParamRef.current = viewAsParam;

  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const hasMoreRef = useRef(hasMore);
  hasMoreRef.current = hasMore;
  const RECENT_LOCAL_SESSION_TTL_MS = 60_000;
  const recentLocalSessionIdsRef = useRef<Map<string, number>>(new Map());
  const markRecentLocalSession = useCallback((targetId: string) => {
    recentLocalSessionIdsRef.current.set(targetId, Date.now());
  }, []);
  const isLoadingMoreRef = useRef(isLoadingMore);
  isLoadingMoreRef.current = isLoadingMore;

  const loadSessions = useCallback(
    async (silent = false, opts?: { fresh?: boolean; skipMerge?: boolean }) => {
      try {
        if (!silent) setIsLoadingSessions(true);
        const freshParam = opts?.fresh ? "&fresh=1" : "";
        const response = await authFetch(
          `/api/sessions?limit=500${viewAsParamRef.current}${freshParam}`,
        );
        if (response.ok) {
          const data = (await response.json()) as {
            sessions?: ApiSessionListItem[];
            hasMore?: boolean;
          };
          const freshSessions = data.sessions || [];
          const freshHasMore = data.hasMore ?? false;
          const now = Date.now();
          for (const [sid, ts] of recentLocalSessionIdsRef.current) {
            if (now - ts > RECENT_LOCAL_SESSION_TTL_MS) {
              recentLocalSessionIdsRef.current.delete(sid);
            }
          }
          if (opts?.skipMerge) {
            setSessions(freshSessions);
          } else {
            setSessions((prev) => {
              const merged = new Map<string, ApiSessionListItem>();
              for (const item of freshSessions)
                merged.set(item.sessionId, item);
              const keepTail =
                freshHasMore && prev.length > freshSessions.length;
              for (const item of prev) {
                const isCurrent = item.sessionId === sessionIdRef.current;
                const isRecentLocal = recentLocalSessionIdsRef.current.has(
                  item.sessionId,
                );
                if (
                  (isCurrent || isRecentLocal || keepTail) &&
                  !merged.has(item.sessionId)
                ) {
                  merged.set(item.sessionId, item);
                }
              }
              return Array.from(merged.values()).sort(
                (a, b) => b.updatedAtMs - a.updatedAtMs,
              );
            });
          }
          setHasMore(freshHasMore);
          setSessionsHydrated(true);
        }
      } catch (err) {
        console.error("加载会话列表失败:", err);
      } finally {
        if (!silent) setIsLoadingSessions(false);
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
        `/api/sessions?limit=50&before=${lastSession.updatedAtMs}${viewAsParamRef.current}`,
      );
      if (response.ok) {
        const data = (await response.json()) as {
          sessions?: ApiSessionListItem[];
          hasMore?: boolean;
        };
        const newSessions: ApiSessionListItem[] = data.sessions || [];
        const existing = new Set(
          sessionsRef.current.map((item) => item.sessionId),
        );
        const updated = [
          ...sessionsRef.current,
          ...newSessions.filter((item) => !existing.has(item.sessionId)),
        ];
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
        const data = (await response.json()) as {
          tokenUsage?: TokenUsage;
          totalCostUsd?: number | null;
        };
        const usage = data.tokenUsage
          ? { ...data.tokenUsage, totalCostUsd: data.totalCostUsd ?? null }
          : null;
        setTokenUsage(usage);
      }
    } catch {
      /* silent */
    }
  }, []);

  const loadSessionDetail = useCallback(
    async (id: string, opts?: { silent?: boolean; preserveTail?: boolean }) => {
      const nonce = ++loadNonceRef.current;
      const isStale = () => loadNonceRef.current !== nonce;
      const platform = getPlatform();

      // silent 模式（后台恢复、WS 重连等）不显示 loading 指示器
      if (!opts?.silent) setIsLoadingMessages(true);

      // preserveTail 场景（done 后同会话刷新）：本地内存里已有最新尾部，cached 反而是更旧的快照，
      // 跳过以免闪回。
      if (!opts?.preserveTail) {
        const cached = await platform.messageCache.load(id);
        if (isStale()) return;
        if (cached) {
          cbRef.current.setMessages(cached);
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
          const data = (await response.json()) as ApiSessionDetail;
          if (isStale()) return;
          const sessionOwner =
            data.owner?.username ??
            sessionsRef.current.find((s) => s.sessionId === id)?.owner
              ?.username;
          const msgs = mapSessionDetailToMessages(data, sessionOwner);

          // Check pending interactions
          try {
            const pendingRes = await authFetch(
              `/api/chat/interactions/pending?sessionId=${encodeURIComponent(id)}`,
            );
            if (!isStale() && pendingRes.ok) {
              const pendingList = (await pendingRes.json()) as Array<{
                interactionId: string;
                type: string;
                questions?: Array<{
                  question: string;
                  header: string;
                  options: Array<{ label: string; description: string }>;
                  multiSelect: boolean;
                }>;
                toolName?: string;
                planContent?: string;
              }>;

              const PLAN_LABELS: Record<
                string,
                { name: string; fallback: string }
              > = {
                EnterPlanMode: {
                  name: "进入规划模式",
                  fallback: "Agent 请求进入规划模式。",
                },
                ExitPlanMode: {
                  name: "规划方案审批",
                  fallback: "Agent 已完成方案规划。",
                },
              };

              const existingIds = new Set(
                msgs
                  .filter((m) => "interactionId" in m && m.interactionId)
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
                    toolName: label.name,
                    toolInput: p.planContent || label.fallback,
                    status: "pending",
                  });
                }
              }
            }
          } catch {
            /* silent */
          }

          if (isStale()) return;
          // preserveTail：refresh 时服务端 transcript 可能尚未写入最后一条 assistant text，
          // 合并保留本地尾部，避免消息瞬间消失。
          let finalMsgs = msgs;
          if (opts?.preserveTail && cbRef.current.getMessages) {
            const localMsgs = cbRef.current.getMessages();
            finalMsgs = mergeServerMessagesWithLocalTail(msgs, localMsgs);
          }
          cbRef.current.setMessages(finalMsgs);
          setSessionId(id);
          setSessionOwner(data.owner ?? null);
          void fetchTokenUsage(id);
          platform.messageCache.save(id, finalMsgs);
        } else if (response.status === 404 || response.status === 403) {
          void platform.messageCache.clear(id);
          void platform.storage.removeItem(`agentChat.model.${id}`);
          removeSession(id);
          setSessionOwner(null);
          setTokenUsage(null);
        }
      } catch (err) {
        console.error("加载会话详情失败:", err);
      } finally {
        if (!isStale()) setIsLoadingMessages(false);
      }
    },
    [fetchTokenUsage],
  );

  const confirmDeleteSession = useCallback(
    (id: string) => setDeleteSessionId(id),
    [],
  );
  const cancelDeleteSession = useCallback(() => setDeleteSessionId(null), []);

  const handleDeleteSession = useCallback(
    async (targetId?: string) => {
      const idToDelete = targetId || deleteSessionId;
      if (!idToDelete) return;
      try {
        const response = await authFetch(
          `/api/sessions/${encodeURIComponent(idToDelete)}?deleteSidecar=true`,
          {
            method: "DELETE",
          },
        );
        if (!response.ok) return;

        const platform = getPlatform();
        await platform.messageCache.clear(idToDelete);
        await platform.storage.removeItem(`agentChat.model.${idToDelete}`);

        setDeleteSessionId(null);
        await loadSessions(false, { skipMerge: true });

        if (idToDelete !== sessionId) return;

        const remaining = sessions.filter(
          (item) => item.sessionId !== idToDelete,
        );
        if (remaining.length > 0) {
          await loadSessionDetail(remaining[0].sessionId);
        } else {
          setSessionId(null);
          await platform.storage.removeItem(SESSION_STORAGE_KEY);
          cbRef.current.resetMessages();
        }
      } catch (err) {
        console.error("删除会话失败:", err);
      }
    },
    [deleteSessionId, loadSessionDetail, loadSessions, sessionId, sessions],
  );

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
    if (sessionIdRef.current === targetId) {
      cbRef.current.cancelActiveStream();
      cbRef.current.resetMessages();
      setSessionId(null);
      setTokenUsage(null);
      void getPlatform().storage.removeItem(SESSION_STORAGE_KEY);
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
        setSessions((prev) =>
          prev.map((s) =>
            s.sessionId === targetId
              ? { ...s, title: newTitle || undefined }
              : s,
          ),
        );
        return true;
      } catch {
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
        const data = (await response.json()) as { title?: string };
        if (data.title) {
          setSessions((prev) =>
            prev.map((s) =>
              s.sessionId === targetId ? { ...s, title: data.title } : s,
            ),
          );
        }
        return true;
      } catch {
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
    setIsLoadingMessages(false);
    void getPlatform().storage.removeItem(SESSION_STORAGE_KEY);
  }, []);

  const selectSession = useCallback(
    (id: string) => {
      if (id === sessionId) return;
      cbRef.current.cancelActiveStream();
      cbRef.current.clearComposer();
      cbRef.current.resetMessages();
      setSessionId(id);
      setSessionOwner(null);
      setTokenUsage(null);
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

  const refreshCurrentSession = useCallback(() => {
    if (sessionId) {
      loadDetailPromiseRef.current = loadSessionDetail(sessionId, {
        silent: true,
        preserveTail: true,
      });
    }
  }, [sessionId, loadSessionDetail]);

  // Load initial session detail
  useEffect(() => {
    if (options?.initialSessionId) {
      loadDetailPromiseRef.current = loadSessionDetail(
        options.initialSessionId,
      );
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist session ID
  useEffect(() => {
    if (sessionId) {
      void getPlatform().storage.setItem(SESSION_STORAGE_KEY, sessionId);
    }
  }, [sessionId]);

  // Load sessions on mount -- cache-first
  useEffect(() => {
    let cancelled = false;

    (async () => {
      // Step 1: 从本地缓存加载，实现冷启动即时展示
      const cached = await loadSessionListCache(viewAsParamRef.current);
      if (!cancelled && cached && cached.sessions.length > 0) {
        setSessions(cached.sessions);
        setHasMore(cached.hasMore);
      }

      // Step 2: 从 API 获取最新数据（有缓存时静默加载，无缓存时显示 loading）
      if (!cancelled) {
        await loadSessions(cached != null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Register refresh bus
  useEffect(() => {
    registerRefresh("sessions", () => loadSessions(false, { fresh: true }));
    return () => unregisterRefresh("sessions");
  }, [loadSessions]);

  // Debounced session list cache write — 统一写入通道
  // 无论来源（API / WS sync），sessions 变化后 5s 内无新变化则持久化
  const debounceSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (sessions.length === 0) return;
    if (debounceSaveRef.current) clearTimeout(debounceSaveRef.current);
    debounceSaveRef.current = setTimeout(() => {
      saveSessionListCache(sessions, hasMore, viewAsParamRef.current);
      debounceSaveRef.current = null;
    }, 5000);
    return () => {
      if (debounceSaveRef.current) {
        clearTimeout(debounceSaveRef.current);
        debounceSaveRef.current = null;
      }
    };
  }, [sessions, hasMore]);

  return {
    sessionId,
    sessions,
    isLoadingSessions,
    sessionsHydrated,
    isLoadingMessages,
    deleteSessionId,
    isNewSession: isNewSessionRef.current,
    tokenUsage,
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
  };
}
