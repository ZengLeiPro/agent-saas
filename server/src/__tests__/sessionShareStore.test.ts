import { describe, expect, it, vi } from 'vitest';

import {
  PgSessionShareStore,
  type SessionShareSnapshot,
  type UpsertSessionShareInput,
} from '../data/sessionShares/store.js';

function snapshotRow(snapshot: SessionShareSnapshot) {
  return {
    share_id: 'share-1',
    token: 'token-1',
    session_id: 'session-1',
    tenant_id: 'tenant-1',
    owner_user_id: 'user-1',
    owner_username: 'alice',
    created_by_user_id: 'user-1',
    created_at: '2026-07-20T00:00:00.000Z',
    updated_at: '2026-07-20T00:00:00.000Z',
    expires_at: null,
    revoked_at: null,
    debug_mode: false,
    snapshot_json: snapshot,
    access_count: 0,
    last_accessed_at: null,
  };
}

function input(snapshot: SessionShareSnapshot): UpsertSessionShareInput {
  return {
    sessionId: 'session-1',
    tenantId: 'tenant-1',
    ownerUserId: 'user-1',
    ownerUsername: 'alice',
    createdByUserId: 'user-1',
    debugMode: false,
    snapshot,
  };
}

function snapshotWithNul(): SessionShareSnapshot {
  return {
    sessionId: 'session-1',
    stats: { lines: 1, parsedLines: 1, parseErrors: 0 },
    blocks: [{
      id: 'block-1',
      kind: 'tool_result',
      title: '工具结果',
      defaultOpen: false,
      content: 'before\u0000after',
      raw: 'literal\\u0000text',
    }],
  };
}

function createStore(existingSnapshot?: SessionShareSnapshot) {
  const writes: string[] = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FOR UPDATE')) {
        return { rows: existingSnapshot ? [snapshotRow(existingSnapshot)] : [] };
      }
      if (sql.includes('INSERT INTO')) {
        const serialized = String(params?.[9]);
        writes.push(serialized);
        return { rows: [snapshotRow(JSON.parse(serialized) as SessionShareSnapshot)] };
      }
      if (sql.includes('UPDATE') && sql.includes('snapshot_json')) {
        const serialized = String(params?.[6]);
        writes.push(serialized);
        return { rows: [snapshotRow(JSON.parse(serialized) as SessionShareSnapshot)] };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client) };
  return {
    store: new PgSessionShareStore({ pool: pool as never, tablePrefix: 'test' }),
    writes,
  };
}

describe('PgSessionShareStore', () => {
  it.each(['insert', 'update'] as const)('sanitizes nested NUL bytes on %s without corrupting literal escapes', async (mode) => {
    const existing: SessionShareSnapshot | undefined = mode === 'update'
      ? { sessionId: 'session-1', stats: { lines: 0, parsedLines: 0, parseErrors: 0 }, blocks: [] }
      : undefined;
    const { store, writes } = createStore(existing);

    await store.upsertActive(input(snapshotWithNul()));

    expect(writes).toHaveLength(1);
    const persisted = JSON.parse(writes[0]!) as SessionShareSnapshot;
    expect(persisted.blocks[0]?.content).toBe('before\\u0000after');
    expect(persisted.blocks[0]?.raw).toBe('literal\\u0000text');
    expect(writes[0]).not.toContain('\u0000');
  });
});
