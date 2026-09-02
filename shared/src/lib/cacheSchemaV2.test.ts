import { describe, expect, it } from 'vitest';
import {
  CacheKeyBuilder,
  CacheSchemaError,
  KeyValueAtomicCacheAdapter,
  assertCacheSendAllowed,
  cacheDigest,
  canonicalSerialize,
  createCacheBackup,
  createCacheSyncGate,
  markCacheFullSyncComplete,
  markCacheRestored,
  migrateKnownLegacyCache,
  parseCacheJson,
  restoreCacheBackup,
  verifyCacheBackup,
  type CacheBackup,
} from './cacheSchemaV2';

const A = { tenantId: 'tenant-a', userId: 'user-a' };
const B = { tenantId: 'tenant-a', userId: 'user-b' };
const exportedAt = '2026-09-01T00:00:00.000Z';
const display = [{ resource: 'messages', resourceId: 'session-1', type: 'message-display', data: [{ id: 'm1', type: 'text', content: 'ok' }] }];

function backup(): CacheBackup { return createCacheBackup(A, display, exportedAt); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function expectCode(run: () => unknown, code: string): void {
  try { run(); throw new Error('expected failure'); } catch (error) { expect(error).toBeInstanceOf(CacheSchemaError); expect((error as CacheSchemaError).code).toBe(code); }
}

describe('M30-02 CacheSchemaV2 canonical contract', () => {
  it('builds and parses schema/tenant/user/resource/resourceId keys with strict limits', () => {
    const key = CacheKeyBuilder.build(A, 'messages', 'session-1');
    expect(key).toBe('agent-cache:v2:tenant=tenant-a:user=user-a:resource=messages:id=session-1');
    expect(CacheKeyBuilder.parse(key)).toMatchObject({ schemaVersion: 2, ...A, resource: 'messages', resourceId: 'session-1' });
    expect(() => CacheKeyBuilder.build(A, 'messages', '../escape')).toThrow(CacheSchemaError);
    expect(() => CacheKeyBuilder.build({ tenantId: 'x'.repeat(129), userId: 'u' }, 'messages', 's')).toThrow(CacheSchemaError);
  });

  it('uses canonical cross-platform serialization and SHA-256', () => {
    expect(canonicalSerialize({ z: 1, a: { y: 2, x: 1 } })).toBe('{"a":{"x":1,"y":2},"z":1}');
    expect(cacheDigest('abc')).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('fails closed on corrupt JSON, prototype pollution, absolute paths and budgets', () => {
    expectCode(() => parseCacheJson('{broken'), 'corrupt_json');
    expectCode(() => parseCacheJson('{"__proto__":{"polluted":true}}'), 'prototype_pollution');
    expectCode(() => parseCacheJson('{"uri":"/private/cache/a"}'), 'absolute_path_forbidden');
    expectCode(() => parseCacheJson(JSON.stringify({ value: 'x'.repeat(100) }), 20), 'budget_exceeded');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe('M30-02 migration/drop policy', () => {
  it('migrates only validated owner-bound display data and renamespaces it', () => {
    const result = migrateKnownLegacyCache([
      { key: 'sessionList:default::u=user-a;t=tenant-a;g=7', raw: JSON.stringify({ schemaVersion: 1, resourceId: 'default', data: { sessions: [{ id: 's1', title: 'Display' }] } }) },
      { key: 'agentChat.queue::u=user-a;t=tenant-a;g=7', raw: JSON.stringify({ queue: ['authoritative'] }) },
      { key: 'agentChat.cursor', raw: 'bad ownerless data' },
    ], A);
    expect(result.entries).toEqual([{ resource: 'sessions', resourceId: 'default', type: 'sessions-display', data: { sessions: [{ id: 's1', title: 'Display' }] } }]);
    expect(result.droppedKeys).toEqual(['agentChat.queue::u=user-a;t=tenant-a;g=7', 'agentChat.cursor']);
    expect(result.requiresFullSync).toBe(true);
    expect(CacheKeyBuilder.build(A, result.entries[0].resource, result.entries[0].resourceId)).toContain(':tenant=tenant-a:user=user-a:');
    expect(migrateKnownLegacyCache([
      { key: 'agentChat.inputDraft.v2.u=user-a;t=tenant-a;g=7.session-1', raw: JSON.stringify('local display draft') },
    ], A).entries).toEqual([{ resource: 'draft-metadata', resourceId: 'session-1', type: 'draft-metadata-display', data: { text: 'local display draft' } }]);
  });

  it('rejects unsupported versions, corrupt known JSON and A/B mismatch without partial output', () => {
    expectCode(() => migrateKnownLegacyCache([{ key: 'sessionList:default::u=user-a;t=tenant-a;g=1', raw: '{"schemaVersion":0}' }], A), 'unsupported_schema');
    expectCode(() => migrateKnownLegacyCache([{ key: 'sessionList:default::u=user-a;t=tenant-a;g=1', raw: '{bad' }], A), 'corrupt_json');
    expectCode(() => migrateKnownLegacyCache([{ key: 'sessionList:default::u=user-b;t=tenant-a;g=1', raw: '{}' }], A), 'owner_mismatch');
  });
});

describe('M30-02 backup/restore transaction', () => {
  it('emits canonical owner manifest with entry and overall digests', () => {
    const value = backup();
    expect(value.manifest).toMatchObject({ schemaVersion: 2, owner: A, exportedAt });
    expect(value.manifest.entries[0]).toMatchObject({ type: 'message-display', digest: expect.stringMatching(/^sha256:/u) });
    expect(value.manifest.overallDigest).toMatch(/^sha256:/u);
    expect(verifyCacheBackup(JSON.stringify(value), A)).toMatchObject({ requiresFullSync: true });
  });

  it('rejects A backup imported by B plus entry and manifest tampering', () => {
    expectCode(() => verifyCacheBackup(backup(), B), 'owner_mismatch');
    const entryTamper = clone(backup()); entryTamper.entries[0].payload = '{"tampered":true}';
    expectCode(() => verifyCacheBackup(entryTamper, A), 'entry_tampered');
    const manifestTamper = clone(backup()); manifestTamper.manifest.exportedAt = '2026-09-02T00:00:00.000Z';
    expectCode(() => verifyCacheBackup(manifestTamper, A), 'manifest_tampered');
    const duplicateDescriptor = clone(backup());
    duplicateDescriptor.manifest.entries.push(clone(duplicateDescriptor.manifest.entries[0]));
    duplicateDescriptor.entries.push({ ...duplicateDescriptor.entries[0], key: CacheKeyBuilder.build(A, 'messages', 'unreferenced') });
    const { overallDigest: _digest, ...body } = duplicateDescriptor.manifest;
    duplicateDescriptor.manifest.overallDigest = cacheDigest(canonicalSerialize(body));
    expectCode(() => verifyCacheBackup(duplicateDescriptor, A), 'duplicate_entry');
  });

  it('rejects unknown keys and forbidden backup authority/path/credential fields', () => {
    const unknown = clone(backup()) as CacheBackup & { surprise?: boolean }; unknown.surprise = true;
    expectCode(() => verifyCacheBackup(unknown, A), 'unknown_backup_key');
    for (const data of [{ token: 'secret' }, { savedPath: 'relative.txt' }, { queue: [] }, { uri: '/tmp/raw' }]) {
      expect(() => createCacheBackup(A, [{ resource: 'messages', resourceId: 's', type: 'display', data }], exportedAt)).toThrow(CacheSchemaError);
    }
  });

  it('allows only unuploaded draft ids/local refs in outbox and rejects server submission authority', () => {
    expect(() => createCacheBackup(A, [{ resource: 'outbox-draft', resourceId: 'draft-1', type: 'draft', data: { draftId: 'd1', localUri: 'content://picker/1' } }], exportedAt)).not.toThrow();
    expect(() => createCacheBackup(A, [{ resource: 'draft-attachments', resourceId: 'draft-1', type: 'draft', data: [{ localUri: 'content://picker/1', originalName: 'a.png' }] }], exportedAt)).not.toThrow();
    for (const data of [{ attachmentId: 'server-id' }, { serverQueueId: 'q1' }, { submissionId: 'submit-1' }, { draftId: 'd1', content: 'authoritative submission' }, { draftId: { nested: 'content' } }]) {
      expectCode(() => createCacheBackup(A, [{ resource: 'outbox-draft', resourceId: 'draft-1', type: 'draft', data }], exportedAt), 'outbox_not_draft_only');
    }
  });

  it('stages and verifies before one atomic commit; write crash keeps prior bundle', async () => {
    let durable = 'prior';
    const adapter = new KeyValueAtomicCacheAdapter({ getItem: () => durable, setItem: () => { throw new Error('crash'); } });
    await expect(restoreCacheBackup(backup(), A, adapter)).rejects.toThrow('crash');
    expect(durable).toBe('prior');
    let commits = 0;
    const good = new KeyValueAtomicCacheAdapter({ getItem: () => durable, setItem: (_key, value) => { commits += 1; durable = value; } });
    await expect(restoreCacheBackup(backup(), A, good)).resolves.toMatchObject({ requiresFullSync: true });
    expect(commits).toBe(1);
    await expect(good.read(A)).resolves.toMatchObject({ requiresFullSync: true, entries: expect.any(Array) });
    durable = durable.replace('"requiresFullSync":true', '"requiresFullSync":false');
    await expect(good.read(A)).rejects.toMatchObject({ code: 'invalid_backup_bundle' });
  });
});

describe('M30-02 restored cache first-sync gate', () => {
  it('blocks send/replay until the matching full-sync generation completes', () => {
    const restored = markCacheRestored(createCacheSyncGate());
    expectCode(() => assertCacheSendAllowed(restored), 'full_sync_required');
    expect(markCacheFullSyncComplete(restored, restored.syncGeneration - 1).requiresFullSync).toBe(true);
    const synced = markCacheFullSyncComplete(restored, restored.syncGeneration);
    expect(() => assertCacheSendAllowed(synced)).not.toThrow();
  });
});
