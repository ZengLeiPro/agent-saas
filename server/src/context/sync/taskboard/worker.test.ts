import { describe, expect, it, vi } from 'vitest';

import type {
  ContextCollection,
  ContextIngestRecordInput,
  ContextSource,
  ContextSyncPartition,
  IngestContextPageInput,
  IngestContextPageResult,
} from '../../store/index.js';
import type { TaskboardContextReader, TaskboardContextStore } from './ports.js';
import type { TaskboardBoardRow, TaskboardChangeRow, TaskboardTaskRow } from './types.js';
import { TaskboardContextSyncWorker } from './worker.js';

const NOW = '2026-08-23T06:00:00.000Z';

class FakeReader implements TaskboardContextReader {
  boards: TaskboardBoardRow[] = [];
  tasks: TaskboardTaskRow[] = [];
  changes: TaskboardChangeRow[] = [];
  changeCalls: Array<{ tenantId: string; afterSeq: string; throughSeq: string; limit: number }> = [];

  async listTenantIds() {
    return [...new Set(this.boards.map(item => item.tenantId))].sort();
  }
  async listBoards(tenantId: string, cursor: string | undefined, limit: number) {
    return page(this.boards.filter(item => item.tenantId === tenantId), cursor, limit, item => item.id);
  }
  async listTasks(tenantId: string, cursor: string | undefined, limit: number) {
    return page(this.tasks.filter(item => item.tenantId === tenantId), cursor, limit, item => item.id);
  }
  async getBoard(tenantId: string, boardId: string) {
    return this.boards.find(item => item.tenantId === tenantId && item.id === boardId) ?? null;
  }
  async getTask(tenantId: string, taskId: string) {
    return this.tasks.find(item => item.tenantId === tenantId && item.id === taskId) ?? null;
  }
  async getChangeUpperBound(tenantId: string) {
    return this.changes.filter(item => item.tenantId === tenantId)
      .reduce((max, item) => BigInt(item.seq) > BigInt(max) ? item.seq : max, '0');
  }
  async listChanges(tenantId: string, afterSeq: string, throughSeq: string, limit: number) {
    this.changeCalls.push({ tenantId, afterSeq, throughSeq, limit });
    const items = this.changes.filter(item => item.tenantId === tenantId
      && BigInt(item.seq) > BigInt(afterSeq) && BigInt(item.seq) <= BigInt(throughSeq))
      .sort((a, b) => Number(BigInt(a.seq) - BigInt(b.seq)))
      .slice(0, limit);
    return { items, ...(items.length === limit ? { nextCursor: items.at(-1)!.seq } : {}) };
  }
}

class FakeStore implements TaskboardContextStore {
  sources = new Map<string, ContextSource>();
  collections = new Map<string, ContextCollection>();
  partitions = new Map<string, ContextSyncPartition>();
  records = new Map<string, { input: ContextIngestRecordInput; revision: number; fingerprint: string }>();
  outboxCount = 0;

