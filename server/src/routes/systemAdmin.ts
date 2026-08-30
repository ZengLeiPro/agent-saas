import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { isPlatformAdmin } from '../auth/types.js';
import { auditLog } from '../data/login-logs/index.js';
import {
  GovernanceAuditUnavailableError,
  governanceDigest,
  recordGovernanceIntent,
  recordGovernanceOutcome,
  type GovernanceAuditStore,
} from '../data/governance-audit/index.js';
import type { UserStore } from '../data/users/store.js';
import type { AlertNotifier } from '../runtime/alertNotifier.js';
import type { RuntimeAdmissionSnapshot } from '../runtime/memoryPressureGuard.js';
import type { SystemMetricsCollector } from '../runtime/systemMetricsCollector.js';
import { WorkspaceScanAlreadyRunningError } from '../runtime/systemMetricsCollector.js';
import type {
  PgSystemMetricsStore,
  SystemMetricRecord,
  WorkspaceUsageRecord,
} from '../runtime/systemMetricsStore.js';
import { archiveWorkspace, deleteWorkspace, isWorkspaceScanFresh } from '../runtime/workspaceArchive.js';

export interface SystemAdminRouterOptions {
  agentCwd: string;
  systemMetricsStore?: PgSystemMetricsStore;
  systemMetricsCollector?: SystemMetricsCollector;
  alertNotifier?: AlertNotifier;
  userStore?: UserStore;
  governanceAuditStore?: GovernanceAuditStore;
  runtimeEventRetention?: {
    enabled?: boolean;
    executionMode?: 'dry-run' | 'execute';
    sweepIntervalMinutes?: number;
  };
  getRuntimeWorkerAdmissionSnapshot?: () => RuntimeAdmissionSnapshot | undefined;
  eventsTable?: string;
}

type WorkspaceUsageResponseRecord = WorkspaceUsageRecord & {
  username: string | null;
  realName: string | null;
};

const metricsQuerySchema = z.object({
  hours: z.coerce.number().int().min(1).max(720).optional(),
});

const archiveBodySchema = z.object({
  path: z.string().min(1).max(1000),
  confirm: z.string().min(1).max(255),
});

const deleteWorkspaceBodySchema = z.object({
  path: z.string().min(1).max(1000),
  confirm: z.string().min(1).max(255),
});

