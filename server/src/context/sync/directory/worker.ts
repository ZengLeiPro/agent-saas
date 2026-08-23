import { randomUUID } from 'node:crypto';

import {
  DIRECTORY_COLLECTION_ID,
  DIRECTORY_EXTERNAL_KEY,
  DIRECTORY_PARTITION_KEY,
  directorySourceId,
  normalizeDirectoryPerson,
  normalizeMissingDirectoryPerson,
} from './normalizer.js';
import type {
  DirectoryContextReader,
  DirectoryContextStore,
  DirectoryContextSyncOptions,
  DirectoryContextSyncResult,
} from './types.js';

const DEFAULT_LEASE_MS = 60_000;

export class DirectoryContextSyncWorker {
  private readonly leaseOwner: string;
  private readonly leaseMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly store: DirectoryContextStore,
    private readonly reader: DirectoryContextReader,
    options: DirectoryContextSyncOptions = {},
  ) {
    this.leaseOwner = options.leaseOwner ?? `directory-context:${randomUUID()}`;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.now = options.now ?? (() => new Date());
  }

  async runOnce(): Promise<DirectoryContextSyncResult[]> {
    const tenantIds = [...new Set(await this.reader.listTenantIds())].sort();
    const results: DirectoryContextSyncResult[] = [];
    for (const tenantId of tenantIds) results.push(await this.runTenant(tenantId));
    return results;
  }

  async runTenant(tenantId: string): Promise<DirectoryContextSyncResult> {
    const sourceId = directorySourceId(tenantId);
    if (!await this.store.getSource(tenantId, sourceId)) {
      await this.store.createSource({
        tenantId,
        sourceId,
        kind: 'directory',
        displayName: '组织成员目录',
        config: { projection: 'minimal-person-v1' },
      });
    }
    if (!await this.store.getCollection(tenantId, sourceId, DIRECTORY_COLLECTION_ID)) {
      await this.store.createCollection({
        tenantId,
        sourceId,
        collectionId: DIRECTORY_COLLECTION_ID,
        externalKey: DIRECTORY_EXTERNAL_KEY,
        displayName: '组织成员',
        metadata: { entityType: 'person', authoritativeInventory: true },
      });
    }
    await this.store.ensurePartition({
      tenantId,
      sourceId,
      collectionId: DIRECTORY_COLLECTION_ID,
      partitionKey: DIRECTORY_PARTITION_KEY,
    });
    const lease = await this.store.acquirePartitionLease({
      tenantId,
      sourceId,
      collectionId: DIRECTORY_COLLECTION_ID,
      partitionKey: DIRECTORY_PARTITION_KEY,
      leaseOwner: this.leaseOwner,
      leaseMs: this.leaseMs,
    });
    if (!lease) return { tenantId, people: 0, revoked: 0, skipped: true };

    const people = await this.reader.listPeople(tenantId);
    if (people.some(person => person.tenantId !== tenantId)) {
      throw new Error('DIRECTORY_TENANT_SCOPE_MISMATCH');
    }
    const observedAt = this.now().toISOString();
    const currentIds = await this.store.listCurrentExternalRecordIds(
      tenantId,
      sourceId,
      DIRECTORY_COLLECTION_ID,
    );
    const seen = new Set(people.map(person => person.userId));
    const missing = currentIds.filter(userId => !seen.has(userId));
    const records = [
      ...people.map(person => normalizeDirectoryPerson(person, observedAt)),
      ...missing.map(userId => normalizeMissingDirectoryPerson(tenantId, userId, observedAt)),
    ];
    await this.store.ingestPage({
      tenantId,
      sourceId,
      collectionId: DIRECTORY_COLLECTION_ID,
      partitionKey: DIRECTORY_PARTITION_KEY,
      leaseOwner: this.leaseOwner,
      leaseFence: lease.leaseFence,
      records,
      checkpoint: {
        watermark: { inventoryObservedAt: observedAt },
        coverageEnd: observedAt,
        complete: true,
        releaseLease: true,
      },
    });
    return {
      tenantId,
      people: people.length,
      revoked: people.filter(person => person.status !== 'active').length + missing.length,
      skipped: false,
    };
  }
}