  async getSource(tenantId: string, sourceId: string) {
    return this.sources.get(`${tenantId}/${sourceId}`) ?? null;
  }
  async createSource(input: Parameters<TaskboardContextStore['createSource']>[0]) {
    const source = {
      ...input, config: input.config ?? {}, status: 'active', revision: 1,
      createdAt: NOW, updatedAt: NOW,
    } as ContextSource;
    this.sources.set(`${input.tenantId}/${input.sourceId}`, source);
    return source;
  }
  async getCollection(tenantId: string, sourceId: string, collectionId: string) {
    return this.collections.get(`${tenantId}/${sourceId}/${collectionId}`) ?? null;
  }
  async createCollection(input: Parameters<TaskboardContextStore['createCollection']>[0]) {
    const collection = {
      ...input, metadata: input.metadata ?? {}, status: 'active', revision: 1,
      createdAt: NOW, updatedAt: NOW,
    } as ContextCollection;
    this.collections.set(`${input.tenantId}/${input.sourceId}/${input.collectionId}`, collection);
    return collection;
  }
  async ensurePartition(input: Parameters<TaskboardContextStore['ensurePartition']>[0]) {
    const key = partitionKey(input.tenantId, input.collectionId);
    let current = this.partitions.get(key);
    if (!current) {
      current = makePartition(input.tenantId, input.sourceId, input.collectionId, input.partitionKey);
      this.partitions.set(key, current);
    }
    return current;
  }
  async getPartition(tenantId: string, _sourceId: string, collectionId: string, _partitionKey: string) {
    return this.partitions.get(partitionKey(tenantId, collectionId)) ?? null;
  }
  async acquirePartitionLease(input: Parameters<TaskboardContextStore['acquirePartitionLease']>[0]) {
    const key = partitionKey(input.tenantId, input.collectionId);
    const current = this.partitions.get(key);
    if (!current || current.leaseOwner) return null;
    const leased = {
      ...current, status: 'syncing', leaseOwner: input.leaseOwner,
      leaseFence: current.leaseFence + 1, leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    } as ContextSyncPartition;
    this.partitions.set(key, leased);
    return leased;
  }
  async ingestPage(input: IngestContextPageInput): Promise<IngestContextPageResult> {
    const key = partitionKey(input.tenantId, input.collectionId);
    const current = this.partitions.get(key)!;
    if (current.leaseOwner !== input.leaseOwner || current.leaseFence !== input.leaseFence) throw new Error('lease lost');
    let created = 0;
    let revised = 0;
    let unchanged = 0;
    for (const record of input.records) {
      const recordKey = `${input.tenantId}/${input.collectionId}/${record.externalRecordId}`;
      const fingerprint = JSON.stringify({ ...record, observedAt: undefined });
      const prior = this.records.get(recordKey);
      if (!prior) {
        this.records.set(recordKey, { input: record, revision: 1, fingerprint });
        created += 1;
        this.outboxCount += 1;
      } else if (prior.fingerprint === fingerprint) {
        unchanged += 1;
      } else {
        this.records.set(recordKey, { input: record, revision: prior.revision + 1, fingerprint });
        revised += 1;
        this.outboxCount += 1;
      }
    }
    const partition = {
      ...current,
      ...(input.checkpoint.watermark !== undefined ? { watermark: input.checkpoint.watermark } : {}),
      ...(input.checkpoint.pageCursor !== undefined ? { pageCursor: input.checkpoint.pageCursor } : {}),
      ...(input.checkpoint.complete ? { status: 'complete', pageCursor: undefined } : {}),
      ...(input.checkpoint.releaseLease || input.checkpoint.complete
        ? { leaseOwner: undefined, leaseExpiresAt: undefined } : {}),
    } as ContextSyncPartition;
    this.partitions.set(key, partition);
    return { partition, created, revised, unchanged, outbox: [] };
  }
  async failPartition(input: Parameters<TaskboardContextStore['failPartition']>[0]) {
    const key = partitionKey(input.tenantId, input.collectionId);
    const current = this.partitions.get(key)!;
    if (current.leaseOwner !== input.leaseOwner || current.leaseFence !== input.leaseFence) throw new Error('lease lost');
    const failed = {
      ...current, status: 'retry_wait', retryCount: current.retryCount + 1,
      nextRetryAt: input.retryAt, lastErrorCode: input.errorCode,
      leaseOwner: undefined, leaseExpiresAt: undefined,
    } as ContextSyncPartition;
    this.partitions.set(key, failed);
    return failed;
  }
}

