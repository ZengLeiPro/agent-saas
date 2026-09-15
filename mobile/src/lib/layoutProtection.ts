/**
 * Tiny port of web `useDesktopLayoutProtection` (main ≥ 640, restore +48px).
 *
 * P5 right slot: dock beside main when window ≥ lg (1024) and host can keep
 * primary ≥ 640 (web levels 0–1 docked); otherwise SideOverlayPanel (level 2).
 * P4: temporarily hide the master list when primary would fall below 640 (level 3).
 * Secondary-sidebar compact (web level 1 chrome) stays N/A — native is single master.
 */
export const DESKTOP_PRIMARY_MIN_WIDTH = 640;
export const DESKTOP_LAYOUT_HYSTERESIS = 48;
/** Floor so the overlay stays usable when the host is tight. */
export const OVERLAY_MIN_WIDTH = 280;

/**
 * Clamp a right overlay so `host − overlay ≥ minMainWidth` whenever that still
 * leaves a usable overlay. Otherwise keep a compact overlay over the host
 * (web protection level 2: overlay, do not dock).
 */
export function clampOverlayForMainMinWidth(opts: {
  hostWidth: number;
  desiredOverlayWidth: number;
  minMainWidth?: number;
  minOverlayWidth?: number;
}): number {
  const minMain = opts.minMainWidth ?? DESKTOP_PRIMARY_MIN_WIDTH;
  const minOverlay = opts.minOverlayWidth ?? OVERLAY_MIN_WIDTH;
  const desired = Math.max(0, opts.desiredOverlayWidth);
  const host = Math.max(0, opts.hostWidth);
  if (desired === 0 || host <= 0) return 0;

  const roomForOverlay = host - minMain;
  if (roomForOverlay >= minOverlay) {
    return Math.min(desired, roomForOverlay);
  }

  const compact = Math.max(minOverlay, Math.floor(host * 0.45));
  return Math.min(desired, compact, host);
}

/**
 * Hysteresis for a boolean “protection active” flag against a width budget.
 * Activate immediately when `value < threshold`; deactivate only after
 * `threshold + margin` (web restore line).
 */
export function withWidthHysteresis(
  value: number,
  threshold: number,
  previouslyActive: boolean,
  margin: number = DESKTOP_LAYOUT_HYSTERESIS,
): boolean {
  if (value < threshold) return true;
  if (previouslyActive) return value < threshold + margin;
  return false;
}

export function remainingMainWidth(hostWidth: number, overlayWidth: number): number {
  return hostWidth - Math.max(0, overlayWidth);
}

export function resolveProtectedOverlayWidth(opts: {
  hostWidth: number;
  desiredOverlayWidth: number;
  protectionActive: boolean;
}): { width: number; protectionActive: boolean } {
  const remainingIfDesired = opts.hostWidth - opts.desiredOverlayWidth;
  const protectionActive = withWidthHysteresis(
    remainingIfDesired,
    DESKTOP_PRIMARY_MIN_WIDTH,
    opts.protectionActive,
  );
  const width = protectionActive
    ? clampOverlayForMainMinWidth({
        hostWidth: opts.hostWidth,
        desiredOverlayWidth: opts.desiredOverlayWidth,
      })
    : Math.min(opts.desiredOverlayWidth, Math.max(0, opts.hostWidth));
  return { width, protectionActive };
}



/** Product gate: prefer docked right pane only at lg+ (window width). */
export const RIGHT_PANE_DOCK_MIN_WINDOW = 1024;

/** Hairline divider between main and a docked right pane. */
export const RIGHT_PANE_DIVIDER_WIDTH = 1;

export type RightPanePresentation = 'docked' | 'overlay';

export type RightPanePresentationInput = {
  /** Full window / breakpoint width (lg gate). */
  windowWidth: number;
  /** Chat session host width (detail card) — budget for main ≥ 640. */
  hostWidth: number;
  paneWidth: number;
  /** Whether the previous open presentation was docked (hysteresis). */
  previouslyDocked: boolean;
  minWindowWidth?: number;
  minMainWidth?: number;
  dividerWidth?: number;
};

/**
 * Web levels 0–2 for the right slot: dock when wide enough and main stays ≥ 640;
 * otherwise overlay. Phone callers never open the slot (md+ only).
 *
 * Hysteresis: once docked, stay docked until remaining main would fall below 640
 * (activate overlay immediately); restore dock only after remaining clears 640+48.
 */
