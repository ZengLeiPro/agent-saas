import { createHash, randomUUID } from 'node:crypto';

import type {
  ContextIngestRecordInput,
  ContextJson,
  ContextObject,
  ContextSyncPartition,
} from '../store/index.js';
import type { ContextSyncStore } from './ports.js';
import type {
  ContextIngestItem,
  ContextIngestPage,
  ContextSyncKey,
  ContextSyncRetryState,
  ContextSyncWindow,
} from './types.js';

export interface ContextPartitionIdentity {
  sourceId: string;
  collectionId: string;
  partitionKey: string;
}

/** Narrow ContextStore surface used by the sync adapter. */
export interface ContextPartitionStore {
  ensurePartition(input: {
    tenantId: string;
    sourceId: string;
    collectionId: string;
    partitionKey: string;
  }): Promise<ContextSyncPartition>;
  getPartition(
    tenantId: string,
    sourceId: string,
    collectionId: string,
    partitionKey: string,
  ): Promise<ContextSyncPartition | null>;
  listCurrentExternalRecordIds(
    tenantId: string,
    sourceId: string,
    collectionId: string,
  ): Promise<string[]>;
  acquirePartitionLease(input: ContextPartitionIdentity & {
    tenantId: string;
    leaseOwner: string;
    leaseMs: number;
  }): Promise<ContextSyncPartition | null>;
  renewPartitionLease(input: ContextPartitionIdentity & {
    tenantId: string;
    leaseOwner: string;
    leaseFence: number;
    leaseMs: number;
  }): Promise<boolean>;
  ingestPage(input: ContextPartitionIdentity & {
    tenantId: string;
    leaseOwner: string;
    leaseFence: number;
    records: readonly ContextIngestRecordInput[];
    checkpoint: {
      watermark?: ContextJson;
      windowStart?: string;
      windowEnd?: string;
      pageCursor?: string;
      coverageStart?: string;
      coverageEnd?: string;
      truncated?: boolean;
      complete?: boolean;
    };
  }): Promise<unknown>;
  failPartition(input: ContextPartitionIdentity & {
    tenantId: string;
    leaseOwner: string;
    leaseFence: number;
    errorCode: string;
    retryAt?: string;
  }): Promise<ContextSyncPartition>;
}

export interface ContextStoreSyncAdapterOptions {
  store: ContextPartitionStore;
  /** Must resolve to source/collection rows provisioned by the upper wiring. */
  resolvePartition?: (key: ContextSyncKey) => ContextPartitionIdentity;
  leaseOwner?: string;
  leaseMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

interface ActiveLease {
  tenantId: string;
  identity: ContextPartitionIdentity;
  leaseFence: number;
  renewAfterMs: number;
  initialWatermark: string | null;
  window?: ContextSyncWindow;
  truncated: boolean;
  retryCount: number;
  pendingFinalRecords?: ContextIngestRecordInput[];
  pendingRevocations?: ContextIngestRecordInput[];
}

const DEFAULT_LEASE_MS = 5 * 60_000;
const DEFAULT_RETRY_BASE_MS = 60_000;
const DEFAULT_RETRY_MAX_MS = 60 * 60_000;

/**
 * Maps the coordinator's page-oriented port onto ContextStore fenced partitions.
 * Page calls never write a watermark. The watermark and `complete` checkpoint are
 * committed together by `advanceWatermark`, after the coordinator has fetched all
 * pages and all document/minutes detail payloads for the fixed window.
 */
export class ContextStoreSyncAdapter implements ContextSyncStore {
  private readonly leaseOwner: string;
  private readonly leaseMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly active = new Map<string, ActiveLease>();
  private readonly invalidated = new Set<string>();

  constructor(private readonly options: ContextStoreSyncAdapterOptions) {
    this.leaseOwner = options.leaseOwner ?? `context-sync-${randomUUID()}`;
    this.leaseMs = positiveInteger(options.leaseMs, DEFAULT_LEASE_MS);
    this.retryBaseMs = positiveInteger(options.retryBaseMs, DEFAULT_RETRY_BASE_MS);
    this.retryMaxMs = positiveInteger(options.retryMaxMs, DEFAULT_RETRY_MAX_MS);
  }

