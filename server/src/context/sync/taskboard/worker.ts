import { randomUUID } from 'node:crypto';

import { ContextStoreError, type ContextIngestRecordInput, type ContextJson, type ContextSyncPartition } from '../../store/index.js';
import {
  normalizeDeletedTaskFallback,
  normalizeTaskboardBoard,
  normalizeTaskboardChange,
  normalizeTaskboardTask,
} from './normalizer.js';
import type { TaskboardClock, TaskboardContextReader, TaskboardContextStore } from './ports.js';
import {
  TASKBOARD_COLLECTIONS,
  TASKBOARD_PARTITION_KEY,
  TASKBOARD_SOURCE_ID,
  TASKBOARD_SOURCE_KIND,
  type TaskboardCollectionKind,
  type TaskboardRunResult,
} from './types.js';

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_LEASE_MS = 10 * 60 * 1000;
const DEFAULT_RETRY_MS = 60_000;
const INVENTORY_WATERMARK = 'inventory-v1';

export interface TaskboardContextSyncWorkerOptions {
  reader: TaskboardContextReader;
  store: TaskboardContextStore;
  clock?: TaskboardClock;
  pageSize?: number;
  leaseMs?: number;
  workerId?: string;
  onTenantError?: (tenantId: string, error: unknown) => void;
}

interface HeldLease {
  collection: TaskboardCollectionKind;
  partition: ContextSyncPartition;
}

export class TaskboardContextSyncWorker {
  private readonly pageSize: number;
  private readonly leaseMs: number;
  private readonly workerId: string;
  private readonly clock: TaskboardClock;

  constructor(private readonly options: TaskboardContextSyncWorkerOptions) {
    this.pageSize = positiveInteger(options.pageSize, DEFAULT_PAGE_SIZE);
    this.leaseMs = positiveInteger(options.leaseMs, DEFAULT_LEASE_MS);
    this.workerId = options.workerId ?? `taskboard-sync:${randomUUID()}`;
    this.clock = options.clock ?? { now: () => new Date() };
  }

  async runOnce(): Promise<TaskboardRunResult[]> {
    const tenantIds = await this.options.reader.listTenantIds();
    const results: TaskboardRunResult[] = [];
    for (const tenantId of tenantIds) {
      try {
        results.push(await this.runTenant(tenantId));
      } catch (error) {
        this.options.onTenantError?.(tenantId, error);
      }
    }
    return results;
  }

