import type { Request, Router } from 'express';

import { environmentTemplateSchema, expectedRevisionSchema, providerSchema } from './governanceResourceSchemas.js';

type Persona = 'platform_admin' | 'org_admin' | 'member';

export function registerGovernanceEnvironmentRoutes(options: {
  router: Router;
  personaFor: (req: Request) => Persona | undefined;
}): void {
  const { router } = options;

  router.put('/environment/providers/:providerId', async (req, res) => {
    if (options.personaFor(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    const parsed = providerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    return res.status(503).json({
      error: 'Signed Environment Provider change authority unavailable',
      code: 'GOVERNANCE_PREVIEW_AUTHORITY_UNAVAILABLE',
    });
  });

  router.post('/environment/templates/:templateId/versions', async (req, res) => {
    if (options.personaFor(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    const parsed = environmentTemplateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    return res.status(503).json({
      error: 'Signed Environment Template publish authority unavailable',
      code: 'GOVERNANCE_PREVIEW_AUTHORITY_UNAVAILABLE',
    });
  });

  router.post('/environment/templates/:templateId/retire', (req, res) => {
    if (options.personaFor(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    const parsed = expectedRevisionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    return res.status(503).json({
      error: 'Signed Environment Template retirement authority unavailable',
      code: 'GOVERNANCE_PREVIEW_AUTHORITY_UNAVAILABLE',
    });
  });
}
