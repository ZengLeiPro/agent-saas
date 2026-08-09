import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';

import type { PgAgentResourceStore } from '../data/agentResources/index.js';
import type { GovernanceAuditStore } from '../data/governance-audit/index.js';
import type { PgSkillGovernanceStore } from '../data/skillGovernance/index.js';
import type { PgConnectorCatalogStore } from '../data/connectorCatalog/index.js';
import type { PgCredentialStore } from '../data/credentials/index.js';
import type { PgEnvironmentStore } from '../data/environments/index.js';
import type { SecretVault } from '../security/secretVault.js';
import { GovernanceChangeJobWorker, type GovernanceChangePlanner, type PgGovernanceChangeJobStore } from '../data/changeJobs/index.js';
import type { PgMembershipStore } from '../data/memberships/index.js';

const createAgentSchema = z.object({
  tenantId: z.string().min(2).max(64).optional(),
  agentId: z.string().min(2).max(96).optional(),
  kind: z.enum(['org_agent', 'personal_agent', 'agent_template']),
  ownerUserId: z.string().min(1).max(128).optional(),
  templateId: z.string().min(2).max(96).optional(),
}).strict();

const publishSchema = z.object({
  expectedRevision: z.number().int().positive(),
  definition: z.record(z.string(), z.unknown()),
}).strict();

const statusSchema = z.object({
  expectedRevision: z.number().int().positive(),
  status: z.enum(['enabled', 'disabled']),
}).strict();

const createSkillSchema = z.object({
  tenantId: z.string().min(2).max(64).optional(),
  skillId: z.string().min(2).max(96),
  scope: z.enum(['platform', 'tenant', 'personal']),
  ownerUserId: z.string().min(1).max(128).optional(),
}).strict();

const connectorPublishSchema = z.object({
  name: z.string().min(1).max(100),
  authMethods: z.array(z.string().min(1).max(64)).max(20),
  capabilitySchema: z.record(z.string(), z.unknown()),
  definition: z.record(z.string(), z.unknown()),
}).strict();
const connectorStatusSchema = z.object({
  expectedVersion: z.number().int().positive(),
  status: z.enum(['disabled', 'retired']),
}).strict();
const credentialCreateSchema = z.object({
  tenantId: z.string().min(2).max(64).optional(),
  connectorId: z.string().min(2).max(96),
  kind: z.enum(['org_shared', 'personal_grant', 'infrastructure']),
  custodianUserId: z.string().min(1).max(128).optional(),
  alias: z.string().max(100).optional(),
  purpose: z.string().min(1).max(500),
  scopeSummary: z.record(z.string(), z.unknown()).optional(),
  secret: z.string().min(1).max(10000),
  expiresAt: z.string().datetime().optional(),
}).strict();
const credentialStatusSchema = z.object({
  expectedVersion: z.number().int().positive(),
  status: z.enum(['rotation_due', 'expired', 'suspended', 'revoked', 'validation_failed']),
  reason: z.string().min(1).max(500),
}).strict();
const providerSchema = z.object({
  status: z.enum(['enabled', 'draining', 'disabled']),
  endpointRef: z.string().min(1).max(500),
  networkPolicy: z.record(z.string(), z.unknown()).optional(),
  infrastructureCredentialId: z.string().min(2).max(128).optional(),
  rolloutPolicy: z.record(z.string(), z.unknown()).optional(),
  expectedRevision: z.number().int().positive().optional(),
}).strict();
const environmentTemplateSchema = z.object({
  name: z.string().min(1).max(100),
  recipe: z.record(z.string(), z.unknown()),
}).strict();

const tenantDeleteJobSchema = z.object({
  tenantId: z.string().min(2).max(64),
  idempotencyKey: z.string().min(8).max(200),
  reasonCode: z.string().min(3).max(120),
}).strict();
const resourceChangeJobSchema = z.object({
  tenantId: z.string().min(2).max(64).optional(),
  targetType: z.string().min(2).max(80),
  targetId: z.string().min(1).max(200),
  idempotencyKey: z.string().min(8).max(200),
  expectedRevision: z.number().int().positive(),
  reasonCode: z.string().min(3).max(120),
}).strict();
const credentialJobSchema = z.object({
  tenantId: z.string().min(2).max(64).optional(),
  credentialId: z.string().min(2).max(128),
  idempotencyKey: z.string().min(8).max(200),
  expectedVersion: z.number().int().positive(),
  reasonCode: z.string().min(3).max(120),
}).strict();

