import type { Request, Router } from 'express';

import type { PgAgentResourceStore } from '../data/agentResources/index.js';
import type { PgSkillGovernanceStore } from '../data/skillGovernance/index.js';
import type { PgConnectorCatalogStore } from '../data/connectorCatalog/index.js';
import type { PgEnvironmentStore } from '../data/environments/index.js';

export function registerGovernanceResourceCatalogRoutes(options: {
  router: Router;
  personaFor: (req: Request) => 'platform_admin' | 'org_admin' | 'member' | undefined;
  agents: PgAgentResourceStore;
  skills: PgSkillGovernanceStore;
  connectors: PgConnectorCatalogStore;
  environments: PgEnvironmentStore;
}): void {
  options.router.get('/entitlement-resource-catalog', async (req, res) => {
    if (options.personaFor(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    const resourceType = typeof req.query.resourceType === 'string' ? req.query.resourceType : '';
    if (resourceType === 'agent_template') {
      const items = (await options.agents.listByKind('agent_template')).filter(item => item.status === 'enabled')
        .map(item => ({ resourceId: item.agentId, label: item.templateId ?? item.agentId, version: item.revision }));
      return res.json({ resourceType, items });
    }
    if (resourceType === 'skill') {
      const items = (await options.skills.listPublishedPlatform())
        .map(item => ({ resourceId: item.skillId, label: item.skillId, version: item.revision }));
      return res.json({ resourceType, items });
    }
    if (resourceType === 'connector') {
      const items = (await options.connectors.list()).filter(item => item.status === 'published')
        .map(item => ({ resourceId: item.connectorId, label: item.name, version: item.version }));
      return res.json({ resourceType, items });
    }
    if (resourceType === 'environment_template') {
      const items = (await options.environments.listTemplates()).filter(item => item.status === 'published')
        .map(item => ({ resourceId: item.templateId, label: item.name, version: item.revision }));
      return res.json({ resourceType, items });
    }
    if (resourceType === 'model' || resourceType === 'tool') {
      return res.status(503).json({ error: 'Resource catalog unavailable', code: 'RESOURCE_CATALOG_UNAVAILABLE' });
    }
    return res.status(400).json({ error: 'Unsupported resourceType' });
  });
}
