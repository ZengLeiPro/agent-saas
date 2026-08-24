import { randomUUID } from 'node:crypto';

import { azerothNativeId, createAzerothRevocation, normalizeAzerothRecord, shouldIngestAzerothRow } from './normalizer.js';
import { parseAzerothPage, type PaginationFacts } from './schemas.js';
import {
  AZEROTH_ENTITIES,
  AzerothAuthorizationError,
  AzerothLeaseUnavailableError,
  type AzerothBindingPort,
  type AzerothContextStorePort,
  type AzerothEntity,
  type AzerothHttpClient,
  type AzerothInventoryResult,
  type AzerothServerBinding,
  type AzerothTenantSyncResult,
} from './types.js';

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 10_000;
const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_RETRY_MS = 60_000;
const SOURCE_ID = 'azeroth-authoritative';
const PARTITION_KEY = 'authoritative-inventory';

export interface AzerothInventoryWorkerOptions {
  bindings: AzerothBindingPort;
  http: AzerothHttpClient;
  store: AzerothContextStorePort;
  leaseOwner?: string;
  leaseMs?: number;
  retryMs?: number;
  pageSize?: number;
  maxPages?: number;
  clock?: () => Date;
}

/**
 * Full-inventory coordinator. Azeroth has no updatedAfter/cursor contract, so a
 * run always starts at page 1. Previously ingested pages may be replayed safely.
 */
export class AzerothInventoryWorker {
  private readonly leaseOwner: string;
  private readonly leaseMs: number;
  private readonly retryMs: number;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly clock: () => Date;

  constructor(private readonly options: AzerothInventoryWorkerOptions) {
    this.leaseOwner = safeId(options.leaseOwner ?? `azeroth-worker-${randomUUID()}`);
    this.leaseMs = positiveInteger(options.leaseMs, DEFAULT_LEASE_MS);
    this.retryMs = positiveInteger(options.retryMs, DEFAULT_RETRY_MS);
    this.pageSize = positiveInteger(options.pageSize, DEFAULT_PAGE_SIZE);
    this.maxPages = positiveInteger(options.maxPages, DEFAULT_MAX_PAGES);
    this.clock = options.clock ?? (() => new Date());
  }

  async syncTenant(tenantId: string, signal?: AbortSignal): Promise<AzerothTenantSyncResult> {
    requiredText(tenantId, 'tenantId');
    const binding = await this.authoritativeBinding(tenantId);
    const inventories: AzerothInventoryResult[] = [];
    for (const entity of AZEROTH_ENTITIES) {
      inventories.push(await this.syncEntityWithBinding(tenantId, entity, binding, signal));
    }
    return { tenantId, bindingId: binding.bindingId, inventories };
  }

  async syncEntity(
    tenantId: string,
    entity: AzerothEntity,
    signal?: AbortSignal,
  ): Promise<AzerothInventoryResult> {
    requiredText(tenantId, 'tenantId');
    if (!AZEROTH_ENTITIES.includes(entity)) throw new Error(`Unsupported Azeroth entity: ${entity}`);
    const binding = await this.authoritativeBinding(tenantId);
    return this.syncEntityWithBinding(tenantId, entity, binding, signal);
  }

  private async authoritativeBinding(tenantId: string): Promise<AzerothServerBinding> {
    const bindings = await this.options.bindings.listServerBindings(tenantId);
    return selectAuthoritativeAzerothBinding(bindings);
  }

