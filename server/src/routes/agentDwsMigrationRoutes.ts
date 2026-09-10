import type { Response, Router } from 'express';
import { z } from 'zod';

import { isPlatformAdmin } from '../auth/middleware.js';
import type { DwsReceiverMigrationService } from '../dws/durableReceiverMigration.js';

const tenantSchema = z.object({ tenantId: z.string().trim().min(1).max(64) }).strict();
const activationSchema = tenantSchema
  .extend({ expectedRevision: z.number().int().positive() })
  .strict();
export type DwsReceiverMigrationRouteService = DwsReceiverMigrationService;

export function registerAgentDwsMigrationRoutes(
  router: Router,
  service?: DwsReceiverMigrationService,
): void {
  router.get('/agent-dws-accounts/:accountId/durable-receiver-migration', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!isPlatformAdmin(req.user))
      return res.status(403).json({ error: '仅平台管理员可执行接收器迁移' });
    if (!service) return res.status(503).json({ error: '持久接收器迁移服务暂不可用' });
    const parsed = tenantSchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    try {
      const migration = await service.status(parsed.data.tenantId, req.params.accountId);
      return migration
        ? res.json({ migration })
        : res.status(404).json({ error: '迁移记录不存在' });
    } catch (error) {
      return migrationError(res, error);
    }
  });

  router.post(
    '/agent-dws-accounts/:accountId/durable-receiver-migration/activate',
    async (req, res) => {
      if (!req.user) return res.status(401).json({ error: 'Authentication required' });
      if (!isPlatformAdmin(req.user))
        return res.status(403).json({ error: '仅平台管理员可执行接收器迁移' });
      if (!service) return res.status(503).json({ error: '持久接收器迁移服务暂不可用' });
      const parsed = activationSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      try {
        const migration = await service.activate(
          parsed.data.tenantId,
          req.params.accountId,
          parsed.data.expectedRevision,
          req.user.username,
        );
        return res.status(200).json({ migration });
      } catch (error) {
        return migrationError(res, error);
      }
    },
  );

  for (const action of ['reconcile', 'abort', 'rollback-check'] as const) {
    router.post(
      `/agent-dws-accounts/:accountId/durable-receiver-migration/${action}`,
      async (req, res) => {
        if (!req.user) return res.status(401).json({ error: 'Authentication required' });
        if (!isPlatformAdmin(req.user))
          return res.status(403).json({ error: '仅平台管理员可执行接收器迁移' });
        if (!service) return res.status(503).json({ error: '持久接收器迁移服务暂不可用' });
        const parsed = tenantSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
        try {
          if (action === 'rollback-check') {
            await service.assertRollbackAllowed(parsed.data.tenantId, req.params.accountId);
            return res.json({ allowed: true });
          }
          const migration =
            action === 'reconcile'
              ? await service.reconcile(parsed.data.tenantId, req.params.accountId)
              : await service.abort(parsed.data.tenantId, req.params.accountId, req.user.username);
          return res.json({ migration });
        } catch (error) {
          return migrationError(res, error);
        }
      },
    );
  }
}

function migrationError(res: Response, error: unknown): Response {
  const code = error instanceof Error ? error.message : 'migration_failed';
  const status = code.includes('not_found')
    ? 404
    : code.includes('revision_conflict') ||
        code.includes('already_active') ||
        code.includes('required') ||
        code.includes('unsafe') ||
        code.includes('blocked') ||
        code.includes('floor')
      ? 409
      : 503;
  return res.status(status).json({ error: code });
}
