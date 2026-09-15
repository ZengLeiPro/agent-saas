import { describe, expect, it } from 'vitest';
import { BP } from '../hooks/useBreakpoint';
import { cardGridColumns } from './cardGrid';

describe('cardGridColumns', () => {
  it('keeps phone single-column below md', () => {
    expect(cardGridColumns(BP.md - 1)).toBe(1);
    expect(cardGridColumns(390)).toBe(1);
  });

  it('uses 2 columns from md and 3 from lg', () => {
    expect(cardGridColumns(BP.md)).toBe(2);
    expect(cardGridColumns(BP.lg - 1)).toBe(2);
    expect(cardGridColumns(BP.lg)).toBe(3);
  });
});