  private async syncEntityWithBinding(
    tenantId: string,
    entity: AzerothEntity,
    binding: AzerothServerBinding,
    signal?: AbortSignal,
  ): Promise<AzerothInventoryResult> {
    const identity = identityFor(entity);
    await this.ensureResources(tenantId, entity, binding, identity.collectionId);
    await this.options.store.ensurePartition({ tenantId, ...identity });
    const lease = await this.options.store.acquirePartitionLease({
      tenantId,
      ...identity,
      leaseOwner: this.leaseOwner,
      leaseMs: this.leaseMs,
    });
    if (!lease) throw new AzerothLeaseUnavailableError(entity);

    let leaseValid = true;
    let pages = 0;
    let records = 0;
    let rawRecords = 0;
    let baselineTotal: number | undefined;
    let baselineTotalPages: number | undefined;
    const inventoryIds = new Set<string>();
    const rawIds = new Set<string>();
    try {
      for (let page = 1; ; page += 1) {
        if (page > this.maxPages) throw new Error(`Azeroth ${entity} exceeded maximum page count`);
        if (page > 1) {
          leaseValid = await this.options.store.renewPartitionLease({
            tenantId,
            ...identity,
            leaseOwner: this.leaseOwner,
            leaseFence: lease.leaseFence,
            leaseMs: this.leaseMs,
          });
          if (!leaseValid) throw new Error(`Azeroth ${entity} inventory lease was lost`);
        }
        const raw = await this.options.http.get({
          binding,
          path: `/api/v1/${entity}`,
          query: { page, pageSize: this.pageSize, sortBy: 'updatedAt', sortOrder: 'asc' },
          ...(signal ? { signal } : {}),
        });
        const parsed = parseAzerothPage(entity, raw, page, this.pageSize);
        if (page === 1) {
          baselineTotal = parsed.pagination.total;
          baselineTotalPages = parsed.pagination.totalPages;
        } else {
          assertStablePaginationFact(entity, 'total', baselineTotal, parsed.pagination.total);
          assertStablePaginationFact(entity, 'totalPages', baselineTotalPages, parsed.pagination.totalPages);
        }
        const hasMore = validatePageCompleteness(
          entity,
          page,
          this.pageSize,
          parsed.items.length,
          parsed.hasMore,
          parsed.pagination,
          baselineTotal,
          baselineTotalPages,
        );
        for (const row of parsed.items) {
          const id = azerothNativeId(entity, row);
          if (rawIds.has(id)) throw new Error(`Azeroth ${entity} inventory repeated id ${id} across pages`);
          rawIds.add(id);
        }
        rawRecords += parsed.items.length;
        const observedAt = this.clock().toISOString();
        const normalized = parsed.items
          .filter(row => shouldIngestAzerothRow(entity, row))
          .map(row => normalizeAzerothRecord(entity, row, observedAt));
        for (const record of normalized) inventoryIds.add(record.externalRecordId);
        await this.options.store.ingestPage({
          tenantId,
          ...identity,
          leaseOwner: this.leaseOwner,
          leaseFence: lease.leaseFence,
          records: normalized,
          checkpoint: { pageCursor: hasMore ? String(page + 1) : String(page), complete: false },
        });
        pages += 1;
        records += normalized.length;
        if (!hasMore) break;
      }

      leaseValid = await this.options.store.renewPartitionLease({
        tenantId,
        ...identity,
        leaseOwner: this.leaseOwner,
        leaseFence: lease.leaseFence,
        leaseMs: this.leaseMs,
      });
      if (!leaseValid) throw new Error(`Azeroth ${entity} inventory lease was lost`);

      const completedAt = this.clock().toISOString();
      if (baselineTotal === undefined) {
        // Page-number traversal without an authoritative record count cannot prove
        // that concurrent inserts/deletes did not shift unseen rows between pages.
        await this.options.store.ingestPage({
          tenantId,
          ...identity,
          leaseOwner: this.leaseOwner,
          leaseFence: lease.leaseFence,
          records: [],
          checkpoint: {
            watermark: {
              mode: 'full_inventory',
              status: 'degraded',
              reason: 'authoritative_count_missing',
              completedAt,
              pages,
              records,
              rawRecords,
            },
            complete: false,
            releaseLease: true,
          },
        });
        return {
          tenantId,
          entity,
          sourceId: identity.sourceId,
          collectionId: identity.collectionId,
          pages,
          records,
          revoked: 0,
          complete: false,
          degraded: true,
          degradedReason: 'authoritative_count_missing',
          completedAt,
        };
      }
      if (rawRecords !== baselineTotal) {
        throw new Error(`Azeroth ${entity} authoritative total expected ${baselineTotal} records but observed ${rawRecords}`);
      }

      // Reconciliation is intentionally delayed until every authoritative page validates and ingests.
      const currentIds = await this.options.store.listCurrentExternalRecordIds(
        tenantId,
        identity.sourceId,
        identity.collectionId,
      );
      const revocations = currentIds
        .filter(externalRecordId => !inventoryIds.has(externalRecordId))
        .map(externalRecordId => createAzerothRevocation(entity, externalRecordId, completedAt));
      await this.options.store.ingestPage({
        tenantId,
        ...identity,
        leaseOwner: this.leaseOwner,
        leaseFence: lease.leaseFence,
        records: revocations,
        checkpoint: {
          watermark: {
            mode: 'full_inventory',
            completedAt,
            pages,
            records,
            sortBy: 'updatedAt',
            sortOrder: 'asc',
          },
          complete: true,
          releaseLease: true,
        },
      });
      return {
        tenantId,
        entity,
        sourceId: identity.sourceId,
        collectionId: identity.collectionId,
        pages,
        records,
        revoked: revocations.length,
        complete: true,
        completedAt,
      };
    } catch (error) {
      if (leaseValid) await this.failInventory(tenantId, identity, lease.leaseFence, error);
      throw error;
    }
  }

  private async failInventory(
    tenantId: string,
    identity: ReturnType<typeof identityFor>,
    leaseFence: number,
    error: unknown,
  ): Promise<void> {
    // Persist an explicitly incomplete checkpoint. No watermark or revocation is offered.
    await this.options.store.ingestPage({
      tenantId,
      ...identity,
      leaseOwner: this.leaseOwner,
      leaseFence,
      records: [],
      checkpoint: { complete: false },
    });
    const message = compactError(error);
    const refused = /(?:\b401\b|\b403\b|forbidden|unauthorized|access denied)/i.test(message);
    await this.options.store.failPartition({
      tenantId,
      ...identity,
      leaseOwner: this.leaseOwner,
      leaseFence,
      errorCode: refused ? 'AZEROTH_SYNC_REFUSED' : 'AZEROTH_SYNC_FAILED',
      retryAt: new Date(this.clock().getTime() + this.retryMs).toISOString(),
      ...(refused ? { refused: true } : {}),
    });
  }

