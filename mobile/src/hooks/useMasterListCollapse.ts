/**
 * md+ master-list collapse — port of web DesktopLayout sidebar-collapsed +
 * useDesktopLayoutProtection hideSidebar (level 3).
 *
 * Persist user preference under the same key name as web (`sidebar-collapsed`).
 * When width protection hides the master, hamburger reveals a temporary overlay;
 * otherwise hamburger toggles the persistent preference.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MASTER_LIST_WIDTH } from '../lib/layoutDensity';
import {
  resolveMasterChromeProtectionLevel,
  shouldHideMasterChrome,
  type MasterChromeProtectionLevel,
} from '../lib/layoutProtection';

export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'sidebar-collapsed';

export type UseMasterListCollapseOptions = {
  /** md+ shells only; phone callers pass false and get no-ops. */
  enabled: boolean;
  containerWidth: number;
  masterWidth?: number;
  /** Effective right-overlay width (0 when closed). */
  overlayWidth?: number;
};

export type MasterListCollapseState = {
  hideMaster: boolean;
  masterOverlayOpen: boolean;
  persistentCollapsed: boolean;
  protectionHidesMaster: boolean;
  togglePersistent: () => void;
  onHamburgerPress: () => void;
  dismissMasterOverlay: () => void;
  /** Call after selecting a list row while the temporary overlay is open. */
  onMasterItemSelected: () => void;
};

export function useMasterListCollapse({
  enabled,
  containerWidth,
  masterWidth = MASTER_LIST_WIDTH,
  overlayWidth = 0,
}: UseMasterListCollapseOptions): MasterListCollapseState {
  const [persistentCollapsed, setPersistentCollapsed] = useState(false);
  const [protectionLevel, setProtectionLevel] = useState<MasterChromeProtectionLevel>(0);
  const [revealed, setRevealed] = useState(false);
  const levelRef = useRef<MasterChromeProtectionLevel>(0);
  levelRef.current = protectionLevel;

  useEffect(() => {
    let cancelled = false;
    void AsyncStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)
      .then((raw) => {
        if (cancelled) return;
        if (raw === 'true') setPersistentCollapsed(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      setProtectionLevel(0);
      setRevealed(false);
      return;
    }
    setProtectionLevel((current) =>
      resolveMasterChromeProtectionLevel(
        {
          containerWidth,
          masterWidth,
          overlayWidth,
          sidebarPersistentlyCollapsed: persistentCollapsed,
        },
        current,
      ),
    );
  }, [enabled, containerWidth, masterWidth, overlayWidth, persistentCollapsed]);

  useEffect(() => {
    if (!enabled) return;
    const hide = shouldHideMasterChrome({
      protectionLevel,
      sidebarPersistentlyCollapsed: persistentCollapsed,
    });
    if (!hide) setRevealed(false);
  }, [enabled, protectionLevel, persistentCollapsed]);

  const hideMaster =
    enabled &&
    shouldHideMasterChrome({
      protectionLevel,
      sidebarPersistentlyCollapsed: persistentCollapsed,
    });

  const togglePersistent = useCallback(() => {
    setPersistentCollapsed((prev) => {
      const next = !prev;
      void AsyncStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(next)).catch(() => {});
      return next;
    });
    setRevealed(false);
  }, []);

  const onHamburgerPress = useCallback(() => {
    if (!enabled) return;
    const protectionHides =
      !persistentCollapsed &&
      shouldHideMasterChrome({
        protectionLevel: levelRef.current,
        sidebarPersistentlyCollapsed: false,
      });
    if (protectionHides) {
      setRevealed((v) => !v);
      return;
    }
    if (persistentCollapsed) {
      // Peek overlay while persistently collapsed, or expand fully on second mental model:
      // match web — hamburger expands when protection-hidden; when user-collapsed, toggle expand.
      togglePersistent();
      return;
    }
    togglePersistent();
  }, [enabled, persistentCollapsed, togglePersistent]);

  const dismissMasterOverlay = useCallback(() => setRevealed(false), []);

  const onMasterItemSelected = useCallback(() => {
    if (revealed) setRevealed(false);
  }, [revealed]);

  return {
    hideMaster,
    masterOverlayOpen: hideMaster && revealed,
    persistentCollapsed,
    protectionHidesMaster: hideMaster && !persistentCollapsed,
    togglePersistent,
    onHamburgerPress,
    dismissMasterOverlay,
    onMasterItemSelected,
  };
}
