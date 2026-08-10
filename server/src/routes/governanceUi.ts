import { Router } from 'express';
import { z } from 'zod';

import { isForbiddenGovernanceField } from '../../../shared/src/types/governance.js';
import {
  AuthoritativeGovernanceService,
  GOVERNANCE_UI_DOMAINS,
  GovernanceUiError,
  type AuthoritativeGovernanceDeps,
  type GovernanceEvaluationCommand,
  type GovernanceUiDomain,
} from '../governance/ui/authoritativeService.js';

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
  if (error instanceof GovernanceUiError) {
    return { status: error.status, body: { code: error.code, message: error.message } };
  }
  return { status: 503, body: { code: 'GOVERNANCE_DEPENDENCY_UNAVAILABLE', message: '治理权威依赖不可用' } };
}

export type GovernanceUiRouterDeps = Partial<AuthoritativeGovernanceDeps> & {
  service?: Pick<AuthoritativeGovernanceService, 'evaluate' | 'preflight' | 'effectiveResources'>;
};

function complete(deps: GovernanceUiRouterDeps): deps is AuthoritativeGovernanceDeps {
  return Boolean(deps.users && deps.tenants && deps.memberships && deps.entitlements && deps.assignments
    && deps.agents && deps.skills && deps.connectors && deps.credentials && deps.environments && deps.audit);
}

export function createGovernanceUiRouter(deps: GovernanceUiRouterDeps): Router {
  const router = Router();
  const service = deps.service ?? (complete(deps) ? new AuthoritativeGovernanceService(deps) : undefined);

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