  private async ensureResources(
    tenantId: string,
    entity: AzerothEntity,
    binding: AzerothServerBinding,
    collectionId: string,
  ): Promise<void> {
    let source = await this.options.store.getSource(tenantId, SOURCE_ID);
    if (!source) {
      try {
        source = await this.options.store.createSource({
          tenantId,
          sourceId: SOURCE_ID,
          kind: 'azeroth',
          displayName: 'Azeroth authoritative inventory',
          // Binding handle and PAT are intentionally absent from durable config.
          config: { authority: 'server_admin_binding', inventoryMode: 'full' },
        });
      } catch (error) {
        source = await this.options.store.getSource(tenantId, SOURCE_ID);
        if (!source) throw error;
      }
    }
    if (source.status !== 'active') throw new Error('Azeroth context source is not active');

    let collection = await this.options.store.getCollection(tenantId, SOURCE_ID, collectionId);
    if (!collection) {
      try {
        collection = await this.options.store.createCollection({
          tenantId,
          sourceId: SOURCE_ID,
          collectionId,
          externalKey: entity,
          displayName: `Azeroth ${entity}`,
          metadata: {
            provider: 'azeroth',
            entity,
            authoritative: true,
            bindingClass: 'server_admin',
          },
        });
      } catch (error) {
        collection = await this.options.store.getCollection(tenantId, SOURCE_ID, collectionId);
        if (!collection) throw error;
      }
    }
    if (collection.status !== 'active') throw new Error(`Azeroth ${entity} collection is not active`);
    void binding;
  }
}

export function selectAuthoritativeAzerothBinding(
  bindings: readonly AzerothServerBinding[],
): AzerothServerBinding {
  const authoritative = bindings.filter(binding =>
    binding.serverSide === true
    && Array.isArray(binding.roles)
    && binding.roles.includes('ADMIN')
    && Boolean(binding.bindingId)
    && Boolean(binding.credentialHandle)
    && /^https?:\/\//i.test(binding.baseUrl),
  );
  if (authoritative.length !== 1) throw new AzerothAuthorizationError();
  return authoritative[0]!;
}

function assertStablePaginationFact(
  entity: AzerothEntity,
  fact: 'total' | 'totalPages',
  expected: number | undefined,
  actual: number | undefined,
): void {
  if (actual !== expected) {
    throw new Error(`Azeroth ${entity} pagination ${fact} drifted from ${String(expected)} to ${String(actual)}`);
  }
}

function validatePageCompleteness(
  entity: AzerothEntity,
  page: number,
  pageSize: number,
  itemCount: number,
  fallbackHasMore: boolean,
  pagination: PaginationFacts,
  total: number | undefined,
  totalPages: number | undefined,
): boolean {
  if (pagination.page !== undefined && pagination.page !== page) {
    throw new Error(`Azeroth ${entity} pagination returned page ${pagination.page} while requesting page ${page}`);
  }
  if (total !== undefined) {
    const expectedPages = Math.max(1, Math.ceil(total / pageSize));
    if (totalPages !== undefined && totalPages !== expectedPages) {
      throw new Error(`Azeroth ${entity} pagination totalPages ${totalPages} disagrees with total ${total}`);
    }
    if (page > expectedPages) throw new Error(`Azeroth ${entity} returned an unexpected page ${page}`);
    const expectedItems = page < expectedPages ? pageSize : total - pageSize * (expectedPages - 1);
    if (itemCount !== expectedItems) {
      throw new Error(`Azeroth ${entity} page ${page} expected ${expectedItems} records but received ${itemCount}`);
    }
    const expectedHasMore = page < expectedPages;
    if (pagination.hasNext !== undefined && pagination.hasNext !== expectedHasMore) {
      throw new Error(`Azeroth ${entity} page ${page} hasNext disagrees with authoritative count`);
    }
    if (pagination.nextPage !== undefined) {
      const expectedNextPage = expectedHasMore ? page + 1 : null;
      if (pagination.nextPage !== expectedNextPage) {
        throw new Error(`Azeroth ${entity} page ${page} nextPage disagrees with authoritative count`);
      }
    }
    return expectedHasMore;
  }
  if (fallbackHasMore && itemCount !== pageSize) {
    throw new Error(`Azeroth ${entity} non-terminal page ${page} is not full`);
  }
  return fallbackHasMore;
}

export function identityFor(entity: AzerothEntity) {
  return {
    sourceId: SOURCE_ID,
    collectionId: `azeroth-${entity}`,
    partitionKey: PARTITION_KEY,
  } as const;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Azeroth ${label} is required`);
  return value;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

function safeId(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.:@/-]/g, '_').slice(0, 200);
  return /^[A-Za-z0-9]/.test(safe) ? safe : `azeroth-${safe}`;
}

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:pat|access_token|authorization|token)\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500) || 'unknown_error';
}