  async runTenant(tenantId: string): Promise<TaskboardRunResult> {
    requiredId(tenantId, 'tenantId');
    await this.ensureResources(tenantId);
    const existing = await this.loadPartitions(tenantId);
    const leases = await this.acquireAllLeases(tenantId);
    if (!leases) return emptyResult(tenantId, watermarkFrom(existing.events.watermark), true);

    const observedAt = this.clock.now().toISOString();
    const result = emptyResult(tenantId, watermarkFrom(existing.events.watermark), false);
    let failureCode = 'TASKBOARD_SYNC_FAILED';
    try {
      if (!inventoryComplete(existing.projects.watermark)) {
        failureCode = 'TASKBOARD_BOARD_INVENTORY_FAILED';
        result.inventoryBoards = await this.importBoardInventory(tenantId, observedAt, leases.projects);
        failureCode = 'TASKBOARD_LEASE_RENEW_FAILED';
        await this.renewLeases(tenantId, Object.values(leases));
      }
      if (!inventoryComplete(existing.tasks.watermark)) {
        failureCode = 'TASKBOARD_TASK_INVENTORY_FAILED';
        result.inventoryTasks = await this.importTaskInventory(tenantId, observedAt, leases.tasks);
        failureCode = 'TASKBOARD_LEASE_RENEW_FAILED';
        await this.renewLeases(tenantId, Object.values(leases));
      }

      failureCode = 'TASKBOARD_CHANGE_BOUND_FAILED';
      const throughSeq = await this.options.reader.getChangeUpperBound(tenantId);
      let afterSeq = watermarkFrom(existing.events.watermark);
      assertSeq(throughSeq);
      assertSeq(afterSeq);
      while (BigInt(afterSeq) < BigInt(throughSeq)) {
        failureCode = 'TASKBOARD_LEASE_RENEW_FAILED';
        await this.renewLeases(tenantId, Object.values(leases));
        failureCode = 'TASKBOARD_CHANGE_PAGE_FAILED';
        const page = await this.options.reader.listChanges(tenantId, afterSeq, throughSeq, this.pageSize);
        if (page.items.length === 0) {
          throw new Error('Taskboard change reader returned an empty page before the fixed upper bound');
        }
        const projectRecords = new Map<string, ContextIngestRecordInput>();
        const taskRecords = new Map<string, ContextIngestRecordInput>();
        const eventRecords: ContextIngestRecordInput[] = [];
        for (const change of page.items) {
          failureCode = 'TASKBOARD_CHANGE_NORMALIZE_FAILED';
          assertTenant(tenantId, change.tenantId);
          assertSeq(change.seq);
          if (BigInt(change.seq) <= BigInt(afterSeq) || BigInt(change.seq) > BigInt(throughSeq)) {
            throw new Error('Taskboard change reader returned a change outside the requested sequence window');
          }
          eventRecords.push(normalizeTaskboardChange(change, observedAt).record);
          if (change.resourceType === 'board') {
            failureCode = 'TASKBOARD_BOARD_LOOKUP_FAILED';
            const board = await this.options.reader.getBoard(tenantId, change.resourceId);
            if (board) {
              failureCode = 'TASKBOARD_BOARD_NORMALIZE_FAILED';
              assertTenant(tenantId, board.tenantId);
              const record = normalizeTaskboardBoard(board, observedAt).record;
              projectRecords.set(record.externalRecordId, record);
            }
          } else {
            failureCode = 'TASKBOARD_TASK_LOOKUP_FAILED';
            const task = await this.options.reader.getTask(tenantId, change.resourceId);
            if (task) {
              failureCode = 'TASKBOARD_TASK_NORMALIZE_FAILED';
              assertTenant(tenantId, task.tenantId);
              const record = normalizeTaskboardTask(task, observedAt).record;
              taskRecords.set(record.externalRecordId, record);
            } else if (change.changeType === 'task.deleted') {
              failureCode = 'TASKBOARD_DELETE_NORMALIZE_FAILED';
              const record = normalizeDeletedTaskFallback(change, observedAt);
              taskRecords.set(record.externalRecordId, record);
            }
          }
        }

        const projectBatch = [...projectRecords.values()];
        const taskBatch = [...taskRecords.values()];
        failureCode = 'TASKBOARD_PROJECT_INGEST_FAILED';
        if (projectBatch.length) await this.ingest(tenantId, leases.projects, projectBatch, {});
        failureCode = 'TASKBOARD_TASK_INGEST_FAILED';
        if (taskBatch.length) await this.ingest(tenantId, leases.tasks, taskBatch, {});
        const lastSeq = page.items[page.items.length - 1]!.seq;
        failureCode = 'TASKBOARD_EVENT_INGEST_FAILED';
        await this.ingest(tenantId, leases.events, eventRecords, {
          watermark: lastSeq,
          ...(page.nextCursor ? { pageCursor: page.nextCursor } : {}),
        });
        result.changes += page.items.length;
        result.snapshots += projectBatch.length + taskBatch.length;
        result.events += eventRecords.length;
        afterSeq = lastSeq;
      }

      failureCode = 'TASKBOARD_LEASE_RENEW_FAILED';
      await this.renewLeases(tenantId, Object.values(leases));
      failureCode = 'TASKBOARD_PROJECT_CHECKPOINT_FAILED';
      await this.ingest(tenantId, leases.projects, [], {
        watermark: INVENTORY_WATERMARK,
        complete: true,
        releaseLease: true,
      });
      failureCode = 'TASKBOARD_TASK_CHECKPOINT_FAILED';
      await this.ingest(tenantId, leases.tasks, [], {
        watermark: INVENTORY_WATERMARK,
        complete: true,
        releaseLease: true,
      });
      failureCode = 'TASKBOARD_EVENT_CHECKPOINT_FAILED';
      await this.ingest(tenantId, leases.events, [], {
        watermark: throughSeq,
        complete: true,
        releaseLease: true,
      });
      result.watermark = throughSeq;
      return result;
    } catch (error) {
      await this.failLeases(tenantId, Object.values(leases), taskboardFailureCode(failureCode, error));
      throw error;
    }
  }

