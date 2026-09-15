/**
 * Chat md+ right-slot layout: overlay width protection, dock vs overlay
 * selection, and docked drag-resize (25–75% / main ≥640) with optional persist.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MASTER_LIST_WIDTH, RIGHT_OVERLAY_WIDTH } from '../lib/layoutDensity';
import {
  DESKTOP_PRIMARY_MIN_WIDTH,
  resolveProtectedOverlayWidth,
  resolveRightPanePresentation,
  type RightPanePresentation,
} from '../lib/layoutProtection';
import {
  RIGHT_PANE_WIDTH_STORAGE_KEY,
  applyRightPaneResizeDelta,
  clampRightPaneWidth,
} from '../lib/rightPaneResize';

export type UseChatRightPaneLayoutOptions = {
  isMdUp: boolean;
  breakpointWidth: number;
  /** Master-detail pane host (detail card) vs full-screen chat route. */
  isPane: boolean;
  rightSlotOpen: boolean;
};

export function useChatRightPaneLayout({
  isMdUp,
  breakpointWidth,
  isPane,
  rightSlotOpen,
}: UseChatRightPaneLayoutOptions) {
  const [hostWidth, setHostWidth] = useState(0);
  const [dockedPaneWidth, setDockedPaneWidth] = useState(RIGHT_OVERLAY_WIDTH);
  const overlayProtectRef = useRef(false);
  const dockPreferRef = useRef(true);

  useEffect(() => {
    let cancelled = false;
    void AsyncStorage.getItem(RIGHT_PANE_WIDTH_STORAGE_KEY)
      .then((raw) => {
        if (cancelled || raw == null) return;
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) setDockedPaneWidth(n);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const persistDockedWidth = useCallback((width: number) => {
    void AsyncStorage.setItem(RIGHT_PANE_WIDTH_STORAGE_KEY, String(width)).catch(() => {});
  }, []);

  const handleHostLayout = useCallback((event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.width);
    setHostWidth((prev) => (Math.abs(prev - next) < 1 ? prev : next));
  }, []);

  const hostBudget =
    hostWidth > 0 ? hostWidth : Math.max(0, breakpointWidth - (isPane ? MASTER_LIST_WIDTH : 0));

  const overlayWidth = useMemo(() => {
    const next = resolveProtectedOverlayWidth({
      hostWidth: hostBudget,
      desiredOverlayWidth: RIGHT_OVERLAY_WIDTH,
      protectionActive: overlayProtectRef.current,
    });
    overlayProtectRef.current = next.protectionActive;
    return next.width;
  }, [hostBudget]);

  const desiredDockedWidth = useMemo(
    () =>
      clampRightPaneWidth({
        hostWidth: hostBudget > 0 ? hostBudget : RIGHT_OVERLAY_WIDTH / 0.35,
        desiredWidth: dockedPaneWidth,
        minMainWidth: DESKTOP_PRIMARY_MIN_WIDTH,
      }),
    [hostBudget, dockedPaneWidth],
  );

  const rightPanePresentation: RightPanePresentation | null = useMemo(() => {
    if (!rightSlotOpen || !isMdUp) return null;
    return resolveRightPanePresentation({
      windowWidth: breakpointWidth,
      hostWidth: hostBudget,
      paneWidth: desiredDockedWidth,
      previouslyDocked: dockPreferRef.current,
    });
  }, [rightSlotOpen, isMdUp, hostBudget, breakpointWidth, desiredDockedWidth]);

  useEffect(() => {
    if (!rightSlotOpen) {
      dockPreferRef.current = true;
      return;
    }
    if (rightPanePresentation) {
      dockPreferRef.current = rightPanePresentation === 'docked';
    }
  }, [rightSlotOpen, rightPanePresentation]);

  const dockedRight = rightPanePresentation === 'docked';
  const overlayRight = rightPanePresentation === 'overlay';
  const rightPaneWidth = dockedRight ? desiredDockedWidth : overlayWidth;

  const handleRightPaneResizeDelta = useCallback(
    (deltaX: number) => {
      setDockedPaneWidth((prev) =>
        applyRightPaneResizeDelta({
          hostWidth: hostBudget,
          currentWidth: prev,
          deltaX,
          minMainWidth: DESKTOP_PRIMARY_MIN_WIDTH,
        }),
      );
    },
    [hostBudget],
  );

  const handleRightPaneResizeEnd = useCallback(() => {
    setDockedPaneWidth((prev) => {
      const next = clampRightPaneWidth({
        hostWidth: hostBudget,
        desiredWidth: prev,
        minMainWidth: DESKTOP_PRIMARY_MIN_WIDTH,
      });
      persistDockedWidth(next);
      return next;
    });
  }, [hostBudget, persistDockedWidth]);

  return {
    handleHostLayout,
    rightPanePresentation,
    dockedRight,
    overlayRight,
    rightPaneWidth,
    handleRightPaneResizeDelta,
    handleRightPaneResizeEnd,
  };
}
