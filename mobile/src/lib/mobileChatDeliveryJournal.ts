import { MESSAGE_CACHE_TTL_MS } from '@agent/shared';
import type { MobileDeliveryOwner, MobileSubmissionRecord } from './mobileChatDeliveryState';

export interface MobileDeliveryReference { clientMsgId: string; owner: MobileDeliveryOwner; createdAt: number }
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** IDs only. No text, canonical submission, paths, voice URL, credentials, or attachment metadata. */
export function deliveryReferences(records: readonly MobileSubmissionRecord[]): MobileDeliveryReference[] {
  return records.filter(record => record.fact.kind === 'unconfirmed').slice(-500).map(record => ({
    clientMsgId: record.clientMsgId, owner: { ...record.owner }, createdAt: record.createdAt,
  }));
}
export function parseDeliveryReferences(value: unknown, now = Date.now()): MobileDeliveryReference[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-500).flatMap(item => {
    if (!object(item) || !nonempty(item.clientMsgId) || !object(item.owner)
      || !nonempty(item.owner.draftId) || (item.owner.sessionId !== undefined && !nonempty(item.owner.sessionId))
      || typeof item.createdAt !== 'number' || !Number.isFinite(item.createdAt)
      || item.createdAt > now || now - item.createdAt > MESSAGE_CACHE_TTL_MS) return [];
    return [{ clientMsgId: item.clientMsgId, createdAt: item.createdAt, owner: {
      draftId: item.owner.draftId, ...(typeof item.owner.sessionId === 'string' ? { sessionId: item.owner.sessionId } : {}),
    } }];
  });
}