export function createSystemAdminRouter(options: SystemAdminRouterOptions): Router {
  const router = Router();

  router.use((req, res, next) => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!isPlatformAdmin(req.user)) {
      res.status(403).json({ error: 'Platform admin access required' });
      return;
    }
    next();
  });

  router.get('/metrics', async (req, res) => {
    const parsed = metricsQuerySchema.safeParse(req.query);
    if (!parsed.success) return invalidQuery(res, parsed.error);
    const store = options.systemMetricsStore;
    if (!store) {
      res.json({ available: false, latest: [], series: [], generatedAt: new Date().toISOString() });
      return;
    }
    try {
      const [latest, series] = await Promise.all([
        store.listLatestMetrics(),
        parsed.data.hours ? store.listMetricsSince(parsed.data.hours) : Promise.resolve([]),
      ]);
      res.json({ available: true, latest, series, generatedAt: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: `System metrics query failed: ${errorMessage(err)}` });
    }
  });

  router.get('/event-store', async (req, res) => {
    const parsed = metricsQuerySchema.safeParse(req.query);
    if (!parsed.success) return invalidQuery(res, parsed.error);
    const generatedAt = new Date();
    const store = options.systemMetricsStore;
    const retentionConfig = options.runtimeEventRetention;
    const retentionBase = {
      enabled: retentionConfig?.enabled === true,
      mode: retentionConfig?.executionMode ?? 'dry-run' as const,
      sweepIntervalMinutes: retentionConfig?.sweepIntervalMinutes ?? 10,
    };
    if (!store) {
      res.json({
        schemaVersion: 1,
        available: false,
        generatedAt: generatedAt.toISOString(),
        retention: unavailableRetention(retentionBase),
        capacity: unavailableCapacity(options.eventsTable),
      });
      return;
    }
    try {
      const hours = parsed.data.hours ?? 24;
      const [retentionMetric, capacityMetric, capacitySeries] = await Promise.all([
        store.getLatestMetric('runtime_event_retention', 'status'),
        options.eventsTable ? store.getLatestMetric('pg_table_size', options.eventsTable) : Promise.resolve(null),
        options.eventsTable
          ? store.listMetricSeries('pg_table_size', options.eventsTable, hours)
          : Promise.resolve([]),
      ]);
      const runtimeWorkerReady = options.getRuntimeWorkerAdmissionSnapshot?.()?.admitting !== false;
      res.json({
        schemaVersion: 1,
        available: true,
        generatedAt: generatedAt.toISOString(),
        retention: !runtimeWorkerReady || store.isRuntimeEventRetentionStatusAvailable?.() === false
          ? unavailableRetention(retentionBase)
          : serializeRetentionStatus(
              retentionBase,
              retentionMetric,
              generatedAt,
              Math.max((retentionConfig?.sweepIntervalMinutes ?? 10) * 2 * 60_000, 30 * 60_000),
            ),
        capacity: serializeCapacity(
          options.eventsTable,
          capacityMetric,
          capacitySeries,
          generatedAt,
        ),
      });
    } catch {
      res.status(500).json({ error: 'Event store diagnostics query failed' });
    }
  });

  router.get('/storage', async (_req, res) => {
    const store = options.systemMetricsStore;
    if (!store) {
      res.json({
        available: false,
        summary: { totalBytes: 0, orphanBytes: 0, orphanCount: 0, byTenant: [], lastScanAt: null },
        workspaces: [],
        orphans: [],
        generatedAt: new Date().toISOString(),
      });
      return;
    }
    try {
      const [summary, workspaces] = await Promise.all([
        store.getWorkspaceStorageSummary(),
        store.listWorkspaceUsage(),
      ]);
      const enrichedWorkspaces = enrichWorkspaceUsage(workspaces, options.userStore);
      res.json({
        available: true,
        summary,
        workspaces: enrichedWorkspaces,
        orphans: enrichedWorkspaces.filter((workspace) => workspace.status !== 'active'),
        generatedAt: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({ error: `Storage query failed: ${errorMessage(err)}` });
    }
  });

  router.post('/storage/scan', async (_req, res) => {
    if (!options.systemMetricsCollector) {
      res.status(503).json({ error: 'System metrics collector is not configured' });
      return;
    }
    try {
      const result = await options.systemMetricsCollector.scanWorkspacesOnce();
      res.json({ ok: true, result });
    } catch (err) {
      if (err instanceof WorkspaceScanAlreadyRunningError) {
        res.status(409).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: `Workspace scan failed: ${errorMessage(err)}` });
    }
  });

  router.post('/storage/archive', async (req, res) => {
    const parsed = archiveBodySchema.safeParse(req.body);
    if (!parsed.success) return invalidBody(res, parsed.error);
    const store = options.systemMetricsStore;
    if (!store) {
      res.status(503).json({ error: 'System metrics store is not configured' });
      return;
    }
    try {
      const usage = await store.getWorkspaceUsage(parsed.data.path);
      if (!usage) {
        res.status(404).json({ error: 'Workspace usage record not found; run a scan first' });
        return;
      }
      if (!isWorkspaceScanFresh(usage.scannedAt)) {
        res.status(409).json({ error: 'Workspace scan is stale; run a scan before archiving' });
        return;
      }
      const result = await archiveWorkspace({
        agentCwd: options.agentCwd,
        path: parsed.data.path,
        confirm: parsed.data.confirm,
        usage,
      });
      await store.deleteWorkspaceUsage(parsed.data.path);
      auditLog(req, 'workspace_archived', `${parsed.data.path} -> ${result.relativeArchivePath}`);
      res.json({ ok: true, result });
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
    }
  });

  router.post('/storage/delete', async (req, res) => {
    const parsed = deleteWorkspaceBodySchema.safeParse(req.body);
    if (!parsed.success) return invalidBody(res, parsed.error);
    const store = options.systemMetricsStore;
    if (!store) {
      res.status(503).json({ error: 'System metrics store is not configured' });
      return;
    }
    let usage: WorkspaceUsageRecord;
    try {
      const found = await store.getWorkspaceUsage(parsed.data.path);
      if (!found) {
        res.status(404).json({ error: 'Workspace usage record not found; run a scan first' });
        return;
      }
      if (!isWorkspaceScanFresh(found.scannedAt)) {
        res.status(409).json({ error: 'Workspace scan is stale; run a scan before deleting' });
        return;
      }
      usage = found;
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
      return;
    }

    let intent;
    try {
      intent = await recordGovernanceIntent(options.governanceAuditStore, req.user!, {
        action: 'workspace.delete',
        targetType: 'workspace',
        targetId: parsed.data.path,
        targetTenantId: usage.tenantId,
        purpose: 'storage_governance',
        reason: 'confirmed_hard_delete',
        beforeDigest: governanceDigest({ path: parsed.data.path, bytes: usage.bytes, scannedAt: usage.scannedAt }),
      });
    } catch (err) {
      if (err instanceof GovernanceAuditUnavailableError) {
        res.status(503).json({ code: err.code, error: err.message });
        return;
      }
      throw err;
    }

    let result;
    try {
      result = await deleteWorkspace({
        agentCwd: options.agentCwd,
        path: parsed.data.path,
        confirm: parsed.data.confirm,
        usage,
      });
      await store.deleteWorkspaceUsage(parsed.data.path);
    } catch (err) {
      await recordGovernanceOutcome(options.governanceAuditStore!, intent, 'failed', {
        metadata: { errorCode: 'WORKSPACE_DELETE_FAILED' },
      }).catch(() => undefined);
      res.status(400).json({ error: errorMessage(err) });
      return;
    }

    let outcome;
    try {
      outcome = await recordGovernanceOutcome(options.governanceAuditStore!, intent, 'succeeded', {
        afterDigest: governanceDigest({ deleted: true, bytes: result.bytes }),
        metadata: { bytesDeleted: result.bytes },
      });
    } catch (err) {
      res.status(500).json({
        code: 'GOVERNANCE_AUDIT_OUTCOME_FAILED',
        error: '工作区已删除，但治理审计结果写入失败，请立即人工核对',
        changed: true,
        intentAuditId: intent.auditId,
      });
      return;
    }
    auditLog(req, 'workspace_deleted', `${parsed.data.path} (${result.bytes} bytes)`);
    res.json({ ok: true, result, auditId: outcome.auditId });
  });

  router.get('/alerts/status', async (_req, res) => {
    if (!options.alertNotifier) {
      res.json({
        configured: false,
        webhookConfigured: false,
        webhookMasked: null,
        minSeverity: 'high',
        lastNotifiedAt: null,
        notifyCount: 0,
      });
      return;
    }
    try {
      res.json(await options.alertNotifier.getStatus());
    } catch (err) {
      res.status(500).json({ error: `Alert status query failed: ${errorMessage(err)}` });
    }
  });

  router.post('/alerts/test', async (_req, res) => {
    if (!options.alertNotifier) {
      res.status(503).json({ error: 'Alert notifier is not configured' });
      return;
    }
    try {
      await options.alertNotifier.sendTestAlert();
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
    }
  });

  return router;
}

