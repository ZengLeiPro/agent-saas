import { describe, expect, it } from 'vitest';
import {
  compareCanonicalSessionKeys,
  decodeSessionListCursor,
  encodeSessionListCursor,
  isSessionAfterCursor,
} from './sessionListHelpers.js';

describe('M20-07 canonical session list cursor', () => {
  it('round-trips updatedAtMs + stable id tie-breaker', () => {
    const encoded = encodeSessionListCursor({ updatedAtMs: 1_800_000_000_000, sessionId: 'same-z' });
    expect(decodeSessionListCursor(encoded)).toEqual({ v: 1, updatedAtMs: 1_800_000_000_000, sessionId: 'same-z' });
  });

  it('uses the same updated DESC/id DESC comparison and strict cursor boundary as shared', () => {
    const input = [
      { updatedAtMs: 100, sessionId: 'a' },
      { updatedAtMs: 100, sessionId: 'c' },
      { updatedAtMs: 100, sessionId: 'b' },
      { updatedAtMs: 99, sessionId: 'z' },
    ].sort(compareCanonicalSessionKeys);
    expect(input.map((item) => item.sessionId)).toEqual(['c', 'b', 'a', 'z']);
    const cursor = { v: 1 as const, updatedAtMs: 100, sessionId: 'b' };
    expect(input.filter((item) => isSessionAfterCursor(item, cursor)).map((item) => item.sessionId)).toEqual(['a', 'z']);
  });

  it('rejects malformed/version-unknown cursors', () => {
    expect(() => decodeSessionListCursor('not-json')).toThrow('Invalid session list cursor');
    const wrongVersion = Buffer.from(JSON.stringify({ v: 2, updatedAtMs: 1, sessionId: 's' })).toString('base64url');
    expect(() => decodeSessionListCursor(wrongVersion)).toThrow('Invalid session list cursor');
  });
});