  private async ensureResources(tenantId: string): Promise<void> {
    let source = await this.options.store.getSource(tenantId, TASKBOARD_SOURCE_ID);
    if (!source) {
      try {
        source = await this.options.store.createSource({
          tenantId,
          sourceId: TASKBOARD_SOURCE_ID,
          kind: TASKBOARD_SOURCE_KIND,
          displayName: 'Taskboard',
          config: { nativeAuthorizationRevalidationRequired: true },
        });
      } catch (error) {
        source = await this.options.store.getSource(tenantId, TASKBOARD_SOURCE_ID);
        if (!source) throw error;
      }
    }
    if (source.kind !== TASKBOARD_SOURCE_KIND) throw new Error('Taskboard context source identity is already used by another kind');

    for (const collection of Object.values(TASKBOARD_COLLECTIONS)) {
      let current = await this.options.store.getCollection(tenantId, TASKBOARD_SOURCE_ID, collection.collectionId);
      if (!current) {
        try {
          current = await this.options.store.createCollection({
            tenantId,
            sourceId: TASKBOARD_SOURCE_ID,
            collectionId: collection.collectionId,
            externalKey: collection.externalKey,
            displayName: collection.displayName,
            metadata: { nativeAuthorizationRevalidationRequired: true },
          });
        } catch (error) {
          current = await this.options.store.getCollection(tenantId, TASKBOARD_SOURCE_ID, collection.collectionId);
          if (!current) throw error;
        }
      }
      if (current.externalKey !== collection.externalKey) {
        throw new Error(`Taskboard context collection ${collection.collectionId} has an unexpected external key`);
      }
      await this.options.store.ensurePartition({
        tenantId,
        sourceId: TASKBOARD_SOURCE_ID,
        collectionId: collection.collectionId,
        partitionKey: TASKBOARD_PARTITION_KEY,
      });
    }
  }

  private async loadPartitions(tenantId: string): Promise<Record<TaskboardCollectionKind, ContextSyncPartition>> {
    const entries = await Promise.all((Object.keys(TASKBOARD_COLLECTIONS) as TaskboardCollectionKind[]).map(async collection => {
      const definition = TASKBOARD_COLLECTIONS[collection];
      const partition = await this.options.store.getPartition(
        tenantId,
        TASKBOARD_SOURCE_ID,
        definition.collectionId,
        TASKBOARD_PARTITION_KEY,
      );
      if (!partition) throw new Error(`Taskboard context partition ${collection} was not initialized`);
      return [collection, partition] as const;
    }));
    return Object.fromEntries(entries) as Record<TaskboardCollectionKind, ContextSyncPartition>;
  }

  private async acquireAllLeases(tenantId: string): Promise<Record<TaskboardCollectionKind, ContextSyncPartition> | null> {
    const held: HeldLease[] = [];
    for (const collection of Object.keys(TASKBOARD_COLLECTIONS) as TaskboardCollectionKind[]) {
      const partition = await this.options.store.acquirePartitionLease({
        tenantId,
        sourceId: TASKBOARD_SOURCE_ID,
        collectionId: TASKBOARD_COLLECTIONS[collection].collectionId,
        partitionKey: TASKBOARD_PARTITION_KEY,
        leaseOwner: this.workerId,
        leaseMs: this.leaseMs,
      });
      if (!partition) {
        await this.releaseLeases(tenantId, held.map(item => item.partition));
        return null;
      }
      held.push({ collection, partition });
    }
    return Object.fromEntries(held.map(item => [item.collection, item.partition])) as Record<TaskboardCollectionKind, ContextSyncPartition>;
  }

