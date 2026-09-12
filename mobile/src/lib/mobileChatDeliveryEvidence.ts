import type { ChatClientState, ChatQueueItem, WsEvent } from '@agent/shared';
import type { MobileAcceptanceEvidence, AcceptanceSource, MobileDeliveryView, MobileSubmissionRecord } from './mobileChatDeliveryState';
import { ownsDeliveryView } from './mobileChatDeliveryState';

const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value;
const statuses = new Set(['queued', 'running', 'steered', 'completed', 'failed', 'cancelled']);
function validItem(item: ChatQueueItem): boolean {
  return !!item && id(item.clientMsgId) && id(item.sessionId) && id(item.runId)
    && (!item.sourceRunId || item.sourceRunId === item.runId)
    && (item.deliveryMode === 'queue' || item.deliveryMode === 'steer') && statuses.has(item.status);
}

/** Reads only the event's precise IDs, then respects the shared reducer's higher-authority progress. */
export function mobileAcceptanceEvidence(
  event: WsEvent,
  state: ChatClientState,
  fallbackSessionId?: string,
  replay = false,
): MobileAcceptanceEvidence[] {
  const result: MobileAcceptanceEvidence[] = [];
  const add = (clientMsgId: unknown, sessionId: string | undefined, runId: string | undefined,
    status: MobileAcceptanceEvidence['status'], source: AcceptanceSource) => {
    if (!id(clientMsgId) || (sessionId !== undefined && !id(sessionId)) || (runId !== undefined && !id(runId))) return;
    const item = sessionId ? state.queues[sessionId]?.items[clientMsgId] : undefined;
    if (item && runId && item.runId !== runId) return;
    result.push({ clientMsgId, sessionId, runId: runId ?? item?.runId,
      status: item && validItem(item) ? item.status : status, source: replay ? 'replay' : source });
  };
  switch (event.type) {
    case 'chat_ack':
      add(event.client_msg_id, event.sessionId ?? fallbackSessionId, event.runId,
        event.status ?? 'accepted', 'chat_ack');
      break;
    case 'stream_id':
      add(event.client_msg_id, event.sessionId ?? fallbackSessionId, event.runId,
        event.queued ? 'queued' : 'running', 'stream_id');
      break;
    case 'message_queued':
      if (id(event.runId)) add(event.clientMsgId, event.sessionId, event.runId, 'queued', 'queue');
      break;
    case 'steering_queued':
      if (id(event.sourceRunId)) add(event.clientMsgId, event.sessionId, event.sourceRunId, 'queued', 'queue');
      break;
    case 'queue_item_updated':
      if (validItem(event.item)) add(event.item.clientMsgId, event.item.sessionId, event.item.runId, event.item.status, 'queue');
      break;
    case 'queue_snapshot':
      if (event.snapshot?.version !== 1 || !id(event.snapshot.sessionId)
        || !Number.isFinite(Date.parse(event.snapshot.generatedAt)) || !Array.isArray(event.snapshot.items)) break;
      for (const item of event.snapshot.items) if (validItem(item) && item.sessionId === event.snapshot.sessionId) {
        add(item.clientMsgId, item.sessionId, item.runId, item.status, 'snapshot');
      }
      break;
    case 'user_message':
      add(event.client_msg_id, event.sessionId ?? fallbackSessionId, event.sourceRunId, 'accepted', 'history');
      break;
    case 'done': {
      const sessionId = event.sessionId ?? fallbackSessionId;
      if (event.client_msg_id && event.runId) add(event.client_msg_id, sessionId, event.runId, event.error ? 'failed' : 'completed', 'queue');
      else if (sessionId && event.runId) for (const item of Object.values(state.queues[sessionId]?.items ?? {})) {
        if (item.runId === event.runId && validItem(item)) add(item.clientMsgId, sessionId, item.runId, item.status, 'queue');
      }
      break;
    }
    case 'session_status':
      if (event.runId) for (const item of Object.values(state.queues[event.sessionId]?.items ?? {})) {
        if (item.runId === event.runId && validItem(item)) add(item.clientMsgId, event.sessionId, item.runId, item.status, 'queue');
      }
      break;
    case 'interjection_applied':
      if (event.sessionId) for (const clientMsgId of event.clientMsgIds) {
        const item = state.queues[event.sessionId]?.items[clientMsgId];
        if (item && validItem(item)) add(clientMsgId, event.sessionId, item.runId, item.status, 'queue');
      }
      break;
  }
  return result;
}

/** Check ownership BEFORE writing any stream/run/cursor/navigation ref in the outer Hook. */
export function canProjectMobileStreamEvent(
  event: WsEvent,
  view: MobileDeliveryView,
  getRecord: (clientMsgId: string) => MobileSubmissionRecord | undefined,
  currentRunId: string | null,
): boolean {
  if (event.type === 'stream_id' || event.type === 'session') {
    if (event.sessionId && view.sessionId && event.sessionId !== view.sessionId) return false;
    if (event.client_msg_id) {
      const record = getRecord(event.client_msg_id);
      if (record && !ownsDeliveryView(record, view)) return false;
      if (!view.sessionId && !record) return false;
      if (record?.owner.sessionId && event.sessionId && record.owner.sessionId !== event.sessionId) return false;
    } else if (!view.sessionId) return false;
    // A sparse session announcement cannot bind an unrelated new draft.
    return !!view.sessionId || !!event.client_msg_id;
  }
  if (event.type === 'done') {
    if (event.sessionId && event.sessionId !== view.sessionId) return false;
    if (event.runId && currentRunId && event.runId !== currentRunId) return false;
    if (event.client_msg_id) {
      const record = getRecord(event.client_msg_id);
      if (record && !ownsDeliveryView(record, view)) return false;
    }
    return !!currentRunId && (!event.runId || event.runId === currentRunId);
  }
  if ('sessionId' in event && typeof event.sessionId === 'string'
    && ['stream_started', 'session_status', 'user_message'].includes(event.type)) return event.sessionId === view.sessionId;
  return true;
}