type RetentionBase = {
  enabled: boolean;
  mode: 'dry-run' | 'execute';
  sweepIntervalMinutes: number;
};

function emptyWatermarks() {
  return {
    legal: null,
    billing: null,
    effective: null,
    maxGlobalSequence: null,
    lag: null,
  };
}

function unavailableRetention(base: RetentionBase) {
  return {
    enabled: base.enabled,
    mode: base.mode,
    status: 'unavailable' as const,
    stale: false,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastSuccessAt: null,
    durationMs: null,
    errorCategory: null,
    nextScheduledAt: null,
    watermarks: emptyWatermarks(),
    categories: {},
  };
}

function neverRunRetention(base: RetentionBase) {
  return {
    ...unavailableRetention(base),
    status: 'never_run' as const,
  };
}

const persistedRetentionStates = new Set([
  'never_run',
  'scheduled',
  'running',
  'dry_run_succeeded',
  'execute_succeeded',
  'blocked',
  'failed',
]);
const retentionCategoryNames = [
  'tool-delta',
  'assistant-stream',
  'tool-stream-summary',
  'model-diagnostics',
  'model-request-finished',
  'hand-events',
] as const;
const retentionCategoryNameSet = new Set<string>(retentionCategoryNames);
const retentionErrorCategorySet = new Set([
  'authorization_missing',
  'legal_watermark_invalid',
  'status_persistence_unavailable',
  'partial_failure',
  'execution_failed',
]);

