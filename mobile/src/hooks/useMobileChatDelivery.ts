import { useEffect, useMemo, useRef } from 'react';
import { AppState } from 'react-native';
import {
  authFetch, beforeReadDeadline, cacheKeyForIdentity, getPlatform, wsClient,
  type AcceptedMessageStatus, type BoundaryIdentity, type MessageItem,
} from '@agent/shared';
import { MobileChatDeliveryController } from '../lib/mobileChatDeliveryController';
import { deliveryReferences, parseDeliveryReferences } from '../lib/mobileChatDeliveryJournal';
import { ownsDeliveryView, type MobileAcceptanceEvidence, type MobileDeliveryFence,
  type MobileDeliveryView, type MobileSubmissionRecord } from '../lib/mobileChatDeliveryState';
import { createMobileMessageCacheForIdentity } from '../platform/mobileMessageCache';

export interface MobileChatDeliveryHookOptions {
  identity: BoundaryIdentity | null;
  unlocked: boolean;
  getView: () => MobileDeliveryView;
  getMessages: () => MessageItem[];
  setMessages: (messages: MessageItem[]) => void;
  onAccepted: (record: MobileSubmissionRecord, evidence: MobileAcceptanceEvidence) => void;
  onSettled: (record: MobileSubmissionRecord) => void;
  mergeStatus: (value: AcceptedMessageStatus) => MobileAcceptanceEvidence;
  trace?: (stage: string, record: MobileSubmissionRecord) => void;
}

function captureFence(identity: BoundaryIdentity | null): MobileDeliveryFence | null {
  if (!identity) return null;
  try {
    const config = getPlatform().platformConfig;
    const base = config.getBaseUrl();
    config.assertTrustedUrl?.(base, 'http');
    return { identity: { ...identity }, origin: new URL(base).origin };
  } catch { return null; }
}

function deliveryJournalKey(fence: MobileDeliveryFence): string | null {
  // Hex encoding is collision-free and stays inside the existing cache-key grammar. An unusually
  // long origin disables only this best-effort ID journal; the owned message cache still recovers.
  const resourceId = 'o-' + Array.from(fence.origin, char => char.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  if (resourceId.length > 128) return null;
  return cacheKeyForIdentity(fence.identity, 'delivery-observations', resourceId);
}

export function useMobileChatDelivery(options: MobileChatDeliveryHookOptions): MobileChatDeliveryController | null {
  const latest = useRef(options);
  latest.current = options;
  const currentFence = useRef(captureFence(options.identity));
  currentFence.current = captureFence(options.identity);
  const foreground = useRef(AppState.currentState === 'active');
  const fence = currentFence.current;
  const key = fence ? JSON.stringify([fence.origin, fence.identity.userId, fence.identity.tenantId, fence.identity.generation]) : null;
  const delivery = useMemo(() => {
    if (!fence) return null;
    const cache = createMobileMessageCacheForIdentity(fence.identity);
    const storage = getPlatform().storage;
    const journalKey = deliveryJournalKey(fence);
    let journalQueued = false;
    const persistReferences = () => {
      if (!journalKey || journalQueued) return;
      journalQueued = true;
      void Promise.resolve().then(() => {
        journalQueued = false;
        if (!controller.isCurrent()) return;
        const references = deliveryReferences(controller.records());
        return references.length ? storage.setItem(journalKey, JSON.stringify(references)) : storage.removeItem(journalKey);
      }).catch(() => {});
    };
    const controller = new MobileChatDeliveryController({
      fence, currentFence: () => currentFence.current,
      canRead: () => foreground.current && latest.current.unlocked,
      request: authFetch,
      mergeStatus: value => latest.current.mergeStatus(value),
      trace: (stage, record) => latest.current.trace?.(stage, record),
      onAccepted: (record, evidence) => latest.current.onAccepted(record, evidence),
      onChange: record => {
        if (!controller.isCurrent()) return;
        const view = latest.current.getView();
        const visible = ownsDeliveryView(record, view);
        if (visible) {
          const projected = controller.project(latest.current.getMessages(), view);
          latest.current.setMessages(projected);
          if (record.owner.sessionId) cache.save(record.owner.sessionId, projected);
          if (record.attempt.phase.kind === 'settled') latest.current.onSettled(record);
        } else if (record.owner.sessionId) {
          // An offscreen receipt writes ONLY its captured identity/session cache, never the current UI.
          const sessionId = record.owner.sessionId;
          void cache.load(sessionId).then(messages => {
            if (!controller.isCurrent()) return;
            cache.save(sessionId, controller.project(messages ?? [], { sessionId, draftId: record.owner.draftId }));
          }).catch(() => {});
        }
        persistReferences();
      },
    });
    return controller;
  }, [key]);

  useEffect(() => {
    if (!delivery || !fence) return;
    delivery.activate();
    const storage = getPlatform().storage;
    const journalKey = deliveryJournalKey(fence);
    const controller = new AbortController();
    if (journalKey) void beforeReadDeadline(async () => {
      const raw = await storage.getItem(journalKey);
      if (!delivery.isCurrent() || controller.signal.aborted || !raw) return;
      const references = parseDeliveryReferences(JSON.parse(String(raw)));
      for (const reference of references) delivery.restoreReference(reference);
      delivery.recover();
    }, Date.now() + 5_000, controller.signal).catch(() => {});
    const appState = AppState.addEventListener('change', state => {
      foreground.current = state === 'active';
      if (foreground.current) delivery.recover();
    });
    const unsubscribe = wsClient.onStateChange(state => { if (state === 'connected') delivery.recover(); });
    return () => {
      controller.abort(); appState.remove(); unsubscribe(); delivery.dispose();
    };
  }, [delivery]);

  useEffect(() => {
    if (!delivery) return;
    if (options.unlocked) delivery.recover(); else delivery.suspend();
  }, [delivery, options.unlocked]);
  return delivery;
}
