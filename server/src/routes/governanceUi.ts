import { Router } from 'express';
import { z } from 'zod';

import {
  isForbiddenGovernanceField,
  managementSnapshotRequestV1Schema,
  managementSnapshotResponseV1Schema,
} from '../../../shared/src/types/governance.js';
import {
  AuthoritativeGovernanceService,
  GOVERNANCE_UI_DOMAINS,
  GovernanceUiError,
  type AuthoritativeGovernanceDeps,
  type GovernanceEvaluationCommand,
  type GovernanceUiDomain,
} from '../governance/ui/authoritativeService.js';
import {
  ManagementSnapshotError,
  ManagementSnapshotService,
  type ManagementSnapshotDeps,
} from '../governance/ui/managementSnapshotService.js';
import { isActivePlatformAdminIdentity } from '../governance/subject/platformIdentity.js';

const resourceSchema = z.object({
  type: z.string().min(1).max(80),
  id: z.string().min(1).max(200),
  tenantId: z.string().min(1).max(128).optional(),
  displayName: z.string().min(1).max(300).optional(),
  domain: z.enum(GOVERNANCE_UI_DOMAINS),
}).strict();
const commandSchema = z.object({
  action: z.string().min(1).max(100),
  resource: resourceSchema,
  subjectUserId: z.string().min(1).max(128).optional(),
}).strict();
function assertSafe(value: unknown): void {
  if (Array.isArray(value)) return void value.forEach(assertSafe);
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (isForbiddenGovernanceField(key)) throw new GovernanceUiError(500, 'UNSAFE_GOVERNANCE_DTO', '治理响应包含禁止字段');
    assertSafe(child);
  }
}

function errorResponse(error: unknown): { status: number; body: { code: string; message: string } } {
  if (error instanceof GovernanceUiError || error instanceof ManagementSnapshotError) {
    return { status: error.status, body: { code: error.code, message: error.message } };
  }
  return { status: 503, body: { code: 'GOVERNANCE_DEPENDENCY_UNAVAILABLE', message: '治理权威依赖不可用' } };
}

type GovernanceUiTenantDeps = AuthoritativeGovernanceDeps['tenants'] & {
  findByIdStrict?: ManagementSnapshotDeps['tenants']['findByIdStrict'];
};

export type GovernanceUiRouterDeps = Partial<Omit<AuthoritativeGovernanceDeps, 'tenants'>> & {
  tenants?: GovernanceUiTenantDeps;
  service?: Pick<AuthoritativeGovernanceService, 'evaluate' | 'preflight' | 'effectiveResources'>;
  managementSnapshotService?: Pick<ManagementSnapshotService, 'createSnapshot'>;
};

function completeManagement(deps: GovernanceUiRouterDeps): deps is GovernanceUiRouterDeps & ManagementSnapshotDeps {
  return Boolean(deps.users && deps.tenants && typeof deps.tenants.findByIdStrict === 'function'
    && deps.memberships && deps.audit);
}

function complete(deps: GovernanceUiRouterDeps): deps is AuthoritativeGovernanceDeps {
  return Boolean(deps.users && deps.tenants && deps.memberships && deps.entitlements && deps.assignments
    && deps.agents && deps.skills && deps.connectors && deps.credentials && deps.environments && deps.audit);
}

