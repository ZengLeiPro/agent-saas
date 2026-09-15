import { describe, expect, it } from 'vitest';
import { BP } from '../hooks/useBreakpoint';
import {
  CHAT_TRANSCRIPT_MAX_WIDTH,
  FORM_CONTENT_MAX_WIDTH,
  chatTranscriptMaxWidthStyle,
  formContentMaxWidthStyle,
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
});
