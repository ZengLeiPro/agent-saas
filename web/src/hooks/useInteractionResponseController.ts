import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import type { MessageItem } from '@/components/types';
import { wsClient } from '@/lib/wsClient';
import type { WsEvent } from '@/types/ws';
import {
  createInteractionRequestId,
  interactionKey,
  projectInteractionResolution,
  rememberResolvedInteraction,
  type AskUserAnswers,
} from '@agent/shared';
import { hydrateInteractionVersion } from './interactionResponseVersion';
import type { MessagesState } from './useMessages';
import type { SessionRuntime, SessionRuntimePatch } from './useChatAppStateTypes';

const RESPONSE_ACK_TIMEOUT_MS = 15_000;

type PendingResponse = {
  sessionId: string;
  type: 'permission_request' | 'ask_user';
  response: Record<string, unknown>;
  version: number;
  generation: number;
  attemptId: string;
  ackTimer?: ReturnType<typeof setTimeout>;
};

type Options = {
  messages: MessagesState;
  currentSessionId: () => string | null;
  activeRunsBySession: MutableRefObject<Map<string, SessionRuntime>>;
  patchSessionRuntime: (
    sessionId: string,
    patch: SessionRuntimePatch,
    options?: { silent?: boolean },
  ) => void;
  handledTerminalKeysRef: MutableRefObject<Set<string>>;
  resolvedInteractionIdsRef: MutableRefObject<Set<string>>;
  interactionRuntimeSyncRef: MutableRefObject<(sessionId: string) => void>;
  loadSessions: () => void;
  markSessionRead: (sessionId: string | null) => void;
};

