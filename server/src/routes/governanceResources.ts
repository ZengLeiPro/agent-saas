import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import multer from 'multer';
import { Router } from 'express';
import type { Request } from 'express';

import type { PgAgentResourceStore } from '../data/agentResources/index.js';
import { governanceDigest, type GovernanceAuditStore } from '../data/governance-audit/index.js';
import type { PgSkillGovernanceStore } from '../data/skillGovernance/index.js';
import type { PgConnectorCatalogStore } from '../data/connectorCatalog/index.js';
import type { PgCredentialStore } from '../data/credentials/index.js';
import type { PgEnvironmentStore } from '../data/environments/index.js';
import { GLOBAL_OWNER_ID, tenantOwnerId, type SecretVault } from '../security/secretVault.js';
import type { GovernanceChangePlanner, PgGovernanceChangeJobStore } from '../data/changeJobs/index.js';
import type { PgMembershipStore } from '../data/memberships/index.js';
import { hasPlatformCapability } from '../auth/platformGovernance.js';
import {
  SkillPackageUploadError,
} from '../services/skillPackageUpload.js';
import type {
  PersonalSkillGovernanceUploadResult,
  TenantSkillGovernanceUploadResult,
} from '../services/tenantSkillGovernanceUpload.js';
import { serverLogger } from '../utils/logger.js';
import type { GovernanceProjectionReconciler, PgGovernanceProjectionOutboxStore } from '../data/governanceProjection/index.js';
import { registerGovernanceAgentResourceRoutes } from './governanceAgentResourceRoutes.js';
import { registerGovernanceResourceCatalogRoutes } from './governanceResourceCatalogRoutes.js';
import {
  connectorPublishSchema, connectorStatusSchema, createCandidateSchema, createSkillSchema,
  credentialCreateSchema, credentialStatusSchema, environmentTemplateSchema, expectedRevisionSchema,
  providerSchema, publishCandidateSchema, publishSchema, reviewSchema, statusSchema,
  userOffboardingJobSchema, userOffboardingPreviewSchema,
} from './governanceResourceSchemas.js';

function signedPreviewId(prefix: 'opv1', secret: string, payload: Record<string, unknown>): string {
  const signature = createHmac('sha256', secret).update(governanceDigest(payload)).digest('hex');
  return `${prefix}.${signature}`;
}