const createCandidateSchema = z.object({
  definition: z.record(z.string(), z.unknown()),
}).strict();

const expectedRevisionSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();
const reviewSchema = z.object({
  expectedRevision: z.number().int().positive(),
  verdict: z.enum(['approved', 'rejected']),
  reason: z.string().min(1).max(1000),
}).strict();
const publishCandidateSchema = z.object({
  expectedCandidateRevision: z.number().int().positive(),
  expectedSkillRevision: z.number().int().positive(),
}).strict();

function credentialView<T extends { secretRef: string }>(credential: T): Omit<T, 'secretRef'> {
  const { secretRef: _secretRef, ...safe } = credential;
  return safe;
}

export function createGovernanceResourcesRouter(deps: {
  memberships: PgMembershipStore;
  agents: PgAgentResourceStore;
  skills: PgSkillGovernanceStore;
  connectors: PgConnectorCatalogStore;
  credentials: PgCredentialStore;
  environments: PgEnvironmentStore;
  changeJobs: PgGovernanceChangeJobStore;
  changePlanner: GovernanceChangePlanner;
  executeTenantDeletion?: (tenantId: string) => Promise<void>;
  vault: SecretVault;
  audit: GovernanceAuditStore;
}): Router {
  const router = Router();
  const changeJobWorker = new GovernanceChangeJobWorker({
    store: deps.changeJobs,
    workerId: 'governance-api',
  });
  const personas = new WeakMap<Request, 'platform_admin' | 'org_admin' | 'member'>();
  const canManageTenant = (req: Request) => {
    const persona = personas.get(req);
    return persona === 'platform_admin' || persona === 'org_admin';
  };
  const tenantFor = (req: Request, requested?: string): string | null => {
    if (personas.get(req) === 'platform_admin') return requested ?? req.user?.tenantId ?? null;
    if (!req.user?.tenantId || (requested && requested !== req.user.tenantId)) return null;
    return req.user.tenantId;
  };

  router.use(async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const platformAdmin = await deps.memberships.getPlatformAdmin(req.user.sub);
    if (platformAdmin?.status === 'active') {
      personas.set(req, 'platform_admin');
      return next();
    }
    const membership = await deps.memberships.getMembership(req.user.tenantId, req.user.sub);
    if (!membership || membership.status !== 'active') {
      return res.status(403).json({ error: 'Governance membership inactive', code: 'GOVERNANCE_MEMBERSHIP_INACTIVE' });
    }
    personas.set(req, membership.persona);
    next();
  });

  router.use(async (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const user = req.user!;
    const requestedTenantId = typeof req.query.tenantId === 'string'
      ? req.query.tenantId
      : typeof req.body?.tenantId === 'string' ? req.body.tenantId : user.tenantId;
    const correlationId = `governance-resource:${randomUUID()}`;
    let intentAuditId: string;
    try {
      const intent = await deps.audit.append({
        correlationId,
        actorType: 'user', actorUserId: user.sub,
        actorPersona: personas.get(req)!,
        actorTenantId: user.tenantId,
        action: `governance.resource.${req.method.toLowerCase()}`,
        targetType: 'governance_resource_api', targetId: req.path,
        targetTenantId: requestedTenantId, purpose: 'typed resource mutation',
        result: 'intent', metadata: {},
      });
      intentAuditId = intent.auditId;
    } catch {
      return res.status(503).json({ error: '治理审计不可用', code: 'GOVERNANCE_AUDIT_UNAVAILABLE' });
    }
    const sendJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      void deps.audit.append({
        correlationId,
        actorType: 'user', actorUserId: user.sub,
        actorPersona: personas.get(req)!,
        actorTenantId: user.tenantId,
        action: `governance.resource.${req.method.toLowerCase()}`,
        targetType: 'governance_resource_api', targetId: req.path,
        targetTenantId: requestedTenantId, purpose: 'typed resource mutation',
        result: res.statusCode < 400 ? 'succeeded' : 'failed',
        metadata: { statusCode: res.statusCode },
      }).then(event => {
        const payload = body && typeof body === 'object' && !Array.isArray(body)
          ? { ...(body as Record<string, unknown>), auditId: event.auditId }
          : { data: body, auditId: event.auditId };
        sendJson(payload);
      }).catch(() => {
        const payload = body && typeof body === 'object' && !Array.isArray(body)
          ? { ...(body as Record<string, unknown>), auditId: intentAuditId, auditCompletion: 'pending' }
          : { data: body, auditId: intentAuditId, auditCompletion: 'pending' };
        sendJson(payload);
      });
      return res;
    }) as typeof res.json;
    next();
  });

  router.get('/agents/:agentId', async (req, res) => {
    const tenantId = tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const resource = await deps.agents.getForTenant(tenantId, req.params.agentId);
    if (!resource) return res.status(404).json({ error: 'Agent not found' });
    if (!canManageTenant(req) && resource.ownerUserId !== req.user!.sub) return res.status(403).json({ error: 'Owner required' });
    const version = resource.currentVersionId ? await deps.agents.getVersion(resource.currentVersionId) : null;
    res.json({ resource, version });
  });

  router.get('/skills/:skillId', async (req, res) => {
    const tenantId = tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const resource = await deps.skills.getResource(req.params.skillId);
    if (!resource || resource.tenantId !== tenantId) return res.status(404).json({ error: 'Skill not found' });
    if (!canManageTenant(req) && resource.ownerUserId !== req.user!.sub) return res.status(403).json({ error: 'Owner required' });
    res.json(resource);
  });

  router.get('/connectors', async (_req, res) => {
    res.json({ connectors: await deps.connectors.list() });
  });

  router.get('/credentials', async (req, res) => {
    const tenantId = tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const credentials = canManageTenant(req)
      ? await deps.credentials.listForTenant(tenantId)
      : await deps.credentials.listForOwner(tenantId, req.user!.sub);
    res.json({ credentials: credentials.map(credentialView) });
  });

  router.get('/environment/providers/:providerId', async (req, res) => {
    if (personas.get(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    const provider = await deps.environments.getProvider(req.params.providerId);
    if (!provider) return res.status(404).json({ error: 'Provider not found' });
    res.json(provider);
  });

  router.get('/environment/templates/:templateId', async (req, res) => {
    const template = await deps.environments.getTemplate(req.params.templateId);
    if (!template) return res.status(404).json({ error: 'Environment Template not found' });
    const version = template.currentVersionId
      ? await deps.environments.getTemplateVersion(template.currentVersionId)
      : null;
    res.json({ template, version });
  });

  router.post('/agents', async (req, res) => {
    const parsed = createAgentSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = tenantFor(req, parsed.data.tenantId);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const ownerUserId = parsed.data.kind === 'personal_agent' ? req.user!.sub : parsed.data.ownerUserId ?? req.user!.sub;
    if (parsed.data.kind !== 'personal_agent' && !canManageTenant(req)) return res.status(403).json({ error: 'Admin required' });
    if (parsed.data.kind === 'personal_agent' && parsed.data.ownerUserId && parsed.data.ownerUserId !== req.user!.sub) {
      return res.status(403).json({ error: 'Personal Agent owner mismatch' });
    }
    try {
      const resource = await deps.agents.create({
        ...(parsed.data.agentId ? { agentId: parsed.data.agentId } : {}), tenantId,
        kind: parsed.data.kind, ownerUserId,
        ...(parsed.data.templateId ? { templateId: parsed.data.templateId } : {}), createdBy: req.user!.sub,
      });
      res.status(201).json(resource);
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/agents/:agentId/versions', async (req, res) => {
    const parsed = publishSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const resource = await deps.agents.getForTenant(tenantId, req.params.agentId);
    if (!resource) return res.status(404).json({ error: 'Agent not found' });
    if (!canManageTenant(req) && resource.ownerUserId !== req.user!.sub) return res.status(403).json({ error: 'Owner required' });
    try {
      const published = await deps.agents.publishVersion({
        tenantId, agentId: resource.agentId, expectedRevision: parsed.data.expectedRevision,
        definition: parsed.data.definition, publishedBy: req.user!.sub,
      });
      res.json(published);
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.patch('/agents/:agentId/status', async (req, res) => {
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const resource = await deps.agents.getForTenant(tenantId, req.params.agentId);
    if (!resource) return res.status(404).json({ error: 'Agent not found' });
    if (!canManageTenant(req) && resource.ownerUserId !== req.user!.sub) return res.status(403).json({ error: 'Owner required' });
    try {
      res.json(await deps.agents.setStatus(tenantId, resource.agentId, parsed.data.status, parsed.data.expectedRevision, req.user!.sub));
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/agents/:agentId/archive', async (req, res) => {
    const parsed = expectedRevisionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const resource = await deps.agents.getForTenant(tenantId, req.params.agentId);
    if (!resource) return res.status(404).json({ error: 'Agent not found' });
    if (!canManageTenant(req) && resource.ownerUserId !== req.user!.sub) return res.status(403).json({ error: 'Owner required' });
    try {
      res.json(await deps.agents.archive(tenantId, resource.agentId, parsed.data.expectedRevision, req.user!.sub));
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/skills', async (req, res) => {
    const parsed = createSkillSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = tenantFor(req, parsed.data.tenantId);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    if (parsed.data.scope !== 'personal' && !canManageTenant(req)) return res.status(403).json({ error: 'Admin required' });
    if (parsed.data.scope === 'platform' && personas.get(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    const ownerUserId = parsed.data.scope === 'personal' ? req.user!.sub : parsed.data.ownerUserId;
    if (parsed.data.scope === 'personal' && parsed.data.ownerUserId && parsed.data.ownerUserId !== req.user!.sub) {
      return res.status(403).json({ error: 'Personal Skill owner mismatch' });
    }
    try {
      const resource = await deps.skills.createResource({
        skillId: parsed.data.skillId, tenantId, scope: parsed.data.scope,
        ...(ownerUserId ? { ownerUserId } : {}), createdBy: req.user!.sub,
      });
      res.status(201).json(resource);
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/skills/:skillId/versions', async (req, res) => {
    if (!canManageTenant(req)) return res.status(403).json({ error: 'Admin required' });
    const parsed = publishSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    try {
      res.json(await deps.skills.publishVersion({
        tenantId, skillId: req.params.skillId, expectedRevision: parsed.data.expectedRevision,
        definition: parsed.data.definition, publishedBy: req.user!.sub,
      }));
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/skills/:skillId/candidates', async (req, res) => {
    const parsed = createCandidateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    try {
      res.status(201).json(await deps.skills.createCandidate({
        tenantId, ownerUserId: req.user!.sub, targetSkillId: req.params.skillId, definition: parsed.data.definition,
      }));
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/skill-candidates/:candidateId/submit', async (req, res) => {
    const parsed = expectedRevisionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    try {
      res.json(await deps.skills.submitCandidate(tenantId, req.params.candidateId, req.user!.sub, parsed.data.expectedRevision));
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/skill-candidates/:candidateId/review', async (req, res) => {
    if (!canManageTenant(req)) return res.status(403).json({ error: 'Admin required' });
    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    try {
      res.json(await deps.skills.reviewCandidate({
        tenantId, candidateId: req.params.candidateId, expectedRevision: parsed.data.expectedRevision,
        verdict: parsed.data.verdict, reviewedBy: req.user!.sub, reason: parsed.data.reason,
      }));
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/skill-candidates/:candidateId/publish', async (req, res) => {
    if (!canManageTenant(req)) return res.status(403).json({ error: 'Admin required' });
    const parsed = publishCandidateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    try {
      res.json(await deps.skills.publishApprovedCandidate({
        tenantId, candidateId: req.params.candidateId,
        expectedCandidateRevision: parsed.data.expectedCandidateRevision,
        expectedSkillRevision: parsed.data.expectedSkillRevision, publishedBy: req.user!.sub,
      }));
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/connectors/:connectorId/versions', async (req, res) => {
    if (personas.get(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    const parsed = connectorPublishSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    try {
      res.json(await deps.connectors.publish({
        connectorId: req.params.connectorId,
        ...parsed.data,
        publishedBy: req.user!.sub,
      }));
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.patch('/connectors/:connectorId/status', async (req, res) => {
    if (personas.get(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    const parsed = connectorStatusSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    try {
      res.json(await deps.connectors.updateStatus(
        req.params.connectorId, parsed.data.status, parsed.data.expectedVersion, req.user!.sub,
      ));
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/credentials', async (req, res) => {
    const parsed = credentialCreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = tenantFor(req, parsed.data.tenantId);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    if (parsed.data.kind === 'org_shared' && !canManageTenant(req)) return res.status(403).json({ error: 'Admin required' });
    if (parsed.data.kind === 'infrastructure' && personas.get(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    const ownerUserId = parsed.data.kind === 'personal_grant' ? req.user!.sub : undefined;
    const custodianUserId = parsed.data.kind === 'org_shared' ? parsed.data.custodianUserId ?? req.user!.sub : undefined;
    const vaultCaller = {
      actor: 'connector_proxy' as const,
      userId: ownerUserId ?? custodianUserId ?? req.user!.sub,
      tenantId,
      scopes: ['secret:connector:write'],
    };
    let secretRef: string | undefined;
    try {
      const secret = await deps.vault.putSecret(
        vaultCaller.userId,
        'connector',
        parsed.data.secret,
        vaultCaller,
        { connectorId: parsed.data.connectorId, tenantId, credentialOwnerId: vaultCaller.userId },
      );
      secretRef = secret.id;
      const credential = await deps.credentials.create({
        tenantId, connectorId: parsed.data.connectorId, kind: parsed.data.kind,
        ...(ownerUserId ? { ownerUserId } : {}),
        ...(custodianUserId ? { custodianUserId } : {}),
        ...(parsed.data.alias ? { alias: parsed.data.alias } : {}),
        purpose: parsed.data.purpose, scopeSummary: parsed.data.scopeSummary ?? {}, secretRef,
        ...(parsed.data.expiresAt ? { expiresAt: parsed.data.expiresAt } : {}),
        createdBy: req.user!.sub,
      });
      const { secretRef: _secretRef, ...safe } = credential;
      res.status(201).json(safe);
    } catch (error) {
      if (secretRef) {
        await deps.vault.revokeSecret(secretRef, {
          actor: 'connector_proxy', userId: vaultCaller.userId, tenantId,
          scopes: ['secret:connector:revoke'],
        }).catch(() => undefined);
      }
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.patch('/credentials/:credentialId/status', async (req, res) => {
    const parsed = credentialStatusSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const current = await deps.credentials.get(req.params.credentialId);
    if (!current || current.tenantId !== tenantId) return res.status(404).json({ error: 'Credential not found' });
    if (!canManageTenant(req) && current.ownerUserId !== req.user!.sub) return res.status(403).json({ error: 'Owner required' });
    try {
      const credential = await deps.credentials.updateStatus(current.credentialId, {
        status: parsed.data.status, expectedVersion: parsed.data.expectedVersion,
        updatedBy: req.user!.sub, updateReason: parsed.data.reason,
      });
      const { secretRef: _secretRef, ...safe } = credential;
      res.json(safe);
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.put('/environment/providers/:providerId', async (req, res) => {
    if (personas.get(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    const parsed = providerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    try {
      res.json(await deps.environments.upsertProvider({
        providerId: req.params.providerId,
        ...parsed.data,
        updatedBy: req.user!.sub,
      }));
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/environment/templates/:templateId/versions', async (req, res) => {
    if (personas.get(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    const parsed = environmentTemplateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    try {
      res.json(await deps.environments.publishTemplate({
        templateId: req.params.templateId,
        name: parsed.data.name,
        recipe: parsed.data.recipe as never,
        publishedBy: req.user!.sub,
      }));
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/environment/templates/:templateId/retire', async (req, res) => {
    if (personas.get(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    const parsed = expectedRevisionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    try {
      res.json(await deps.environments.retireTemplate(
        req.params.templateId, parsed.data.expectedRevision, req.user!.sub,
      ));
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/change-jobs/:jobId', async (req, res) => {
    const tenantId = tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const job = await deps.changeJobs.get(tenantId, req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Change Job not found' });
    const domains = await deps.changeJobs.listDomains(tenantId, job.jobId);
    res.json({ job, domains });
  });

  router.get('/previews/resource-retirement', async (req, res) => {
    const tenantId = tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    const targetType = typeof req.query.targetType === 'string' ? req.query.targetType : '';
    const targetId = typeof req.query.targetId === 'string' ? req.query.targetId : '';
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    if (!targetType || !targetId) return res.status(400).json({ error: 'targetType and targetId are required' });
    res.json(await deps.changePlanner.previewResourceRetirement(tenantId, targetType, targetId));
  });

  router.get('/previews/credentials/:credentialId', async (req, res) => {
    const tenantId = tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    const action = req.query.action === 'revoke' ? 'revoke' : req.query.action === 'suspend' ? 'suspend' : undefined;
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    if (!action) return res.status(400).json({ error: 'action must be suspend or revoke' });
    try {
      res.json(await deps.changePlanner.previewCredentialChange(tenantId, req.params.credentialId, action));
    } catch (error) {
      res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/change-jobs/tenant-delete', async (req, res) => {
    if (personas.get(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    const parsed = tenantDeleteJobSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    if (!deps.executeTenantDeletion) return res.status(503).json({ error: 'Tenant deletion worker unavailable' });
    try {
      const result = await deps.changePlanner.createTenantDeletion({
        tenantId: parsed.data.tenantId,
        idempotencyKey: parsed.data.idempotencyKey,
        requestedBy: req.user!.sub,
        reasonCode: parsed.data.reasonCode,
      });
      const job = result.job.status === 'pending' || result.job.status === 'retry_wait'
        ? await changeJobWorker.execute({
            tenantId: parsed.data.tenantId,
            jobId: result.job.jobId,
            handlers: {
              sessions_runs: () => deps.executeTenantDeletion!(parsed.data.tenantId),
              memory: async () => undefined,
              assignments: async () => undefined,
              agents_skills: async () => undefined,
              credentials: async () => undefined,
              memberships: async () => undefined,
              tenant_configuration: async () => undefined,
              audit_retention: async () => undefined,
            },
          })
        : result.job;
      res.status(result.created ? 201 : 200).json({ ...result, job });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/change-jobs/resource-retire', async (req, res) => {
    if (!canManageTenant(req)) return res.status(403).json({ error: 'Admin required' });
    const parsed = resourceChangeJobSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = tenantFor(req, parsed.data.tenantId);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    try {
      const result = await deps.changeJobs.create({
        tenantId, jobType: 'resource_retire', targetType: parsed.data.targetType,
        targetId: parsed.data.targetId, idempotencyKey: parsed.data.idempotencyKey,
        request: { reasonCode: parsed.data.reasonCode, expectedRevision: parsed.data.expectedRevision },
        domains: ['reference_validation', 'resource_retirement'], createdBy: req.user!.sub,
      });
      const retire = async () => {
        switch (parsed.data.targetType) {
          case 'agent':
          case 'org_agent':
          case 'personal_agent':
            await deps.agents.archive(tenantId, parsed.data.targetId, parsed.data.expectedRevision, req.user!.sub);
            return;
          case 'skill':
            await deps.skills.retire(tenantId, parsed.data.targetId, parsed.data.expectedRevision, req.user!.sub);
            return;
          case 'connector':
            if (personas.get(req) !== 'platform_admin') throw new Error('PLATFORM_ADMIN_REQUIRED');
            await deps.connectors.updateStatus(parsed.data.targetId, 'retired', parsed.data.expectedRevision, req.user!.sub);
            return;
          case 'environment_template':
            if (personas.get(req) !== 'platform_admin') throw new Error('PLATFORM_ADMIN_REQUIRED');
            await deps.environments.retireTemplate(parsed.data.targetId, parsed.data.expectedRevision, req.user!.sub);
            return;
          default:
            throw new Error('RESOURCE_RETIREMENT_UNSUPPORTED');
        }
      };
      const job = result.job.status === 'pending' || result.job.status === 'retry_wait'
        ? await changeJobWorker.execute({
            tenantId, jobId: result.job.jobId,
            handlers: {
              reference_validation: async () => { await deps.changePlanner.previewResourceRetirement(tenantId, parsed.data.targetType, parsed.data.targetId); },
              resource_retirement: retire,
            },
          })
        : result.job;
      res.status(result.created ? 201 : 200).json({ ...result, job });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/change-jobs/credential-revoke', async (req, res) => {
    if (!canManageTenant(req)) return res.status(403).json({ error: 'Admin required' });
    const parsed = credentialJobSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = tenantFor(req, parsed.data.tenantId);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    try {
      await deps.changePlanner.previewCredentialChange(tenantId, parsed.data.credentialId, 'revoke');
      const result = await deps.changeJobs.create({
        tenantId, jobType: 'credential_revoke', targetType: 'credential',
        targetId: parsed.data.credentialId, idempotencyKey: parsed.data.idempotencyKey,
        request: { reasonCode: parsed.data.reasonCode, expectedVersion: parsed.data.expectedVersion },
        domains: ['credential_status', 'credential_assignments', 'credential_references'], createdBy: req.user!.sub,
      });
      const job = result.job.status === 'pending' || result.job.status === 'retry_wait'
        ? await changeJobWorker.execute({
            tenantId, jobId: result.job.jobId,
            handlers: {
              credential_status: async () => {
                await deps.credentials.updateStatus(parsed.data.credentialId, {
                  status: 'revoked', expectedVersion: parsed.data.expectedVersion,
                  updatedBy: req.user!.sub, updateReason: parsed.data.reasonCode,
                });
              },
              credential_assignments: async () => undefined,
              credential_references: async () => undefined,
            },
          })
        : result.job;
      res.status(result.created ? 201 : 200).json({ ...result, job });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
