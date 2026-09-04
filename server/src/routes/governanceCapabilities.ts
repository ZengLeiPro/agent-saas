import { Router } from 'express';

import { GOVERNANCE_CAPABILITIES } from '../../../shared/src/types/governanceCapability.js';

export function createGovernanceCapabilitiesRouter(): Router {
  const router = Router();
  router.get('/', (_req, res) => res.json({ capabilities: GOVERNANCE_CAPABILITIES }));
  return router;
}
