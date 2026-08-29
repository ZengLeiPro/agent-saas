import { useCallback, useEffect, useRef, useState } from "react";
import type { MemoryRecallData, NotificationData, PluginInstallData } from "@agent/shared";
import type { WsEvent } from "@/types/ws";
import type { WsResumeMessage } from "@/lib/wsClient";
import { wsClient } from "@/lib/wsClient";

const MAX_NOTIFICATIONS = 5;

/** Owns transient SDK notifications, memory recall, and plugin-install notices. */
export function useChatNotificationState() {
  const [notifications, setNotifications] = useState<NotificationData[]>([]);
  const notificationTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismissNotification = useCallback((key: string) => {
    setNotifications((list) => list.filter((notification) => notification.key !== key));
    const timer = notificationTimersRef.current.get(key);
    if (timer) {
      clearTimeout(timer);
      notificationTimersRef.current.delete(key);
    }
  }, []);

  const pushNotification = useCallback((notification: NotificationData) => {
    // The updater may run twice in StrictMode; both passes leave this flag consistent.
    let included = true;
    setNotifications((list) => {
      const next = list.filter((item) => item.key !== notification.key);
      next.push(notification);
      const order: Record<NotificationData["priority"], number> = {
        immediate: 0,
        high: 1,
        medium: 2,
        low: 3,
      };
      next.sort((a, b) => order[a.priority] - order[b.priority]);
      if (next.length > MAX_NOTIFICATIONS) {
        const dropped = next.slice(MAX_NOTIFICATIONS);
        for (const item of dropped) {
          const timer = notificationTimersRef.current.get(item.key);
          if (timer) {
            clearTimeout(timer);
            notificationTimersRef.current.delete(item.key);
          }
        }
        const finalNext = next.slice(0, MAX_NOTIFICATIONS);
        included = finalNext.some((item) => item.key === notification.key);
        return finalNext;
      }
      included = true;
      return next;
    });

    const existing = notificationTimersRef.current.get(notification.key);
    if (existing) {
      clearTimeout(existing);
      notificationTimersRef.current.delete(notification.key);
    }
    if (included && notification.timeoutMs && notification.timeoutMs > 0) {
      const timer = setTimeout(() => dismissNotification(notification.key), notification.timeoutMs);
      notificationTimersRef.current.set(notification.key, timer);
    }
  }, [dismissNotification]);

  const [lastMemoryRecall, setLastMemoryRecall] = useState<MemoryRecallData | null>(null);
  const dismissMemoryRecall = useCallback(() => setLastMemoryRecall(null), []);
  const showMemoryRecall = useCallback((memoryRecall: MemoryRecallData) => {
    setLastMemoryRecall(memoryRecall);
  }, []);

  const [pluginInstallStatus, setPluginInstallStatus] = useState<PluginInstallData | null>(null);
  const pluginInstallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearPluginInstallTimer = useCallback(() => {
    if (pluginInstallTimerRef.current) {
      clearTimeout(pluginInstallTimerRef.current);
      pluginInstallTimerRef.current = null;
    }
  }, []);
  const showPluginInstallStatus = useCallback((status: PluginInstallData) => {
    setPluginInstallStatus(status);
    clearPluginInstallTimer();
    if (status.status === "completed" || status.status === "installed" || status.status === "failed") {
      pluginInstallTimerRef.current = setTimeout(() => {
        setPluginInstallStatus((current) => (
          current && current.status === status.status && current.name === status.name ? null : current
        ));
        pluginInstallTimerRef.current = null;
      }, 5000);
    }
  }, [clearPluginInstallTimer]);

  const resetChatNotifications = useCallback(() => {
    setNotifications([]);
    for (const timer of notificationTimersRef.current.values()) clearTimeout(timer);
    notificationTimersRef.current.clear();
    setLastMemoryRecall(null);
    setPluginInstallStatus(null);
    clearPluginInstallTimer();
  }, [clearPluginInstallTimer]);

  useEffect(() => () => {
    for (const timer of notificationTimersRef.current.values()) clearTimeout(timer);
    notificationTimersRef.current.clear();
    clearPluginInstallTimer();
  }, [clearPluginInstallTimer]);

  return {
    notifications,
    dismissNotification,
    pushNotification,
    lastMemoryRecall,
    dismissMemoryRecall,
    showMemoryRecall,
    pluginInstallStatus,
    showPluginInstallStatus,
    resetChatNotifications,
  };
}

type RefLike<T> = { current: T };

interface ChatStreamCorrelationOptions {
  streamIdRef: RefLike<string | null>;
  runIdRef: RefLike<string | null>;
  immediateSessionIdRef: RefLike<string | null>;
  wsAttachedRef: RefLike<boolean>;
  loadingRef: RefLike<boolean>;
  sessionRef: RefLike<{ refreshCurrentSession: () => unknown }>;
}

