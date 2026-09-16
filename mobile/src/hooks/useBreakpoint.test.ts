import { describe, expect, it } from 'vitest';
import { BP, breakpointFromWidth } from './useBreakpoint';

describe('breakpointFromWidth', () => {
  it('keeps phone widths below md', () => {
    expect(breakpointFromWidth(390)).toEqual({ isSmUp: false, isMdUp: false, isLgUp: false });
    expect(breakpointFromWidth(BP.sm)).toEqual({ isSmUp: true, isMdUp: false, isLgUp: false });
  });

  it('treats md as the wide / iPad shell threshold', () => {
    expect(breakpointFromWidth(BP.md - 1).isMdUp).toBe(false);
    expect(breakpointFromWidth(BP.md).isMdUp).toBe(true);
    expect(breakpointFromWidth(BP.lg).isLgUp).toBe(true);
  });
});