function serializeRetentionStatus(
  base: RetentionBase,
  metric: SystemMetricRecord | null,
  now: Date,
  staleAfterMs: number,
) {
  if (!metric) return neverRunRetention(base);
  const detail = metric.detailJson;
  if (!detail || detail.schemaVersion !== 1) return unavailableRetention(base);
  const persistedState = typeof detail.state === 'string' ? detail.state : '';
  if (!persistedRetentionStates.has(persistedState)) return unavailableRetention(base);
  if (!isIsoTimestamp(metric.sampledAt)) return unavailableRetention(base);
  const sampledMs = Date.parse(metric.sampledAt);
  if (sampledMs > now.getTime() + 5 * 60_000) return unavailableRetention(base);
  const persistedWatermarks = isObject(detail.watermarks) ? detail.watermarks : null;
  const categories = parseRetentionCategories(detail.categories);
  if (
    detail.mode !== base.mode
    || detail.sweepIntervalMinutes !== base.sweepIntervalMinutes
    || !persistedWatermarks
    || !isNullableIsoTimestamp(detail.lastStartedAt)
    || !isNullableIsoTimestamp(detail.lastCompletedAt)
    || !isNullableIsoTimestamp(detail.lastSuccessAt)
    || !retentionRunTimestampsNotFuture(detail, sampledMs)
    || !isNullableNonnegativeNumber(detail.durationMs)
    || !isNullableRetentionErrorCategory(detail.errorCategory)
    || !isNullableIsoTimestamp(detail.nextScheduledAt)
    || !isDigitString(persistedWatermarks.legal)
    || !isNullableDigitString(persistedWatermarks.billing)
    || !isNullableDigitString(persistedWatermarks.effectiveDeleteThrough)
    || !isNullableDigitString(detail.maxGlobalSequence)
    || !categories
  ) return unavailableRetention(base);
  const snapshot = {
    state: persistedState,
    mode: base.mode,
    enabled: base.enabled,
    lastStartedAt: detail.lastStartedAt,
    lastCompletedAt: detail.lastCompletedAt,
    lastSuccessAt: detail.lastSuccessAt,
    durationMs: detail.durationMs,
    errorCategory: detail.errorCategory,
    nextScheduledAt: detail.nextScheduledAt,
    legal: persistedWatermarks.legal,
    billing: persistedWatermarks.billing,
    effective: persistedWatermarks.effectiveDeleteThrough,
    maxGlobalSequence: detail.maxGlobalSequence,
    categories,
  };
  if (!isRetentionStateSemanticallyValid(snapshot)) return unavailableRetention(base);
  const stale = now.getTime() - sampledMs > staleAfterMs;
  return {
    enabled: base.enabled,
    mode: base.mode,
    status: persistedState,
    stale,
    lastStartedAt: snapshot.lastStartedAt,
    lastCompletedAt: snapshot.lastCompletedAt,
    lastSuccessAt: snapshot.lastSuccessAt,
    durationMs: snapshot.durationMs,
    errorCategory: snapshot.errorCategory,
    nextScheduledAt: snapshot.nextScheduledAt,
    watermarks: {
      legal: persistedWatermarks.legal,
      billing: snapshot.billing,
      effective: snapshot.effective,
      maxGlobalSequence: snapshot.maxGlobalSequence,
      lag: bigintLag(snapshot.maxGlobalSequence, snapshot.effective),
    },
    categories,
  };
}

