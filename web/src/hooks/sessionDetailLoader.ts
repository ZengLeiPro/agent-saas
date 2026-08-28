import type React from "react";
import type {
  ApiSessionDetail,
  ApiSessionListItem,
  TokenUsage,
} from "@/lib/sessionsApi";
import type { MessageItem } from "@/components/types";
import type { SessionCallbacks } from "./useSession";
import type { ContextUsageData, SessionOwnerInfo } from "@agent/shared";
import {
  formatRuntimeFailureMessage,
  isInsufficientCreditsFailure,
  mergeServerMessagesWithLocalTail,
  mergeSessionMessageDelta,
} from "@agent/shared";
import { authFetch } from "@/lib/authFetch";
import {
  loadSessionMessageSnapshot,
  saveSessionMessages,
} from "@/lib/messageCache";
import {
  appendPendingInteractions,
  recordPerformanceMeasure,
  type PendingInteraction,
} from "./sessionMessageHelpers";

export const SESSION_DETAIL_PAGE_SIZE = 200;
const SESSION_CACHE_BUDGET_MS = 200;
const SESSION_DETAIL_TIMEOUT_MS = 15_000;

export interface SessionDetailCursor {
  historyComplete: boolean;
  tailCursor?: string;
  oldestCursor?: string;
}

export interface SessionDetailLoadOptions {
  scrollToBottom?: boolean;
  silent?: boolean;
  preserveTail?: boolean;
}

interface SessionDetailLoaderDependencies {
  callbacksRef: React.MutableRefObject<SessionCallbacks>;
  sessionsRef: React.MutableRefObject<ApiSessionListItem[]>;
  sessionIdRef: React.MutableRefObject<string | null>;
  detailCursorRef: React.MutableRefObject<Map<string, SessionDetailCursor>>;
  loadNonceRef: React.MutableRefObject<number>;
  detailAbortRef: React.MutableRefObject<AbortController | null>;
  setIsLoadingMessages: React.Dispatch<React.SetStateAction<boolean>>;
  setSessionLoadError: React.Dispatch<React.SetStateAction<string | null>>;
  setHasMoreHistory: React.Dispatch<React.SetStateAction<boolean>>;
  setSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setSessionOwner: React.Dispatch<React.SetStateAction<SessionOwnerInfo | null>>;
  setTokenUsage: React.Dispatch<React.SetStateAction<TokenUsage | null>>;
  setContextUsage: React.Dispatch<React.SetStateAction<ContextUsageData | null>>;
  fetchTokenUsage: (id: string) => Promise<void>;
  removeSession: (id: string) => void;
}

