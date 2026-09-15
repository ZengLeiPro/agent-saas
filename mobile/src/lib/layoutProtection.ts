/**
 * Tiny port of web `useDesktopLayoutProtection` (main ≥ 640, restore +48px).
 * Native md+ already uses overlay (not a docked divider); we only clamp overlay
 * width so the visible main column stays readable when the window can afford it.
 *
 * Full multi-level sidebar collapse / docked divider stays deferred.
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
