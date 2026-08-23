import { Router, type Request } from 'express';
import { z } from 'zod';

import { isPlatformAdmin } from '../auth/types.js';

interface ContextAdminSource {
  sourceId: string;
  kind: string;
  displayName: string;
  status: string;
}

interface ContextAdminCollection {
  sourceId: string;
  collectionId: string;
  displayName: string;
  status: string;
  metadata?: Record<string, unknown>;
}

interface ContextAdminPartition {
  sourceId: string;
  collectionId: string;
  status: string;
  watermark?: unknown;
  coverageStart?: string;
  coverageEnd?: string;
  truncated: boolean;
  refused: boolean;
  lastErrorCode?: string;
  updatedAt: string;
}

interface ContextAdminEvidence {
  sourceId: string;
  collectionId: string;
  evidenceId: string;
  kind: string;
  data: Record<string, unknown>;
  createdAt: string;
}

/** Structural port so the read router can adopt listEvidence before the concrete Store type catches up. */
export interface ContextAdminStorePort {
  listSources(tenantId: string): Promise<ContextAdminSource[]>;
  listCollections(tenantId: string, sourceId?: string): Promise<ContextAdminCollection[]>;
  listPartitions(tenantId: string, sourceId?: string, collectionId?: string): Promise<ContextAdminPartition[]>;
  getEvidence(
    tenantId: string,
    sourceId: string,
    collectionId: string,
    recordId: string,
  ): Promise<ContextAdminEvidence[]>;
  listEvidence?(
    tenantId: string,
    sourceId: string,
    collectionId: string,
  ): Promise<ContextAdminEvidence[]>;
  countUnreadableRecords?(
    tenantId: string,
    sourceId: string,
    collectionId: string,
  ): Promise<number>;
}

export interface ContextAdminConsumerStorePort {
  listConsumers(tenantId: string): Promise<Array<{
    id: string;
    name: string;
    kind: string;
    status: 'current' | 'lagging' | 'blocked' | 'offline';
    watermarkAt: string | null;
    lagSeconds: number | null;
    detail?: string;
  }>>;
}

export interface ContextAdminRouterOptions {
  store?: ContextAdminStorePort;
  consumers?: ContextAdminConsumerStorePort;
  now?: () => Date;
}

const tenantQuerySchema = z.object({
  tenantId: z.string().trim().min(1).max(128).optional(),
}).strict();
const evidenceQuerySchema = tenantQuerySchema.extend({
  sourceId: z.string().trim().min(1).max(128),
  collectionId: z.string().trim().min(1).max(128),
  recordId: z.string().trim().min(1).max(128).optional(),
}).strict();

/** Read-only Context Plane administration endpoints. Authentication/admin role is mounted by app. */
export function createContextAdminRouter(options: ContextAdminRouterOptions): Router {
  const router = Router();

  router.get('/snapshot', async (req, res) => {
    if (!options.store) return unavailable(res);
    const query = tenantQuerySchema.safeParse(req.query);
    if (!query.success) return res.status(400).json({ code: 'CONTEXT_ADMIN_INVALID_QUERY' });
    const tenantId = resolveTenant(req, query.data.tenantId);
    if (!tenantId) return res.status(403).json({ code: 'CONTEXT_ADMIN_TENANT_FORBIDDEN' });

    try {
      const [sources, collections, partitions] = await Promise.all([
        options.store.listSources(tenantId),
        options.store.listCollections(tenantId),
        options.store.listPartitions(tenantId),
      ]);
      const sourceById = new Map(sources.map(source => [source.sourceId, source]));
      const unreadableCounts = new Map<string, number>();
      if (options.store.countUnreadableRecords) {
        await Promise.all(collections.map(async collection => {
          unreadableCounts.set(
            collectionKey(collection.sourceId, collection.collectionId),
            await options.store!.countUnreadableRecords!(
              tenantId,
              collection.sourceId,
              collection.collectionId,
            ),
          );
        }));
      }
      const partitionsByCollection = new Map<string, ContextAdminPartition[]>();
      for (const partition of partitions) {
        const key = collectionKey(partition.sourceId, partition.collectionId);
        const current = partitionsByCollection.get(key) ?? [];
        current.push(partition);
        partitionsByCollection.set(key, current);
      }
      const now = (options.now ?? (() => new Date()))();
      const cards = collections.map(collection => mapSourceCard(
        sourceById.get(collection.sourceId),
        collection,
        partitionsByCollection.get(collectionKey(collection.sourceId, collection.collectionId)) ?? [],
        now,
        unreadableCounts.get(collectionKey(collection.sourceId, collection.collectionId)) ?? 0,
      ));
      const consumers = options.consumers ? await options.consumers.listConsumers(tenantId) : [];
      return res.json({ generatedAt: now.toISOString(), sources: cards, consumers });
    } catch {
      return res.status(503).json({ code: 'CONTEXT_ADMIN_READ_UNAVAILABLE' });
    }
  });

  router.get('/evidence', async (req, res) => {
    if (!options.store) return unavailable(res);
    const query = evidenceQuerySchema.safeParse(req.query);
    if (!query.success) return res.status(400).json({ code: 'CONTEXT_ADMIN_INVALID_QUERY' });
    const tenantId = resolveTenant(req, query.data.tenantId);
    if (!tenantId) return res.status(403).json({ code: 'CONTEXT_ADMIN_TENANT_FORBIDDEN' });

    try {
      const evidence = query.data.recordId
        ? await options.store.getEvidence(
          tenantId,
          query.data.sourceId,
          query.data.collectionId,
          query.data.recordId,
        )
        : options.store.listEvidence
          ? await options.store.listEvidence(tenantId, query.data.sourceId, query.data.collectionId)
          : null;
      if (evidence === null) return unavailable(res);
      return res.json(evidence.flatMap(item => mapEvidence(item, query.data.sourceId, query.data.collectionId)));
    } catch {
      return res.status(503).json({ code: 'CONTEXT_ADMIN_READ_UNAVAILABLE' });
    }
  });

  return router;
}

