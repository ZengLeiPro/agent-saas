import { Router } from 'express';

import type { EffectiveConfigStatus } from '../config/effectiveConfigStatus.js';
import { requirePlatformAdmin } from '../auth/middleware.js';

export function createConfigStatusAdminRouter(options: {
  getStatus: () => EffectiveConfigStatus;
}): Router {
  const router = Router();
  router.use(requirePlatformAdmin);
  router.get('/', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(options.getStatus());
  });
  return router;
}