function retentionRunTimestampsNotFuture(
  detail: Record<string, unknown>,
  sampledMs: number,
): boolean {
  return [detail.lastStartedAt, detail.lastCompletedAt, detail.lastSuccessAt]
    .every((value) => value === null || (isIsoTimestamp(value) && Date.parse(value) <= sampledMs + 5 * 60_000));
}

function isRetentionStateSemanticallyValid(snapshot: {
  state: string;
  mode: 'dry-run' | 'execute';
  enabled: boolean;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastSuccessAt: string | null;
  durationMs: number | null;
  errorCategory: string | null;
  nextScheduledAt: string | null;
  legal: string;
  billing: string | null;
  effective: string | null;
  maxGlobalSequence: string | null;
  categories: Record<string, { eligible: number; deleted: number }>;
}): boolean {
  const runCompleted = snapshot.lastStartedAt !== null
    && snapshot.lastCompletedAt !== null
    && snapshot.durationMs !== null
    && Date.parse(snapshot.lastCompletedAt) >= Date.parse(snapshot.lastStartedAt);
  const scheduledWhenEnabled = !snapshot.enabled || snapshot.nextScheduledAt !== null;
  const hasNoProgress = snapshot.billing === null && snapshot.effective === null
    && snapshot.maxGlobalSequence === null && Object.keys(snapshot.categories).length === 0;
  if (snapshot.state === 'scheduled') {
    return snapshot.enabled && snapshot.nextScheduledAt !== null
      && snapshot.lastStartedAt === null && snapshot.lastCompletedAt === null
      && snapshot.durationMs === null && snapshot.errorCategory === null && hasNoProgress;
  }
  if (snapshot.state === 'never_run') {
    return snapshot.lastStartedAt === null && snapshot.lastCompletedAt === null
      && snapshot.durationMs === null && snapshot.errorCategory === null && hasNoProgress;
  }
  if (snapshot.state === 'running') {
    return snapshot.lastStartedAt !== null && snapshot.lastCompletedAt === null
      && snapshot.durationMs === null && snapshot.errorCategory === null && hasNoProgress;
  }
  if (snapshot.state === 'dry_run_succeeded' || snapshot.state === 'execute_succeeded') {
    const completeCategories = retentionCategoryNames.every((name) => snapshot.categories[name] !== undefined)
      && Object.keys(snapshot.categories).length === retentionCategoryNames.length;
    const dryRunDeletedNothing = snapshot.state !== 'dry_run_succeeded'
      || Object.values(snapshot.categories).every((category) => category.deleted === 0);
    return runCompleted && snapshot.lastSuccessAt !== null
      && Date.parse(snapshot.lastSuccessAt) >= Date.parse(snapshot.lastStartedAt!)
      && snapshot.errorCategory === null && scheduledWhenEnabled
      && hasConsistentRetentionWatermarks(snapshot)
      && completeCategories && dryRunDeletedNothing
      && (snapshot.state === 'dry_run_succeeded') === (snapshot.mode === 'dry-run');
  }
  return runCompleted && scheduledWhenEnabled
    && typeof snapshot.errorCategory === 'string' && snapshot.errorCategory.trim().length > 0;
}

function hasConsistentRetentionWatermarks(snapshot: {
  legal: string;
  billing: string | null;
  effective: string | null;
  maxGlobalSequence: string | null;
}): boolean {
  if (snapshot.billing === null || snapshot.effective === null || snapshot.maxGlobalSequence === null) {
    return false;
  }
  const legal = BigInt(snapshot.legal);
  const billing = BigInt(snapshot.billing);
  const effective = BigInt(snapshot.effective);
  const maxGlobalSequence = BigInt(snapshot.maxGlobalSequence);
  return effective === (legal < billing ? legal : billing) && maxGlobalSequence >= billing;
}

function unavailableCapacity(tableName?: string) {
  return {
    available: false,
    tableName: tableName ?? null,
    totalBytes: null,
    tableBytes: null,
    indexBytes: null,
    sampledAt: null,
    stale: false,
    series: [],
  };
}