function mapSourceCard(
  source: ContextAdminSource | undefined,
  collection: ContextAdminCollection,
  partitions: ContextAdminPartition[],
  now: Date,
  unreadableRecords: number,
) {
  const coverageStart = earliestIso(partitions.map(partition => partition.coverageStart));
  const coverageEnd = latestIso(partitions.map(partition => partition.coverageEnd));
  const completedAt = latestIso(
    partitions.filter(partition => partition.status === 'complete').map(partition => partition.updatedAt),
  );
  const realtimeConfigured = partitions.some(partition => partition.watermark !== undefined && partition.watermark !== null);
  const historicalScope = configuredScope(collection.metadata, 'historicalLearning');
  const realtimeScope = configuredScope(collection.metadata, 'realtimeListening');
  return {
    sourceId: collection.sourceId,
    name: nonEmpty(source?.displayName) ?? '未配置',
    system: nonEmpty(source?.kind) ?? 'unknown',
    collectionId: collection.collectionId,
    collection: nonEmpty(collection.displayName) ?? '未配置',
    status: sourceStatus(source?.status, collection.status, partitions),
    lastSyncedAt: completedAt,
    backfillCoverage: {
      kind: 'time' as const,
      coveredFrom: coverageStart,
      coveredThrough: coverageEnd,
    },
    watermarkLagSeconds: watermarkLag(partitions, now),
    ingestOutcomes: {
      truncated: partitions.filter(partition => partition.truncated).length,
      refused: partitions.filter(partition => partition.refused || partition.status === 'refused').length,
      unreadable: unreadableRecords
        + partitions.filter(partition => partition.lastErrorCode === 'CONTEXT_SYNC_UNREADABLE').length,
    },
    historicalLearningScope: {
      enabled: historicalScope?.enabled ?? Boolean(coverageStart || coverageEnd),
      summary: historicalScope?.summary ?? (coverageStart || coverageEnd ? '已配置' : '未配置'),
      from: coverageStart,
      through: coverageEnd,
    },
    realtimeListeningScope: {
      enabled: realtimeScope?.enabled ?? realtimeConfigured,
      summary: realtimeScope?.summary ?? (realtimeConfigured ? '已配置' : '未配置'),
    },
  };
}

