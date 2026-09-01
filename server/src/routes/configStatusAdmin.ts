import { Router } from 'express';

import type { EffectiveConfigStatus } from '../config/effectiveConfigStatus.js';
import { requirePlatformAdmin } from '../auth/middleware.js';

export function createConfigStatusAdminRouter(options: {
  getStatus: () => EffectiveConfigStatus | Promise<EffectiveConfigStatus>;
}): Router {
  const router = Router();
  router.use(requirePlatformAdmin);
  router.get('/', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      res.json(await options.getStatus());
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  return router;
}
