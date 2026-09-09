import { describe, expect, it } from 'vitest';
import { bottomSheetLayout } from './bottomSheetLayout';

describe('bottom sheet safe-area geometry', () => {
  it('places a full detail sheet just below the Dynamic Island, with bottom padding inside the surface', () => {
    expect(bottomSheetLayout(844, 59, 34, 'full')).toEqual({ sizing: { height: 777 }, paddingBottom: 34, fixedHeight: true });
  });
  it('keeps the full surface flush with the bottom on devices without a home-indicator inset', () => {
    expect(bottomSheetLayout(667, 20, 0, 'full')).toEqual({ sizing: { height: 639 }, paddingBottom: 8, fixedHeight: true });
  });
  it.each(['full', 'half', 'auto'] as const)('never covers the top safe area in landscape: %s', (snap) => {
    const { sizing } = bottomSheetLayout(320, 48, 21, snap);
    const height = 'height' in sizing ? sizing.height : sizing.maxHeight;
    expect(height).toBeLessThanOrEqual(264);
    expect(height).toBeGreaterThan(0);
  });
  it('retains content-sized and half-height callers without giving auto sheets flex growth', () => {
    expect(bottomSheetLayout(844, 59, 34, 'half').sizing).toEqual({ height: 422 });
    expect(bottomSheetLayout(844, 59, 34, 'auto')).toEqual({ sizing: { maxHeight: 717 }, paddingBottom: 34, fixedHeight: false });
  });
  it('clamps a transient zero-height window rather than creating a negative height', () => {
    expect(bottomSheetLayout(0, 59, 34, 'full').sizing).toEqual({ height: 0 });
  });
});