function serializeCapacity(
  tableName: string | undefined,
  latest: SystemMetricRecord | null,
  series: SystemMetricRecord[],
  now: Date,
) {
  if (!tableName || !latest) return unavailableCapacity(tableName);
  const capacity = capacityValues(latest);
  if (!capacity || !isIsoTimestamp(latest.sampledAt)) return unavailableCapacity(tableName);
  const sampledMs = Date.parse(latest.sampledAt);
  const latestAllowedMs = now.getTime() + 5 * 60_000;
  if (sampledMs > latestAllowedMs) return unavailableCapacity(tableName);
  return {
    available: true,
    tableName,
    ...capacity,
    sampledAt: latest.sampledAt,
    stale: !Number.isFinite(sampledMs) || now.getTime() - sampledMs > 30 * 60_000,
    series: series.flatMap((metric) => {
      const values = capacityValues(metric);
      return values && isIsoTimestamp(metric.sampledAt) && Date.parse(metric.sampledAt) <= latestAllowedMs
        ? [{ sampledAt: metric.sampledAt, ...values }]
        : [];
    }).sort((a, b) => Date.parse(a.sampledAt) - Date.parse(b.sampledAt)),
  };
}

function capacityValues(metric: SystemMetricRecord): {
  totalBytes: number;
  tableBytes: number;
  indexBytes: number;
} | null {
  const totalBytes = nonnegativeNumber(metric.detailJson?.totalBytes);
  const tableBytes = nonnegativeNumber(metric.detailJson?.tableBytes);
  const indexBytes = nonnegativeNumber(metric.detailJson?.indexBytes);
  if (totalBytes === null || tableBytes === null || indexBytes === null) return null;
  if (totalBytes < tableBytes + indexBytes) return null;
  return { totalBytes, tableBytes, indexBytes };
}

function parseRetentionCategories(
  value: unknown,
): Record<string, { eligible: number; deleted: number }> | null {
  if (!isObject(value)) return null;
  const categories: Record<string, { eligible: number; deleted: number }> = {};
  for (const [key, category] of Object.entries(value)) {
    if (!retentionCategoryNameSet.has(key) || !isObject(category)) return null;
    const eligible = nonnegativeInteger(category.eligible);
    const deleted = nonnegativeInteger(category.deleted);
    if (eligible === null || deleted === null || deleted > eligible) return null;
    categories[key] = { eligible, deleted };
  }
  return categories;
}

function bigintLag(maxGlobalSequence: string | null, effective: string | null): string | null {
  if (!maxGlobalSequence || !effective || !/^\d+$/.test(maxGlobalSequence) || !/^\d+$/.test(effective)) return null;
  const lag = BigInt(maxGlobalSequence) - BigInt(effective);
  return (lag > 0n ? lag : 0n).toString();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isNullableRetentionErrorCategory(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && retentionErrorCategorySet.has(value));
}

function isDigitString(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value);
}

function isNullableDigitString(value: unknown): value is string | null {
  return value === null || isDigitString(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isNullableIsoTimestamp(value: unknown): value is string | null {
  return value === null || isIsoTimestamp(value);
}

function isNullableNonnegativeNumber(value: unknown): value is number | null {
  return value === null || nonnegativeNumber(value) !== null;
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function nonnegativeNumber(value: unknown): number | null {
  const number = nullableNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function invalidQuery(res: Response, error: z.ZodError): void {
  res.status(400).json({ error: error.issues.map((issue) => issue.message).join('; ') });
}

function invalidBody(res: Response, error: z.ZodError): void {
  res.status(400).json({ error: error.issues.map((issue) => issue.message).join('; ') });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function enrichWorkspaceUsage(
  workspaces: WorkspaceUsageRecord[],
  userStore?: UserStore,
): WorkspaceUsageResponseRecord[] {
  const usersByTenantAndId = new Map(
    (userStore?.listAll() ?? []).map((user) => [`${user.tenantId}:${user.id}`, user]),
  );
  return workspaces.map((workspace) => {
    const user = workspace.userId
      ? usersByTenantAndId.get(`${workspace.tenantId}:${workspace.userId}`) ?? null
      : null;
    return {
      ...workspace,
      username: user?.username ?? null,
      realName: user?.realName ?? null,
    };
  });
}