function configuredScope(
  metadata: Record<string, unknown> | undefined,
  key: 'historicalLearning' | 'realtimeListening',
): { enabled: boolean; summary: string } | null {
  if (!metadata) return null;
  const raw = metadata[key];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const scope = raw as Record<string, unknown>;
  if (typeof scope.enabled !== 'boolean') return null;
  const mode = scope.mode;
  const lookbackDays = Number.isSafeInteger(scope.lookbackDays) ? Number(scope.lookbackDays) : undefined;
  const ids = Array.isArray(scope.conversationIds)
    ? scope.conversationIds.filter(item => typeof item === 'string' && item.trim()).length
    : 0;
  if (mode === 'none') return {
    enabled: false,
    summary: key === 'historicalLearning' ? '不采集' : '不监听',
  };
  if (mode === 'all') {
    return {
      enabled: true,
      summary: `全部会话${lookbackDays ? ` · ${lookbackDays} 天` : ''}`,
    };
  }
  if (mode === 'selected') {
    return {
      enabled: true,
      summary: `${ids} 个指定会话${lookbackDays ? ` · ${lookbackDays} 天` : ''}`,
    };
  }
  return {
    enabled: scope.enabled,
    summary: scope.enabled
      ? `已启用${lookbackDays ? ` · ${lookbackDays} 天` : ''}`
      : '未启用',
  };
}

function mapEvidence(
  evidence: ContextAdminEvidence,
  sourceId: string,
  collectionId: string,
) {
  const excerpt = stringField(evidence.data, 'excerpt')
    ?? (evidence.data.unreadable === true
      ? `不可读：${stringField(evidence.data, 'unreadableReason') ?? 'content_unavailable'}`
      : undefined);
  if (!excerpt) return [];
  return [{
    id: stringField(evidence.data, 'externalId') ?? evidence.evidenceId,
    sourceName: sourceId,
    collection: collectionId,
    author: stringField(evidence.data, 'author') ?? null,
    occurredAt: validIso(stringField(evidence.data, 'occurredAt')) ?? evidence.createdAt,
    quote: excerpt,
    derived: evidence.data.derived === true || evidence.kind === 'derived',
    freshness: 'unknown' as const,
    freshnessAsOf: null,
    originalUrl: stringField(evidence.data, 'url') ?? null,
  }];
}

function sourceStatus(
  sourceStatusValue: string | undefined,
  collectionStatus: string,
  partitions: ContextAdminPartition[],
): 'healthy' | 'syncing' | 'attention' | 'paused' {
  if (sourceStatusValue !== 'active' || collectionStatus !== 'active') return 'paused';
  if (partitions.some(partition => partition.status === 'retry_wait'
    || partition.status === 'refused' || partition.refused)) return 'attention';
  if (partitions.some(partition => partition.status === 'syncing')) return 'syncing';
  if (partitions.length > 0 && partitions.every(partition => partition.status === 'complete')) return 'healthy';
  return 'attention';
}

function watermarkLag(partitions: ContextAdminPartition[], now: Date): number | null {
  const latest = latestIso(partitions.map(partition => watermarkTimestamp(partition.watermark)));
  if (!latest) return null;
  return Math.max(0, Math.floor((now.getTime() - Date.parse(latest)) / 1_000));
}

function watermarkTimestamp(value: unknown): string | undefined {
  if (typeof value === 'string') return validIso(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const candidate = (value as Record<string, unknown>).value;
    if (typeof candidate === 'string') return validIso(candidate);
  }
  return undefined;
}

function earliestIso(values: Array<string | undefined>): string | null {
  const valid = values.map(validIso).filter((value): value is string => Boolean(value));
  return valid.length ? valid.reduce((left, right) => Date.parse(left) <= Date.parse(right) ? left : right) : null;
}

function latestIso(values: Array<string | undefined>): string | null {
  const valid = values.map(validIso).filter((value): value is string => Boolean(value));
  return valid.length ? valid.reduce((left, right) => Date.parse(left) >= Date.parse(right) ? left : right) : null;
}

function validIso(value: string | undefined): string | undefined {
  return value && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' && field.trim() ? field : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

function collectionKey(sourceId: string, collectionId: string): string {
  return `${sourceId}\u0000${collectionId}`;
}

function resolveTenant(req: Request, requestedTenantId?: string): string | null {
  const actor = req.user;
  if (!actor) return null;
  if (isPlatformAdmin(actor)) return requestedTenantId ?? actor.tenantId ?? null;
  if (!actor.tenantId || (requestedTenantId && requestedTenantId !== actor.tenantId)) return null;
  return actor.tenantId;
}

function unavailable(res: import('express').Response) {
  return res.status(503).json({ code: 'CONTEXT_ADMIN_DEPENDENCY_UNAVAILABLE' });
}
