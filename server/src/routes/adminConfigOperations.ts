import { Router } from 'express';

import { requirePlatformAdmin } from '../auth/middleware.js';
import type { AdminConfigMutationService } from '../config/adminConfigMutationService.js';

export function createAdminConfigOperationsRouter(service: AdminConfigMutationService): Router {
  const router = Router();
  router.use(requirePlatformAdmin);
  router.get('/:operationId', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const actor = req.user?.username ?? req.user?.sub ?? 'platform-admin';
    try {
      const operation = service.getProductionOperationStatus(req.params.operationId, actor);
      if (!operation) {
        res.status(404).json({ operationId: req.params.operationId, state: 'unknown' });
        return;
      }
      res.json(operation);
    } catch {
      res.status(400).json({ error: 'operationId 无效' });
    }
  });
  return router;
}
