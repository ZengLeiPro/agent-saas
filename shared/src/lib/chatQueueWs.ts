import type { WsEvent } from '../types/ws';
import type { ChatQueueReducerEvent, ChatQueueStatus } from './chatQueue';

function queueStatusFromAck(
  status: Extract<WsEvent, { type: 'chat_ack' }>['status'],
): ChatQueueStatus | undefined {
  if (!status || status === 'accepted' || status === 'queued') return 'queued';
  return status;
}

/**
 * Thin compatibility projector from current WS frames into the M20-02 queue reducer protocol.
 * One WS frame may yield no queue event; snapshot/detail remains the cold-start authority.
 */
export function chatQueueReducerEventsFromWsEvent(
  event: WsEvent,
  fallbackSessionId?: string,
): ChatQueueReducerEvent[] {
  switch (event.type) {
    case 'queue_snapshot':
      return [{ type: 'snapshot', snapshot: event.snapshot }];
    case 'queue_item_updated':
      return [{ type: 'server_upsert', item: event.item }];
    case 'message_queued':
      return [{
        type: 'server_upsert',
        item: {
          sessionId: event.sessionId,
          clientMsgId: event.clientMsgId,
          runId: event.runId,
          sourceRunId: event.runId,
          deliveryMode: event.deliveryMode,
          status: 'queued',
          ...(event.targetRunId ? { targetRunId: event.targetRunId } : {}),
          ...(event.queuePosition !== undefined ? { queuePosition: event.queuePosition } : {}),
          content: event.content,
          ...(event.attachments ? {
            attachments: event.attachments.flatMap((attachment) => attachment.attachmentId
              ? [{ ...attachment, attachmentId: attachment.attachmentId }]
              : []),
          } : {}),
          acceptedAt: new Date(event.timestamp).toISOString(),
        },
      }];
    case 'steering_queued':
      return [{
        type: 'server_upsert',
        item: {
          sessionId: event.sessionId,
          clientMsgId: event.clientMsgId,
          runId: event.sourceRunId,
          sourceRunId: event.sourceRunId,
          deliveryMode: 'steer',
          status: 'queued',
          targetRunId: event.targetRunId,
          content: event.content,
          ...(event.attachments ? {
            attachments: event.attachments.flatMap((attachment) => attachment.attachmentId
              ? [{ ...attachment, attachmentId: attachment.attachmentId }]
              : []),
          } : {}),
          acceptedAt: new Date(event.timestamp).toISOString(),
        },
      }];
    case 'chat_ack': {
      const sessionId = event.sessionId ?? fallbackSessionId;
      const runId = event.runId;
      const status = queueStatusFromAck(event.status);
      if (!sessionId || !runId || !status) return [];
      return [{
        type: 'server_upsert',
        item: {
          sessionId,
          clientMsgId: event.client_msg_id,
          runId,
          sourceRunId: event.sourceRunId ?? runId,
          deliveryMode: event.deliveryMode ?? 'queue',
          status,
          ...(event.queuePosition !== undefined ? { queuePosition: event.queuePosition } : {}),
        },
      }];
    }
    case 'stream_id': {
      const sessionId = event.sessionId ?? fallbackSessionId;
      if (!sessionId || !event.runId || !event.client_msg_id) return [];
      return [{
        type: 'server_upsert',
        item: {
          sessionId,
          clientMsgId: event.client_msg_id,
          runId: event.runId,
          sourceRunId: event.runId,
          deliveryMode: event.deliveryMode ?? 'queue',
          status: event.queued ? 'queued' : 'running',
          ...(event.targetRunId ? { targetRunId: event.targetRunId } : {}),
          ...(event.queuePosition !== undefined ? { queuePosition: event.queuePosition } : {}),
        },
      }];
    }
    case 'session_status': {
      const status = event.status === 'completed'
        ? 'completed'
        : event.status === 'failed' || event.status === 'orphaned'
          ? 'failed'
          : event.status === 'cancelled'
            ? 'cancelled'
            : event.status === 'queued'
              ? 'queued'
              : ['busy', 'running', 'waiting_approval', 'waiting_user', 'waiting_hand'].includes(event.status)
                ? 'running'
                : undefined;
      if (!status || !event.runId) return [];
      if (status === 'completed' || status === 'failed' || status === 'cancelled') {
        return [{
          type: 'server_terminal',
          sessionId: event.sessionId,
          runId: event.runId,
          status,
          ...(event.reason ? { reason: event.reason } : {}),
        }];
      }
      return [{
        type: 'server_upsert',
        item: {
          sessionId: event.sessionId,
          runId: event.runId,
          sourceRunId: event.runId,
          // clientMsgId is filled from the existing item selected by runId.
          status,
        },
      }];
    }
    case 'done': {
      const sessionId = event.sessionId ?? fallbackSessionId;
      if (!sessionId || (!event.runId && !event.client_msg_id)) return [];
      return [{
        type: 'server_terminal',
        sessionId,
        ...(event.runId ? { runId: event.runId } : {}),
        ...(event.client_msg_id ? { clientMsgId: event.client_msg_id } : {}),
        status: event.error ? 'failed' : 'completed',
        ...(event.error ? { reason: event.error } : {}),
      }];
    }
    case 'interjection_applied':
      return [{
        type: 'steered',
        sessionId: event.sessionId ?? fallbackSessionId ?? '',
        clientMsgIds: event.clientMsgIds,
        sourceRunIds: event.sourceRunIds,
      }].filter((candidate) => candidate.sessionId) as ChatQueueReducerEvent[];
    case 'steering_cancelled':
      return [{
        type: 'server_terminal',
        sessionId: event.sessionId,
        sourceRunId: event.sourceRunId,
        ...(event.clientMsgId ? { clientMsgId: event.clientMsgId } : {}),
        status: 'cancelled',
        reason: event.reason,
      }];
    case 'cancel_queued_result': {
      if (event.snapshot) return [{ type: 'snapshot', snapshot: event.snapshot }];
      if (event.item) return [{ type: 'server_upsert', item: event.item }];
      const sessionId = event.sessionId ?? fallbackSessionId;
      if (!event.ok || !sessionId) return [];
      return [{
        type: 'server_terminal',
        sessionId,
        sourceRunId: event.sourceRunId,
        ...(event.clientMsgId ? { clientMsgId: event.clientMsgId } : {}),
        status: 'cancelled',
      }];
    }
    default:
      return [];
  }
}
