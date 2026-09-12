import type { BoundaryIdentity, CanonicalChatSubmission, ChatQueueItem, MessageItem } from '@agent/shared';

export const MOBILE_CONNECT_DEADLINE_MS = 60_000;
export const MOBILE_ACK_DEADLINE_MS = 15_000;
export const MOBILE_DELIVERY_UNKNOWN = '尚未确认是否送达，请先核验；不要重复发送新消息。';
export type DeliveryBubble = Extract<MessageItem, { type: 'user' | 'user-voice' }>;
export interface MobileDeliveryFence { identity: BoundaryIdentity; origin: string }
export interface MobileDeliveryOwner { draftId: string; sessionId?: string }
export interface MobileDeliveryView { draftId: string; sessionId: string | null }
export type AcceptanceSource = 'chat_ack' | 'stream_id' | 'queue' | 'snapshot' | 'replay' | 'status' | 'history';
export interface MobileAcceptanceEvidence {
  clientMsgId: string;
  sessionId?: string;
  runId?: string;
  status: ChatQueueItem['status'] | 'accepted';
  source: AcceptanceSource;
}
export type MobileDeliveryFact =
  | { kind: 'unconfirmed' }
  | { kind: 'rejected'; code?: string }
  | { kind: 'accepted'; sessionId?: string; runId?: string; presentation: 'receipt' | 'queued' | 'progressed' };
export type MobileDeliveryPhase =
  | { kind: 'connecting' | 'awaiting_ack'; deadlineAt: number }
  | { kind: 'verifying'; deadlineAt: number; verification: number }
  | { kind: 'settled' };
export interface MobileDeliveryAttempt {
  id: number;
  controller: AbortController;
  phase: MobileDeliveryPhase;
  timer?: ReturnType<typeof setTimeout>;
}
/** Replaces the former transient outbox entry; queue/run state stays in ChatClientState. */
export interface MobileSubmissionRecord {
  clientMsgId: string;
  fence: MobileDeliveryFence;
  owner: MobileDeliveryOwner;
  canonical?: CanonicalChatSubmission;
  bubble?: DeliveryBubble;
  fact: MobileDeliveryFact;
  attempt: MobileDeliveryAttempt;
  createdAt: number;
  transcriptObserved?: boolean;
  lastAutoProbeAt?: number;
}

export function sameMobileDeliveryFence(a: MobileDeliveryFence | null, b: MobileDeliveryFence | null): boolean {
  return !!a && !!b && a.origin === b.origin
    && a.identity.userId === b.identity.userId && a.identity.tenantId === b.identity.tenantId
    && a.identity.generation === b.identity.generation;
}
export function ownsDeliveryView(record: MobileSubmissionRecord, view: MobileDeliveryView): boolean {
  if (view.sessionId) return record.owner.sessionId === view.sessionId;
  return record.owner.draftId === view.draftId;
}
export function copyCanonicalSubmission(value: CanonicalChatSubmission): CanonicalChatSubmission {
  // The canonical boundary has already validated a JSON wire value. Never rebuild a retry from the
  // current composer/model/Agent or from display attachments. Keep this snapshot in memory only.
  const copy: CanonicalChatSubmission = JSON.parse(JSON.stringify(value));
  const freeze = (object: object) => {
    Object.values(object).forEach(child => { if (child && typeof child === 'object') freeze(child); });
    Object.freeze(object);
  };
  freeze(copy);
  return copy;
}
export function deliveryPresentation(status: MobileAcceptanceEvidence['status']): Extract<MobileDeliveryFact, { kind: 'accepted' }>['presentation'] {
  return status === 'accepted' ? 'receipt' : status === 'queued' ? 'queued' : 'progressed';
}

export function projectDeliveryBubble(bubble: DeliveryBubble, record: MobileSubmissionRecord): DeliveryBubble {
  if (record.fact.kind === 'accepted') {
    const status = bubble.type === 'user' && record.fact.presentation === 'queued' ? 'queued' : 'sent';
    return { ...bubble, status, failedReason: undefined, deliveryIssue: undefined, deliveryPhase: undefined } as DeliveryBubble;
  }
  if (record.fact.kind === 'rejected') {
    return { ...bubble, status: 'failed', deliveryIssue: 'rejected', deliveryPhase: undefined,
      failedReason: '服务端未受理此消息，请检查内容或设置后重新编辑发送。' };
  }
  const phase = record.attempt.phase;
  if (phase.kind !== 'settled') {
    return { ...bubble, status: bubble.type === 'user' ? 'pending' : 'ready', failedReason: undefined,
      deliveryIssue: undefined, deliveryPhase: phase.kind } as DeliveryBubble;
  }
  return { ...bubble, status: 'failed', deliveryPhase: undefined,
    deliveryIssue: record.canonical ? 'unknown' : 'missing_payload', failedReason: MOBILE_DELIVERY_UNKNOWN };
}

/** Exact IDs only. Server transcript projection wins; a voice bubble keeps its canonical audio IDs. */
export function dedupeDeliveryBubbles(messages: MessageItem[]): MessageItem[] {
  const seen = new Map<string, number>();
  const next: MessageItem[] = [];
  for (const message of messages) {
    if ((message.type !== 'user' && message.type !== 'user-voice') || !message.clientMsgId) {
      next.push(message); continue;
    }
    const index = seen.get(message.clientMsgId);
    if (index === undefined) { seen.set(message.clientMsgId, next.length); next.push(message); continue; }
    const previous = next[index];
    if (message.type === 'user-voice' && previous.type === 'user') next[index] = message;
  }
  return next;
}