export function resolveRightPanePresentation(
  input: RightPanePresentationInput,
): RightPanePresentation {
  const minWindow = input.minWindowWidth ?? RIGHT_PANE_DOCK_MIN_WINDOW;
  const minMain = input.minMainWidth ?? DESKTOP_PRIMARY_MIN_WIDTH;
  const divider = input.dividerWidth ?? RIGHT_PANE_DIVIDER_WIDTH;
  const host = Math.max(0, input.hostWidth);
  const pane = Math.max(0, input.paneWidth);
  const windowWidth = Math.max(0, input.windowWidth);

  if (windowWidth < minWindow || host <= 0 || pane <= 0) return 'overlay';

  const remainingIfDocked = host - pane - divider;
  // previouslyDocked=false means we treat overlay-protection as previously active
  // when deciding whether to restore dock after a tight layout.
  const forceOverlay = withWidthHysteresis(
    remainingIfDocked,
    minMain,
    !input.previouslyDocked,
  );
  return forceOverlay ? 'overlay' : 'docked';
}

/** Pure predicate (no hysteresis) — lg gate + main ≥ 640 if docked. */
export function canDockRightPane(opts: {
  windowWidth: number;
  hostWidth: number;
  paneWidth: number;
  minWindowWidth?: number;
  minMainWidth?: number;
  dividerWidth?: number;
}): boolean {
  const minWindow = opts.minWindowWidth ?? RIGHT_PANE_DOCK_MIN_WINDOW;
  const minMain = opts.minMainWidth ?? DESKTOP_PRIMARY_MIN_WIDTH;
  const divider = opts.dividerWidth ?? RIGHT_PANE_DIVIDER_WIDTH;
  if (opts.windowWidth < minWindow || opts.hostWidth <= 0 || opts.paneWidth <= 0) return false;
  return opts.hostWidth - opts.paneWidth - divider >= minMain;
}

/**
 * Master-list chrome protection (web levels → native single master column).
 * Native has no secondary sidebar; when the right slot is docked it already
 * shrinks host width. The remaining lever when main would fall below 640 is
 * hide the master list (web protection level 3). User persistent collapse is
 * handled by callers via `sidebarPersistentlyCollapsed` (AsyncStorage
 * `sidebar-collapsed`).
 */
export type MasterChromeProtectionLevel = 0 | 1;

export type MasterChromeBudgetInput = {
  containerWidth: number;
  masterWidth: number;
  /** Effective overlay width currently covering main (0 when closed). */
  overlayWidth: number;
  sidebarPersistentlyCollapsed: boolean;
};

/** Primary (detail) width at a given master-chrome level. */
export function getPrimaryWidthWithMasterChrome(
  input: MasterChromeBudgetInput,
  level: MasterChromeProtectionLevel,
): number {
  const master =
    input.sidebarPersistentlyCollapsed || level >= 1 ? 0 : Math.max(0, input.masterWidth);
  return Math.max(0, input.containerWidth - master - Math.max(0, input.overlayWidth));
}

/**
 * Resolve whether to temporarily hide the master list so primary stays ≥ 640.
 * Hysteresis: restore only after primary at the looser level clears 640+48.
 * When the user has persistently collapsed, return 0 (caller already hides).
 */
export function resolveMasterChromeProtectionLevel(
  input: MasterChromeBudgetInput,
  previousLevel: MasterChromeProtectionLevel,
): MasterChromeProtectionLevel {
  if (input.containerWidth <= 0) return 0;
  if (input.sidebarPersistentlyCollapsed) return 0;

  const levels: MasterChromeProtectionLevel[] = [0, 1];
  const requiredLevel =
    levels.find(
      (level) => getPrimaryWidthWithMasterChrome(input, level) >= DESKTOP_PRIMARY_MIN_WIDTH,
    ) ?? 1;

  if (requiredLevel >= previousLevel) return requiredLevel;

  const restoreThreshold = DESKTOP_PRIMARY_MIN_WIDTH + DESKTOP_LAYOUT_HYSTERESIS;
  return (
    levels.find(
      (level) =>
        level < previousLevel &&
        getPrimaryWidthWithMasterChrome(input, level) >= restoreThreshold,
    ) ?? previousLevel
  );
}

/** Whether master chrome should be withheld from the flex row. */
export function shouldHideMasterChrome(opts: {
  protectionLevel: MasterChromeProtectionLevel;
  sidebarPersistentlyCollapsed: boolean;
}): boolean {
  return opts.sidebarPersistentlyCollapsed || opts.protectionLevel >= 1;
}
