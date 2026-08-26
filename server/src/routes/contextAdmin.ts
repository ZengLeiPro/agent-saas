import { Router, type Request } from 'express';
import { z } from 'zod';

import { isPlatformAdmin } from '../auth/types.js';
import { ContextProductError, type ContextProductService } from '../context/product/index.js';
import type {
  ContextRetentionAuditState,
  ContextRetentionReceipt,
  ContextRetentionRequest,
} from '../context/lifecycle/index.js';

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
  nextRetryAt?: string;
  lastErrorCode?: string;
  updatedAt: string;
}

/** Metadata-only administration port; source content/evidence is intentionally excluded. */
export interface ContextAdminStorePort {
  listSources(tenantId: string): Promise<ContextAdminSource[]>;
  listCollections(tenantId: string, sourceId?: string): Promise<ContextAdminCollection[]>;
  listPartitions(tenantId: string, sourceId?: string, collectionId?: string): Promise<ContextAdminPartition[]>;
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

export interface ContextRetentionWorkerPort {
  run(requests: readonly ContextRetentionRequest[]): Promise<{
    receipts: ContextRetentionReceipt[];
    failures: Array<{ tenantId: string; error: string; receipt?: ContextRetentionReceipt }>;
  }>;
  getAuditState(tenantId: string, receiptId: string): Promise<ContextRetentionAuditState>;
  retryAudit(tenantId: string, receiptId: string): Promise<ContextRetentionReceipt>;
  replayDeadLetterAudit(tenantId: string, receiptId: string, expectedRevision: number): Promise<ContextRetentionReceipt>;
}

export interface ContextAdminRouterOptions {
  store?: ContextAdminStorePort;
  consumers?: ContextAdminConsumerStorePort;
  product?: ContextProductService;
  retention?: ContextRetentionWorkerPort;
  now?: () => Date;
}

const tenantQuerySchema = z.object({
  tenantId: z.string().trim().min(1).max(128).optional(),
}).strict();
const evidenceQuerySchema = tenantQuerySchema.extend({
  id: z.string().min(1).max(2_000),
}).strict();
const retentionBodySchema = z.object({
  tenantId: z.string().trim().min(1).max(128).optional(),
  sourceOutboxWatermark: z.string().regex(/^\d+$/),
  derivedOutboxWatermark: z.string().regex(/^\d+$/),
  retainAfter: z.iso.datetime(),
  dryRun: z.boolean().optional(),
}).strict();
const retentionReceiptParamsSchema = z.object({ receiptId: z.uuid() }).strict();
const retentionReplayBodySchema = z.object({ expectedRevision: z.number().int().positive() }).strict();
const productListQuerySchema = tenantQuerySchema.extend({
  cursor: z.string().min(1).max(2_000).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  filter: z.string().trim().min(1).max(200).optional(),
  type: z.string().trim().min(1).max(80).optional(),
}).strict();
const timelineQuerySchema = productListQuerySchema.extend({
  entityId: z.string().trim().min(1).max(500).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  through: z.string().datetime({ offset: true }).optional(),
}).strict().refine(value => !value.from || !value.through || Date.parse(value.from) <= Date.parse(value.through), {
  message: 'from must not be after through', path: ['through'],
});
const relationQuerySchema = productListQuerySchema.extend({
  depth: z.coerce.number().int().min(1).max(2).optional(),
}).strict();
const correctionBodySchema = z.object({
  action: z.enum(['assert', 'reject']), scope: z.enum(['personal', 'organization']),
  expectedRevision: z.number().int().positive(), targetItemId: z.string().trim().min(1).max(500),
  summary: z.string().trim().min(1).max(500).optional(),
  evidenceIds: z.array(z.string().min(1).max(2_000)).min(1).max(50),
}).strict().superRefine((value, context) => {
  if (value.action === 'assert' && !value.summary) context.addIssue({ code: 'custom', path: ['summary'], message: 'summary is required for assert' });
});
const reviewDecisionBodySchema = z.object({
  decision: z.enum(['confirm', 'reject', 'confirmed', 'rejected']),
  expectedRevision: z.number().int().positive(),
}).strict();
const entityParamsSchema = z.object({ entityId: z.string().trim().min(1).max(500) }).strict();
const reviewParamsSchema = z.object({ itemId: z.string().trim().min(1).max(500) }).strict();

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
    const query = evidenceQuerySchema.safeParse(req.query);
    if (!query.success) return res.status(400).json({ code: 'CONTEXT_PRODUCT_EVIDENCE_INVALID' });
    return productCall(req, res, options, query.data.tenantId,
      (product, subject) => product.getEvidence(subject, query.data.id));
  });

  router.get('/timeline', async (req, res) => productRead(req, res, options, timelineQuerySchema,
    (product, subject, query) => product.listTimeline(subject, query)));
  router.get('/entities', async (req, res) => productRead(req, res, options, productListQuerySchema,
    (product, subject, query) => product.listEntities(subject, query)));
  router.get('/entities/:entityId', async (req, res) => {
    const params = entityParamsSchema.safeParse(req.params);
    const query = tenantQuerySchema.safeParse(req.query);
    if (!params.success || !query.success) return res.status(400).json({ code: 'CONTEXT_PRODUCT_INVALID' });
    return productCall(req, res, options, query.data.tenantId,
      (product, subject) => product.getEntity(subject, params.data.entityId));
  });
  router.get('/entities/:entityId/items', async (req, res) => {
    const params = entityParamsSchema.safeParse(req.params);
    const query = productListQuerySchema.safeParse(req.query);
    if (!params.success || !query.success) return res.status(400).json({ code: 'CONTEXT_PRODUCT_INVALID' });
    const { tenantId: requested, ...data } = query.data;
    return productCall(req, res, options, requested,
      (product, subject) => product.listEntityItems(subject, params.data.entityId, data));
  });
  router.get('/entities/:entityId/corrections', async (req, res) => {
    const params = entityParamsSchema.safeParse(req.params);
    const query = productListQuerySchema.safeParse(req.query);
    if (!params.success || !query.success) return res.status(400).json({ code: 'CONTEXT_PRODUCT_INVALID' });
    const { tenantId: requested, ...data } = query.data;
    return productCall(req, res, options, requested,
      (product, subject) => product.listEntityCorrections(subject, params.data.entityId, data));
  });
  router.get('/entities/:entityId/profile', async (req, res) => {
    const params = entityParamsSchema.safeParse(req.params);
    const query = tenantQuerySchema.safeParse(req.query);
    if (!params.success || !query.success) return res.status(400).json({ code: 'CONTEXT_PRODUCT_INVALID' });
    return productCall(req, res, options, query.data.tenantId,
      (product, subject) => product.getProfile(subject, params.data.entityId));
  });
  router.get('/entities/:entityId/relations', async (req, res) => {
    const params = entityParamsSchema.safeParse(req.params);
    const query = relationQuerySchema.safeParse(req.query);
    if (!params.success || !query.success) return res.status(400).json({ code: 'CONTEXT_PRODUCT_INVALID' });
    const { tenantId: requested, ...data } = query.data;
    return productCall(req, res, options, requested,
      (product, subject) => product.listRelations(subject, params.data.entityId, data));
  });
  router.get('/reviews', async (req, res) => productRead(req, res, options, productListQuerySchema,
    (product, subject, query) => product.listReviews(subject, query)));

  router.post('/retention', async (req, res) => {
    if (!options.retention) return unavailable(res);
    const body = retentionBodySchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ code: 'CONTEXT_RETENTION_INVALID' });
    const tenantId = resolveTenant(req, body.data.tenantId);
    if (!tenantId) return res.status(403).json({ code: 'CONTEXT_ADMIN_TENANT_FORBIDDEN' });
    const { tenantId: _requested, ...plan } = body.data;
    const result = await options.retention.run([{ ...plan, tenantId }]);
    if (result.failures.length) {
      const failure = result.failures[0]!;
      return res.status(failure.receipt ? 502 : 500).json({
        code: 'CONTEXT_RETENTION_FAILED', error: failure.error,
        ...(failure.receipt ? { receipt: failure.receipt } : {}),
      });
    }
    return res.status(200).json({ receipt: result.receipts[0] });
  });

  router.get('/retention/receipts/:receiptId', async (req, res) => {
    if (!options.retention) return unavailable(res);
    const params = retentionReceiptParamsSchema.safeParse(req.params);
    const query = tenantQuerySchema.safeParse(req.query);
    if (!params.success || !query.success) return res.status(400).json({ code: 'CONTEXT_RETENTION_INVALID' });
    const tenantId = resolveTenant(req, query.data.tenantId);
    if (!tenantId) return res.status(403).json({ code: 'CONTEXT_ADMIN_TENANT_FORBIDDEN' });
    try {
      const state = await options.retention.getAuditState(tenantId, params.data.receiptId);
      return res.status(200).json({ state });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'CONTEXT_RETENTION_RECEIPT_NOT_FOUND') return res.status(404).json({ code: message });
      return res.status(502).json({ code: 'CONTEXT_RETENTION_AUDIT_STATE_FAILED' });
    }
  });

  router.post('/retention/receipts/:receiptId/retry', async (req, res) => {
    if (!options.retention) return unavailable(res);
    const params = retentionReceiptParamsSchema.safeParse(req.params);
    const query = tenantQuerySchema.safeParse(req.query);
    if (!params.success || !query.success) return res.status(400).json({ code: 'CONTEXT_RETENTION_INVALID' });
    const tenantId = resolveTenant(req, query.data.tenantId);
    if (!tenantId) return res.status(403).json({ code: 'CONTEXT_ADMIN_TENANT_FORBIDDEN' });
    try {
      const receipt = await options.retention.retryAudit(tenantId, params.data.receiptId);
      return res.status(200).json({ receipt });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'CONTEXT_RETENTION_RECEIPT_NOT_FOUND') {
        return res.status(404).json({ code: message });
      }
      if (message === 'CONTEXT_RETENTION_AUDIT_IN_PROGRESS') {
        return res.status(409).json({ code: message });
      }
      return res.status(502).json({ code: 'CONTEXT_RETENTION_AUDIT_FAILED' });
    }
  });

  router.post('/retention/receipts/:receiptId/replay', async (req, res) => {
    if (!options.retention) return unavailable(res);
    const params = retentionReceiptParamsSchema.safeParse(req.params);
    const query = tenantQuerySchema.safeParse(req.query);
    if (!params.success || !query.success) return res.status(400).json({ code: 'CONTEXT_RETENTION_INVALID' });
    const tenantId = resolveTenant(req, query.data.tenantId);
    if (!tenantId) return res.status(403).json({ code: 'CONTEXT_ADMIN_TENANT_FORBIDDEN' });
    if (req.body?.expectedRevision === undefined) {
      return res.status(428).json({ code: 'CONTEXT_RETENTION_PRECONDITION_REQUIRED' });
    }
    const body = retentionReplayBodySchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ code: 'CONTEXT_RETENTION_INVALID' });
    try {
      const receipt = await options.retention.replayDeadLetterAudit(
        tenantId, params.data.receiptId, body.data.expectedRevision,
      );
      return res.status(200).json({ receipt });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'CONTEXT_RETENTION_RECEIPT_NOT_FOUND') return res.status(404).json({ code: message });
      if (message === 'CONTEXT_RETENTION_AUDIT_REPLAY_CONFLICT') return res.status(409).json({ code: message });
      return res.status(502).json({ code: 'CONTEXT_RETENTION_AUDIT_FAILED' });
    }
  });

  router.post('/entities/:entityId/corrections', async (req, res) => {
    const params = entityParamsSchema.safeParse(req.params);
    const query = tenantQuerySchema.safeParse(req.query);
    if (!params.success || !query.success) return res.status(400).json({ code: 'CONTEXT_PRODUCT_INVALID' });
    if (req.body?.expectedRevision === undefined) return res.status(428).json({ code: 'CONTEXT_PRODUCT_PRECONDITION_REQUIRED' });
    const body = correctionBodySchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ code: 'CONTEXT_PRODUCT_INVALID' });
    return productCall(req, res, options, query.data.tenantId,
      (product, subject) => product.correct(subject, params.data.entityId, body.data));
  });

  router.post('/reviews/:itemId/decision', async (req, res) => {
    const params = reviewParamsSchema.safeParse(req.params);
    const query = tenantQuerySchema.safeParse(req.query);
    if (!params.success || !query.success) return res.status(400).json({ code: 'CONTEXT_PRODUCT_INVALID' });
    if (req.body?.expectedRevision === undefined) return res.status(428).json({ code: 'CONTEXT_PRODUCT_PRECONDITION_REQUIRED' });
    const body = reviewDecisionBodySchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ code: 'CONTEXT_PRODUCT_INVALID' });
    const decision = body.data.decision === 'confirm' ? 'confirmed'
      : body.data.decision === 'reject' ? 'rejected' : body.data.decision;
    return productCall(req, res, options, query.data.tenantId,
      (product, subject) => product.decideReview(subject, params.data.itemId,
        { decision, expectedRevision: body.data.expectedRevision }));
  });

  return router;
}

