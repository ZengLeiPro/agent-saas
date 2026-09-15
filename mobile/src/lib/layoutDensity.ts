/**
 * Width-driven density tokens for md+ (iPad / wide shell).
 * Keep forms readable; mirror web floating-main content feel without porting TSX.
 */
import { BP } from '../hooks/useBreakpoint';

/** Settings / login / full-bleed forms — centered column on md+. */
export const FORM_CONTENT_MAX_WIDTH = 640;

/** Optional chat transcript readable column on very wide panes. */
export const CHAT_TRANSCRIPT_MAX_WIDTH = 720;

/** Master list column in list|detail splits (chat / files / cron). */
export const MASTER_LIST_WIDTH = 340;

/** Right overlay slot width (chat preview / subagent), web-ish ~35%. */
export const RIGHT_OVERLAY_WIDTH = 380;

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
