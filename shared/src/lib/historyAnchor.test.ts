import { describe, expect, it } from 'vitest';
import { captureHistoryAnchor, restoreHistoryAnchor } from './historyAnchor';

describe('history scroll anchor', () => {
  it('restores first visible semantic id and offset after prepend', () => {
    const anchor = captureHistoryAnchor({ semanticIds: ['m3', 'm4'], offsets: [0, 100] }, 35)!;
    expect(anchor).toMatchObject({ semanticId: 'm3', offset: -35 });
    expect(restoreHistoryAnchor(anchor, { semanticIds: ['m1', 'm2', 'm3', 'm4'], offsets: [0, 80, 170, 270] }))
      .toMatchObject({ semanticId: 'm3', scrollOffset: 205, fallback: 'exact' });
  });

  it('corrects image/BusinessStep remeasure without jumping to bottom', () => {
    const anchor = captureHistoryAnchor({ semanticIds: ['image', 'step', 'tail'], offsets: [0, 120, 220] }, 145)!;
    expect(restoreHistoryAnchor(anchor, { semanticIds: ['image', 'step', 'tail'], offsets: [0, 300, 520] }))
      .toMatchObject({ semanticId: 'step', scrollOffset: 325, fallback: 'exact' });
  });

  it('uses nearest adjacent item when the anchor was deleted', () => {
    const anchor = captureHistoryAnchor({ semanticIds: ['before', 'gone', 'after'], offsets: [0, 100, 200] }, 130)!;
    expect(restoreHistoryAnchor(anchor, { semanticIds: ['before', 'after'], offsets: [0, 120] }))
      .toMatchObject({ semanticId: 'before', fallback: 'previous' });
  });
});
