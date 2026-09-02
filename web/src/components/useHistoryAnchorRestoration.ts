import { useLayoutEffect, type MutableRefObject } from 'react';
import { captureHistoryAnchor, restoreHistoryAnchor, type HistoryAnchor } from '@agent/shared';
import type { MessageVirtualLayout } from '@/lib/messageVirtualizer';

export interface PendingHistoryPrepend {
  anchor: HistoryAnchor;
  firstKey?: string;
  scrollTop: number;
  scrollHeight: number;
}

interface HistoryAnchorRestorationOptions {
  containerRef: MutableRefObject<HTMLDivElement | null>;
  bodyRef: MutableRefObject<HTMLDivElement | null>;
  layout: MessageVirtualLayout;
  wasNearBottomRef: MutableRefObject<boolean>;
  pendingPrependRef: MutableRefObject<PendingHistoryPrepend | null>;
  previousLayoutRef: MutableRefObject<MessageVirtualLayout>;
  settleTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  syncNearBottomState: () => void;
  updateViewportNow: () => void;
  hasMoreHistory?: boolean;
  showAgentLoading?: boolean;
  showSyncLoading?: boolean;
}

/** Preserves the semantic viewport across prepends and virtual-row remeasurement. */
export function useHistoryAnchorRestoration({
  containerRef,
  bodyRef,
  layout,
  wasNearBottomRef,
  pendingPrependRef,
  previousLayoutRef,
  settleTimerRef,
  syncNearBottomState,
  updateViewportNow,
  hasMoreHistory,
  showAgentLoading,
  showSyncLoading,
}: HistoryAnchorRestorationOptions): void {
  useLayoutEffect(() => {
    const container = containerRef.current;
    const body = bodyRef.current;
    const previous = previousLayoutRef.current;
    if (!container || !body) {
      previousLayoutRef.current = layout;
      return;
    }

    if (wasNearBottomRef.current) {
      container.scrollTop = container.scrollHeight;
    } else if (previous !== layout && previous.keys.length > 0) {
      const pendingPrepend = pendingPrependRef.current;
      const didPrepend = pendingPrepend && pendingPrepend.firstKey !== layout.keys[0];
      if (didPrepend) {
        const restored = restoreHistoryAnchor(pendingPrepend.anchor, {
          semanticIds: layout.keys,
          offsets: layout.offsets,
        });
        if (restored) {
          container.scrollTop = body.offsetTop + restored.scrollOffset;
        } else {
          // A grouped row may disappear across the page boundary; preserve actual added height.
          const addedHeight = container.scrollHeight - pendingPrepend.scrollHeight;
          container.scrollTop = Math.max(0, pendingPrepend.scrollTop + addedHeight);
        }
        pendingPrependRef.current = null;
      } else {
        const previousLocalStart = Math.max(0, container.scrollTop - body.offsetTop);
        const anchor = captureHistoryAnchor(
          { semanticIds: previous.keys, offsets: previous.offsets },
          previousLocalStart,
        );
        const restored = anchor ? restoreHistoryAnchor(anchor, {
          semanticIds: layout.keys,
          offsets: layout.offsets,
        }) : undefined;
        if (restored) container.scrollTop = body.offsetTop + restored.scrollOffset;
      }
    }

    previousLayoutRef.current = layout;
    syncNearBottomState();
    updateViewportNow();
    // A parent effect can force scrollTop without a scroll event; sample after its rAF.
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      syncNearBottomState();
      updateViewportNow();
    }, 50);
  }, [bodyRef, containerRef, hasMoreHistory, layout, pendingPrependRef, previousLayoutRef, settleTimerRef, showAgentLoading, showSyncLoading, syncNearBottomState, updateViewportNow, wasNearBottomRef]);
}
