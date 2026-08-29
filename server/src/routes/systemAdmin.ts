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
      res.json({
        schemaVersion: 1,
        available: true,
        generatedAt: generatedAt.toISOString(),
        retention: serializeRetentionStatus(
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

type RetentionBase = { enabled: boolean; mode: 'dry-run' | 'execute' };

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
    ...base,
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

function serializeRetentionStatus(
  base: RetentionBase,
  metric: SystemMetricRecord | null,
  now: Date,
  staleAfterMs: number,
) {
  if (!metric) return neverRunRetention(base);
  const detail = metric.detailJson;
  if (!detail || detail.schemaVersion !== 1) return unavailableRetention(base);
  const sampledMs = Date.parse(metric.sampledAt);
  const stale = !Number.isFinite(sampledMs) || now.getTime() - sampledMs > staleAfterMs;
  const persistedState = typeof detail.state === 'string' ? detail.state : 'unavailable';
  const allowed = new Set([
    'never_run', 'running', 'dry_run_succeeded', 'execute_succeeded', 'blocked', 'failed',
  ]);
  const status = stale ? 'stale' : (allowed.has(persistedState) ? persistedState : 'unavailable');
  const persistedWatermarks = isObject(detail.watermarks) ? detail.watermarks : {};
  const billing = nullableString(persistedWatermarks.billing);
  const effective = nullableString(persistedWatermarks.effectiveDeleteThrough);
  const maxGlobalSequence = nullableString(detail.maxGlobalSequence);
  return {
    enabled: base.enabled,
    mode: detail.mode === 'execute' || detail.mode === 'dry-run' ? detail.mode : base.mode,
    status,
    stale,
    lastStartedAt: nullableString(detail.lastStartedAt),
    lastCompletedAt: nullableString(detail.lastCompletedAt),
    lastSuccessAt: nullableString(detail.lastSuccessAt),
    durationMs: nullableNumber(detail.durationMs),
    errorCategory: nullableString(detail.errorCategory),
    nextScheduledAt: nullableString(detail.nextScheduledAt),
    watermarks: {
      legal: nullableString(persistedWatermarks.legal),
      billing,
      effective,
      maxGlobalSequence,
      lag: bigintLag(maxGlobalSequence, effective),
    },
    categories: serializeCategories(detail.categories),
  };
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
  const detail = latest.detailJson;
  const sampledMs = Date.parse(latest.sampledAt);
  return {
    available: true,
    tableName,
    totalBytes: nullableNumber(detail?.totalBytes) ?? latest.valueNum,
    tableBytes: nullableNumber(detail?.tableBytes),
    indexBytes: nullableNumber(detail?.indexBytes),
    sampledAt: latest.sampledAt,
    stale: !Number.isFinite(sampledMs) || now.getTime() - sampledMs > 30 * 60_000,
    series: series.map((metric) => ({
      sampledAt: metric.sampledAt,
      totalBytes: nullableNumber(metric.detailJson?.totalBytes) ?? metric.valueNum,
      tableBytes: nullableNumber(metric.detailJson?.tableBytes),
      indexBytes: nullableNumber(metric.detailJson?.indexBytes),
    })).sort((a, b) => Date.parse(a.sampledAt) - Date.parse(b.sampledAt)),
  };
}

function serializeCategories(value: unknown): Record<string, { eligible: number | null; deleted: number | null }> {
  if (!isObject(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, category]) => {
    const item = isObject(category) ? category : {};
    return [key, {
      eligible: nullableNumber(item.eligible),
      deleted: nullableNumber(item.deleted),
    }];
  }));
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