class SessionDetailTimeoutError extends Error {
  constructor() {
    super("Session detail request timed out");
    this.name = "SessionDetailTimeoutError";
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function loadSessionCacheWithinBudget(
  sessionId: string,
): Promise<Awaited<ReturnType<typeof loadSessionMessageSnapshot>>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      loadSessionMessageSnapshot(sessionId),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), SESSION_CACHE_BUDGET_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createSessionDetailDeadline(controller: AbortController): {
  wait: <T>(operation: Promise<T>) => Promise<T>;
  dispose: () => void;
} {
  let timedOut = false;
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => {
      if (timedOut) {
        reject(new SessionDetailTimeoutError());
        return;
      }
      const error = new Error("Session detail request aborted");
      error.name = "AbortError";
      reject(error);
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, SESSION_DETAIL_TIMEOUT_MS);
  return {
    wait: <T>(operation: Promise<T>) => Promise.race([operation, cancelled]),
    dispose: () => {
      clearTimeout(timer);
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    },
  };
}

export async function loadSessionDetailRequest(
  id: string,
  opts: SessionDetailLoadOptions | undefined,
  deps: SessionDetailLoaderDependencies,
): Promise<void> {
  deps.detailAbortRef.current?.abort();
  const controller = new AbortController();
  const deadline = createSessionDetailDeadline(controller);
  deps.detailAbortRef.current = controller;
  const nonce = ++deps.loadNonceRef.current;
  const isCurrent = () => deps.loadNonceRef.current === nonce;
  const isStale = () => !isCurrent() || controller.signal.aborted;
  const mapperPromise = import("@/lib/sessionMessageMapper");

  if (!opts?.silent) {
    deps.setSessionLoadError(null);
    deps.setIsLoadingMessages(true);
  }

  let baseMessages: MessageItem[] | null = null;
  let requestCursor: string | undefined;
  let baseHistoryComplete = false;
  let baseOldestCursor: string | undefined;
  const canPreserveTail = opts?.preserveTail === true && deps.sessionIdRef.current === id;

  if (canPreserveTail && deps.callbacksRef.current.getMessages) {
    const detailState = deps.detailCursorRef.current.get(id);
    if (detailState?.tailCursor) {
      baseMessages = deps.callbacksRef.current.getMessages();
      requestCursor = detailState.tailCursor;
      baseHistoryComplete = detailState.historyComplete;
      baseOldestCursor = detailState.oldestCursor;
    }
  } else {
    const cached = await loadSessionCacheWithinBudget(id);
    if (isStale()) {
      deadline.dispose();
      return;
    }
    if (cached) {
      const cachedMessages = cached.messages.filter((message) => message.type !== "system-error");
      baseMessages = cachedMessages;
      requestCursor = cached.tailCursor;
      baseHistoryComplete = cached.historyComplete;
      baseOldestCursor = cached.oldestCursor;
      deps.detailCursorRef.current.set(id, {
        historyComplete: cached.historyComplete,
        ...(cached.tailCursor ? { tailCursor: cached.tailCursor } : {}),
        ...(cached.oldestCursor ? { oldestCursor: cached.oldestCursor } : {}),
      });
      deps.setHasMoreHistory(!cached.historyComplete);
      deps.callbacksRef.current.setMessages(cachedMessages, opts);
      deps.setSessionId(deps.sessionIdRef.current = id);
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
    const response = await deadline.wait(
      authFetch(
        `/api/sessions/${encodeURIComponent(id)}${query}`,
        { signal: controller.signal },
      ),
    );
    const responseReceivedAt = performance.now();
    recordPerformanceMeasure(
      "agent-saas:session-detail-fetch",
      requestStartedAt,
      responseReceivedAt,
    );
    if (isStale()) return;
    if (!response.ok) {
      console.error("加载会话详情失败:", response.statusText);
      if (response.status === 404 || response.status === 403) {
        if (isCurrent()) deps.setSessionLoadError(null);
        deps.callbacksRef.current.onSessionInvalidated?.(id, response.status);
        deps.removeSession(id);
        deps.setSessionOwner(null);
        deps.setTokenUsage(null);
        deps.setContextUsage(null);
      } else if (!opts?.silent && isCurrent()) {
        deps.setSessionLoadError("会话暂时无法打开，请重试");
      }
      return;
    }

    const data: ApiSessionDetail = await deadline.wait(response.json());
    const responseParsedAt = performance.now();
    recordPerformanceMeasure(
      "agent-saas:session-detail-json",
      responseReceivedAt,
      responseParsedAt,
    );
    if (isStale()) return;
    const sessionOwner =
      data.owner?.username ??
      deps.sessionsRef.current.find((session) => session.sessionId === id)?.owner
        ?.username;
    const incomingMsgs = (
      await deadline.wait(mapperPromise)
    ).mapSessionDetailToMessages(data, sessionOwner);
    let msgs = data.mode === "delta" && baseMessages
      ? mergeSessionMessageDelta(baseMessages, incomingMsgs)
      : incomingMsgs;
    const historyComplete = data.mode === "delta"
      ? baseHistoryComplete
      : data.historyComplete !== false;
    const oldestCursor = data.mode === "delta"
      ? baseOldestCursor
      : data.oldestCursor ?? incomingMsgs[0]?.id;

    msgs = msgs.filter((message) =>
      message.type !== "system-error" && !message.id.startsWith("pending-"),
    );
    if (data.lastRunState) {
      const lastRunState = data.lastRunState;
      let alertContent: string | null = null;
      let severity: "error" | "cancelled" | "billing" = "error";
      if (lastRunState.status === "failed" || lastRunState.status === "orphaned") {
        alertContent = formatRuntimeFailureMessage(
          lastRunState.error,
          lastRunState.failureKind,
        );
        if (isInsufficientCreditsFailure(lastRunState.error)) severity = "billing";
      } else if (lastRunState.status === "cancelled") {
        alertContent = "会话已停止";
        severity = "cancelled";
      }
      if (alertContent) {
        const last = msgs[msgs.length - 1];
        if (!(
          last?.type === "system-error" &&
          last.content === alertContent &&
          last.failureKind === lastRunState.failureKind &&
          last.recoveryAction === lastRunState.recoveryAction
        )) {
          msgs.push({
            id: `system-error-${lastRunState.runId}`,
            type: "system-error",
            content: alertContent,
            severity,
            runId: lastRunState.runId,
            ...(lastRunState.failureKind ? { failureKind: lastRunState.failureKind } : {}),
            ...(lastRunState.recoveryAction ? { recoveryAction: lastRunState.recoveryAction } : {}),
            ...(lastRunState.finishedAt ? { timestamp: Date.parse(lastRunState.finishedAt) || Date.now() } : {}),
          });
        }
      }
      deps.callbacksRef.current.onLastRunState?.(id, lastRunState);
    }
    deps.callbacksRef.current.onQueuedMessages?.(id, data.queuedMessages ?? []);
    deps.callbacksRef.current.onSandboxProfile?.(id, data.sandboxProfile);

    if (isStale()) return;
    let finalMsgs = msgs;
    if (canPreserveTail && deps.sessionIdRef.current === id && deps.callbacksRef.current.getMessages) {
      finalMsgs = mergeServerMessagesWithLocalTail(
        msgs,
        deps.callbacksRef.current.getMessages(),
      );
    }
    deps.setSessionLoadError(null);
    deps.callbacksRef.current.setMessages(finalMsgs, opts);
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
    deps.setSessionId(deps.sessionIdRef.current = id);
    deps.setSessionOwner(data.owner ?? null);
    deps.setHasMoreHistory(!historyComplete);
    void deps.fetchTokenUsage(id);
    deps.detailCursorRef.current.set(id, {
      historyComplete,
      ...(data.cursor ? { tailCursor: data.cursor } : {}),
      ...(oldestCursor ? { oldestCursor } : {}),
    });
    saveSessionMessages(id, finalMsgs, {
      historyComplete,
      ...(data.cursor ? { tailCursor: data.cursor } : {}),
      ...(oldestCursor ? { oldestCursor } : {}),
    });

    void authFetch(
      `/api/chat/interactions/pending?sessionId=${encodeURIComponent(id)}`,
    ).then(async (pendingResponse) => {
      if (!pendingResponse.ok) return null;
      return pendingResponse.json() as Promise<PendingInteraction[]>;
    }).then((pendingList) => {
      if (!pendingList || isStale() || deps.sessionIdRef.current !== id) return;
      const currentMessages = deps.callbacksRef.current.getMessages?.() ?? finalMsgs;
      deps.callbacksRef.current.setMessages(
        appendPendingInteractions(currentMessages, pendingList),
        { scrollToBottom: false },
      );
    }).catch(() => {
      // pending check is best-effort
    });
  } catch (error) {
    if (isCurrent() && !opts?.silent) {
      if (error instanceof SessionDetailTimeoutError) {
        deps.setSessionLoadError("会话加载超时，请重试");
      } else if (!isAbortError(error)) {
        deps.setSessionLoadError("会话加载失败，请检查网络后重试");
      }
    }
    if (!isAbortError(error) && !(error instanceof SessionDetailTimeoutError)) {
      console.error("加载会话详情失败:", error);
    }
  } finally {
    deadline.dispose();
    if (isCurrent()) deps.setIsLoadingMessages(false);
    if (deps.detailAbortRef.current === controller) {
      deps.detailAbortRef.current = null;
    }
  }
}