  async getWatermark(key: ContextSyncKey): Promise<string | null> {
    // Acquire before any upstream read. A policy reset increments the fence, so
    // an operation that started under the old policy can never write afterward.
    return (await this.lease(key)).initialWatermark;
  }

  async heartbeat(): Promise<void> {
    const now = Date.now();
    for (const [mapKey, lease] of this.active) {
      if (now < lease.renewAfterMs) continue;
      const renewed = await this.options.store.renewPartitionLease({
        tenantId: lease.tenantId,
        ...lease.identity,
        leaseOwner: this.leaseOwner,
        leaseFence: lease.leaseFence,
        leaseMs: this.leaseMs,
      });
      if (!renewed) {
        this.active.delete(mapKey);
        this.invalidated.add(mapKey);
        throw new Error('Context sync partition lease was invalidated');
      }
      lease.renewAfterMs = now + Math.max(1_000, Math.floor(this.leaseMs / 3));
    }
  }

  async getResumeCursor(
    key: ContextSyncKey,
    window: ContextSyncWindow,
  ): Promise<string | undefined> {
    // Wiki reconciliation needs a complete inventory in one attempt; after a
    // failure it restarts from page 1 instead of sweeping from a partial set.
    if (key.source === 'wiki') return undefined;
    const identity = this.identity(key);
    const partition = await this.options.store.getPartition(
      key.tenantId,
      identity.sourceId,
      identity.collectionId,
      identity.partitionKey,
    );
    if (partition?.status !== 'retry_wait'
      || partition.windowStart !== window.from
      || partition.windowEnd !== window.to) return undefined;
    return partition.pageCursor;
  }

  async ingestPage(page: ContextIngestPage): Promise<void> {
    const lease = await this.lease(page.key);
    lease.window = page.window;
    lease.truncated ||= page.truncated;
    const records = page.items.map(toContextRecord);
    if (!page.nextCursor) {
      // Hold the terminal page until advanceWatermark so its records, revisions,
      // evidence, outbox rows and high watermark share one PostgreSQL transaction.
      lease.pendingFinalRecords = records;
      return;
    }
    await this.options.store.ingestPage({
      tenantId: page.key.tenantId,
      ...lease.identity,
      leaseOwner: this.leaseOwner,
      leaseFence: lease.leaseFence,
      records,
      checkpoint: {
        windowStart: page.window.from,
        windowEnd: page.window.to,
        pageCursor: page.nextCursor,
        truncated: lease.truncated,
        complete: false,
      },
    });
  }

  async reconcileInventory(input: {
    key: ContextSyncKey;
    window: ContextSyncWindow;
    externalRecordIds: readonly string[];
  }): Promise<number> {
    const lease = await this.lease(input.key);
    lease.window = input.window;
    const current = await this.options.store.listCurrentExternalRecordIds(
      input.key.tenantId,
      lease.identity.sourceId,
      lease.identity.collectionId,
    );
    const present = new Set(input.externalRecordIds);
    const missing = current.filter(externalRecordId => !present.has(externalRecordId));
    lease.pendingRevocations = missing.map(externalRecordId => ({
      recordId: `dws-${digest(externalRecordId).slice(0, 48)}`,
      externalRecordId,
      content: null,
      metadata: { source: input.key.source, revocationReason: 'inventory_absent' },
      revoked: true,
      observedAt: input.window.to,
    }));
    return missing.length;
  }

  async advanceWatermark(input: {
    key: ContextSyncKey;
    expected: string | null;
    value: string;
  }): Promise<void> {
    const lease = await this.lease(input.key);
    if (lease.initialWatermark !== input.expected) {
      throw new Error('Context sync watermark compare-and-set failed');
    }
    const window = lease.window;
    await this.options.store.ingestPage({
      tenantId: input.key.tenantId,
      ...lease.identity,
      leaseOwner: this.leaseOwner,
      leaseFence: lease.leaseFence,
      records: [
        ...(lease.pendingFinalRecords ?? []),
        ...(lease.pendingRevocations ?? []),
      ],
      checkpoint: {
        watermark: input.value,
        ...(window ? {
          windowStart: window.from,
          windowEnd: window.to,
          coverageStart: window.from,
          coverageEnd: window.to,
        } : {}),
        truncated: lease.truncated,
        complete: true,
      },
    });
    this.active.delete(keyString(input.key));
  }

