import { describe, expect, it } from 'vitest';
import { BP } from '../hooks/useBreakpoint';
import {
  CHAT_TRANSCRIPT_MAX_WIDTH,
  FORM_CONTENT_MAX_WIDTH,
  MASTER_LIST_WIDTH,
  MASTER_LIST_WIDTH_MAX,
  MASTER_LIST_WIDTH_MIN,
  chatTranscriptMaxWidthStyle,
  formContentMaxWidthStyle,
  resolveMasterListWidth,
  shouldUseMasterDetail,
} from './layoutDensity';

describe('layoutDensity', () => {
  it('centers forms only on md+', () => {
    expect(formContentMaxWidthStyle(false)).toEqual({ width: '100%' });
    expect(formContentMaxWidthStyle(true)).toEqual({
      width: '100%',
      maxWidth: FORM_CONTENT_MAX_WIDTH,
      alignSelf: 'center',
    });
  });

  it('caps chat transcript width on wide panes', () => {
    expect(chatTranscriptMaxWidthStyle(390).maxWidth).toBeUndefined();
    expect(chatTranscriptMaxWidthStyle(BP.md).maxWidth).toBe(CHAT_TRANSCRIPT_MAX_WIDTH);
  });

  it('uses md as master-detail threshold', () => {
    expect(shouldUseMasterDetail(BP.md - 1)).toBe(false);
    expect(shouldUseMasterDetail(BP.md)).toBe(true);
  });

  it('keeps master list width in the 320–380 band', () => {
    expect(MASTER_LIST_WIDTH).toBeGreaterThanOrEqual(MASTER_LIST_WIDTH_MIN);
    expect(MASTER_LIST_WIDTH).toBeLessThanOrEqual(MASTER_LIST_WIDTH_MAX);
    expect(resolveMasterListWidth(200)).toBe(MASTER_LIST_WIDTH_MIN);
    expect(resolveMasterListWidth(500)).toBe(MASTER_LIST_WIDTH_MAX);
    expect(resolveMasterListWidth(360)).toBe(360);
  });
});
