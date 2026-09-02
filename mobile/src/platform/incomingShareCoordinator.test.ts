import { describe, expect, it } from 'vitest';
import { INCOMING_SHARE_DRAFT_TTL_MS, type CacheOwner, type IncomingShare } from '@agent/shared';
import { IncomingShareCoordinator, type IncomingShareDraftStore, type IncomingSharePlatformAdapter } from './incomingShareCoordinator';

const OWNER = { userId: 'user-1', tenantId: 'tenant-1' };
const PDF = new TextEncoder().encode('%PDF-1.7\nhello');
const source = { uri: 'content://provider/a', name: 'a.pdf', mimeType: 'application/pdf', size: 14 };

class Store implements IncomingShareDraftStore {
  rows = new Map<string, IncomingShare>();
  key(owner: CacheOwner, intentId: string) { return `${owner.tenantId}:${owner.userId}:${intentId}`; }
  async get(owner: CacheOwner, intentId: string) { return this.rows.get(this.key(owner, intentId)) ?? null; }
  async put(owner: CacheOwner, share: IncomingShare) { this.rows.set(this.key(owner, share.intentId), structuredClone(share)); }
  async remove(owner: CacheOwner, intentId: string) { this.rows.delete(this.key(owner, intentId)); }
  async list(owner: CacheOwner) { return [...this.rows.entries()].filter(([key]) => key.startsWith(`${owner.tenantId}:${owner.userId}:`)).map(([, value]) => structuredClone(value)); }
}

class Adapter implements IncomingSharePlatformAdapter {
  disk = 100 * 1024 * 1024;
  stageCount = 0;
  uploadCount = 0;
  released: string[] = [];
  staged = true;
  offline = false;
  stageError: Error & { code?: string } | null = null;
  completed = new Map<string, string>();
  async availableDiskBytes() { return this.disk; }
  async stage(_owner: CacheOwner, _draft: any) {
    this.stageCount += 1;
    if (this.stageError) throw this.stageError;
    this.staged = true;
    return { size: source.size, head: PDF };
  }
  async upload(_owner: CacheOwner, draft: any) {
    this.uploadCount += 1;
    if (this.offline) throw Object.assign(new Error('offline'), { code: 'OFFLINE' });
    if (!this.staged) throw Object.assign(new Error('missing'), { code: 'SOURCE_MISSING' });
    const attachmentId = this.completed.get(draft.requestId) ?? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    this.completed.set(draft.requestId, attachmentId);
    return { attachmentId, originalName: draft.name, size: draft.size, mimeType: draft.mimeType, isImage: false };
  }
  async queryUpload(_owner: CacheOwner, requestId: string) {
    const attachmentId = this.completed.get(requestId);
    return attachmentId ? { attachmentId, originalName: 'a.pdf', size: source.size, mimeType: 'application/pdf', isImage: false } : null;
  }
  async release(_owner: CacheOwner, draftId: string) { this.released.push(draftId); this.staged = false; }
}

function ids() {
  const values = ['11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'];
  return () => values.shift() ?? 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
}

