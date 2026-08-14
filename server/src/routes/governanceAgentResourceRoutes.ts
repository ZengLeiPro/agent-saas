import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Router } from 'express';
import { z } from 'zod';

import type { PgAgentResourceStore } from '../data/agentResources/index.js';
import { managedOrgAgentDefinitionSchema } from '../data/agentResources/orgAgentProjection.js';
import { governanceDigest } from '../data/governance-audit/index.js';
import type { PgGovernanceChangeJobStore } from '../data/changeJobs/index.js';
import type { PgMembershipStore } from '../data/memberships/index.js';
import type {
  GovernanceProjectionOutboxStore,
  GovernanceProjectionReconciler,
} from '../data/governanceProjection/index.js';
import { createAgentSchema, expectedRevisionSchema, statusSchema } from './governanceResourceSchemas.js';

type Persona = 'platform_admin' | 'org_admin' | 'member';

const agentVersionPreviewSchema = z.object({
  expectedRevision: z.number().int().positive(),
  definition: managedOrgAgentDefinitionSchema,
  reason: z.string().trim().min(3).max(500),
}).strict();

const agentVersionPublishSchema = agentVersionPreviewSchema.extend({
  previewId: z.string().regex(/^agpv1\.[a-f0-9]{64}$/),
  baselineDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();

function signedPreviewId(secret: string, payload: Record<string, unknown>): string {
  return `agpv1.${createHmac('sha256', secret).update(governanceDigest(payload)).digest('hex')}`;
}

function previewMatches(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function registerGovernanceAgentResourceRoutes(options: {
  router: Router;
  agents: PgAgentResourceStore;
  memberships: PgMembershipStore;
  changeJobs: PgGovernanceChangeJobStore;
  previewSecret: string;
  personaFor(req: Request): Persona | undefined;
  resourceTenantFor(req: Request, requested?: string): string | null;
  projectionOutbox?: GovernanceProjectionOutboxStore;
  projectionReconciler?: GovernanceProjectionReconciler;
  now?: () => Date;
}): void {
  const { router } = options;
  const now = options.now ?? (() => new Date());
  const canManageOrganization = (req: Request) => options.personaFor(req) === 'org_admin';
  const canManageAgent = (req: Request, resource: { kind: string; ownerUserId: string }) => {
    if (resource.kind === 'personal_agent') return resource.ownerUserId === req.user?.sub;
    if (resource.kind === 'agent_template') return options.personaFor(req) === 'platform_admin';
    return canManageOrganization(req);
  };
  const canAccessAgent = (req: Request, resource: { kind: string; ownerUserId: string }) => (
    canManageAgent(req, resource)
    || (resource.kind === 'org_agent' && options.personaFor(req) === 'member' && resource.ownerUserId === req.user?.sub)
  );
  const baselineFor = async (resource: Awaited<ReturnType<PgAgentResourceStore['getForTenant']>>) => {
    if (!resource) return null;
    const version = resource.currentVersionId ? await options.agents.getVersion(resource.currentVersionId) : null;
    return {
      agentId: resource.agentId,
      tenantId: resource.tenantId,
      kind: resource.kind,
      ownerUserId: resource.ownerUserId,
      status: resource.status,
      currentVersionId: resource.currentVersionId ?? null,
      currentVersionDigest: version?.digest ?? null,
      revision: resource.revision,
    };
  };
  const signatureInput = (input: {
    req: Request; tenantId: string; agentId: string; expectedRevision: number;
    baselineDigest: string; definitionDigest: string; reason: string; expiresAt: string;
  }) => ({
    version: 1,
    actorUserId: input.req.user!.sub,
    actorTenantId: input.req.user!.tenantId,
    tenantId: input.tenantId,
    agentId: input.agentId,
    expectedRevision: input.expectedRevision,
    baselineDigest: input.baselineDigest,
    definitionDigest: input.definitionDigest,
    reason: input.reason,
    expiresAt: input.expiresAt,
  });

  router.get('/agents', async (req, res) => {
    if (options.personaFor(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    const kind = req.query.kind === 'agent_template' ? 'agent_template' : undefined;
    if (!kind) return res.status(400).json({ error: 'kind=agent_template is required' });
    return res.json({ agents: await options.agents.listByKind(kind) });
  });

  router.get('/agents/:agentId', async (req, res) => {
    const tenantId = options.resourceTenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const resource = await options.agents.getForTenant(tenantId, req.params.agentId);
    if (!resource || !canAccessAgent(req, resource)) return res.status(404).json({ error: 'Agent not found' });
    const version = resource.currentVersionId ? await options.agents.getVersion(resource.currentVersionId) : null;
    return res.json({ resource, version });
  });

  router.post('/agents', async (req, res) => {
    const parsed = createAgentSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = options.resourceTenantFor(req, parsed.data.tenantId);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const ownerUserId = parsed.data.kind === 'agent_template'
      ? 'global'
      : parsed.data.kind === 'personal_agent' ? req.user!.sub : parsed.data.ownerUserId ?? req.user!.sub;
    if (parsed.data.kind !== 'agent_template') {
      const ownerMembership = await options.memberships.getMembership(tenantId, ownerUserId);
      if (!ownerMembership || ownerMembership.status !== 'active') {
        return res.status(409).json({ error: 'Active in-tenant owner Membership required', code: 'RESOURCE_OWNER_MEMBERSHIP_REQUIRED' });
      }
      const offboarding = await options.changeJobs.findActiveForTarget(tenantId, 'user_offboarding', 'user', ownerUserId);
      if (offboarding) return res.status(409).json({ error: 'Resource owner offboarding is active', code: 'RESOURCE_OWNER_OFFBOARDING_ACTIVE' });
    }
    if (parsed.data.kind === 'org_agent' && !canManageOrganization(req)) return res.status(403).json({ error: 'Organization admin required' });
    if (parsed.data.kind === 'agent_template' && options.personaFor(req) !== 'platform_admin') {
      return res.status(403).json({ error: 'Platform admin required' });
    }
    if (parsed.data.kind === 'personal_agent' && parsed.data.ownerUserId && parsed.data.ownerUserId !== req.user!.sub) {
      return res.status(403).json({ error: 'Personal Agent owner mismatch' });
    }
    try {
      const resource = await options.agents.create({
        ...(parsed.data.agentId ? { agentId: parsed.data.agentId } : {}), tenantId,
        kind: parsed.data.kind, ownerUserId,
        ...(parsed.data.templateId ? { templateId: parsed.data.templateId } : {}), createdBy: req.user!.sub,
      });
      return res.status(201).json(resource);
    } catch (error) {
      return res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/agents/:agentId/versions/preview', async (req, res) => {
    const parsed = agentVersionPreviewSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = options.resourceTenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const resource = await options.agents.getForTenant(tenantId, req.params.agentId);
    if (!resource || !canManageAgent(req, resource)) return res.status(404).json({ error: 'Agent not found' });
    if (resource.kind !== 'org_agent') {
      return res.status(503).json({ error: 'Signed Agent version publish authority unavailable', code: 'GOVERNANCE_PREVIEW_AUTHORITY_UNAVAILABLE' });
    }
    if (resource.revision !== parsed.data.expectedRevision || resource.status === 'archived') {
      return res.status(409).json({ error: 'Agent version preview baseline changed', code: 'AGENT_VERSION_PREVIEW_BASELINE_CONFLICT' });
    }
    const baseline = await baselineFor(resource);
    const baselineDigest = governanceDigest(baseline);
    const definitionDigest = governanceDigest(parsed.data.definition);
    const expiresAt = new Date(now().getTime() + 5 * 60_000).toISOString();
    const blockers = options.projectionOutbox ? [] : ['GOVERNANCE_PROJECTION_AUTHORITY_UNAVAILABLE'];
    return res.json({
      previewId: signedPreviewId(options.previewSecret, signatureInput({
        req, tenantId, agentId: resource.agentId, expectedRevision: resource.revision,
        baselineDigest, definitionDigest, reason: parsed.data.reason, expiresAt,
      })),
      baselineDigest,
      expiresAt,
      impact: {
        from: { status: resource.status, versionId: resource.currentVersionId ?? null },
        to: { status: 'enabled', definitionDigest },
        blockers,
        reversible: true,
        effectiveMode: 'source_immediate_projection_pending',
      },
      canCommit: blockers.length === 0,
      changeId: res.locals.governanceChangeId,
    });
  });

  router.post('/agents/:agentId/versions', async (req, res) => {
    const tenantId = options.resourceTenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const resource = await options.agents.getForTenant(tenantId, req.params.agentId);
    if (!resource || !canManageAgent(req, resource)) return res.status(404).json({ error: 'Agent not found' });
    if (resource.kind !== 'org_agent') {
      return res.status(503).json({ error: 'Signed Agent version publish authority unavailable', code: 'GOVERNANCE_PREVIEW_AUTHORITY_UNAVAILABLE' });
    }
    const parsed = agentVersionPublishSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    if (!options.projectionOutbox) {
      return res.status(503).json({ error: 'Governance projection authority unavailable', code: 'GOVERNANCE_PROJECTION_AUTHORITY_UNAVAILABLE' });
    }
    if (Date.parse(parsed.data.expiresAt) <= now().getTime()) {
      return res.status(409).json({ error: 'Agent version preview expired', code: 'AGENT_VERSION_PREVIEW_EXPIRED' });
    }
    const definitionDigest = governanceDigest(parsed.data.definition);
    const expectedPreviewId = signedPreviewId(options.previewSecret, signatureInput({
      req, tenantId, agentId: resource.agentId, expectedRevision: parsed.data.expectedRevision,
      baselineDigest: parsed.data.baselineDigest, definitionDigest,
      reason: parsed.data.reason, expiresAt: parsed.data.expiresAt,
    }));
    if (!previewMatches(parsed.data.previewId, expectedPreviewId)) {
      return res.status(409).json({ error: 'Agent version preview invalid', code: 'AGENT_VERSION_PREVIEW_INVALID' });
    }
    const baseline = await baselineFor(resource);
    if (resource.revision !== parsed.data.expectedRevision || governanceDigest(baseline) !== parsed.data.baselineDigest) {
      return res.status(409).json({ error: 'Agent version preview baseline changed', code: 'AGENT_VERSION_PREVIEW_BASELINE_CONFLICT' });
    }
    let changed = false;
    try {
      const published = await options.agents.publishVersion({
        tenantId, agentId: resource.agentId, expectedRevision: parsed.data.expectedRevision,
        definition: parsed.data.definition, publishedBy: req.user!.sub,
      });
      changed = published.created;
      const projection = await options.projectionOutbox.enqueue({
        tenantId,
        projector: 'org_agent',
        idempotencyKey: `${resource.agentId}:${published.version.versionId}:${published.resource.revision}`,
        payload: {
          tenantId,
          agentId: resource.agentId,
          versionId: published.version.versionId,
          resourceRevision: published.resource.revision,
        },
      });
      void options.projectionReconciler?.reconcileOne();
      return res.json({
        ...published,
        projectionId: projection.outboxId,
        projectionStatus: 'pending',
        compatibilityProjection: 'applied_with_projection_pending',
        changeId: res.locals.governanceChangeId,
      });
    } catch (error) {
      if (changed) {
        return res.status(500).json({
          error: 'Agent version 已发布，但兼容投影未能持久化',
          code: 'GOVERNANCE_PROJECTION_NOT_DURABLE',
          changed: true,
          changeId: res.locals.governanceChangeId,
        });
      }
      return res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.patch('/agents/:agentId/status', async (req, res) => {
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = options.resourceTenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const resource = await options.agents.getForTenant(tenantId, req.params.agentId);
    if (!resource || !canManageAgent(req, resource)) return res.status(404).json({ error: 'Agent not found' });
    return res.status(503).json({
      error: 'Signed Agent status authority unavailable',
      code: 'GOVERNANCE_PREVIEW_AUTHORITY_UNAVAILABLE',
    });
  });

  router.post('/agents/:agentId/archive', (req, res) => {
    const parsed = expectedRevisionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = options.resourceTenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    return res.status(503).json({
      error: 'Signed Agent archive authority unavailable',
      code: 'GOVERNANCE_PREVIEW_AUTHORITY_UNAVAILABLE',
    });
  });
}