describe('TaskboardContextSyncWorker', () => {
  it('imports inventory, pages a fixed sequence window, advances watermark, and replays without revisions/outbox', async () => {
    const reader = seededReader();
    reader.changes.push(
      change('1', 'board', 'board-a', 'board.updated'),
      change('2', 'task', 'task-a', 'task.updated'),
      change('3', 'task', 'task-a', 'task.transitioned'),
    );
    const store = new FakeStore();
    const worker = createWorker(reader, store, 2);

    const first = await worker.runTenant('tenant-a');
    expect(first).toMatchObject({ inventoryBoards: 1, inventoryTasks: 1, changes: 3, events: 3, watermark: '3' });
    expect(reader.changeCalls.map(call => call.afterSeq)).toEqual(['0', '2']);
    const revisions = [...store.records.values()].reduce((sum, item) => sum + item.revision, 0);
    const outbox = store.outboxCount;

    reader.changeCalls = [];
    const replay = await worker.runTenant('tenant-a');
    expect(replay).toMatchObject({ inventoryBoards: 0, inventoryTasks: 0, changes: 0, watermark: '3' });
    expect(reader.changeCalls).toEqual([]);
    expect([...store.records.values()].reduce((sum, item) => sum + item.revision, 0)).toBe(revisions);
    expect(store.outboxCount).toBe(outbox);
  });

  it('creates a tombstone only for explicit task deletion and treats archive as a normal snapshot update', async () => {
    const reader = seededReader();
    reader.tasks[0] = task({ archivedAt: NOW });
    reader.tasks.push(task({ id: 'task-deleted', identifier: 'A-2', deletedAt: NOW }));
    reader.changes.push(
      change('1', 'task', 'task-a', 'task.archived', true),
      change('2', 'task', 'task-deleted', 'task.deleted', true),
      change('3', 'task', 'missing-task', 'task.updated', true),
      change('4', 'task', 'missing-deleted', 'task.deleted', true),
    );
    const store = new FakeStore();
    await createWorker(reader, store, 2).runTenant('tenant-a');

    expect(record(store, 'taskboard-tasks', 'task-a')).toMatchObject({ deleted: false, content: expect.objectContaining({ archived: true }) });
    expect(record(store, 'taskboard-tasks', 'task-deleted')).toMatchObject({ deleted: true });
    expect(record(store, 'taskboard-tasks', 'missing-task')).toBeUndefined();
    expect(record(store, 'taskboard-tasks', 'missing-deleted')).toMatchObject({ deleted: true });
  });

  it('does not advance a fixed change window across an empty page and persists retry state', async () => {
    const reader = seededReader();
    reader.changes.push(change('1', 'task', 'task-a', 'task.updated'));
    vi.spyOn(reader, 'listChanges').mockResolvedValue({ items: [] });
    const store = new FakeStore();

    await expect(createWorker(reader, store, 2).runTenant('tenant-a'))
      .rejects.toThrow('empty page before the fixed upper bound');
    expect([...store.partitions.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'retry_wait', lastErrorCode: 'TASKBOARD_SYNC_FAILED',
        nextRetryAt: '2026-08-23T06:01:00.000Z',
      }),
    ]));
  });

  it('runOnce isolates every source, collection, watermark, owner and ACL by tenant', async () => {
    const reader = seededReader();
    reader.boards.push(board({ id: 'board-b', tenantId: 'tenant-b', ownerUserId: 'owner-b', visibility: 'organization' }));
    reader.tasks.push(task({
      id: 'task-b', tenantId: 'tenant-b', boardId: 'board-b', boardName: 'Board B',
      ownerUserId: 'owner-b', visibility: 'organization', identifier: 'B-1',
    }));
    reader.changes.push(
      change('1', 'task', 'task-a', 'task.updated'),
      change('2', 'task', 'task-b', 'task.updated', false, { tenantId: 'tenant-b', ownerUserId: 'owner-b', visibility: 'organization' }),
    );
    const store = new FakeStore();
    const results = await createWorker(reader, store, 1).runOnce();

    expect(results.map(item => [item.tenantId, item.watermark])).toEqual([['tenant-a', '1'], ['tenant-b', '2']]);
    expect(record(store, 'taskboard-tasks', 'task-b', 'tenant-b')).toMatchObject({
      ownerPrincipal: 'user:owner-b', aclPrincipals: ['org:tenant-b'], nativeId: 'task-b',
    });
    expect(store.records.has('tenant-a/taskboard-tasks/task-b')).toBe(false);
    expect(store.records.has('tenant-b/taskboard-tasks/task-a')).toBe(false);
  });

  it('continues with later tenants and reports a tenant-scoped failure', async () => {
    const reader = seededReader();
    reader.boards.push(board({ id: 'board-b', tenantId: 'tenant-b' }));
    const onTenantError = vi.fn();
    const worker = new TaskboardContextSyncWorker({
      reader,
      store: new FakeStore(),
      workerId: 'test-worker',
      onTenantError,
    });
    vi.spyOn(worker, 'runTenant')
      .mockRejectedValueOnce(new Error('tenant-a unavailable'))
      .mockResolvedValueOnce({
        tenantId: 'tenant-b', skipped: false, inventoryBoards: 1, inventoryTasks: 0,
        changes: 0, snapshots: 0, events: 0, watermark: '0',
      });

    await expect(worker.runOnce()).resolves.toEqual([
      expect.objectContaining({ tenantId: 'tenant-b' }),
    ]);
    expect(onTenantError).toHaveBeenCalledWith('tenant-a', expect.objectContaining({ message: 'tenant-a unavailable' }));
    expect(worker.runTenant).toHaveBeenCalledWith('tenant-b');
  });
});