describe('M50-01 mobile incoming share coordinator', () => {
  it('consumes duplicate intent once and releases sandbox immediately after upload', async () => {
    const store = new Store(); const adapter = new Adapter();
    const coordinator = new IncomingShareCoordinator(store, adapter, () => 0, ids());
    const [first, duplicate] = await Promise.all([
      coordinator.consume(OWNER, { intentId: 'intent-1', text: 'shared text', files: [source] }),
      coordinator.consume(OWNER, { intentId: 'intent-1', text: 'shared text', files: [source] }),
    ]);
    expect(first).toEqual(duplicate);
    expect(first).toMatchObject({ status: 'uploaded', text: 'shared text' });
    expect(adapter.stageCount).toBe(1);
    expect(adapter.uploadCount).toBe(1);
    expect(adapter.released).toHaveLength(1);
    expect(JSON.stringify(first)).not.toContain('content://');
  });

  it('accepts a text-only share as an uploaded composer draft without invoking upload', async () => {
    const store = new Store(); const adapter = new Adapter();
    const result = await new IncomingShareCoordinator(store, adapter, () => 0, ids())
      .consume(OWNER, { intentId: 'intent-text', text: 'shared plain text', files: [] });
    expect(result).toMatchObject({ status: 'uploaded', text: 'shared plain text', attachments: [] });
    expect(adapter.stageCount).toBe(0);
    expect(adapter.uploadCount).toBe(0);
  });

  it('fails low disk before staging and preserves text', async () => {
    const store = new Store(); const adapter = new Adapter(); adapter.disk = source.size;
    const result = await new IncomingShareCoordinator(store, adapter, () => 0, ids())
      .consume(OWNER, { intentId: 'intent-low-disk', text: 'original composer', files: [source] });
    expect(result).toMatchObject({ status: 'failed', text: 'original composer', attachments: [{ error: { code: 'share_low_disk', retryable: false, requiresRepick: true } }] });
    expect(adapter.stageCount).toBe(0);
  });

  it('maps revoked content URI to repick without dropping draft', async () => {
    const store = new Store(); const adapter = new Adapter();
    adapter.stageError = Object.assign(new Error('revoked'), { code: 'SOURCE_REVOKED' });
    const result = await new IncomingShareCoordinator(store, adapter, () => 0, ids())
      .consume(OWNER, { intentId: 'intent-revoked', text: 'keep', files: [source] });
    expect(result).toMatchObject({ status: 'failed', text: 'keep', attachments: [{ error: { code: 'share_source_revoked', requiresRepick: true } }] });
    expect(await store.get(OWNER, 'intent-revoked')).not.toBeNull();
  });

  it('retries offline/restart with the same requestId and queries completed upload first', async () => {
    const store = new Store(); const adapter = new Adapter(); adapter.offline = true;
    const firstCoordinator = new IncomingShareCoordinator(store, adapter, () => 0, ids());
    const failed = await firstCoordinator.consume(OWNER, { intentId: 'intent-restart', files: [source] });
    expect(failed.attachments[0]).toMatchObject({ requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', error: { code: 'share_offline' } });
    adapter.offline = false; adapter.staged = true;
    const restarted = new IncomingShareCoordinator(store, adapter, () => 1, ids());
    const uploaded = await restarted.resume(OWNER, (await store.get(OWNER, 'intent-restart'))!);
    expect(uploaded.attachments[0]).toMatchObject({ status: 'uploaded', requestId: failed.attachments[0].requestId });
    expect(adapter.completed.size).toBe(1);

    // A kill after server completion but before local commit resolves by query, not a second generation.
    const snapshot = structuredClone(failed);
    adapter.completed.set(snapshot.attachments[0].requestId, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    adapter.uploadCount = 0;
    const recovered = await restarted.resume(OWNER, snapshot);
    expect(recovered.attachments[0].attachmentId).toBe('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    expect(adapter.uploadCount).toBe(0);
  });

  it('cancel/TTL clean local sources and owner switch fails closed', async () => {
    const store = new Store(); const adapter = new Adapter(); adapter.offline = true;
    const coordinator = new IncomingShareCoordinator(store, adapter, () => 0, ids());
    const share = await coordinator.consume(OWNER, { intentId: 'intent-cancel', files: [source] });
    await coordinator.cancel(OWNER, share);
    expect(await store.get(OWNER, share.intentId)).toBeNull();

    let now = 0;
    const expiring = new IncomingShareCoordinator(store, adapter, () => now, ids());
    adapter.staged = true;
    const ttlShare = await expiring.consume(OWNER, { intentId: 'intent-ttl', files: [source] });
    now = INCOMING_SHARE_DRAFT_TTL_MS + 1;
    expect(await expiring.cleanup(OWNER)).toBe(1);
    expect(await store.get(OWNER, ttlShare.intentId)).toBeNull();

    await expect(coordinator.consume({ userId: 'user-2', tenantId: 'tenant-1' }, { intentId: 'x', files: [source] })).rejects.toMatchObject({ code: 'OWNER_CHANGED' });
  });
});
