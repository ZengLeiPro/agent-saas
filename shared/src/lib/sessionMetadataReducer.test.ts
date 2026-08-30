import { describe, expect, it } from 'vitest';
import { createSessionMetadataState, reduceSessionMetadata } from './sessionMetadataReducer';

const item = (sessionId: string, updatedAtMs: number, version: number, extra = {}) => ({ sessionId, updatedAtMs, serverVersion: version, hasUnread: false, ...extra });

describe('M20-07 canonical session metadata reducer', () => {
  it('rejects late title and duplicate updates', () => {
    let s = reduceSessionMetadata(createSessionMetadataState('g1'), { type: 'metadata', session: item('s1', 2, 2, { title: 'new' }) });
    const once = s;
    s = reduceSessionMetadata(s, { type: 'metadata', session: item('s1', 1, 1, { title: 'old' }) });
    expect(s).toBe(once);
    s = reduceSessionMetadata(s, { type: 'metadata', session: item('s1', 2, 2, { title: 'new' }) });
    expect(s.byId.s1.title).toBe('new');
  });

  it('orders read/new-reply race by server version and rolls back failed read ACK', () => {
    let s = reduceSessionMetadata(createSessionMetadataState(), { type: 'metadata', session: item('s1', 1, 5, { hasUnread: true }) });
    s = reduceSessionMetadata(s, { type: 'read_optimistic', sessionId: 's1' });
    expect(s.byId.s1.hasUnread).toBe(false);
    s = reduceSessionMetadata(s, { type: 'read_failed', sessionId: 's1' });
    expect(s.byId.s1.hasUnread).toBe(true);
    s = reduceSessionMetadata(s, { type: 'read_ack', session: item('s1', 2, 6, { hasUnread: false, readSeq: 6 }) });
    s = reduceSessionMetadata(s, { type: 'metadata', session: item('s1', 3, 7, { hasUnread: true }) });
    s = reduceSessionMetadata(s, { type: 'read_ack', session: item('s1', 2, 6, { hasUnread: false }) });
    expect(s.byId.s1.hasUnread).toBe(true);
    s = reduceSessionMetadata(s, { type: 'read_optimistic', sessionId: 's1' });
    s = reduceSessionMetadata(s, { type: 'metadata', session: item('s1', 4, 8, { hasUnread: true }) });
    s = reduceSessionMetadata(s, { type: 'read_failed', sessionId: 's1' });
    expect(s.byId.s1).toMatchObject({ version: 8, hasUnread: true });
  });

  it('makes duplicate delete idempotent and prevents post-delete resurrection', () => {
    let s = reduceSessionMetadata(createSessionMetadataState(), { type: 'metadata', session: item('s1', 1, 1, { title: 'alive' }) });
    s = reduceSessionMetadata(s, { type: 'delete', sessionId: 's1', serverVersion: 2 });
    const deleted = s;
    s = reduceSessionMetadata(s, { type: 'delete', sessionId: 's1', serverVersion: 2 });
    expect(s).toBe(deleted);
    s = reduceSessionMetadata(s, { type: 'metadata', session: item('s1', 9, 99, { title: 'zombie', hasUnread: true }) });
    expect(s.byId.s1).toMatchObject({ deleted: true, title: 'alive' });
  });

  it('keeps selection sticky across reorder/title/hydrate and late detail-like metadata', () => {
    let s = reduceSessionMetadata(createSessionMetadataState(), { type: 'hydrate', sessions: [item('a', 2, 1), item('b', 1, 1)], authoritative: true });
    s = reduceSessionMetadata(s, { type: 'select', sessionId: 'b' });
    s = reduceSessionMetadata(s, { type: 'metadata', session: item('a', 9, 2, { title: 'A2' }) });
    s = reduceSessionMetadata(s, { type: 'hydrate', sessions: [item('a', 10, 3), item('b', 8, 2)], authoritative: true });
    expect(s.selectedSessionId).toBe('b');
  });

  it('deleting non-current preserves focus; deleting current deterministically picks same-index next then null', () => {
    let s = reduceSessionMetadata(createSessionMetadataState(), { type: 'hydrate', sessions: [item('a', 3, 1), item('b', 2, 1), item('c', 1, 1)], authoritative: true });
    s = reduceSessionMetadata(s, { type: 'select', sessionId: 'b' });
    s = reduceSessionMetadata(s, { type: 'delete', sessionId: 'a', serverVersion: 2 });
    expect(s.selectedSessionId).toBe('b');
    s = reduceSessionMetadata(s, { type: 'delete', sessionId: 'b', serverVersion: 2 });
    expect(s.selectedSessionId).toBe('c');
    s = reduceSessionMetadata(s, { type: 'delete', sessionId: 'c', serverVersion: 2 });
    expect(s.selectedSessionId).toBeNull();
  });

  it('resets account/tenant generation atomically', () => {
    let s = reduceSessionMetadata(createSessionMetadataState('tenant:a/user:1'), { type: 'metadata', session: item('s1', 1, 1) });
    s = reduceSessionMetadata(s, { type: 'select', sessionId: 's1' });
    s = reduceSessionMetadata(s, { type: 'identity_reset', generation: 'tenant:b/user:1' });
    expect(s).toEqual(createSessionMetadataState('tenant:b/user:1'));
  });

  it('isolates N-1 versionless updates but fail-closes versionless delete tombstones', () => {
    let s = reduceSessionMetadata(createSessionMetadataState(), { type: 'metadata', session: item('s1', 2, 2, { title: 'v2' }) });
    s = reduceSessionMetadata(s, { type: 'metadata', session: { sessionId: 's1', updatedAtMs: 99, title: 'legacy' } });
    expect(s.byId.s1.title).toBe('v2');
    s = reduceSessionMetadata(s, { type: 'delete', sessionId: 's1' });
    expect(s.byId.s1.deleted).toBe(true);
  });

  it('authoritative hydrate replaces cache without changing a still-valid explicit selection', () => {
    let s = reduceSessionMetadata(createSessionMetadataState(), { type: 'hydrate', sessions: [item('cache', 1, 1), item('keep', 2, 1)], authoritative: false });
    s = reduceSessionMetadata(s, { type: 'select', sessionId: 'keep' });
    s = reduceSessionMetadata(s, { type: 'hydrate', sessions: [item('keep', 3, 2)], authoritative: true });
    expect(s.order).toEqual(['keep']); expect(s.selectedSessionId).toBe('keep');
  });
});