async function productRead<T extends { tenantId?: string }>(
  req: Request,
  res: import('express').Response,
  options: ContextAdminRouterOptions,
  schema: z.ZodType<T>,
  run: (product: ContextProductService, subject: { tenantId: string; actorId: string }, query: Omit<T, 'tenantId'>) => Promise<unknown>,
) {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ code: 'CONTEXT_PRODUCT_INVALID' });
  const { tenantId: requested, ...query } = parsed.data;
  return productCall(req, res, options, requested,
    (product, subject) => run(product, subject, query as Omit<T, 'tenantId'>));
}

async function productCall(
  req: Request,
  res: import('express').Response,
  options: ContextAdminRouterOptions,
  requestedTenantId: string | undefined,
  run: (product: ContextProductService, subject: { tenantId: string; actorId: string }) => Promise<unknown>,
) {
  if (!options.product) return res.status(503).json({ code: 'CONTEXT_PRODUCT_UNAVAILABLE' });
  const tenantId = resolveTenant(req, requestedTenantId);
  if (!tenantId || !req.user?.sub) return res.status(403).json({ code: 'CONTEXT_PRODUCT_FORBIDDEN' });
  try {
    return res.json(await run(options.product, { tenantId, actorId: req.user.sub }));
  } catch (error) {
    if (!(error instanceof ContextProductError)) {
      return res.status(503).json({ code: 'CONTEXT_PRODUCT_UNAVAILABLE' });
    }
    const status = error.code === 'CONTEXT_PRODUCT_INVALID' || error.code === 'CONTEXT_PRODUCT_CURSOR_INVALID'
      || error.code === 'CONTEXT_PRODUCT_EVIDENCE_INVALID' ? 400
      : error.code === 'CONTEXT_PRODUCT_FORBIDDEN' ? 403
        : error.code === 'CONTEXT_PRODUCT_NOT_FOUND' ? 404
          : error.code === 'CONTEXT_PRODUCT_CONFLICT' ? 409
            : error.code === 'CONTEXT_PRODUCT_PRECONDITION_REQUIRED' ? 428 : 503;
    return res.status(status).json({ code: error.code });
  }
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
    status: sourceStatus(source?.status, source?.kind, collection.status, partitions, now),
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
      retrying: partitions.filter(partition => partition.status === 'retry_wait').length,
      lastErrorCodes: [...new Set(partitions
        .filter(partition => partition.status === 'retry_wait')
        .map(partition => nonEmpty(partition.lastErrorCode))
        .filter((value): value is string => Boolean(value)))].sort(),
      nextRetryAt: earliestIso(partitions.map(partition => partition.nextRetryAt)),
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

function sourceStatus(
  sourceStatusValue: string | undefined,
  sourceKind: string | undefined,
  collectionStatus: string,
  partitions: ContextAdminPartition[],
  now: Date,
): 'healthy' | 'syncing' | 'attention' | 'paused' {
  if (sourceStatusValue !== 'active' || collectionStatus !== 'active') return 'paused';
  if (partitions.some(partition => partition.status === 'retry_wait'
    || partition.status === 'refused' || partition.refused)) return 'attention';
  if (partitions.some(partition => partition.status === 'syncing')) return 'syncing';
  if (partitions.length > 0 && partitions.every(partition => partition.status === 'complete')) {
    const threshold = staleAfterMs(sourceKind);
    if (!partitions.every(partition => {
      const heartbeat = validIso(partition.updatedAt);
      return heartbeat && now.getTime() - Date.parse(heartbeat) <= threshold;
    })) return 'attention';
    return 'healthy';
  }
  return 'attention';
}

function staleAfterMs(sourceKind: string | undefined): number {
  if (sourceKind === 'taskboard' || sourceKind === 'directory') return 5 * 60_000;
  if (sourceKind === 'azeroth') return 3 * 60 * 60_000;
  if (sourceKind === 'dws') return 2 * 60 * 60_000;
  return 24 * 60 * 60_000;
}

function watermarkLag(partitions: ContextAdminPartition[], now: Date): number | null {
  const oldest = earliestIso(partitions.map(partition =>
    watermarkTimestamp(partition.watermark) ?? validIso(partition.updatedAt)));
  if (!oldest) return null;
  return Math.max(0, Math.floor((now.getTime() - Date.parse(oldest)) / 1_000));
}

function watermarkTimestamp(value: unknown): string | undefined {
  if (typeof value === 'string') return validIso(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const fields = value as Record<string, unknown>;
    for (const key of ['value', 'inventoryObservedAt', 'completedAt', 'observedAt', 'through']) {
      if (typeof fields[key] === 'string') {
        const timestamp = validIso(fields[key]);
        if (timestamp) return timestamp;
      }
    }
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
