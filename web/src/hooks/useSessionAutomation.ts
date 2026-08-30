import { useCallback, useEffect, useRef, useState } from 'react';
import type { WsEnvelope } from '@/lib/wsClient';
import { wsClient } from '@/lib/wsClient';
import type { UploadedFile } from '@/components/types';
import {
  controlSessionAutomation,
  createStableClientMsgId,
  fetchAutomationEvents,
  fetchSessionAutomation,
  normalizeAutomationSnapshot,
  submitAutomationCommand,
  type AutomationControlRequest,
  type AutomationTimelineEvent,
  type SessionAutomationSnapshot,
} from '@/lib/sessionAutomation';

interface UseSessionAutomationOptions {
  sessionId: string | null;
  onSessionCommitted?: (sessionId: string) => void;
  onNotification?: (notification: { key: string; text: string; priority: 'low' | 'medium' | 'high' | 'immediate'; color?: string; timeoutMs?: number }) => void;
}

interface PendingCommand {
  key: string;
  clientMsgId: string;
}

function projectionVersion(snapshot: SessionAutomationSnapshot | null | undefined): number {
  return Number(snapshot?.projectionVersion ?? 0);
}

export function useSessionAutomation({ sessionId, onSessionCommitted, onNotification }: UseSessionAutomationOptions) {
  const [snapshot, setSnapshot] = useState<SessionAutomationSnapshot | null>(null);
  const [timeline, setTimeline] = useState<AutomationTimelineEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [commandPending, setCommandPending] = useState(false);
  const [controlPending, setControlPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionIdRef = useRef(sessionId);
  const snapshotRef = useRef(snapshot);
  const cursorRef = useRef<string | null>(null);
  const requestGenerationRef = useRef(0);
  const seenEventIdsRef = useRef(new Set<string>());
  const notifiedEventIdsRef = useRef(new Set<string>());
  const pendingCommandRef = useRef<PendingCommand | null>(null);
  const callbacksRef = useRef({ onSessionCommitted, onNotification });
  callbacksRef.current = { onSessionCommitted, onNotification };
  sessionIdRef.current = sessionId;
  snapshotRef.current = snapshot;

  const applySnapshot = useCallback((incoming: SessionAutomationSnapshot | null) => {
    const next = incoming ? normalizeAutomationSnapshot(incoming) : null;
    if (next && snapshotRef.current
      && next.automationId === snapshotRef.current.automationId
      && projectionVersion(next) < projectionVersion(snapshotRef.current)) return false;
    snapshotRef.current = next;
    setSnapshot(next);
    return true;
  }, []);

  const appendEvents = useCallback((events: AutomationTimelineEvent[]) => {
    const unseen = events.filter((event) => {
      if (!event.eventId || seenEventIdsRef.current.has(event.eventId)) return false;
      seenEventIdsRef.current.add(event.eventId);
      return true;
    });
    if (unseen.length === 0) return;
    setTimeline((current) => [...current, ...unseen].slice(-50));
  }, []);

  const refresh = useCallback(async (targetSessionId = sessionIdRef.current) => {
    const generation = ++requestGenerationRef.current;
    if (!targetSessionId) {
      applySnapshot(null);
      cursorRef.current = null;
      setTimeline([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await fetchSessionAutomation(targetSessionId);
      if (generation !== requestGenerationRef.current || sessionIdRef.current !== targetSessionId) return;
      applySnapshot(result.snapshot);
      cursorRef.current = result.cursor;
      if (result.snapshot) {
        const eventResult = await fetchAutomationEvents(result.snapshot.automationId, result.cursor);
        if (generation !== requestGenerationRef.current || sessionIdRef.current !== targetSessionId) return;
        appendEvents(eventResult.events);
        cursorRef.current = eventResult.cursor;
      }
    } catch (cause) {
      if (generation === requestGenerationRef.current) setError(cause instanceof Error ? cause.message : '自动化状态加载失败');
    } finally {
      if (generation === requestGenerationRef.current) setLoading(false);
    }
  }, [applySnapshot, appendEvents]);

  useEffect(() => {
    seenEventIdsRef.current.clear();
    setTimeline([]);
    cursorRef.current = null;
    void refresh(sessionId);
  }, [refresh, sessionId]);

  useEffect(() => {
    const unsubscribeMessage = wsClient.onMessage((envelope: WsEnvelope) => {
      const data = envelope.data as Record<string, unknown>;
      const type = String(data?.type ?? '');
      if (!type.startsWith('automation_')) return;
      const eventSessionId = typeof data.sessionId === 'string' ? data.sessionId : null;
      if (eventSessionId && eventSessionId !== sessionIdRef.current) return;
      const eventId = typeof data.eventId === 'string' ? data.eventId : '';
      if (eventId && seenEventIdsRef.current.has(eventId)) return;
      if (eventId) seenEventIdsRef.current.add(eventId);

      if (type === 'automation_command_ack') {
        const ackSnapshot = data.snapshot as SessionAutomationSnapshot | undefined;
        if (ackSnapshot) applySnapshot(ackSnapshot);
        if (eventSessionId) callbacksRef.current.onSessionCommitted?.(eventSessionId);
        return;
      }
      if (type === 'automation_state_changed') {
        const next = data.snapshot as SessionAutomationSnapshot | undefined;
        if (next && applySnapshot(next)) {
          setTimeline((current) => [...current, {
            eventId: eventId || `${next.automationId}:${next.projectionVersion}`,
            type,
            snapshot: next,
            message: typeof data.message === 'string' ? data.message : undefined,
          }].slice(-50));
        }
        return;
      }
      if (type === 'automation_execution_changed') {
        setTimeline((current) => [...current, {
          eventId: eventId || `${String(data.runId)}:${String(data.phase)}`,
          type,
          message: `Runtime phase: ${String(data.phase ?? 'unknown')}`,
        }].slice(-50));
        return;
      }
      if (type === 'automation_notification' && eventId && !notifiedEventIdsRef.current.has(eventId)) {
        notifiedEventIdsRef.current.add(eventId);
        const severity = String(data.severity ?? 'info');
        callbacksRef.current.onNotification?.({
          key: `automation:${eventId}`,
          text: String(data.message ?? data.code ?? '自动化状态已更新'),
          priority: severity === 'error' ? 'immediate' : severity === 'warn' ? 'high' : 'medium',
          color: severity === 'error' ? 'red' : severity === 'warn' ? 'amber' : 'blue',
          timeoutMs: severity === 'error' ? undefined : 8_000,
        });
      }
    });
    const unsubscribeState = wsClient.onStateChange((state) => {
      if (state === 'connected' && sessionIdRef.current) void refresh(sessionIdRef.current);
    });
    return () => {
      unsubscribeMessage();
      unsubscribeState();
    };
  }, [applySnapshot, refresh]);

  const submitCommand = useCallback(async (rawCommand: string, attachments: UploadedFile[]) => {
    const attachmentIds = attachments.map((file) => file.attachmentId).filter((id): id is string => Boolean(id));
    if (attachmentIds.length !== attachments.length) throw new Error('附件尚未取得 attachmentId，请重新上传后再试');
    const key = `${sessionIdRef.current ?? 'new'}\n${rawCommand}\n${attachmentIds.join(',')}`;
    const pending = pendingCommandRef.current?.key === key
      ? pendingCommandRef.current
      : { key, clientMsgId: createStableClientMsgId() };
    pendingCommandRef.current = pending;
    setCommandPending(true);
    setError(null);
    try {
      const result = await submitAutomationCommand({
        clientMsgId: pending.clientMsgId,
        sessionId: sessionIdRef.current,
        rawCommand,
        attachmentIds,
      });
      pendingCommandRef.current = null;
      applySnapshot(result.automation);
      cursorRef.current = result.cursor ?? null;
      callbacksRef.current.onSessionCommitted?.(result.sessionId);
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '自动化命令提交失败');
      throw cause;
    } finally {
      setCommandPending(false);
    }
  }, [applySnapshot]);

  const control = useCallback(async (request: AutomationControlRequest) => {
    const current = snapshotRef.current;
    if (!current) return;
    setControlPending(true);
    setError(null);
    try {
      applySnapshot(await controlSessionAutomation(current, request));
    } catch (cause) {
      const status = (cause as { status?: number }).status;
      setError(cause instanceof Error ? cause.message : '自动化控制失败');
      if (status === 409 || status === 412) await refresh();
      throw cause;
    } finally {
      setControlPending(false);
    }
  }, [applySnapshot, refresh]);

  return { snapshot, timeline, loading, commandPending, controlPending, error, refresh, submitCommand, control };
}
