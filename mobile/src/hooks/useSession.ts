import { useState, useRef, useCallback, useEffect } from "react";
import type {
  ApiSessionListItem,
  BoundaryIdentity,
  ApiSessionDetail,
  TokenUsage,
  ContextUsageData,
  MessageItem,
  SessionOwnerInfo,
} from "@agent/shared";
import {
  authFetch,
  mapSessionDetailToMessages,
  mergeServerMessagesWithLocalTail,
  mergeSessionMessagePage,
  SESSION_STORAGE_KEY,
  registerRefresh,
  unregisterRefresh,
  getPlatform,
  beginSessionListRefresh,
  createSessionListPagerState,
  mergeLegacyOffsetSessionPage,
  mergeSessionListPage,
  reduceSessionListInteraction,
  selectSessionListItems,
  tombstoneSessionListItem,
  upsertSessionListItem,
  type SessionListInteractionEvent,
  type SessionListPage,
} from "@agent/shared";
import {
  saveSessionListCache,
  loadSessionListCache,
} from "../lib/sessionListCache";
import { injectCompactionMessages } from "../lib/compaction";

export interface SessionCallbacks {
  resetMessages: () => void;
  setMessages: (msgs: MessageItem[]) => void;
  /** 返回当前本地消息列表引用（用于 refresh 时保留本地流式尾部，见 mergeServerMessagesWithLocalTail） */
  getMessages?: () => MessageItem[];
  triggerScroll: () => void;
  cancelActiveStream: () => void;
  clearComposer: () => void;
  onQueueSnapshot?: (sessionId: string, snapshot: NonNullable<ApiSessionDetail['queueSnapshot']>) => void;
}

export interface SessionState {
  sessionId: string | null;
  sessions: ApiSessionListItem[];
  isLoadingSessions: boolean;
  sessionsHydrated: boolean;
  isLoadingMessages: boolean;
  hasMoreHistory: boolean;
  isLoadingEarlier: boolean;
  deleteSessionId: string | null;
  isNewSession: boolean;
  tokenUsage: TokenUsage | null;
  contextUsage: ContextUsageData | null;
  setContextUsage: (usage: ContextUsageData | null) => void;
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
  loadEarlierMessages: () => Promise<void>;
  newSession: (options?: { preserveComposer?: boolean }) => void;
  selectSession: (id: string) => void;
  applySessionInteractionEvent: (event: SessionListInteractionEvent) => void;
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
  /** Called only from a visible at-bottom viewport. */
  markSessionRead: (sessionId: string) => Promise<void>;
}

export interface SessionOptions {
  identity?: BoundaryIdentity | null;
  ownerFilter?: string | null;
  isAdmin?: boolean;
  initialSessionId?: string | null;
}