  async getRetryState(key: ContextSyncKey): Promise<ContextSyncRetryState | null> {
    const identity = this.identity(key);
    const partition = await this.options.store.getPartition(
      key.tenantId,
      identity.sourceId,
      identity.collectionId,
      identity.partitionKey,
    );
    if (!partition || partition.status !== 'retry_wait' || !partition.windowStart
      || !partition.windowEnd || !partition.nextRetryAt) return null;
    return {
      key,
      window: { from: partition.windowStart, to: partition.windowEnd },
      attempt: partition.retryCount,
      status: 'waiting',
      nextAttemptAt: partition.nextRetryAt,
      lastError: partition.lastErrorCode ?? 'CONTEXT_SYNC_FAILED',
    };
  }

  async recordRetryFailure(input: {
    key: ContextSyncKey;
    window: ContextSyncWindow;
    error: string;
    failedAt: string;
  }): Promise<ContextSyncRetryState> {
    const lease = await this.lease(input.key);
    lease.window = input.window;

    // Persist the exact failed window before releasing the fenced lease. This is
    // needed when the failure happened during the first upstream/detail fetch.
    await this.options.store.ingestPage({
      tenantId: input.key.tenantId,
      ...lease.identity,
      leaseOwner: this.leaseOwner,
      leaseFence: lease.leaseFence,
      records: [],
      checkpoint: {
        windowStart: input.window.from,
        windowEnd: input.window.to,
        truncated: lease.truncated,
        complete: false,
      },
    });

    const retryAt = new Date(
      Date.parse(input.failedAt) + retryDelay(lease.retryCount + 1, this.retryBaseMs, this.retryMaxMs),
    ).toISOString();
    const refused = /(?:\b401\b|\b403\b|forbidden|permission denied|unauthorized|not authorized|access denied)/i
      .test(input.error);
    const partition = await this.options.store.failPartition({
      tenantId: input.key.tenantId,
      ...lease.identity,
      leaseOwner: this.leaseOwner,
      leaseFence: lease.leaseFence,
      errorCode: refused
        ? 'CONTEXT_SYNC_REFUSED'
        : input.error.includes('returned truncated upstream content')
          ? 'CONTEXT_SYNC_UNREADABLE'
          : 'CONTEXT_SYNC_FAILED',
      retryAt,
      ...(refused ? { refused: true } : {}),
    });
    this.active.delete(keyString(input.key));
    return {
      key: input.key,
      window: input.window,
      attempt: partition.retryCount,
      status: 'waiting',
      nextAttemptAt: partition.nextRetryAt ?? retryAt,
      lastError: redactError(input.error),
    };
  }

  async clearRetryState(key: ContextSyncKey): Promise<void> {
    // ContextStore.ingestPage resets retry state atomically with complete=true.
    // There is intentionally no second, unfenced mutation here.
    this.active.delete(keyString(key));
  }

  private identity(key: ContextSyncKey): ContextPartitionIdentity {
    return (this.options.resolvePartition ?? defaultPartitionIdentity)(key);
  }