function createWorker(reader: FakeReader, store: FakeStore, pageSize: number) {
  return new TaskboardContextSyncWorker({
    reader, store, pageSize, workerId: 'test-worker', clock: { now: () => new Date(NOW) },
  });
}

function seededReader(): FakeReader {
  const reader = new FakeReader();
  reader.boards = [board()];
  reader.tasks = [task()];
  return reader;
}

function board(overrides: Partial<TaskboardBoardRow> = {}): TaskboardBoardRow {
  return {
    id: 'board-a', tenantId: 'tenant-a', ownerUserId: 'owner-a', name: 'Board A',
    visibility: 'personal', version: 1, createdAt: NOW, updatedAt: NOW, ...overrides,
  };
}

function task(overrides: Partial<TaskboardTaskRow> = {}): TaskboardTaskRow {
  return {
    id: 'task-a', tenantId: 'tenant-a', boardId: 'board-a', boardName: 'Board A',
    ownerUserId: 'owner-a', visibility: 'personal', identifier: 'A-1', kind: 'delivery',
    title: 'Task A', description: 'Business work', status: 'todo', priority: 'none', labels: [],
    version: 1, createdAt: NOW, updatedAt: NOW, ...overrides,
  };
}

function change(
  seq: string,
  resourceType: 'board' | 'task',
  resourceId: string,
  changeType: string,
  tombstone = false,
  overrides: Partial<TaskboardChangeRow> = {},
): TaskboardChangeRow {
  return {
    seq, tenantId: 'tenant-a', resourceType, resourceId, changeType,
    actorType: 'user', actorId: 'actor-a', tombstone, createdAt: NOW,
    ownerUserId: 'owner-a', visibility: 'personal', ...overrides,
  };
}

function page<T>(items: T[], cursor: string | undefined, limit: number, key: (item: T) => string) {
  const available = items.filter(item => key(item) > (cursor ?? '')).sort((a, b) => key(a).localeCompare(key(b)));
  const selected = available.slice(0, limit);
  return { items: selected, ...(available.length > limit ? { nextCursor: key(selected.at(-1)!) } : {}) };
}

function makePartition(tenantId: string, sourceId: string, collectionId: string, key: string): ContextSyncPartition {
  return {
    tenantId, sourceId, collectionId, partitionKey: key, status: 'idle', leaseFence: 0,
    retryCount: 0, truncated: false, refused: false, updatedAt: NOW,
  };
}

function partitionKey(tenantId: string, collectionId: string) {
  return `${tenantId}/${collectionId}`;
}

function record(store: FakeStore, collectionId: string, externalRecordId: string, tenantId = 'tenant-a') {
  return store.records.get(`${tenantId}/${collectionId}/${externalRecordId}`)?.input;
}