function previewMatches(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function credentialView<T extends { secretRef: string }>(credential: T): Omit<T, 'secretRef'> {
  const { secretRef: _secretRef, ...safe } = credential;
  return safe;
}

export function createGovernanceResourcesRouter(deps: {
  memberships: PgMembershipStore;
  agents: PgAgentResourceStore;
  skills: PgSkillGovernanceStore;
  importTenantSkill?: (input: {
    tenantId: string;
    actorUserId: string;
    files: Express.Multer.File[];
  }) => Promise<TenantSkillGovernanceUploadResult>;
  importPersonalSkill?: (input: {
    tenantId: string;
    actorUserId: string;
    files: Express.Multer.File[];
  }) => Promise<PersonalSkillGovernanceUploadResult>;
  connectors: PgConnectorCatalogStore;
  credentials: PgCredentialStore;
  environments: PgEnvironmentStore;
  changeJobs: PgGovernanceChangeJobStore;
  changePlanner: GovernanceChangePlanner;
  tenantExists?: (tenantId: string) => boolean;
  resolveUserTenantId?: (userId: string) => string | undefined;
  listCronIdsByOwner?: (userId: string) => Promise<Array<{ id: string; version: string }>>;
  listActiveRunIdsByUser?: (tenantId: string, userId: string) => Promise<Array<{ id: string; version: string }>>;
  listActiveSessionIdsByUser?: (tenantId: string, userId: string) => Promise<Array<{ id: string; version: string }>>;
  listActiveOAuthGrantIdsByUser?: (tenantId: string, userId: string) => Promise<Array<{ id: string; version: string }>>;
  listExternalConnectionIdsByUser?: (tenantId: string, userId: string) => Promise<Array<{ id: string; version: string }>>;
  listPersonalMemoryIds?: (tenantId: string, userId: string) => Promise<string[]>;
  listFileOwnership?: (tenantId: string, userId: string) => Promise<{ personalFileIds: string[]; organizationFileIds: string[] }>;
  offboardingPreviewSecret: string;
  now?: () => Date;
  projectionOutbox?: PgGovernanceProjectionOutboxStore;
  projectionReconciler?: GovernanceProjectionReconciler;
  executeUserOffboarding?: ((input: {
    tenantId: string; userId: string; handoffTargetUserId: string;
    idempotencyKey: string; requestedBy: string; reasonCode: string;
    manifest: { baselineDigest: string; baseline: Record<string, unknown> };
  }) => Promise<unknown>) & {
    retry?: (input: { tenantId: string; jobId: string; expectedRevision: number; requestedBy: string }) => Promise<unknown>;
  };
  vault: SecretVault;
  audit: GovernanceAuditStore;
}): Router {
  if (deps.offboardingPreviewSecret.length < 32) {
    throw new Error('offboardingPreviewSecret must contain at least 32 characters');
  }
  const router = Router();
  const skillUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024, files: 300 },
  });
  const now = deps.now ?? (() => new Date());
  const personas = new WeakMap<Request, 'platform_admin' | 'org_admin' | 'member'>();
  const canManageTenant = (req: Request) => {
    const persona = personas.get(req);
    return persona === 'platform_admin' || persona === 'org_admin';
  };
  const canManageOrganization = (req: Request) => personas.get(req) === 'org_admin';
  const hasActiveOffboarding = async (tenantId: string, userId: string): Promise<boolean> => Boolean(
    await deps.changeJobs.findActiveForTarget(tenantId, 'user_offboarding', 'user', userId),
  );
  const canManageSkill = (req: Request, resource: { scope: string; ownerUserId?: string }) => {
    if (resource.scope === 'personal') return resource.ownerUserId === req.user?.sub;
    if (resource.scope === 'platform') return personas.get(req) === 'platform_admin';
    return canManageOrganization(req);
  };
  const canAccessSkill = (req: Request, resource: { scope: string; ownerUserId?: string }) =>
    canManageSkill(req, resource)
    || (resource.scope === 'tenant' && personas.get(req) === 'member' && resource.ownerUserId === req.user?.sub);
  const tenantFor = (req: Request, requested?: string): string | null => {
    if (personas.get(req) === 'platform_admin') return requested ?? req.user?.tenantId ?? null;
    if (!req.user?.tenantId || (requested && requested !== req.user.tenantId)) return null;
    return req.user.tenantId;
  };
  const resourceTenantFor = (req: Request, requested?: string): string | null => {
    if (!req.user?.tenantId || (requested && requested !== req.user.tenantId)) return null;
    return req.user.tenantId;
  };
  const candidateTarget = async (tenantId: string, candidateId: string) => {
    const candidate = await deps.skills.getCandidate(tenantId, candidateId);
    if (!candidate) return null;
    const target = await deps.skills.getResource(candidate.targetSkillId);
    if (!target || target.tenantId !== tenantId || target.scope === 'personal') return null;
    return { candidate, target };
  };
  const buildOffboardingPreview = async (tenantId: string, userId: string, handoffTargetUserId: string) => {
    const optional = <T>(authority?: () => Promise<T>): Promise<T | null> =>
      authority ? authority().catch(() => null) : Promise.resolve(null);
    const [
      targetMembership, handoffMembership, ownedAgents, ownedSkills, ownedCredentials, custodialCredentials,
      cronIds, activeRunIds, activeSessionIds, oauthGrantIds, externalConnectionIds,
      personalMemoryIds, fileOwnership,
    ] = await Promise.all([
      deps.memberships.getMembership(tenantId, userId),
      deps.memberships.getMembership(tenantId, handoffTargetUserId),
      deps.agents.listByOwner(tenantId, userId),
      deps.skills.listPersonalByOwner(tenantId, userId),
      deps.credentials.listForOwner(tenantId, userId),
      deps.credentials.listForCustodian(tenantId, userId),
      optional(deps.listCronIdsByOwner ? () => deps.listCronIdsByOwner!(userId) : undefined),
      optional(deps.listActiveRunIdsByUser ? () => deps.listActiveRunIdsByUser!(tenantId, userId) : undefined),
      optional(deps.listActiveSessionIdsByUser ? () => deps.listActiveSessionIdsByUser!(tenantId, userId) : undefined),
      optional(deps.listActiveOAuthGrantIdsByUser ? () => deps.listActiveOAuthGrantIdsByUser!(tenantId, userId) : undefined),
      optional(deps.listExternalConnectionIdsByUser ? () => deps.listExternalConnectionIdsByUser!(tenantId, userId) : undefined),
      optional(deps.listPersonalMemoryIds ? () => deps.listPersonalMemoryIds!(tenantId, userId) : undefined),
      optional(deps.listFileOwnership ? () => deps.listFileOwnership!(tenantId, userId) : undefined),
    ]);
    if (!targetMembership) return { error: { status: 404, body: { error: 'Target user not found in tenant' } } } as const;
    if (!handoffMembership || handoffMembership.status !== 'active') {
      return { error: { status: 409, body: { error: 'Active handoff target required' } } } as const;
    }
    const organizationAgents = ownedAgents.filter(item => item.kind === 'org_agent' && item.status !== 'archived');
    const personalAgents = ownedAgents.filter(item => item.kind === 'personal_agent' && item.status !== 'archived');
    const personalSkills = ownedSkills.filter(item => item.status !== 'retired');
    const transferableCredentials = custodialCredentials.filter(item => item.status !== 'revoked');
    const blockers = [
      ...(cronIds === null ? [{ code: 'CRON_OWNERSHIP_AUTHORITY_UNAVAILABLE', domain: 'cron_ownership' }] : []),
      ...(activeRunIds === null ? [{ code: 'ACTIVE_RUN_AUTHORITY_UNAVAILABLE', domain: 'runs_sessions' }] : []),
      ...(activeSessionIds === null ? [{ code: 'SESSION_RETENTION_AUTHORITY_UNAVAILABLE', domain: 'runs_sessions' }] : []),
      ...(oauthGrantIds === null ? [{ code: 'OAUTH_GRANT_AUTHORITY_UNAVAILABLE', domain: 'credentials_connectors' }] : []),
      ...(externalConnectionIds === null ? [{ code: 'EXTERNAL_CONNECTION_AUTHORITY_UNAVAILABLE', domain: 'credentials_connectors' }] : []),
      ...(personalMemoryIds === null ? [{ code: 'PERSONAL_MEMORY_AUTHORITY_UNAVAILABLE', domain: 'personal_memory' }] : []),
      ...(fileOwnership === null
        ? [{ code: 'FILE_OWNERSHIP_AUTHORITY_UNAVAILABLE', domain: 'file_ownership' }]
        : fileOwnership.organizationFileIds.map(id => ({
          code: 'ORGANIZATION_FILE_HANDOFF_UNSUPPORTED', domain: 'file_ownership', targetId: id,
        }))),
    ];
    const authoritySummary = (items: Array<{ id: string; version: string }> | null) => ({
      authority: items === null ? 'unavailable' : 'available',
      ids: items?.map(item => item.id) ?? [],
      snapshots: items ?? [],
      count: items?.length ?? 0,
    });
    const baseline = {
      tenantId,
      userId,
      handoffTargetUserId,
      membershipVersions: { target: targetMembership.version, handoff: handoffMembership.version },
      agents: ownedAgents.map(item => ({ id: item.agentId, version: item.revision })),
      skills: ownedSkills.map(item => ({ id: item.skillId, version: item.revision })),
      ownedCredentials: ownedCredentials.map(item => ({ id: item.credentialId, version: item.version })),
      custodialCredentials: custodialCredentials.map(item => ({ id: item.credentialId, version: item.version })),
      cronIds: cronIds ?? [],
      activeRuns: authoritySummary(activeRunIds),
      activeSessions: authoritySummary(activeSessionIds),
      oauthGrants: authoritySummary(oauthGrantIds),
      externalConnections: authoritySummary(externalConnectionIds),
      personalMemoryIds: personalMemoryIds ?? [],
      fileOwnership: fileOwnership ?? { personalFileIds: [], organizationFileIds: [] },
    };
    return {
      baseline,
      impact: {
        membership: 1,
        agents: organizationAgents.map(item => ({ id: item.agentId, kind: item.kind, action: 'transfer' })),
        personalAgents: personalAgents.map(item => ({ id: item.agentId, action: 'archive' })),
        skills: personalSkills.map(item => ({ id: item.skillId, action: 'retain_and_disable' })),
        personalCredentials: ownedCredentials.map(item => ({ id: item.credentialId, action: 'revoke' })),
        custodialCredentials: transferableCredentials.map(item => ({ id: item.credentialId, action: 'transfer_custodian' })),
        cronOwnership: cronIds === null
          ? { status: 'unavailable' }
          : { status: cronIds.length ? 'transfer' : 'clear', ids: cronIds.map(item => item.id) },
        activeRuns: authoritySummary(activeRunIds),
        activeSessions: authoritySummary(activeSessionIds),
        oauthGrants: authoritySummary(oauthGrantIds),
        externalConnections: authoritySummary(externalConnectionIds),
        personalMemory: personalMemoryIds === null
          ? { status: 'unavailable' }
          : { status: personalMemoryIds.length ? 'archive' : 'clear', ids: personalMemoryIds },
        fileOwnership: fileOwnership === null
          ? { status: 'unavailable' }
          : {
            status: fileOwnership.organizationFileIds.length ? 'blocked'
              : fileOwnership.personalFileIds.length ? 'archive' : 'clear',
            ...fileOwnership,
          },
      },
      blockers,
    } as const;
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
    const requestedTenantId = personas.get(req) === 'platform_admin'
      ? (typeof req.query.tenantId === 'string'
          ? req.query.tenantId
          : typeof req.body?.tenantId === 'string' ? req.body.tenantId : user.tenantId)
      : user.tenantId;
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
      res.locals.governanceChangeId = intent.auditId;
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
        targetTenantId: requestedTenantId, purpose: 'typed resource mutation', changeId: intentAuditId,
        result: res.statusCode < 400 ? 'succeeded' : 'failed',
        metadata: { statusCode: res.statusCode },
      }).then(event => {
        const payload = body && typeof body === 'object' && !Array.isArray(body)
          ? { effectiveAt: event.occurredAt, ...(body as Record<string, unknown>), changeId: intentAuditId, auditId: event.auditId }
          : { data: body, changeId: intentAuditId, auditId: event.auditId, effectiveAt: event.occurredAt };
        sendJson(payload);
      }).catch(async () => {
        let auditProjectionId: string | undefined;
        try {
          if (!deps.projectionOutbox) throw new Error('GOVERNANCE_AUDIT_OUTBOX_UNAVAILABLE');
          const projection = await deps.projectionOutbox.enqueue({
            tenantId: requestedTenantId,
            projector: 'audit_terminal',
            idempotencyKey: `${correlationId}:${res.statusCode < 400 ? 'succeeded' : 'failed'}`,
            payload: {
              correlationId,
              actorType: 'user',
              actorUserId: user.sub,
              actorPersona: personas.get(req)!,
              actorTenantId: user.tenantId,
              action: `governance.resource.${req.method.toLowerCase()}`,
              targetType: 'governance_resource_api',
              targetId: req.path,
              targetTenantId: requestedTenantId,
              purpose: 'typed resource mutation',
              changeId: intentAuditId,
              result: res.statusCode < 400 ? 'succeeded' : 'failed',
              metadata: { statusCode: res.statusCode },
            },
          });
          auditProjectionId = projection.outboxId;
          void deps.projectionReconciler?.reconcileOne();
        } catch {
          const changed = (body && typeof body === 'object' && !Array.isArray(body)
            && (body as Record<string, unknown>).changed === true) || res.statusCode < 400;
          res.statusCode = 500;
          sendJson({
            code: 'GOVERNANCE_AUDIT_TERMINAL_NOT_DURABLE',
            error: changed ? '变更已执行，但终态审计未能持久化' : '请求失败且终态审计未能持久化',
            changed,
            auditId: intentAuditId,
          });
          return;
        }
        const payload = body && typeof body === 'object' && !Array.isArray(body)
          ? { ...(body as Record<string, unknown>), changeId: intentAuditId, auditId: intentAuditId, auditCompletion: 'pending', auditProjectionId }
          : { data: body, changeId: intentAuditId, auditId: intentAuditId, auditCompletion: 'pending', auditProjectionId };
        sendJson(payload);
      });
      return res;
    }) as typeof res.json;
    next();
  });

  registerGovernanceAgentResourceRoutes({
    router,
    agents: deps.agents,
    memberships: deps.memberships,
    changeJobs: deps.changeJobs,
    previewSecret: deps.offboardingPreviewSecret,
    personaFor: req => personas.get(req),
    resourceTenantFor,
    ...(deps.projectionOutbox ? { projectionOutbox: deps.projectionOutbox } : {}),
    ...(deps.projectionReconciler ? { projectionReconciler: deps.projectionReconciler } : {}),
    now,
  });

  router.get('/skills/:skillId', async (req, res) => {
    const tenantId = resourceTenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const resource = await deps.skills.getResource(req.params.skillId);
    if (!resource || resource.tenantId !== tenantId) return res.status(404).json({ error: 'Skill not found' });
    if (!canAccessSkill(req, resource)) return res.status(404).json({ error: 'Skill not found' });
    res.json(resource);
  });

  router.get('/connectors', async (_req, res) => {
    res.json({ connectors: await deps.connectors.list() });
  });

  router.get('/credentials', async (req, res) => {
    const tenantId = resourceTenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const credentials = canManageTenant(req)
      ? (await deps.credentials.listForTenant(tenantId)).filter(item => item.kind !== 'personal_grant')
      : await deps.credentials.listForOwner(tenantId, req.user!.sub);
    res.json({ credentials: credentials.map(credentialView) });
  });

  router.get('/environment/providers/:providerId', async (req, res) => {
    if (personas.get(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    const provider = await deps.environments.getProvider(req.params.providerId);
    if (!provider) return res.status(404).json({ error: 'Provider not found' });
    res.json(provider);
  });

  router.get('/environment/templates', async (req, res) => {
    if (personas.get(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    return res.json({ templates: await deps.environments.listTemplates() });
  });

  registerGovernanceResourceCatalogRoutes({ router,
    personaFor: req => personas.get(req), agents: deps.agents, skills: deps.skills,
    connectors: deps.connectors, environments: deps.environments });

  router.get('/environment/templates/:templateId', async (req, res) => {
    const template = await deps.environments.getTemplate(req.params.templateId);
    if (!template) return res.status(404).json({ error: 'Environment Template not found' });
    const version = template.currentVersionId
      ? await deps.environments.getTemplateVersion(template.currentVersionId)
      : null;
    res.json({ template, version });
  });

  router.post('/skills/import', (req, res) => {
    skillUpload.array('files', 300)(req, res, (uploadError) => {
      if (uploadError) {
        const limitExceeded = uploadError instanceof multer.MulterError
          && ['LIMIT_FILE_SIZE', 'LIMIT_FILE_COUNT', 'LIMIT_UNEXPECTED_FILE'].includes(uploadError.code);
        return res.status(limitExceeded ? 413 : 400).json({
          error: limitExceeded
            ? '技能包超出限制：单个文件不能超过 25MB，且最多上传 300 个文件'
            : '技能包上传请求无效',
          code: limitExceeded ? 'SKILL_PACKAGE_LIMIT_EXCEEDED' : 'SKILL_PACKAGE_REQUEST_INVALID',
        });
      }
      void (async () => {
        const scope = req.body?.scope;
        if (scope !== 'tenant' && scope !== 'personal') {
          return res.status(400).json({ error: '技能作用域无效', code: 'SKILL_SCOPE_INVALID' });
        }
        const files = (req.files as Express.Multer.File[] | undefined) ?? [];
        try {
          if (scope === 'personal') {
            if (!deps.importPersonalSkill) {
              return res.status(503).json({ error: '个人技能上传服务暂不可用', code: 'SKILL_UPLOAD_UNAVAILABLE' });
            }
            const tenantId = resourceTenantFor(req);
            if (!tenantId) {
              return res.status(403).json({ error: '当前组织作用域无效', code: 'SKILL_TENANT_SCOPE_DENIED' });
            }
            if (await hasActiveOffboarding(tenantId, req.user!.sub)) {
              return res.status(409).json({ error: '账号正在离职交接，暂不能上传个人技能', code: 'RESOURCE_OWNER_OFFBOARDING_ACTIVE' });
            }
            const result = await deps.importPersonalSkill({
              tenantId,
              actorUserId: req.user!.sub,
              files,
            });
            return res.status(201).json(result);
          }

          if (!deps.importTenantSkill) {
            return res.status(503).json({ error: '组织技能上传服务暂不可用', code: 'SKILL_UPLOAD_UNAVAILABLE' });
          }
          const requestedTenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined;
          if (!requestedTenantId) {
            return res.status(400).json({ error: '请选择目标组织', code: 'SKILL_TENANT_REQUIRED' });
          }
          const persona = personas.get(req);
          if (persona === 'platform_admin') {
            if (!hasPlatformCapability(req.user, 'skill.tenant.manage')) {
              return res.status(403).json({ error: '当前平台管理员无组织技能管理权限', code: 'PLATFORM_CAPABILITY_REQUIRED' });
            }
          } else if (persona !== 'org_admin') {
            return res.status(403).json({ error: '仅组织管理员可以上传组织技能', code: 'ORGANIZATION_ADMIN_REQUIRED' });
          }
          const tenantId = tenantFor(req, requestedTenantId);
          if (!tenantId) {
            return res.status(403).json({ error: '不能向其他组织上传技能', code: 'SKILL_TENANT_SCOPE_DENIED' });
          }
          if (deps.tenantExists && !deps.tenantExists(tenantId)) {
            return res.status(404).json({ error: '目标组织不存在', code: 'SKILL_TENANT_NOT_FOUND' });
          }
          const result = await deps.importTenantSkill({
            tenantId,
            actorUserId: req.user!.sub,
            files,
          });
          return res.status(201).json(result);
        } catch (error) {
          if (error instanceof SkillPackageUploadError) {
            return res.status(error.status).json({ error: error.message, code: error.code });
          }
          serverLogger.error(`Governance Skill upload failed: ${error}`);
          return res.status(500).json({ error: '技能上传失败，请稍后重试', code: 'SKILL_UPLOAD_FAILED' });
        }
      })();
    });
  });

  router.post('/skills', async (req, res) => {
    const parsed = createSkillSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = resourceTenantFor(req, parsed.data.tenantId);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    if (parsed.data.scope === 'tenant' && !canManageOrganization(req)) return res.status(403).json({ error: 'Organization admin required' });
    if (parsed.data.scope === 'platform' && personas.get(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    const ownerUserId = parsed.data.scope === 'personal' ? req.user!.sub : parsed.data.ownerUserId;
    if (parsed.data.scope === 'personal' && parsed.data.ownerUserId && parsed.data.ownerUserId !== req.user!.sub) {
      return res.status(403).json({ error: 'Personal Skill owner mismatch' });
    }
    if (ownerUserId && await hasActiveOffboarding(tenantId, ownerUserId)) {
      return res.status(409).json({ error: 'Resource owner offboarding is active', code: 'RESOURCE_OWNER_OFFBOARDING_ACTIVE' });
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
    const parsed = publishSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = resourceTenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const resource = await deps.skills.getResource(req.params.skillId);
    if (!resource || resource.tenantId !== tenantId || !canManageSkill(req, resource)) {
      return res.status(404).json({ error: 'Skill not found' });
    }
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
    const tenantId = resourceTenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const target = await deps.skills.getResource(req.params.skillId);
    if (!target || target.tenantId !== tenantId || target.scope === 'personal') {
      return res.status(404).json({ error: 'Skill not found' });
    }
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
    const tenantId = resourceTenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const target = await candidateTarget(tenantId, req.params.candidateId);
    if (!target || target.candidate.ownerUserId !== req.user!.sub) {
      return res.status(404).json({ error: 'Skill candidate not found' });
    }
    try {
      res.json(await deps.skills.submitCandidate(tenantId, req.params.candidateId, req.user!.sub, parsed.data.expectedRevision));
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/skill-candidates/:candidateId/review', async (req, res) => {
    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = resourceTenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const target = await candidateTarget(tenantId, req.params.candidateId);
    if (!target) return res.status(404).json({ error: 'Skill candidate not found' });
    if (!canManageSkill(req, target.target)) return res.status(403).json({ error: 'Admin required' });
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
    const parsed = publishCandidateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = resourceTenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const target = await candidateTarget(tenantId, req.params.candidateId);
    if (!target) return res.status(404).json({ error: 'Skill candidate not found' });
    if (!canManageSkill(req, target.target)) return res.status(403).json({ error: 'Admin required' });
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
    return res.status(503).json({
      error: 'Signed Connector version publish authority unavailable',
      code: 'GOVERNANCE_PREVIEW_AUTHORITY_UNAVAILABLE',
    });
  });

  router.patch('/connectors/:connectorId/status', async (req, res) => {
    if (personas.get(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    const parsed = connectorStatusSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    return res.status(503).json({
      error: 'Signed Connector lifecycle authority unavailable',
      code: 'GOVERNANCE_PREVIEW_AUTHORITY_UNAVAILABLE',
    });
  });

  router.post('/credentials', async (req, res) => {
    const parsed = credentialCreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = resourceTenantFor(req, parsed.data.tenantId);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    if (parsed.data.kind === 'org_shared' && !canManageOrganization(req)) return res.status(403).json({ error: 'Admin required' });
    if (parsed.data.kind === 'infrastructure' && personas.get(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    const connector = await deps.connectors.get(parsed.data.connectorId);
    if (!connector || connector.status !== 'published') {
      return res.status(409).json({ error: 'Connector unavailable', code: 'CONNECTOR_NOT_PUBLISHED' });
    }
    const ownerUserId = parsed.data.kind === 'personal_grant' ? req.user!.sub : undefined;
    const custodianUserId = parsed.data.kind === 'org_shared' ? parsed.data.custodianUserId ?? req.user!.sub : undefined;
    const responsibleUserId = ownerUserId ?? custodianUserId;
    if (responsibleUserId) {
      const membership = await deps.memberships.getMembership(tenantId, responsibleUserId);
      if (!membership || membership.status !== 'active') {
        return res.status(409).json({ error: 'Active in-tenant Credential owner/custodian required', code: 'CREDENTIAL_CUSTODIAN_MEMBERSHIP_REQUIRED' });
      }
      if (await hasActiveOffboarding(tenantId, responsibleUserId)) {
        return res.status(409).json({ error: 'Credential owner/custodian offboarding is active', code: 'CREDENTIAL_SUBJECT_OFFBOARDING_ACTIVE' });
      }
    }
    const vaultCaller = {
      actor: 'connector_proxy' as const,
      userId: ownerUserId ?? custodianUserId ?? req.user!.sub,
      tenantId,
      scopes: ['secret:connector:write'],
    };
    const vaultOwnerId = parsed.data.kind === 'org_shared'
      ? tenantOwnerId(tenantId)
      : parsed.data.kind === 'infrastructure'
        ? GLOBAL_OWNER_ID
        : vaultCaller.userId;
    let secretRef: string | undefined;
    try {
      const secret = await deps.vault.putSecret(
        vaultOwnerId,
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
    const tenantId = resourceTenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const current = await deps.credentials.get(req.params.credentialId);
    if (!current || current.tenantId !== tenantId) return res.status(404).json({ error: 'Credential not found' });
    if (current.kind === 'personal_grant' && current.ownerUserId !== req.user!.sub) {
      return res.status(404).json({ error: 'Credential not found' });
    }
    if (current.kind === 'org_shared' && !canManageOrganization(req)) {
      return res.status(403).json({ error: 'Organization admin required' });
    }
    if (current.kind === 'infrastructure' && personas.get(req) !== 'platform_admin') {
      return res.status(403).json({ error: 'Platform admin required' });
    }
    if (parsed.data.status === 'suspended' || parsed.data.status === 'revoked') {
      return res.status(409).json({ error: 'Signed impact preview required', code: 'GOVERNANCE_PREVIEW_REQUIRED' });
    }
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
    return res.status(503).json({
      error: 'Signed Environment Provider change authority unavailable',
      code: 'GOVERNANCE_PREVIEW_AUTHORITY_UNAVAILABLE',
    });
  });

  router.post('/environment/templates/:templateId/versions', async (req, res) => {
    if (personas.get(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    const parsed = environmentTemplateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    return res.status(503).json({
      error: 'Signed Environment Template publish authority unavailable',
      code: 'GOVERNANCE_PREVIEW_AUTHORITY_UNAVAILABLE',
    });
  });

  router.post('/environment/templates/:templateId/retire', (req, res) => {
    if (personas.get(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    const parsed = expectedRevisionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    return res.status(503).json({
      error: 'Signed Environment Template retirement authority unavailable',
      code: 'GOVERNANCE_PREVIEW_AUTHORITY_UNAVAILABLE',
    });
  });

  router.get('/change-jobs/:jobId', async (req, res) => {
    const tenantId = tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const job = await deps.changeJobs.get(tenantId, req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Change Job not found' });
    const domains = await deps.changeJobs.listDomains(tenantId, job.jobId);
    res.json({ job, domains });
  });

  router.post('/change-jobs/:jobId/retry', async (req, res) => {
    if (!canManageTenant(req)) return res.status(403).json({ error: 'Admin required' });
    const parsed = expectedRevisionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const job = await deps.changeJobs.get(tenantId, req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Change Job not found' });
    if (job.jobType !== 'user_offboarding' || !deps.executeUserOffboarding?.retry) {
      return res.status(503).json({
        error: 'Change Job retry worker unavailable', code: 'CHANGE_JOB_RETRY_WORKER_UNAVAILABLE',
      });
    }
    const handoff = job.request.handoffTarget as { userId?: unknown } | undefined;
    const manifest = job.request.manifest as { baselineDigest?: unknown } | undefined;
    if (typeof handoff?.userId !== 'string' || typeof manifest?.baselineDigest !== 'string') {
      return res.status(409).json({ error: 'Offboarding manifest invalid', code: 'OFFBOARDING_MANIFEST_INVALID' });
    }
    const currentPreview = await buildOffboardingPreview(tenantId, job.targetId, handoff.userId);
    if ('error' in currentPreview && currentPreview.error) return res.status(currentPreview.error.status).json(currentPreview.error.body);
    if (governanceDigest(currentPreview.baseline) !== manifest.baselineDigest) {
      return res.status(409).json({
        error: 'Offboarding inventory changed after commit', code: 'OFFBOARDING_RESUME_MANIFEST_STALE',
      });
    }
    try {
      const result = await deps.executeUserOffboarding.retry({
        tenantId, jobId: job.jobId, expectedRevision: parsed.data.expectedRevision,
        requestedBy: req.user!.sub,
      });
      return res.status(202).json(result);
    } catch (error) {
      return res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/previews/resource-retirement', async (req, res) => {
    const tenantId = resourceTenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    const targetType = typeof req.query.targetType === 'string' ? req.query.targetType : '';
    const targetId = typeof req.query.targetId === 'string' ? req.query.targetId : '';
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    if (!targetType || !targetId) return res.status(400).json({ error: 'targetType and targetId are required' });
    res.json(await deps.changePlanner.previewResourceRetirement(tenantId, targetType, targetId));
  });

  router.get('/previews/credentials/:credentialId', async (req, res) => {
    const tenantId = resourceTenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    const action = req.query.action === 'revoke' ? 'revoke' : req.query.action === 'suspend' ? 'suspend' : undefined;
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    if (!action) return res.status(400).json({ error: 'action must be suspend or revoke' });
    try {
      res.json(await deps.changePlanner.previewCredentialChange(tenantId, req.params.credentialId, action));
    } catch (error) {
      res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/previews/user-offboarding', async (req, res) => {
    if (!canManageTenant(req)) return res.status(403).json({ error: 'Admin required' });
    const parsed = userOffboardingPreviewSchema.safeParse(req.body);
    if (!parsed.success || parsed.data.userId === parsed.data.handoffTargetUserId) {
      return res.status(400).json({ error: 'Invalid body' });
    }
    const tenantId = tenantFor(req, parsed.data.tenantId);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    if (deps.resolveUserTenantId) {
      const targetTenant = deps.resolveUserTenantId(parsed.data.userId);
      const handoffTenant = deps.resolveUserTenantId(parsed.data.handoffTargetUserId);
      if (targetTenant !== tenantId || handoffTenant !== tenantId) {
        return res.status(409).json({ error: 'Governance and legacy tenant identity mismatch' });
      }
    }
    const preview = await buildOffboardingPreview(tenantId, parsed.data.userId, parsed.data.handoffTargetUserId);
    if ('error' in preview && preview.error) return res.status(preview.error.status).json(preview.error.body);
    const baselineDigest = governanceDigest(preview.baseline);
    const expiresAt = new Date(now().getTime() + 5 * 60_000).toISOString();
    const idempotencyKey = `offboard-${randomUUID()}`;
    const signatureInput = {
      version: 1,
      actorUserId: req.user!.sub,
      tenantId,
      userId: parsed.data.userId,
      handoffTargetUserId: parsed.data.handoffTargetUserId,
      reasonCode: parsed.data.reasonCode,
      idempotencyKey,
      baselineDigest,
      expiresAt,
    };
    return res.json({
      previewId: signedPreviewId('opv1', deps.offboardingPreviewSecret, signatureInput),
      idempotencyKey,
      baselineDigest,
      expiresAt,
      impact: preview.impact,
      blockers: preview.blockers,
      canCommit: preview.blockers.length === 0,
      changeId: res.locals.governanceChangeId,
    });
  });

  router.post('/change-jobs/user-offboarding', async (req, res) => {
    if (!canManageTenant(req)) return res.status(403).json({ error: 'Admin required' });
    if (!deps.executeUserOffboarding) return res.status(503).json({ error: 'Offboarding worker unavailable' });
    const parsed = userOffboardingJobSchema.safeParse(req.body);
    if (!parsed.success || parsed.data.userId === parsed.data.handoffTargetUserId) {
      return res.status(400).json({ error: 'Invalid body' });
    }
    const tenantId = tenantFor(req, parsed.success ? parsed.data.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    if (Date.parse(parsed.data.expiresAt) <= now().getTime()) {
      return res.status(409).json({ error: 'Offboarding preview expired', code: 'OFFBOARDING_PREVIEW_EXPIRED' });
    }
    const expectedPreviewId = signedPreviewId('opv1', deps.offboardingPreviewSecret, {
      version: 1,
      actorUserId: req.user!.sub,
      tenantId,
      userId: parsed.data.userId,
      handoffTargetUserId: parsed.data.handoffTargetUserId,
      reasonCode: parsed.data.reasonCode,
      idempotencyKey: parsed.data.idempotencyKey,
      baselineDigest: parsed.data.baselineDigest,
      expiresAt: parsed.data.expiresAt,
    });
    if (!previewMatches(parsed.data.previewId, expectedPreviewId)) {
      return res.status(409).json({ error: 'Offboarding preview invalid', code: 'OFFBOARDING_PREVIEW_INVALID' });
    }
    if (deps.resolveUserTenantId) {
      const targetLegacyTenant = deps.resolveUserTenantId(parsed.data.userId);
      const handoffLegacyTenant = deps.resolveUserTenantId(parsed.data.handoffTargetUserId);
      if (targetLegacyTenant !== tenantId || handoffLegacyTenant !== tenantId) {
        return res.status(409).json({ error: 'Governance and legacy tenant identity mismatch' });
      }
    }
    const preview = await buildOffboardingPreview(tenantId, parsed.data.userId, parsed.data.handoffTargetUserId);
    if ('error' in preview && preview.error) return res.status(preview.error.status).json(preview.error.body);
    if (governanceDigest(preview.baseline) !== parsed.data.baselineDigest) {
      return res.status(409).json({ error: 'Offboarding baseline changed', code: 'OFFBOARDING_PREVIEW_BASELINE_CONFLICT' });
    }
    if (preview.blockers.length > 0) {
      return res.status(409).json({ error: 'Offboarding blockers remain', code: 'OFFBOARDING_BLOCKED', blockers: preview.blockers });
    }
    try {
      const result = await deps.executeUserOffboarding({
        tenantId,
        userId: parsed.data.userId,
        handoffTargetUserId: parsed.data.handoffTargetUserId,
        idempotencyKey: parsed.data.idempotencyKey,
        reasonCode: parsed.data.reasonCode,
        requestedBy: req.user!.sub,
        manifest: { baselineDigest: parsed.data.baselineDigest, baseline: preview.baseline },
      });
      res.status(202).json(result);
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/previews/tenant-delete', (req, res) => {
    if (personas.get(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    return res.status(503).json({ error: 'Tenant deletion inventory authority unavailable', code: 'TENANT_DELETE_INVENTORY_AUTHORITY_UNAVAILABLE' });
  });

  router.post('/change-jobs/tenant-delete', (req, res) => {
    if (personas.get(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    return res.status(503).json({ error: 'Tenant deletion inventory authority unavailable', code: 'TENANT_DELETE_INVENTORY_AUTHORITY_UNAVAILABLE' });
  });

  router.post('/change-jobs/resource-retire', (req, res) => {
    if (!canManageTenant(req)) return res.status(403).json({ error: 'Admin required' });
    return res.status(503).json({ error: 'Signed resource retirement authority unavailable', code: 'GOVERNANCE_PREVIEW_AUTHORITY_UNAVAILABLE' });
  });

  router.post('/change-jobs/credential-revoke', (req, res) => {
    if (!canManageTenant(req)) return res.status(403).json({ error: 'Admin required' });
    return res.status(503).json({ error: 'Signed credential revocation authority unavailable', code: 'GOVERNANCE_PREVIEW_AUTHORITY_UNAVAILABLE' });
  });

  return router;
}