export function useInteractionResponseController(options: Options) {
  const {
    messages,
    currentSessionId,
    activeRunsBySession,
    patchSessionRuntime,
    handledTerminalKeysRef,
    resolvedInteractionIdsRef,
    interactionRuntimeSyncRef,
    loadSessions,
    markSessionRead,
  } = options;
  const messagesStateRef = useRef(messages);
  messagesStateRef.current = messages;
  const loadSessionsRef = useRef(loadSessions);
  loadSessionsRef.current = loadSessions;
  const markSessionReadRef = useRef(markSessionRead);
  markSessionReadRef.current = markSessionRead;
  const pendingResponsesRef = useRef(new Map<string, PendingResponse>());
  const responseGenerationRef = useRef(new Map<string, number>());
  const responseLocksRef = useRef(new Set<string>());

  const releaseResponse = useCallback(
    (id: string, generation: number, error: string) => {
      const pending = pendingResponsesRef.current.get(id);
      if (!pending || pending.generation !== generation) return;
      if (pending.ackTimer) clearTimeout(pending.ackTimer);
      pendingResponsesRef.current.delete(id);
      if (pending.sessionId === currentSessionId())
        messagesStateRef.current.addMessage({
          type: 'system-error',
          severity: 'error',
          content: `回复未确认：${error}。请重试。`,
          timestamp: Date.now(),
        });
    },
    [currentSessionId],
  );

  const releaseAllResponses = useCallback(
    (error: string) => {
      for (const [id, { generation }] of pendingResponsesRef.current)
        releaseResponse(id, generation, error);
    },
    [releaseResponse],
  );

  useEffect(
    () => () => {
      for (const { ackTimer } of pendingResponsesRef.current.values())
        if (ackTimer) clearTimeout(ackTimer);
      pendingResponsesRef.current.clear();
      responseLocksRef.current.clear();
    },
    [],
  );

  const syncInteractionRuntime = useCallback(
    (sessionId: string) => {
      if (sessionId !== currentSessionId()) return;
      const pending = messagesStateRef.current.messagesRef.current
        .filter(
          (message): message is Extract<MessageItem, { type: 'permission_request' | 'ask_user' }> =>
            (message.type === 'permission_request' || message.type === 'ask_user') &&
            message.status === 'pending',
        )
        .sort(
          (left, right) =>
            (left.interactionOrder ?? Number.MAX_SAFE_INTEGER) -
            (right.interactionOrder ?? Number.MAX_SAFE_INTEGER),
        );
      const activeIds = new Set(pending.map((message) => message.interactionId));
      for (const [interactionId, response] of pendingResponsesRef.current) {
        if (response.sessionId !== sessionId || activeIds.has(interactionId)) continue;
        if (response.ackTimer) clearTimeout(response.ackTimer);
        pendingResponsesRef.current.delete(interactionId);
      }
      if (pending[0]) {
        patchSessionRuntime(sessionId, {
          status: pending[0].type === 'permission_request' ? 'waiting_approval' : 'waiting_user',
          source: 'ws',
          attached: true,
        });
        return;
      }
      const current = activeRunsBySession.current.get(sessionId);
      if (current?.status === 'waiting_user' || current?.status === 'waiting_approval') {
        patchSessionRuntime(sessionId, { status: 'queued', source: 'ws', attached: true });
      }
    },
    [activeRunsBySession, currentSessionId, patchSessionRuntime],
  );
  interactionRuntimeSyncRef.current = syncInteractionRuntime;

  const finalizeInteractionProjection = useCallback(
    (sessionId: string, interactionId: string, response?: Record<string, unknown>) => {
      rememberResolvedInteraction(resolvedInteractionIdsRef.current, sessionId, interactionId);
      handledTerminalKeysRef.current.add(`interaction:${interactionKey(sessionId, interactionId)}`);
      const pending = pendingResponsesRef.current.get(interactionId);
      if (pending?.ackTimer) clearTimeout(pending.ackTimer);
      pendingResponsesRef.current.delete(interactionId);
      if (sessionId === currentSessionId()) {
        if (response)
          messagesStateRef.current.setMessages(
            projectInteractionResolution(
              messagesStateRef.current.messagesRef.current,
              interactionId,
              response,
            ),
            { scrollToBottom: false },
          );
        syncInteractionRuntime(sessionId);
      }
      loadSessionsRef.current();
    },
    [currentSessionId, handledTerminalKeysRef, resolvedInteractionIdsRef, syncInteractionRuntime],
  );

  const resolveInteractionResponse = useCallback(
    (data: Extract<WsEvent, { type: 'respond_ok' | 'respond_error' }>) => {
      const pending = pendingResponsesRef.current.get(data.interactionId);
      if (!pending) return;
      const ackAttemptId = (data as { clientAttemptId?: unknown }).clientAttemptId;
      if (
        (typeof ackAttemptId === 'string' && ackAttemptId !== pending.attemptId) ||
        (ackAttemptId === undefined && pending.generation > 1) ||
        (data.version !== undefined && data.version !== pending.version)
      )
        return;
      if (pending.ackTimer) clearTimeout(pending.ackTimer);
      if (data.type === 'respond_ok' && data.status === 'accepted') {
        pending.ackTimer = setTimeout(
          () => releaseResponse(data.interactionId, pending.generation, '等待服务端完成超时'),
          RESPONSE_ACK_TIMEOUT_MS,
        );
        return;
      }
      pendingResponsesRef.current.delete(data.interactionId);
      if (data.type === 'respond_ok') {
        const response =
          data.response && typeof data.response === 'object' ? data.response : pending.response;
        const sessionId = data.sessionId ?? pending.sessionId;
        finalizeInteractionProjection(sessionId, data.interactionId, response);
        markSessionReadRef.current(sessionId);
        return;
      }
      if (pending.sessionId !== currentSessionId()) return;
      const index = messagesStateRef.current.messagesRef.current.findIndex(
        (message) => message.type === pending.type && message.interactionId === data.interactionId,
      );
      if (index < 0) return;
      messagesStateRef.current.updateMessageAt(index, (message) =>
        message.type === pending.type && message.interactionId === data.interactionId
          ? { ...message, status: 'pending' as const }
          : message,
      );
      messagesStateRef.current.addMessage({
        type: 'system-error',
        severity: 'error',
        content: `回复未提交：${data.error || '服务端拒绝了该回复'}。请重试。`,
        timestamp: Date.now(),
      });
    },
    [currentSessionId, finalizeInteractionProjection, releaseResponse],
  );

  const respondToInteraction = useCallback(
    async (
      interactionId: string,
      type: 'permission_request' | 'ask_user',
      response: Record<string, unknown>,
    ) => {
      if (
        pendingResponsesRef.current.has(interactionId) ||
        responseLocksRef.current.has(interactionId)
      )
        return;
      responseLocksRef.current.add(interactionId);
      const generation = (responseGenerationRef.current.get(interactionId) ?? 0) + 1;
      const sessionId = currentSessionId();
      if (!sessionId) {
        responseLocksRef.current.delete(interactionId);
        return;
      }
      const version = await hydrateInteractionVersion(
        sessionId,
        interactionId,
        () => messagesStateRef.current.messagesRef.current,
        (nextMessages, setOptions) => {
          if (sessionId === currentSessionId())
            messagesStateRef.current.setMessages(nextMessages, setOptions);
        },
      ).catch(() => null);
      if (!Number.isSafeInteger(version)) {
        responseLocksRef.current.delete(interactionId);
        const stillPending = messagesStateRef.current.messagesRef.current.some(
          (message) =>
            (message.type === 'permission_request' || message.type === 'ask_user') &&
            message.interactionId === interactionId &&
            message.status === 'pending',
        );
        if (stillPending && sessionId === currentSessionId())
          messagesStateRef.current.addMessage({
            type: 'system-error',
            severity: 'error',
            content: '问题状态同步失败，请重试。',
            timestamp: Date.now(),
          });
        return;
      }
      const attemptId = createInteractionRequestId(sessionId, interactionId, response);
      responseGenerationRef.current.set(interactionId, generation);
      const pending: PendingResponse = {
        sessionId,
        type,
        response,
        version: version!,
        generation,
        attemptId,
      };
      pendingResponsesRef.current.set(interactionId, pending);
      responseLocksRef.current.delete(interactionId);
      const sent = await wsClient
        .ensureConnectedSend({
          action: 'respond',
          interactionId,
          sessionId,
          version,
          requestId: attemptId,
          clientAttemptId: attemptId,
          response,
          ...response,
        })
        .catch(() => false);
      if (!sent) {
        releaseResponse(interactionId, generation, '网络连接失败');
        return;
      }
      if (pendingResponsesRef.current.get(interactionId) !== pending) return;
      pending.ackTimer = setTimeout(
        () => releaseResponse(interactionId, generation, '等待服务端确认超时'),
        RESPONSE_ACK_TIMEOUT_MS,
      );
    },
    [currentSessionId, releaseResponse],
  );

  const handlePermissionResponse = useCallback(
    (interactionId: string, allow: boolean) =>
      respondToInteraction(interactionId, 'permission_request', {
        allow,
        message: allow ? undefined : 'User denied',
      }),
    [respondToInteraction],
  );
  const handleAskUserResponse = useCallback(
    (interactionId: string, answers: AskUserAnswers) =>
      respondToInteraction(interactionId, 'ask_user', { answers }),
    [respondToInteraction],
  );

  return {
    releaseAllResponses,
    resolveInteractionResponse,
    syncInteractionRuntime,
    finalizeInteractionProjection,
    handlePermissionResponse,
    handleAskUserResponse,
  };
}