  private async lease(key: ContextSyncKey): Promise<ActiveLease> {
    const mapKey = keyString(key);
    if (this.invalidated.has(mapKey)) throw new Error('Context sync partition lease was invalidated');
    const current = this.active.get(mapKey);
    if (current) {
      const renewed = await this.options.store.renewPartitionLease({
        tenantId: key.tenantId,
        ...current.identity,
        leaseOwner: this.leaseOwner,
        leaseFence: current.leaseFence,
        leaseMs: this.leaseMs,
      });
      if (renewed) {
        current.renewAfterMs = Date.now() + Math.max(1_000, Math.floor(this.leaseMs / 3));
        return current;
      }
      this.active.delete(mapKey);
      this.invalidated.add(mapKey);
      throw new Error('Context sync partition lease was invalidated');
    }

    const identity = this.identity(key);
    await this.options.store.ensurePartition({ tenantId: key.tenantId, ...identity });
    const partition = await this.options.store.acquirePartitionLease({
      tenantId: key.tenantId,
      ...identity,
      leaseOwner: this.leaseOwner,
      leaseMs: this.leaseMs,
    });
    if (!partition) throw new Error('Context sync partition lease is unavailable');
    const lease: ActiveLease = {
      tenantId: key.tenantId,
      identity,
      leaseFence: partition.leaseFence,
      renewAfterMs: Date.now() + Math.max(1_000, Math.floor(this.leaseMs / 3)),
      initialWatermark: watermarkFromPartition(partition),
      truncated: false,
      retryCount: partition.retryCount,
    };
    this.active.set(mapKey, lease);
    return lease;
  }
}

export function defaultPartitionIdentity(key: ContextSyncKey): ContextPartitionIdentity {
  const accountHash = digest(`${key.tenantId}\0${key.accountId}\0${key.profileId}`).slice(0, 32);
  const targetHash = digest(`${key.source}\0${conversationTargetKey(key)}`).slice(0, 32);
  return {
    sourceId: `dws-${accountHash}`,
    collectionId: `dws-${key.source}-${accountHash}`,
    partitionKey: `dws:${key.source}:${targetHash}`,
  };
}

const EVIDENCE_EXCERPT_CHARACTERS = 500;

function toContextRecord(item: ContextIngestItem): ContextIngestRecordInput {
  const content: ContextObject = {
    text: item.content,
    kind: item.kind,
    ...(item.title ? { title: item.title } : {}),
  };
  const metadata: ContextObject = {
    ...item.metadata,
    source: item.source,
    sourceId: item.sourceId,
    occurredAt: item.occurredAt,
    truncation: { ...item.truncation },
    ...(item.conversationId ? { conversationId: item.conversationId } : {}),
    ...(item.url ? { url: item.url } : {}),
  };
  const author = evidenceAuthor(item.metadata);
  const evidenceData: ContextObject = {
    externalId: item.sourceId,
    excerpt: Array.from(item.content).slice(0, EVIDENCE_EXCERPT_CHARACTERS).join(''),
    source: item.source,
    occurredAt: item.occurredAt,
    ...(item.conversationId ? { conversationId: item.conversationId } : {}),
    ...(item.url ? { url: item.url } : {}),
    ...(author ? { author } : {}),
    ...(item.metadata.unreadable === true ? {
      unreadable: true,
      unreadableReason: typeof item.metadata.unreadableReason === 'string'
        ? item.metadata.unreadableReason
        : 'content_unavailable',
    } : {}),
  };
  return {
    recordId: `dws-${digest(item.idempotencyKey).slice(0, 48)}`,
    externalRecordId: item.idempotencyKey,
    content,
    metadata,
    ...(item.revoked ? { revoked: true } : {}),
    sourceUpdatedAt: item.updatedAt ?? item.occurredAt,
    observedAt: item.occurredAt,
    evidence: [{
      evidenceId: `source-locator-${digest(item.idempotencyKey).slice(0, 40)}`,
      kind: 'source_locator',
      data: evidenceData,
    }],
  };
}

function evidenceAuthor(metadata: ContextIngestItem['metadata']): string | undefined {
  const value = metadata.author ?? metadata.senderId;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function watermarkFromPartition(partition: ContextSyncPartition | null): string | null {
  if (!partition || partition.watermark === undefined || partition.watermark === null) return null;
  if (typeof partition.watermark === 'string') return partition.watermark;
  if (!Array.isArray(partition.watermark) && typeof partition.watermark === 'object') {
    const value = partition.watermark.value;
    if (typeof value === 'string') return value;
  }
  throw new Error('Context sync partition watermark is not a timestamp string');
}

function retryDelay(attempt: number, baseMs: number, maxMs: number): number {
  const exponent = Math.min(30, Math.max(0, attempt - 1));
  return Math.min(maxMs, baseMs * (2 ** exponent));
}

function redactError(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:access_token|refresh_token|client_secret|authorization|token)\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500) || 'unknown_error';
}

function keyString(key: ContextSyncKey): string {
  return JSON.stringify([
    key.tenantId,
    key.accountId,
    key.profileId,
    key.source,
    conversationTargetKey(key),
  ]);
}

function conversationTargetKey(key: ContextSyncKey): string {
  if (key.conversationId) return `one:${key.conversationId}`;
  if (key.conversationIds) return `selected:${[...key.conversationIds].sort().join('\0')}`;
  return '*';
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}