export function createGovernanceUiRouter(deps: GovernanceUiRouterDeps): Router {
  const router = Router();
  const service = deps.service ?? (complete(deps) ? new AuthoritativeGovernanceService(deps) : undefined);
  const managementSnapshotService = deps.managementSnapshotService
    ?? (completeManagement(deps) ? new ManagementSnapshotService(deps) : undefined);

  router.post('/api/access/management-snapshot', async (req, res) => {
    if (!req.user) return res.status(401).json({ code: 'UNAUTHORIZED', message: '未登录' });
    if (!managementSnapshotService) {
      return res.status(503).json({ code: 'GOVERNANCE_DEPENDENCY_UNAVAILABLE', message: '治理权威依赖不可用' });
    }
    const parsed = managementSnapshotRequestV1Schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'INVALID_MANAGEMENT_SNAPSHOT_REQUEST', message: '管理权限快照请求无效' });
    }
    try {
      const value = await managementSnapshotService.createSnapshot(req.user.sub, parsed.data);
      assertSafe(value);
      res.json(managementSnapshotResponseV1Schema.parse(value));
    } catch (error) {
      const response = errorResponse(error);
      res.status(response.status).json(response.body);
    }
  });

  router.post('/api/access/evaluate', async (req, res) => {
    if (!req.user) return res.status(401).json({ code: 'UNAUTHORIZED', message: '未登录' });
    if (!service) return res.status(503).json({ code: 'GOVERNANCE_DEPENDENCY_UNAVAILABLE', message: '治理权威依赖不可用' });
    const parsed = commandSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ code: 'INVALID_GOVERNANCE_REQUEST', message: '请求格式无效' });
    try {
      const value = await service.evaluate(req.user.sub, parsed.data as GovernanceEvaluationCommand);
      assertSafe(value);
      res.json(value);
    } catch (error) {
      const response = errorResponse(error);
      res.status(response.status).json(response.body);
    }
  });

  router.post('/api/execution/preflight', async (req, res) => {
    if (!req.user) return res.status(401).json({ code: 'UNAUTHORIZED', message: '未登录' });
    if (!service) return res.status(503).json({ code: 'GOVERNANCE_DEPENDENCY_UNAVAILABLE', message: '治理权威依赖不可用' });
    const parsed = commandSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ code: 'INVALID_GOVERNANCE_REQUEST', message: '请求格式无效' });
    try {
      const value = await service.preflight(req.user.sub, parsed.data as GovernanceEvaluationCommand);
      assertSafe(value);
      res.json(value);
    } catch (error) {
      const response = errorResponse(error);
      res.status(response.status).json(response.body);
    }
  });

  router.get('/api/me/governance-summary', async (req, res) => {
    if (!req.user) return res.status(401).json({ code: 'UNAUTHORIZED', message: '未登录' });
    if (!deps.memberships) return res.status(503).json({ code: 'GOVERNANCE_DEPENDENCY_UNAVAILABLE', message: '治理权威依赖不可用' });
    try {
      const platformAdmin = await deps.memberships.getPlatformAdmin(req.user.sub);
      if (isActivePlatformAdminIdentity(req.user.tenantId, platformAdmin)) {
        return res.json({ persona: 'platform_admin', label: '平台管理员', desktopPath: '/platform-console/overview/overview', attention: { status: 'desktop_required' } });
      }
      const membership = await deps.memberships.getMembership(req.user.tenantId, req.user.sub);
      if (!membership || membership.status !== 'active') {
        return res.status(403).json({ code: 'GOVERNANCE_MEMBERSHIP_INACTIVE', message: '治理成员身份不可用' });
      }
      return res.json(membership.persona === 'org_admin'
        ? { persona: 'org_admin', label: '组织管理员', desktopPath: '/organization-console/overview/overview', attention: { status: 'desktop_required' } }
        : { persona: 'member', label: '普通成员', desktopPath: '/settings/my-agent', attention: { status: 'none' } });
    } catch {
      return res.status(503).json({ code: 'GOVERNANCE_DEPENDENCY_UNAVAILABLE', message: '治理权威依赖不可用' });
    }
  });

  router.get('/api/me/effective-resources', async (req, res) => {
    if (!req.user) return res.status(401).json({ code: 'UNAUTHORIZED', message: '未登录' });
    if (!service) return res.status(503).json({ code: 'GOVERNANCE_DEPENDENCY_UNAVAILABLE', message: '治理权威依赖不可用' });
    const raw = typeof req.query.domains === 'string' && req.query.domains ? req.query.domains.split(',') : [];
    if (raw.some(domain => !GOVERNANCE_UI_DOMAINS.includes(domain as GovernanceUiDomain))) {
      return res.status(400).json({ code: 'INVALID_GOVERNANCE_REQUEST', message: 'domains 无效' });
    }
    try {
      const value = await service.effectiveResources(req.user.sub, raw as GovernanceUiDomain[]);
      assertSafe(value);
      res.json(value);
    } catch (error) {
      const response = errorResponse(error);
      res.status(response.status).json(response.body);
    }
  });

  return router;
}
