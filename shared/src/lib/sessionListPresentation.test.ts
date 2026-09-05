import { describe, expect, it } from 'vitest';
import {
  LOAD_MORE_DISTANCE_PX,
  SWIPE_DISMISS_GUARD_MS,
  resolveSessionListRuntimeStatus,
  resolveSwipeSelectGuard,
  selectGroupUnreadMap,
  shouldLoadMoreOnScroll,
} from './sessionListPresentation';

describe('resolveSessionListRuntimeStatus', () => {
  it('把待人工交互映射成等待态，且优先于运行中', () => {
    expect(
      resolveSessionListRuntimeStatus({ activeInteraction: { type: 'ask_user' }, running: true }),
    ).toBe('waiting_user');
    expect(
      resolveSessionListRuntimeStatus({ activeInteraction: { type: 'permission_request' } }),
    ).toBe('waiting_approval');
    expect(resolveSessionListRuntimeStatus({ activeInteraction: { type: 'approval' } })).toBe(
      'waiting_approval',
    );
  });

  it('无待人工交互时才回落到运行中 / 空态', () => {
    expect(resolveSessionListRuntimeStatus({ running: true })).toBe('running');
    expect(resolveSessionListRuntimeStatus({ running: false })).toBeUndefined();
    expect(resolveSessionListRuntimeStatus({})).toBeUndefined();
  });
});

describe('selectGroupUnreadMap', () => {
  const sessions = [
    { id: 's1', hasUnreadAiReply: true },
    { id: 's2', hasUnreadAiReply: false },
    { id: 's3' },
  ];

  it('分组内任一会话未读即整组未读', () => {
    const map = selectGroupUnreadMap(
      [
        { id: 'g1', sessionIds: ['s2', 's1'] },
        { id: 'g2', sessionIds: ['s2', 's3'] },
        { id: 'g3', sessionIds: [] },
      ],
      sessions,
    );
    expect(map.get('g1')).toBe(true);
    expect(map.get('g2')).toBe(false);
    expect(map.get('g3')).toBe(false);
  });

  it('分组引用了不在当前页的会话时不误判未读', () => {
    const map = selectGroupUnreadMap([{ id: 'g1', sessionIds: ['missing'] }], sessions);
    expect(map.get('g1')).toBe(false);
  });
});

describe('shouldLoadMoreOnScroll', () => {
  it('距底小于阈值时触发', () => {
    expect(shouldLoadMoreOnScroll({ contentHeight: 1000, offsetY: 600, viewportHeight: 200 })).toBe(
      false,
    );
    expect(shouldLoadMoreOnScroll({ contentHeight: 1000, offsetY: 601, viewportHeight: 200 })).toBe(
      true,
    );
    expect(LOAD_MORE_DISTANCE_PX).toBe(200);
  });

  it('支持自定义阈值', () => {
    expect(
      shouldLoadMoreOnScroll({
        contentHeight: 1000,
        offsetY: 600,
        viewportHeight: 200,
        distance: 400,
      }),
    ).toBe(true);
  });
});

describe('resolveSwipeSelectGuard', () => {
  it('滑开态点击只收起', () => {
    expect(resolveSwipeSelectGuard({ hasOpenRow: true, dismissedAt: 0, now: 1000 })).toBe(
      'close-open-row',
    );
  });

  it('收回后 300ms 内抑制选择，之后放行', () => {
    expect(resolveSwipeSelectGuard({ hasOpenRow: false, dismissedAt: 1000, now: 1299 })).toBe(
      'suppress',
    );
    expect(resolveSwipeSelectGuard({ hasOpenRow: false, dismissedAt: 1000, now: 1300 })).toBe(
      'select',
    );
    expect(SWIPE_DISMISS_GUARD_MS).toBe(300);
  });

  it('从未滑开过时直接选择', () => {
    expect(resolveSwipeSelectGuard({ hasOpenRow: false, dismissedAt: 0, now: 10 })).toBe('select');
  });
});