export function useSession(
  callbacks: SessionCallbacks,
  options?: SessionOptions,
): SessionState {
  const identity = options?.identity ?? null;
  const identityKey = identity
    ? `${identity.tenantId}:${identity.userId}:${identity.generation}`
    : 'anonymous';
  const identityKeyRef = useRef(identityKey);
  identityKeyRef.current = identityKey;
  const [sessionId, setSessionId] = useState<string | null>(
    options?.initialSessionId ?? null,
  );
  const [sessions, setSessions] = useState<ApiSessionListItem[]>([]);
  const pagerRef = useRef(createSessionListPagerState());
  const commitPager = useCallback((next: ReturnType<typeof createSessionListPagerState>) => {
    pagerRef.current = next;
    setSessions(selectSessionListItems(next));
    setHasMore(next.hasMore);
  }, []);
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);
  const [sessionsHydrated, setSessionsHydrated] = useState(false);
  const [deleteSessionId, setDeleteSessionId] = useState<string | null>(null);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const [contextUsage, setContextUsage] = useState<ContextUsageData | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [isLoadingEarlier, setIsLoadingEarlier] = useState(false);
  const historyCursorRef = useRef(new Map<string, { nextCursor?: string; hasMore: boolean; historyRevision?: string }>());
  const loadingEarlierSessionIdsRef = useRef(new Set<string>());
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

  useEffect(() => {
    loadNonceRef.current += 1;
    pagerRef.current = createSessionListPagerState();
    historyCursorRef.current.clear();
    loadingEarlierSessionIdsRef.current.clear();
    cbRef.current.cancelActiveStream();
    cbRef.current.resetMessages();
    setSessionId(options?.initialSessionId ?? null);
    setSessions([]);
    setSessionsHydrated(false);
    setHasMore(true);
    setIsLoadingSessions(false);
    setIsLoadingMore(false);
    setIsLoadingMessages(false);
    setHasMoreHistory(false);
    setIsLoadingEarlier(false);
    setSessionOwner(null);
    setTokenUsage(null);
    setContextUsage(null);
  }, [identityKey]); // identity generation 是强制内存边界

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
      const requestIdentityKey = identityKeyRef.current;
      const isCurrentIdentity = () => identityKeyRef.current === requestIdentityKey;
      const refreshing = beginSessionListRefresh(pagerRef.current);
      pagerRef.current = refreshing;
      const generation = refreshing.generation;
      try {
        if (!silent) setIsLoadingSessions(true);
        const freshParam = opts?.fresh ? "&fresh=1" : "";
        const response = await authFetch(
          `/api/sessions?limit=50${viewAsParamRef.current}${freshParam}`,
        );
        if (response.ok && isCurrentIdentity()) {
          const data = (await response.json()) as SessionListPage;
          if (!isCurrentIdentity()) return;
          const page = { sessions: data.sessions || [], hasMore: data.hasMore ?? false, nextCursor: data.nextCursor };
          const next = data.nextCursor !== undefined || !data.hasMore
            ? mergeSessionListPage(pagerRef.current, { ...page, generation, requestCursor: null })
            : mergeLegacyOffsetSessionPage(
                { ...pagerRef.current, pagingMode: null },
                { generation, sessions: page.sessions, hasMore: page.hasMore, replace: true },
              );
          commitPager(next);
          setSessionsHydrated(true);
        }
      } catch (err) {
        console.error("加载会话列表失败:", err);
      } finally {
        if (!silent && isCurrentIdentity()) setIsLoadingSessions(false);
      }
    },
    [commitPager],
  );

  const loadMoreSessions = useCallback(async () => {
    const requestIdentityKey = identityKeyRef.current;
    const isCurrentIdentity = () => identityKeyRef.current === requestIdentityKey;
    const pager = pagerRef.current;
    if (!pager.hasMore || isLoadingMoreRef.current) return;
    const requestCursor = pager.nextCursor;
    const lastSession = sessionsRef.current[sessionsRef.current.length - 1];
    if (pager.pagingMode === 'cursor' && !requestCursor) return;
    if (pager.pagingMode === 'offset' && !lastSession) return;

    setIsLoadingMore(true);
    try {
      const pageParam = pager.pagingMode === 'cursor'
        ? `&cursor=${encodeURIComponent(requestCursor!)}`
        : `&before=${lastSession!.updatedAtMs}`;
      const response = await authFetch(
        `/api/sessions?limit=50${pageParam}${viewAsParamRef.current}`,
      );
      if (response.ok && isCurrentIdentity()) {
        const data = (await response.json()) as SessionListPage;
        if (!isCurrentIdentity()) return;
        const next = pager.pagingMode === 'cursor'
          ? mergeSessionListPage(pagerRef.current, {
              sessions: data.sessions || [], hasMore: data.hasMore ?? false,
              nextCursor: data.nextCursor, generation: pager.generation, requestCursor,
            })
          : mergeLegacyOffsetSessionPage(pagerRef.current, {
              generation: pager.generation, sessions: data.sessions || [], hasMore: data.hasMore ?? false,
            });
        commitPager(next);
      }
    } catch (err) {
      console.error("加载更多会话失败:", err);
    } finally {
      if (isCurrentIdentity()) setIsLoadingMore(false);
    }
  }, [commitPager]);

  // stats 同时绑定 identity 与当前会话，避免慢响应覆盖新会话头部。
  const fetchTokenUsage = useCallback(async (id: string) => {
    const requestIdentityKey = identityKeyRef.current;
    const isCurrentIdentity = () => identityKeyRef.current === requestIdentityKey;
    try {
      const response = await authFetch(
        `/api/sessions/${encodeURIComponent(id)}/stats`,
      );
      if (response.ok && isCurrentIdentity()) {
        const data = (await response.json()) as {
          tokenUsage?: TokenUsage;
          contextUsage?: ContextUsageData;
          totalCostUsd?: number | null;
        };
        if (!isCurrentIdentity() || sessionIdRef.current !== id) return;
        const usage = data.tokenUsage
          ? { ...data.tokenUsage, totalCostUsd: data.totalCostUsd ?? null }
          : null;
        setTokenUsage(usage);
        setContextUsage(data.contextUsage ?? null);
      }
    } catch {
      /* silent */
    }
  }, []);

  const loadSessionDetail = useCallback(
    async (id: string, opts?: { silent?: boolean; preserveTail?: boolean }) => {
      const nonce = ++loadNonceRef.current;
      const requestIdentityKey = identityKeyRef.current;
      const isStale = () => loadNonceRef.current !== nonce || identityKeyRef.current !== requestIdentityKey;
      const platform = getPlatform();

      // silent 模式（后台恢复、WS 重连等）不显示 loading 指示器
      if (!opts?.silent) setIsLoadingMessages(true);

      /**
       * getMessages() 返回的是**全局当前消息数组**（与 id 无关），所以 preserveTail 只有在
       * "目标会话恰好就是屏幕上正在显示的会话"时才成立。否则会把上一个会话的尾部
       * （含用户消息与失败提示）整段拼进另一个会话——2026-08-01 web 端同款泄漏。
       */
      const canPreserveTail = opts?.preserveTail === true && sessionIdRef.current === id;

      // preserveTail 场景（done 后同会话刷新）：本地内存里已有最新尾部，cached 反而是更旧的快照，
      // 跳过以免闪回。
      if (!canPreserveTail) {
        const cached = await platform.messageCache.load(id);
        if (isStale()) return;
        if (cached) {
          cbRef.current.setMessages(cached);
          setSessionId(id);
        }
      }

      try {
        const detailParams = new URLSearchParams({ limit: '50' });
        if (opts?.silent) detailParams.set('silent', '1');
        const response = await authFetch(
          `/api/sessions/${encodeURIComponent(id)}?${detailParams.toString()}`,
        );
        if (isStale()) return;
        if (response.ok) {
          const data = (await response.json()) as ApiSessionDetail;
          if (isStale()) return;
          if (data.queueSnapshot) cbRef.current.onQueueSnapshot?.(id, data.queueSnapshot);
          const sessionOwner =
            data.owner?.username ??
            sessionsRef.current.find((s) => s.sessionId === id)?.owner
              ?.username;
          // /compact v2：shared mapBlock 会丢弃 kind==='compaction' 的分界线块，
          // 这里在 mobile 侧按 transcript 原始顺序注回压缩分界线消息
          const msgs = injectCompactionMessages(
            data.blocks,
            mapSessionDetailToMessages(data, sessionOwner),
          );

          // Check pending interactions
          try {
            const pendingRes = await authFetch(
              `/api/chat/interactions/pending?sessionId=${encodeURIComponent(id)}`,
            );
            if (!isStale() && pendingRes.ok) {
              const pendingList = (await pendingRes.json()) as Array<{
                interactionId: string;
                type: string;
                version: number;
                order: number;
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
                    interactionVersion: p.version,
                    interactionOrder: p.order,
                    questions: p.questions,
                    status: "pending",
                  });
                } else if ((p.type === "permission_request" || p.type === "approval") && p.toolName) {
                  const label = PLAN_LABELS[p.toolName] ?? {
                    name: p.toolName,
                    fallback: "",
                  };
                  msgs.push({
                    id: `pending-${p.interactionId}`,
                    type: "permission_request",
                    interactionId: p.interactionId,
                    interactionVersion: p.version,
                    interactionOrder: p.order,
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
          // 归属在请求前后各校验一次：飞行期间用户切走时，屏幕上已是别的会话的消息，不能再拼。
          let finalMsgs = msgs;
          if (canPreserveTail && sessionIdRef.current === id && cbRef.current.getMessages) {
            const localMsgs = cbRef.current.getMessages();
            finalMsgs = mergeServerMessagesWithLocalTail(msgs, localMsgs);
          }
          cbRef.current.setMessages(finalMsgs);
          setSessionId(id);
          setSessionOwner(data.owner ?? null);
          const pageHasMore = data.hasMore !== undefined ? data.hasMore : data.historyComplete === false;
          const nextHistoryCursor = data.nextCursor ?? data.oldestCursor;
          historyCursorRef.current.set(id, {
            hasMore: pageHasMore,
            ...(nextHistoryCursor ? { nextCursor: nextHistoryCursor } : {}),
            ...(data.historyRevision ? { historyRevision: data.historyRevision } : {}),
          });
          setHasMoreHistory(pageHasMore);
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

  const loadEarlierMessages = useCallback(async () => {
    const requestIdentityKey = identityKeyRef.current;
    const isCurrentIdentity = () => identityKeyRef.current === requestIdentityKey;
    const id = sessionIdRef.current;
    const cursorState = id ? historyCursorRef.current.get(id) : undefined;
    if (!id || !cursorState?.hasMore || !cursorState.nextCursor
      || loadingEarlierSessionIdsRef.current.has(id)) return;
    loadingEarlierSessionIdsRef.current.add(id);
    setIsLoadingEarlier(true);
    try {
      const params = new URLSearchParams({ before: cursorState.nextCursor, limit: '50', silent: '1' });
      const response = await authFetch(`/api/sessions/${encodeURIComponent(id)}?${params.toString()}`);
      if (!response.ok || sessionIdRef.current !== id || !isCurrentIdentity()) return;
      const data = await response.json() as ApiSessionDetail;
      if (!isCurrentIdentity()) return;
      if (cursorState.historyRevision && data.historyRevision
        && cursorState.historyRevision !== data.historyRevision) {
        await loadSessionDetail(id, { silent: true, preserveTail: true });
        return;
      }
      const owner = data.owner?.username ?? sessionOwner?.username;
      const incoming = injectCompactionMessages(data.blocks, mapSessionDetailToMessages(data, owner));
      cbRef.current.setMessages(mergeSessionMessagePage(cbRef.current.getMessages?.() ?? [], incoming));
      const hasMore = data.hasMore !== undefined ? data.hasMore : data.historyComplete === false;
      const nextCursor = data.nextCursor ?? data.oldestCursor;
      historyCursorRef.current.set(id, {
        hasMore,
        ...(nextCursor ? { nextCursor } : {}),
        ...(data.historyRevision ? { historyRevision: data.historyRevision } : {}),
      });
      setHasMoreHistory(hasMore);
    } finally {
      loadingEarlierSessionIdsRef.current.delete(id);
      if (sessionIdRef.current === id && isCurrentIdentity()) setIsLoadingEarlier(false);
    }
  }, [loadSessionDetail, sessionOwner?.username]);

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
    const prior = pagerRef.current.byId[targetId];
    if (prior) commitPager(upsertSessionListItem(pagerRef.current, { ...prior, title }));
  }, [commitPager]);

  const updateSessionMeta = useCallback(
    (targetId: string, patch: { preview?: string; updatedAtMs?: number; title?: string }) => {
      const prior = pagerRef.current.byId[targetId];
      if (!prior) return;
      commitPager(upsertSessionListItem(pagerRef.current, {
        ...prior,
        ...(patch.preview !== undefined ? { preview: patch.preview } : {}),
        ...(patch.updatedAtMs !== undefined ? { updatedAtMs: patch.updatedAtMs } : {}),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
      }));
    },
    [commitPager],
  );

  const removeSession = useCallback((targetId: string) => {
    commitPager(tombstoneSessionListItem(pagerRef.current, targetId));
    if (sessionIdRef.current === targetId) {
      cbRef.current.cancelActiveStream();
      cbRef.current.resetMessages();
      setSessionId(null);
      setTokenUsage(null);
      void getPlatform().storage.removeItem(SESSION_STORAGE_KEY);
    }
  }, [commitPager]);

  /** 插入或更新会话（其他设备创建的新会话无需 HTTP 请求） */
  const upsertSession = useCallback(
    (newSession: {
      sessionId: string; title?: string; preview?: string; updatedAtMs: number;
      model?: string; username?: string;
    }) => {
      markRecentLocalSession(newSession.sessionId);
      const prior = pagerRef.current.byId[newSession.sessionId];
      const item: ApiSessionListItem = {
        ...(prior ?? { source: { type: 'web' as const, label: 'WEB' } }),
        sessionId: newSession.sessionId,
        updatedAtMs: newSession.updatedAtMs,
        ...(newSession.title !== undefined ? { title: newSession.title } : {}),
        ...(newSession.preview !== undefined ? { preview: newSession.preview } : {}),
        ...(newSession.model !== undefined ? { model: newSession.model } : {}),
        ...(newSession.username !== undefined ? { owner: { userId: '', username: newSession.username } } : {}),
      };
      commitPager(upsertSessionListItem(pagerRef.current, item));
    },
    [commitPager, markRecentLocalSession],
  );

  const applySessionInteractionEvent = useCallback((event: SessionListInteractionEvent) => {
    commitPager(reduceSessionListInteraction(pagerRef.current, event));
  }, [commitPager]);

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
        updateSessionTitle(targetId, newTitle || '');
        return true;
      } catch {
        return false;
      }
    },
    [updateSessionTitle],
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
          updateSessionTitle(targetId, data.title);
        }
        return true;
      } catch {
        return false;
      }
    },
    [updateSessionTitle],
  );

  const newSession = useCallback((options?: { preserveComposer?: boolean }) => {
    // 作废所有在飞的会话详情请求：否则旧请求返回后仍会 setMessages + setSessionId，
    // 把上一个会话的消息灌进刚清空的草稿页（selectSession 走 loadSessionDetail 会自然递增，
    // 只有新建会话这条路径原先漏了）。
    ++loadNonceRef.current;
    cbRef.current.cancelActiveStream();
    if (!options?.preserveComposer) cbRef.current.clearComposer();
    cbRef.current.resetMessages();
    isNewSessionRef.current = true;
    setSessionId(null);
    setSessionOwner(null);
    setTokenUsage(null);
    setIsLoadingMessages(false);
    setHasMoreHistory(false);
    setIsLoadingEarlier(false);
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
      setHasMoreHistory(false);
      setIsLoadingEarlier(false);
      isNewSessionRef.current = false;
      // Opening a session does not mark it read; the visible-at-bottom callback owns that commit.
      loadDetailPromiseRef.current = loadSessionDetail(id);
    },
    [loadSessionDetail, sessionId],
  );

  const markSessionRead = useCallback(async (id: string) => {
    // Caller is the canonical visible-at-bottom viewport transition.
    const selected = pagerRef.current.byId[id];
    if (!selected?.hasUnreadAiReply) return;
    commitPager(upsertSessionListItem(pagerRef.current, { ...selected, hasUnreadAiReply: false }));
    try {
      const response = await authFetch(`/api/sessions/${encodeURIComponent(id)}/read`, { method: 'PUT' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { ack?: { sessionId?: string } };
      if (body.ack?.sessionId && body.ack.sessionId !== id) throw new Error('read ACK session mismatch');
    } catch {
      await loadSessions(true, { fresh: true });
    }
  }, [commitPager, loadSessions]);

  const refreshTokenUsage = useCallback(async () => {
    if (sessionId) void fetchTokenUsage(sessionId);
  }, [fetchTokenUsage, sessionId]);

  const setIsNewSession = useCallback((v: boolean) => {
    isNewSessionRef.current = v;
  }, []);

  /**
   * 必须读同帧的 sessionIdRef：切换会话后 React state 在重渲染前仍是上一个会话，
   * 用它会把刷新打到旧会话上。
   */
  const refreshCurrentSession = useCallback(() => {
    const sid = sessionIdRef.current;
    if (sid) {
      loadDetailPromiseRef.current = loadSessionDetail(sid, {
        silent: true,
        preserveTail: true,
      });
    }
  }, [loadSessionDetail]);

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
      const cached = await loadSessionListCache(viewAsParamRef.current, identity);
      if (!cancelled && cached && cached.sessions.length > 0) {
        const hydrated = mergeLegacyOffsetSessionPage(pagerRef.current, {
          generation: pagerRef.current.generation,
          sessions: cached.sessions,
          hasMore: cached.hasMore,
          replace: true,
        });
        commitPager(hydrated);
      }

      // Step 2: 从 API 获取最新数据（有缓存时静默加载，无缓存时显示 loading）
      if (!cancelled) {
        await loadSessions(cached != null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [identityKey]); // eslint-disable-line react-hooks/exhaustive-deps

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
      saveSessionListCache(sessions, hasMore, viewAsParamRef.current, identity);
      debounceSaveRef.current = null;
    }, 5000);
    return () => {
      if (debounceSaveRef.current) {
        clearTimeout(debounceSaveRef.current);
        debounceSaveRef.current = null;
      }
    };
  }, [sessions, hasMore, identity]);

  return {
    sessionId,
    sessions,
    isLoadingSessions,
    sessionsHydrated,
    isLoadingMessages,
    hasMoreHistory,
    isLoadingEarlier,
    deleteSessionId,
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
    applySessionInteractionEvent,
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
    markSessionRead,
  };
}