  private async importBoardInventory(tenantId: string, observedAt: string, lease: ContextSyncPartition): Promise<number> {
    let cursor = lease.pageCursor;
    let imported = 0;
    for (;;) {
      const page = await this.options.reader.listBoards(tenantId, cursor, this.pageSize);
      for (const board of page.items) assertTenant(tenantId, board.tenantId);
      const records = page.items.map(board => normalizeTaskboardBoard(board, observedAt).record);
      await this.ingest(tenantId, lease, records, page.nextCursor ? { pageCursor: page.nextCursor } : {});
      imported += records.length;
      if (!page.nextCursor) return imported;
      assertAdvancingCursor(cursor, page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  private async importTaskInventory(tenantId: string, observedAt: string, lease: ContextSyncPartition): Promise<number> {
    let cursor = lease.pageCursor;
    let imported = 0;
    for (;;) {
      const page = await this.options.reader.listTasks(tenantId, cursor, this.pageSize);
      for (const task of page.items) assertTenant(tenantId, task.tenantId);
      const records = page.items.map(task => normalizeTaskboardTask(task, observedAt).record);
      await this.ingest(tenantId, lease, records, page.nextCursor ? { pageCursor: page.nextCursor } : {});
      imported += records.length;
      if (!page.nextCursor) return imported;
      assertAdvancingCursor(cursor, page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  private async renewLeases(tenantId: string, partitions: ContextSyncPartition[]): Promise<void> {
    const renewed = await Promise.all(partitions.map(partition => this.options.store.renewPartitionLease({
      tenantId,
      sourceId: TASKBOARD_SOURCE_ID,
      collectionId: partition.collectionId,
      partitionKey: TASKBOARD_PARTITION_KEY,
      leaseOwner: this.workerId,
      leaseFence: partition.leaseFence,
      leaseMs: this.leaseMs,
    })));
    if (renewed.some(value => !value)) throw new Error('Taskboard context lease renewal failed');
  }

  private ingest(
    tenantId: string,
    lease: ContextSyncPartition,
    records: readonly ContextIngestRecordInput[],
    checkpoint: {
      watermark?: ContextJson;
      pageCursor?: string;
      complete?: boolean;
      releaseLease?: boolean;
    },
  ) {
    return this.options.store.ingestPage({
      tenantId,
      sourceId: TASKBOARD_SOURCE_ID,
      collectionId: lease.collectionId,
      partitionKey: TASKBOARD_PARTITION_KEY,
      leaseOwner: this.workerId,
      leaseFence: lease.leaseFence,
      records,
      checkpoint,
    });
  }

  private async failLeases(
    tenantId: string,
    partitions: ContextSyncPartition[],
    errorCode: string,
  ): Promise<void> {
    const retryAt = new Date(this.clock.now().getTime() + DEFAULT_RETRY_MS).toISOString();
    await Promise.all(partitions.map(partition => this.options.store.failPartition({
      tenantId,
      sourceId: TASKBOARD_SOURCE_ID,
      collectionId: partition.collectionId,
      partitionKey: TASKBOARD_PARTITION_KEY,
      leaseOwner: this.workerId,
      leaseFence: partition.leaseFence,
      errorCode,
      retryAt,
    }).catch(() => undefined)));
  }

  private async releaseLeases(tenantId: string, partitions: ContextSyncPartition[]): Promise<void> {
    await Promise.all(partitions.map(partition => this.ingest(tenantId, partition, [], { releaseLease: true }).catch(() => undefined)));
  }
}

export function taskboardFailureCode(stage: string, error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '') : '';
  if (error instanceof ContextStoreError || /^CONTEXT_[A-Z0-9_]+$/.test(code)) {
    return `${stage}_${code.replace(/^CONTEXT_/, '')}`;
  }
  const suffix = code === '23503' ? 'REFERENCE_MISSING'
    : code === '23505' ? 'UNIQUE_CONFLICT'
      : code === '23514' ? 'CONSTRAINT_VIOLATION'
        : code === '22P02' ? 'VALUE_INVALID'
          : code === '40001' ? 'SERIALIZATION_FAILURE'
            : code === '40P01' ? 'DEADLOCK'
              : code === '42P01' || code === '42703' ? 'SCHEMA_MISMATCH' : '';
  if (suffix) return `${stage}_${suffix}`;
  return /^[0-9A-Z]{5}$/.test(code) ? `${stage}_PG_${code}` : stage;
}

function inventoryComplete(watermark: ContextJson | undefined): boolean {
  return watermark === INVENTORY_WATERMARK;
}

function watermarkFrom(watermark: ContextJson | undefined): string {
  return typeof watermark === 'string' && /^(0|[1-9][0-9]*)$/.test(watermark) ? watermark : '0';
}

function emptyResult(tenantId: string, watermark: string, skipped: boolean): TaskboardRunResult {
  return { tenantId, skipped, inventoryBoards: 0, inventoryTasks: 0, changes: 0, snapshots: 0, events: 0, watermark };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : Number.isSafeInteger(value) && value > 0 ? value : (() => { throw new Error('Taskboard context sync option must be a positive integer'); })();
}

function requiredId(value: string, label: string): void {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,199}$/.test(value)) throw new Error(`Taskboard context sync ${label} is invalid`);
}

function assertSeq(value: string): void {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('Taskboard change sequence is invalid');
}

function assertTenant(expected: string, actual: string): void {
  if (actual !== expected) throw new Error('Taskboard reader crossed a tenant boundary');
}

function assertAdvancingCursor(previous: string | undefined, next: string): void {
  if (!next || next === previous) throw new Error('Taskboard inventory cursor did not advance');
}
