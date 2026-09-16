/**
 * Pure clamp helpers for docked right-pane drag resize (web useResizePanel 25–75%).
 * Callers own gesture state / AsyncStorage persistence.
 */
import {
  DESKTOP_PRIMARY_MIN_WIDTH,
  OVERLAY_MIN_WIDTH,
  RIGHT_PANE_DIVIDER_WIDTH,
} from './layoutProtection';
import { RIGHT_OVERLAY_WIDTH } from './layoutDensity';

/** Default / min / max ratio of the right pane within the host (web parity). */
export const RIGHT_PANE_RATIO_DEFAULT = 0.35;
export const RIGHT_PANE_RATIO_MIN = 0.25;
export const RIGHT_PANE_RATIO_MAX = 0.75;

/** Absolute floors so a drag never leaves an unusable strip. */
export const RIGHT_PANE_WIDTH_MIN_PX = OVERLAY_MIN_WIDTH;
/** Soft ceiling (~web clamp 46rem-ish); ratio still wins when host is smaller. */
export const RIGHT_PANE_WIDTH_MAX_PX = 736;

export const RIGHT_PANE_WIDTH_STORAGE_KEY = 'chat-right-pane-width';

export function clampRightPaneRatio(
  ratio: number,
  minRatio: number = RIGHT_PANE_RATIO_MIN,
  maxRatio: number = RIGHT_PANE_RATIO_MAX,
): number {
  if (!Number.isFinite(ratio)) return RIGHT_PANE_RATIO_DEFAULT;
  return Math.min(maxRatio, Math.max(minRatio, ratio));
}

export function rightPaneWidthFromRatio(hostWidth: number, ratio: number): number {
  const host = Math.max(0, hostWidth);
  if (host <= 0) return 0;
  return Math.round(host * clampRightPaneRatio(ratio));
}

export function rightPaneRatioFromWidth(hostWidth: number, width: number): number {
  const host = Math.max(0, hostWidth);
  if (host <= 0) return RIGHT_PANE_RATIO_DEFAULT;
  return clampRightPaneRatio(width / host);
}

/**
 * Clamp a desired docked pane width into ratio + px bands, and optionally
 * keep primary (host − pane − divider) ≥ minMainWidth when docking.
 */
export function clampRightPaneWidth(opts: {
  hostWidth: number;
  desiredWidth: number;
  minRatio?: number;
  maxRatio?: number;
  minPx?: number;
  maxPx?: number;
  /** When set, never grow the pane past host − minMain − divider. */
  minMainWidth?: number;
  dividerWidth?: number;
}): number {
  const host = Math.max(0, opts.hostWidth);
  if (host <= 0) return 0;

  const minRatio = opts.minRatio ?? RIGHT_PANE_RATIO_MIN;
  const maxRatio = opts.maxRatio ?? RIGHT_PANE_RATIO_MAX;
  const minPx = opts.minPx ?? RIGHT_PANE_WIDTH_MIN_PX;
  const maxPx = opts.maxPx ?? RIGHT_PANE_WIDTH_MAX_PX;
  const divider = opts.dividerWidth ?? RIGHT_PANE_DIVIDER_WIDTH;

  let lo = Math.max(minPx, Math.round(host * minRatio));
  let hi = Math.min(maxPx, Math.round(host * maxRatio));

  if (opts.minMainWidth != null) {
    const mainCap = host - opts.minMainWidth - divider;
    hi = Math.min(hi, Math.max(0, mainCap));
  }

  if (hi < lo) {
    // Host too tight for the preferred band — keep a compact usable strip.
    const compact = Math.min(host, Math.max(minPx, Math.floor(host * 0.45)));
    return Math.min(Math.max(0, opts.desiredWidth), compact, host);
  }

  const desired = Number.isFinite(opts.desiredWidth) ? opts.desiredWidth : RIGHT_OVERLAY_WIDTH;
  return Math.min(hi, Math.max(lo, Math.round(desired)));
}

/** Apply a horizontal drag delta (positive = pointer moved right → shrink pane). */
export function applyRightPaneResizeDelta(opts: {
  hostWidth: number;
  currentWidth: number;
  deltaX: number;
  minMainWidth?: number;
}): number {
  return clampRightPaneWidth({
    hostWidth: opts.hostWidth,
    desiredWidth: opts.currentWidth - opts.deltaX,
    minMainWidth: opts.minMainWidth ?? DESKTOP_PRIMARY_MIN_WIDTH,
  });
}
