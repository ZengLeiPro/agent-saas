import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { isPlatformAdmin } from '../auth/types.js';
import { auditLog } from '../data/login-logs/index.js';
import type { AlertNotifier } from '../runtime/alertNotifier.js';
import type { SystemMetricsCollector } from '../runtime/systemMetricsCollector.js';
import { WorkspaceScanAlreadyRunningError } from '../runtime/systemMetricsCollector.js';
import type { PgSystemMetricsStore } from '../runtime/systemMetricsStore.js';
import { archiveWorkspace, isWorkspaceScanFresh } from '../runtime/workspaceArchive.js';

export interface SystemAdminRouterOptions {
  agentCwd: string;
  systemMetricsStore?: PgSystemMetricsStore;
  systemMetricsCollector?: SystemMetricsCollector;
  alertNotifier?: AlertNotifier;
}

const metricsQuerySchema = z.object({
  hours: z.coerce.number().int().min(1).max(720).optional(),
});

const archiveBodySchema = z.object({
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
      res.json({
        available: true,
        summary,
        workspaces,
        orphans: workspaces.filter((workspace) => workspace.status !== 'active'),
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