/** Validates resume requests and responses against the current run/stream binding generation. */
export function useChatStreamCorrelation({
  streamIdRef,
  runIdRef,
  immediateSessionIdRef,
  wsAttachedRef,
  loadingRef,
  sessionRef,
}: ChatStreamCorrelationOptions) {
  const bindingGenerationRef = useRef(0);
  const resumeRequestsRef = useRef(new Map<string, { sessionId: string; generation: number }>());
  const resumeDedupRef = useRef<{ sessionId: string; generation: number; sentAt: number } | null>(null);
  const resumeRequestSerialRef = useRef(0);

  const advanceBindingGenerationIfChanged = useCallback((next: {
    streamId?: string | null;
    runId?: string | null;
  }): boolean => {
    const changed = (next.streamId !== undefined && next.streamId !== streamIdRef.current)
      || (next.runId !== undefined && next.runId !== runIdRef.current);
    if (changed) bindingGenerationRef.current += 1;
    return changed;
  }, [runIdRef, streamIdRef]);

  const sendCorrelatedResume = useCallback((payload: Omit<WsResumeMessage, "requestId">): Promise<boolean> => {
    const now = Date.now();
    const generation = bindingGenerationRef.current;
    const previous = resumeDedupRef.current;
    if (previous?.sessionId === payload.sessionId
      && previous.generation === generation
      && now - previous.sentAt < 2_000) {
      return Promise.resolve(true);
    }

    const requestId = `resume-${now}-${++resumeRequestSerialRef.current}`;
    const correlation = { sessionId: payload.sessionId, generation };
    resumeDedupRef.current = { sessionId: payload.sessionId, generation, sentAt: now };
    resumeRequestsRef.current.set(requestId, correlation);
    setTimeout(() => {
      if (resumeRequestsRef.current.get(requestId) === correlation) {
        resumeRequestsRef.current.delete(requestId);
      }
    }, 30_000);

    return wsClient.ensureConnectedSend({ ...payload, requestId }).then(
      (ok) => {
        if (!ok) {
          resumeRequestsRef.current.delete(requestId);
        } else {
          // ensureConnectedSend may wait for reconnect; calibrate when the send actually settles.
          correlation.generation = bindingGenerationRef.current;
          resumeDedupRef.current = {
            sessionId: payload.sessionId,
            generation: correlation.generation,
            sentAt: Date.now(),
          };
        }
        return ok;
      },
      (err) => {
        resumeRequestsRef.current.delete(requestId);
        throw err;
      },
    );
  }, []);

  const invalidateResumeRequests = useCallback((sessionId: string) => {
    for (const [requestId, request] of resumeRequestsRef.current) {
      if (request.sessionId === sessionId) resumeRequestsRef.current.delete(requestId);
    }
    if (resumeDedupRef.current?.sessionId === sessionId) resumeDedupRef.current = null;
  }, []);

  const shouldApplyActiveStreamResponse = useCallback((
    response: Extract<WsEvent, { type: "active_stream" }>,
  ): boolean => {
    if (response.requestId) {
      const request = resumeRequestsRef.current.get(response.requestId);
      const accepted = Boolean(
        request
        && request.sessionId === response.sessionId
        && request.generation === bindingGenerationRef.current,
      );
      if (accepted && request) {
        const dedup = resumeDedupRef.current;
        if (dedup?.sessionId === request.sessionId && dedup.generation === request.generation) resumeDedupRef.current = null;
      }
      return accepted;
    }

    // Legacy servers may omit requestId. Never let an inactive or mismatched late
    // response tear down the current binding.
    if (response.sessionId === immediateSessionIdRef.current) {
      const hasCurrentBinding = Boolean(
        runIdRef.current || streamIdRef.current || wsAttachedRef.current || loadingRef.current,
      );
      if (!response.active && hasCurrentBinding) {
        sessionRef.current.refreshCurrentSession();
        return false;
      }
      if (response.active) {
        if (runIdRef.current && response.runId && response.runId !== runIdRef.current) return false;
        if (streamIdRef.current && response.streamId && response.streamId !== streamIdRef.current) return false;
      }
    }
    return true;
  }, [immediateSessionIdRef, loadingRef, runIdRef, sessionRef, streamIdRef, wsAttachedRef]);

  return {
    streamBindingGenerationRef: bindingGenerationRef,
    advanceStreamBindingGenerationIfChanged: advanceBindingGenerationIfChanged,
    sendCorrelatedResume,
    invalidateResumeRequests,
    shouldApplyActiveStreamResponse,
  };
}
