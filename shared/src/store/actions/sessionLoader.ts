/**
 * Session Loader — 会话列表和详情加载
 *
 * 从两端 useSession 提取的共享逻辑。
 */

import { getChatStore } from "../index";
import { authFetch } from "../../lib/authFetch";
import { getPlatform } from "../../platform/context";
import { mapSessionDetailToMessages } from "../../lib/sessionsApi";
import { resolvePlanModeDisplay } from "../../lib/wsEventProcessor";
import type {
  ApiSessionDetail,
  ApiSessionListItem,
  TokenUsage,
} from "../../types/session";
import type { WsAskUserQuestion } from "../../types/ws";

let _loadNonce = 0;
let _loadSessionsDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const LOAD_SESSIONS_DEBOUNCE_MS = 2000;

/** 加载会话列表（含防抖） */
export async function loadSessions(opts?: {
  fresh?: boolean;
  silent?: boolean;
}): Promise<void> {
  const store = getChatStore();
  if (!opts?.silent) store.setState({ isLoadingSessions: true });

  try {
    const freshParam = opts?.fresh ? "&fresh=1" : "";
    const response = await authFetch(`/api/sessions?limit=200${freshParam}`);
    if (response.ok) {
      const data = (await response.json()) as {
        sessions?: ApiSessionListItem[];
        hasMore?: boolean;
      };
      store.setState({
        sessions: data.sessions || [],
        hasMore: data.hasMore ?? false,
      });
    }
  } catch (err) {
    console.error("加载会话列表失败:", err);
  } finally {
    if (!opts?.silent) store.setState({ isLoadingSessions: false });
  }
}

/** 防抖版 loadSessions */
export function debouncedLoadSessions(opts?: { fresh?: boolean }): void {
  if (_loadSessionsDebounceTimer) clearTimeout(_loadSessionsDebounceTimer);
  _loadSessionsDebounceTimer = setTimeout(() => {
    _loadSessionsDebounceTimer = null;
    void loadSessions(opts);
  }, LOAD_SESSIONS_DEBOUNCE_MS);
}

/** 加载更多会话（分页） */
export async function loadMoreSessions(): Promise<void> {
  const store = getChatStore();
  const state = store.getState();
  if (!state.hasMore || state.isLoadingMore) return;

  const lastSession = state.sessions[state.sessions.length - 1];
  if (!lastSession) return;

  store.setState({ isLoadingMore: true });
  try {
    const response = await authFetch(
      `/api/sessions?limit=50&before=${lastSession.updatedAtMs}`,
    );
    if (response.ok) {
      const data = (await response.json()) as {
        sessions?: ApiSessionListItem[];
        hasMore?: boolean;
      };
      const newSessions = data.sessions || [];
      store.setState((s) => ({
        sessions: [...s.sessions, ...newSessions],
        hasMore: data.hasMore ?? false,
      }));
    }
  } catch (err) {
    console.error("加载更多会话失败:", err);
  } finally {
    store.setState({ isLoadingMore: false });
  }
}

/** 加载会话详情（含缓存、pending interactions） */
export async function loadSessionDetail(
  id: string,
  opts?: { silent?: boolean },
): Promise<void> {
  const store = getChatStore();
  const nonce = ++_loadNonce;
  const isStale = () => _loadNonce !== nonce;
  const platform = getPlatform();

  // 尝试本地缓存
  const cached = await platform.messageCache.load(id);
  if (isStale()) return;
  if (cached) {
    store.getState().setMessages(cached);
    store.setState({ activeSessionId: id });
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
        store.getState().sessions.find((s) => s.sessionId === id)?.owner
          ?.username;
      store.setState({ sessionOwner });

      const msgs = mapSessionDetailToMessages(data, sessionOwner);

      // 获取 pending interactions
      try {
        const pendingRes = await authFetch(
          `/api/chat/interactions/pending?sessionId=${encodeURIComponent(id)}`,
        );
        if (!isStale() && pendingRes.ok) {
          const pendingList = (await pendingRes.json()) as Array<{
            interactionId: string;
            type: string;
            questions?: WsAskUserQuestion[];
            toolId?: string;
            toolName?: string;
            displayName?: string;
            toolInput?: Record<string, unknown>;
            planContent?: string;
          }>;
          const existingIds = new Set(
            msgs
              .filter(
                (m) =>
                  "interactionId" in m &&
                  (m as { interactionId?: string }).interactionId,
              )
              .map((m) => (m as { interactionId: string }).interactionId),
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
              const label = resolvePlanModeDisplay(
                p.toolName,
                p.toolInput ? JSON.stringify(p.toolInput, null, 2) : "",
                p.planContent,
                p.displayName,
              );
              msgs.push({
                id: `pending-${p.interactionId}`,
                type: "permission_request",
                interactionId: p.interactionId,
                toolName: label.name,
                toolInput: label.description,
                status: "pending",
              });
            }
          }
        }
      } catch {
        /* silent */
      }

      if (isStale()) return;
      store.getState().setMessages(msgs);
      store.setState({ activeSessionId: id });

      // 缓存消息
      platform.messageCache.save(id, store.getState().getMessagesRef());

      // 加载 token 使用量
      void fetchTokenUsage(id);
    } else if (response.status === 404 || response.status === 403) {
      if (!isStale()) {
        store.setState({ activeSessionId: null });
        store.getState().resetMessages();
      }
    }
  } catch (err) {
    console.error("加载会话详情失败:", err);
  }
}

/** 刷新当前会话（不滚动到底部） */
export function refreshCurrentSession(): void {
  const store = getChatStore();
  const sid = store.getState().activeSessionId;
  if (sid) void loadSessionDetail(sid, { silent: true });
}

/** 获取 token 使用量 */
export async function fetchTokenUsage(sessionId: string): Promise<void> {
  const store = getChatStore();
  try {
    const res = await authFetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/stats`,
    );
    if (res.ok && store.getState().activeSessionId === sessionId) {
      const data = (await res.json()) as {
        tokenUsage: TokenUsage | null;
        totalCostUsd?: number | null;
      };
      const tokenUsage = data.tokenUsage
        ? { ...data.tokenUsage, totalCostUsd: data.totalCostUsd ?? null }
        : null;
      store.setState({ tokenUsage });
    }
  } catch {
    /* silent */
  }
}
