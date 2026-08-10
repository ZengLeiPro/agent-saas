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
import type { PgSystemMetricsStore, WorkspaceUsageRecord } from '../runtime/systemMetricsStore.js';
import { archiveWorkspace, deleteWorkspace, isWorkspaceScanFresh } from '../runtime/workspaceArchive.js';

export interface SystemAdminRouterOptions {
  agentCwd: string;
  systemMetricsStore?: PgSystemMetricsStore;
  systemMetricsCollector?: SystemMetricsCollector;
  alertNotifier?: AlertNotifier;
  userStore?: UserStore;
  governanceAuditStore?: GovernanceAuditStore;
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
