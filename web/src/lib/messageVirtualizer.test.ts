import { describe, expect, it } from 'vitest';
import {
  buildMessageVirtualLayout,
  getMessageAnchorAdjustment,
  getMessageVirtualRange,
  MAX_RENDERED_MESSAGE_ROWS,
} from './messageVirtualizer';

function keys(count: number, start = 0): string[] {
  return Array.from({ length: count }, (_, index) => `row-${start + index}`);
}

describe('messageVirtualizer', () => {
  it('handles empty and single-row lists', () => {
    const empty = buildMessageVirtualLayout([], new Map());
    expect(empty.totalSize).toBe(0);
    expect(getMessageVirtualRange(empty, 0, 800)).toEqual({ start: 0, end: 0 });

    const single = buildMessageVirtualLayout(['only'], new Map([['only', 240]]), 100, 12);
    expect(single.offsets).toEqual([0]);
    expect(single.sizes).toEqual([240]);
    expect(single.totalSize).toBe(240);
    expect(getMessageVirtualRange(single, 0, 800)).toEqual({ start: 0, end: 1 });
  });

  it('selects viewport rows plus pixel overscan in a 100-row list', () => {
    const layout = buildMessageVirtualLayout(keys(100), new Map(), 100, 10);
    expect(getMessageVirtualRange(layout, 1_000, 200, 220)).toEqual({ start: 7, end: 13 });
  });

  it('renders a complete small list before measurement and a bounded long tail', () => {
    const small = buildMessageVirtualLayout(keys(12), new Map());
    expect(getMessageVirtualRange(small, 0, 0)).toEqual({ start: 0, end: 12 });

    const long = buildMessageVirtualLayout(keys(500), new Map());
    expect(getMessageVirtualRange(long, 0, 0)).toEqual({
      start: 500 - MAX_RENDERED_MESSAGE_ROWS,
      end: 500,
    });
  });

  it('enforces the exported mounted-row upper bound for a 500-row list', () => {
    const layout = buildMessageVirtualLayout(keys(500), new Map(), 100, 0);
    const range = getMessageVirtualRange(
      layout,
      0,
      10_000,
      10_000,
      MAX_RENDERED_MESSAGE_ROWS,
    );
    expect(range.end - range.start).toBe(MAX_RENDERED_MESSAGE_ROWS);
    expect(range).toEqual({ start: 0, end: MAX_RENDERED_MESSAGE_ROWS });
  });

  it('reflows offsets and reports anchor movement after a dynamic height change', () => {
    const before = buildMessageVirtualLayout(
      ['a', 'b', 'c'],
      new Map([['a', 100], ['b', 300], ['c', 50]]),
      160,
      10,
    );
    const after = buildMessageVirtualLayout(
      ['a', 'b', 'c'],
      new Map([['a', 200], ['b', 300], ['c', 50]]),
      160,
      10,
    );

    expect(before.offsets).toEqual([0, 110, 420]);
    expect(after.offsets).toEqual([0, 210, 520]);
    expect(after.totalSize).toBe(570);
    expect(getMessageAnchorAdjustment(before, after, 'b')).toBe(100);
  });

  it('keeps measurements keyed to rows and computes a stable prepend anchor', () => {
    const measured = new Map([['row-10', 80], ['row-11', 120]]);
    const before = buildMessageVirtualLayout(['row-10', 'row-11'], measured, 100, 10);
    const after = buildMessageVirtualLayout(
      ['row-8', 'row-9', 'row-10', 'row-11'],
      measured,
      100,
      10,
    );

    expect(after.sizes).toEqual([100, 100, 80, 120]);
    expect(after.indexByKey.get('row-10')).toBe(2);
    expect(getMessageAnchorAdjustment(before, after, 'row-10')).toBe(220);
  });
});
