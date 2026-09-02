import { describe, expect, it } from 'vitest';
import { createSessionSeenCommit, selectSessionUnread, type UnreadSemanticItem } from './sessionUnread';

const row = (semanticId: string, sequence: number, kind: UnreadSemanticItem['kind'], businessStepChanged?: boolean): UnreadSemanticItem => ({
  semanticId,
  order: { sequence, eventIndex: 0, stableId: semanticId },
  kind,
  ...(businessStepChanged === undefined ? {} : { businessStepChanged }),
});
const items = [
  row('u1', 1, 'user'),
  row('a1', 2, 'assistant'),
  row('u2', 3, 'user'),
  row('step-running', 4, 'business_step', true),
  row('interaction', 5, 'interaction'),
];

describe('canonical unread selector', () => {
  it('counts AI and BusinessStep status, but not user messages or active interaction', () => {
    expect(selectSessionUnread({
      sessionId: 's', targetSessionId: 'other', historyRevision: 'r1', items,
      visible: true, atBottom: true, activeInteractionPending: true,
    })).toMatchObject({ unreadCount: 2, hasUnread: true, pendingInteraction: true });
  });

  it('opening a session away from bottom does not clear unread', () => {
    const selection = selectSessionUnread({
      sessionId: 's', targetSessionId: 's', historyRevision: 'r1', items,
      seen: { sessionId: 's', lastSeenSemanticId: 'u1', revision: 'r1' },
      visible: true, atBottom: false,
    });
    expect(selection).toMatchObject({ unreadCount: 2, shouldMarkSeen: false });
    expect(createSessionSeenCommit({ sessionId: 's', targetSessionId: 's', historyRevision: 'r1', items, visible: true, atBottom: false }, selection)).toBeNull();
  });

  it('atomically marks the latest countable semantic id only at visible bottom', () => {
    const input = { sessionId: 's', targetSessionId: 's', historyRevision: 'r2', items, visible: true, atBottom: true } as const;
    const selection = selectSessionUnread(input);
    expect(selection).toMatchObject({ unreadCount: 0, hasUnread: false, shouldMarkSeen: true });
    expect(createSessionSeenCommit(input, selection)).toEqual({ sessionId: 's', lastSeenSemanticId: 'step-running', revision: 'r2' });
  });

  it('does not clear while app is hidden and fails safe when revision removed the seen id', () => {
    const selection = selectSessionUnread({
      sessionId: 's', targetSessionId: 's', historyRevision: 'compacted', items: items.slice(2),
      seen: { sessionId: 's', lastSeenSemanticId: 'missing', revision: 'old' },
      visible: false, atBottom: true,
    });
    expect(selection).toMatchObject({ unreadCount: 1, hasUnread: true, shouldMarkSeen: false });
  });
});
