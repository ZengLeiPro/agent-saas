import { parseEventLine, type DwsPersonalEvent } from './personalEventGateway.js';

export const DWS_SUPPORTED_EVENT_TYPES = new Set([
  'user_im_message_receive_at',
  'user_im_message_receive_o2o_all',
]);

export type DwsIntakeRejection = 'invalid_utf8' | 'invalid_ndjson' | 'unsupported_event_type'
  | 'invalid_event_identity' | 'unsupported_event_content';

function boundedId(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit
    && value.trim() === value && !/[\r\n\0]/.test(value);
}

/** Keep this decision shared with business routing; false is not delivery success. */
export function dwsEventRejection(event: DwsPersonalEvent): DwsIntakeRejection | undefined {
  if (!DWS_SUPPORTED_EVENT_TYPES.has(event.type)) return 'unsupported_event_type';
  if (!boundedId(event.eventId, 512) || !boundedId(event.conversationId, 1024)
    || (event.messageId !== undefined && !boundedId(event.messageId, 512))
    || (event.senderOpenDingtalkId !== undefined && !boundedId(event.senderOpenDingtalkId, 512))
    || (event.senderName !== undefined && (!event.senderName.trim() || event.senderName.length > 200))) {
    return 'invalid_event_identity';
  }
  if (typeof event.content !== 'string' || !event.content.trim() || event.content.length > 100_000) {
    return 'unsupported_event_content';
  }
  return undefined;
}

export function classifyDwsIntake(bytes: Uint8Array): {
  event?: DwsPersonalEvent;
  eventId?: string;
  reason?: DwsIntakeRejection;
} {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return { reason: 'invalid_utf8' }; }
  const event = parseEventLine(text);
  if (!event) return { reason: 'invalid_ndjson' };
  const reason = dwsEventRejection(event);
  const eventId = boundedId(event.eventId, 512) ? event.eventId : undefined;
  return reason ? { eventId, reason } : { eventId, event };
}
