import { describe, expect, it, vi } from 'vitest';

import type {
  ContextCollection,
  ContextIngestRecordInput,
  ContextSource,
  ContextSyncPartition,
  IngestContextPageInput,
} from '../../store/types.js';
import { DIRECTORY_COLLECTION_ID, directorySourceId } from './normalizer.js';
import type { DirectoryContextReader, DirectoryContextStore, DirectoryPerson } from './types.js';
import { DirectoryContextSyncWorker } from './worker.js';

const now = '2026-08-23T01:02:03.000Z';

class FakeStore implements DirectoryContextStore {
  source?: ContextSource;
  collection?: ContextCollection;
  currentIds: string[] = [];
  ingested: ContextIngestRecordInput[] = [];
  failed?: Parameters<DirectoryContextStore['failPartition']>[0];

  async getSource() { return this.source ?? null; }
  async createSource(input: { tenantId: string; sourceId: string; kind: string; displayName: string; config?: object }) {
    this.source = { ...input, config: input.config ?? {}, status: 'active', revision: 1, createdAt: now, updatedAt: now } as ContextSource;
    return this.source;
  }
  async getCollection() { return this.collection ?? null; }
  async createCollection(input: { tenantId: string; sourceId: string; collectionId: string; externalKey: string; displayName: string; metadata?: object }) {
    this.collection = { ...input, metadata: input.metadata ?? {}, status: 'active', revision: 1, createdAt: now, updatedAt: now } as ContextCollection;
    return this.collection;
  }
  async ensurePartition(input: { tenantId: string; sourceId: string; collectionId: string; partitionKey: string }) {
    return partition(input.tenantId, input.sourceId, input.collectionId, input.partitionKey);
  }
  async acquirePartitionLease(input: { tenantId: string; sourceId: string; collectionId: string; partitionKey: string; leaseOwner: string }) {
    return { ...partition(input.tenantId, input.sourceId, input.collectionId, input.partitionKey), status: 'syncing' as const, leaseOwner: input.leaseOwner, leaseFence: 1 };
  }
  async listCurrentExternalRecordIds() { return this.currentIds; }
  async ingestPage(input: IngestContextPageInput) {
    this.ingested.push(...input.records);
    return { partition: partition(input.tenantId, input.sourceId, input.collectionId, input.partitionKey), created: input.records.length, revised: 0, unchanged: 0, outbox: [] };
  }
  async failPartition(input: Parameters<DirectoryContextStore['failPartition']>[0]) {
    this.failed = input;
    return { ...partition(input.tenantId, input.sourceId, input.collectionId, input.partitionKey), status: 'retry_wait' as const };
  }
}

class FakeReader implements DirectoryContextReader {
  constructor(readonly people: DirectoryPerson[]) {}
  async listTenantIds() { return ['tenant-a']; }
  async listPeople() { return this.people; }
}

describe('DirectoryContextSyncWorker', () => {
  it('projects a complete inventory and revokes disabled or missing people', async () => {
    const store = new FakeStore();
    store.currentIds = ['missing-user'];
    const reader = new FakeReader([
      { tenantId: 'tenant-a', userId: 'active-user', username: 'active', status: 'active', updatedAt: now },
      { tenantId: 'tenant-a', userId: 'disabled-user', username: 'disabled', status: 'disabled', updatedAt: now },
    ]);
    const worker = new DirectoryContextSyncWorker(store, reader, { now: () => new Date(now), leaseOwner: 'worker' });

    await expect(worker.runTenant('tenant-a')).resolves.toEqual({
      tenantId: 'tenant-a', people: 2, revoked: 2, skipped: false,
    });
    expect(store.source?.sourceId).toBe(directorySourceId('tenant-a'));
    expect(store.collection?.collectionId).toBe(DIRECTORY_COLLECTION_ID);
    expect(store.ingested.map(record => [record.externalRecordId, record.revoked])).toEqual([
      ['active-user', false],
      ['disabled-user', true],
      ['missing-user', true],
    ]);
  });

  it('fails closed when a reader crosses tenants', async () => {
    const store = new FakeStore();
    const worker = new DirectoryContextSyncWorker(store, new FakeReader([
      { tenantId: 'tenant-b', userId: 'wrong', username: 'wrong', status: 'active', updatedAt: now },
    ]), { leaseOwner: 'worker', now: () => new Date(now) });
    await expect(worker.runTenant('tenant-a')).rejects.toThrow('DIRECTORY_TENANT_SCOPE_MISMATCH');
    expect(store.ingested).toEqual([]);
    expect(store.failed).toMatchObject({
      tenantId: 'tenant-a', errorCode: 'DIRECTORY_SYNC_FAILED', retryAt: '2026-08-23T01:03:03.000Z',
    });
  });

  it('continues with later tenants and reports a tenant-scoped failure', async () => {
    const onTenantError = vi.fn();
    const reader: DirectoryContextReader = {
      listTenantIds: vi.fn().mockResolvedValue(['tenant-a', 'tenant-b']),
      listPeople: vi.fn().mockResolvedValue([]),
    };
    const worker = new DirectoryContextSyncWorker(new FakeStore(), reader, { onTenantError });
    vi.spyOn(worker, 'runTenant')
      .mockRejectedValueOnce(new Error('tenant-a unavailable'))
      .mockResolvedValueOnce({ tenantId: 'tenant-b', people: 1, revoked: 0, skipped: false });

    await expect(worker.runOnce()).resolves.toEqual([
      { tenantId: 'tenant-b', people: 1, revoked: 0, skipped: false },
    ]);
    expect(onTenantError).toHaveBeenCalledWith('tenant-a', expect.objectContaining({ message: 'tenant-a unavailable' }));
    expect(worker.runTenant).toHaveBeenCalledWith('tenant-b');
  });
});

function partition(tenantId: string, sourceId: string, collectionId: string, partitionKey: string): ContextSyncPartition {
  return {
    tenantId, sourceId, collectionId, partitionKey, status: 'idle', leaseFence: 0, retryCount: 0,
    truncated: false, refused: false, updatedAt: now,
  };
}
