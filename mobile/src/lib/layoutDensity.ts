/**
 * Width-driven density tokens for md+ (iPad / wide shell).
 * Keep forms readable; mirror web floating-main content feel without porting TSX.
 */
import { BP } from '../hooks/useBreakpoint';

/** Settings / login / full-bleed forms — centered column on md+. */
export const FORM_CONTENT_MAX_WIDTH = 640;

/** Optional chat transcript readable column on very wide panes. */
export const CHAT_TRANSCRIPT_MAX_WIDTH = 720;

/** Master list column in list|detail splits (chat / files / cron). Target ~320–380. */
export const MASTER_LIST_WIDTH = 360;
export const MASTER_LIST_WIDTH_MIN = 320;
export const MASTER_LIST_WIDTH_MAX = 380;

/** Right overlay slot width (chat preview / subagent), web-ish ~35%. */
export const RIGHT_OVERLAY_WIDTH = 380;

/** Floating main card inset (web DesktopLayout outer gap ≈ 10). */
export const FLOATING_MAIN_INSET = 10;

export function formContentMaxWidthStyle(isMdUp: boolean): {
  width: '100%';
  maxWidth?: number;
  alignSelf?: 'center';
} {
  if (!isMdUp) return { width: '100%' };
  return { width: '100%', maxWidth: FORM_CONTENT_MAX_WIDTH, alignSelf: 'center' };
}

export function chatTranscriptMaxWidthStyle(width: number): {
  width: '100%';
  maxWidth?: number;
  alignSelf?: 'center';
} {
  if (width < BP.md) return { width: '100%' };
  return { width: '100%', maxWidth: CHAT_TRANSCRIPT_MAX_WIDTH, alignSelf: 'center' };
}

export function shouldUseMasterDetail(width: number): boolean {
  return width >= BP.md;
}

/** Clamp a preferred master width into the 320–380 product band. */
export function resolveMasterListWidth(preferred: number = MASTER_LIST_WIDTH): number {
  return Math.min(MASTER_LIST_WIDTH_MAX, Math.max(MASTER_LIST_WIDTH_MIN, preferred));
}
