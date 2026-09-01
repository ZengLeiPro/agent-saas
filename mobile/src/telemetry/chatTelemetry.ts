import type { WsEvent } from '@agent/shared';
import { telemetryClient } from './runtime';

const now = () => globalThis.performance?.now?.() ?? Date.now();
const submissions = new Map<
  string,
  { startedAt: number; sessionId?: string; firstToken: boolean }
>();
let latestClientMsgId: string | null = null;

export function markChatSubmit(clientMsgId: string, sessionId?: string): void {
  latestClientMsgId = clientMsgId;
  submissions.set(clientMsgId, {
    startedAt: now(),
    ...(sessionId ? { sessionId } : {}),
    firstToken: false,
  });
  telemetryClient()?.capture('chat_submit', {
    correlationId: clientMsgId,
    ...(sessionId ? { sessionId } : {}),
  });
}

export function markChatAck(clientMsgId: string, event?: WsEvent): void {
  const pending = submissions.get(clientMsgId);
  const sessionId =
    event && 'sessionId' in event && typeof event.sessionId === 'string'
      ? event.sessionId
      : pending?.sessionId;
  const runId =
    event && 'runId' in event && typeof event.runId === 'string' ? event.runId : undefined;
  telemetryClient()?.capture('chat_ack', {
    correlationId: clientMsgId,
    ...(sessionId ? { sessionId } : {}),
    ...(runId ? { runId } : {}),
    ...(pending ? { measurements: { durationMs: Math.max(0, now() - pending.startedAt) } } : {}),
  });
}

export function observeChatEvent(event: WsEvent, fallbackSessionId?: string): void {
  const id = latestClientMsgId;
  if (!id) return;
  const pending = submissions.get(id);
  if (!pending) return;
  const sessionId =
    'sessionId' in event && typeof event.sessionId === 'string'
      ? event.sessionId
      : (pending.sessionId ?? fallbackSessionId);
  const runId = 'runId' in event && typeof event.runId === 'string' ? event.runId : undefined;
  if (event.type === 'text' && !pending.firstToken) {
    pending.firstToken = true;
    telemetryClient()?.capture('first_token', {
      correlationId: id,
      ...(sessionId ? { sessionId } : {}),
      ...(runId ? { runId } : {}),
      measurements: { durationMs: Math.max(0, now() - pending.startedAt) },
    });
  }
  if (event.type === 'done') {
    telemetryClient()?.capture('run_terminal', {
      correlationId: id,
      ...(sessionId ? { sessionId } : {}),
      ...(runId ? { runId } : {}),
      measurements: {
        durationMs: Math.max(0, now() - pending.startedAt),
        status: event.error ? 'failed' : 'completed',
      },
    });
    submissions.delete(id);
    if (latestClientMsgId === id) latestClientMsgId = null;
  }
}

export function clearChatTelemetry(): void {
  submissions.clear();
  latestClientMsgId = null;
}
