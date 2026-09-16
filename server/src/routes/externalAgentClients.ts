import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { isPlatformAdmin } from '../auth/types.js';
import {
  EXTERNAL_CLIENT_SCOPES,
  generateExternalApiKey,
  toExternalClientView,
  type ExternalClientRecord,
  type ExternalClientScope,
  type ExternalClientStore,
} from '../data/externalClients/index.js';
import { checkTenantAccess } from '../data/tenants/access.js';
import { TENANT_SLUG_PATTERN } from '../data/tenants/types.js';
import type { TenantStore } from '../data/tenants/store.js';
import type { UserStore } from '../data/users/store.js';
import type { OrgAgentStore } from '../data/orgAgents/store.js';

const createSchema = z.object({
  tenantId: z.string().regex(TENANT_SLUG_PATTERN).optional(),
  serviceAccountUserId: z.string().min(1).max(128),
  name: z.string().trim().min(1).max(120),
  scopes: z.array(z.enum(EXTERNAL_CLIENT_SCOPES)).min(1).optional(),
  allowedConnectionIds: z.array(z.string().trim().min(1).max(128)).max(100).optional(),
  allowedAgentIds: z.array(z.string().trim().min(1).max(128)).max(100).optional(),
  expiresAt: z.iso.datetime().optional(),
});

const listSchema = z.object({
  tenantId: z.string().regex(TENANT_SLUG_PATTERN).optional(),
});

export interface ExternalAgentClientsRouterDeps {
  store?: ExternalClientStore;
  userStore?: UserStore;
  tenantStore?: TenantStore;
  orgAgentStore?: Pick<OrgAgentStore, 'get'>;
}

function requireDependencies(
  deps: ExternalAgentClientsRouterDeps,
  res: Response,
): deps is Required<Pick<ExternalAgentClientsRouterDeps, 'store' | 'userStore'>> &
  ExternalAgentClientsRouterDeps {
  if (deps.store && deps.userStore) return true;
  res.status(503).json({
    error: 'External Agent API client store unavailable',
    code: 'external_agent_unavailable',
  });
  return false;
}

function resolveTenantId(req: Request, requestedTenantId?: string): string | undefined {
  if (!req.user) return undefined;
  if (isPlatformAdmin(req.user)) return requestedTenantId;
  return req.user.tenantId;
}

function canAccessRecord(req: Request, record: ExternalClientRecord): boolean {
  return isPlatformAdmin(req.user) || record.tenantId === req.user?.tenantId;
}

function validateServiceAccount(
  deps: Required<Pick<ExternalAgentClientsRouterDeps, 'userStore'>> &
    ExternalAgentClientsRouterDeps,
  tenantId: string,
  serviceAccountUserId: string,
): { ok: true } | { ok: false; status: number; code: string; error: string } {
  const tenantAccess = checkTenantAccess(deps.tenantStore, tenantId);
  if (!tenantAccess.ok)
    return { ok: false, status: 409, code: 'tenant_unavailable', error: tenantAccess.message };
  if (deps.tenantStore?.getSettings(tenantId)?.features.personalAgentEnabled === false) {
    return {
      ok: false,
      status: 409,
      code: 'personal_agent_unavailable',
      error: '该组织未开放个人 Agent',
    };
  }
  const account = deps.userStore.findById(serviceAccountUserId);
  if (!account || account.tenantId !== tenantId) {
    return { ok: false, status: 404, code: 'service_account_not_found', error: '专用账号不存在' };
  }
  if (account.role !== 'user') {
    return {
      ok: false,
      status: 409,
      code: 'invalid_service_account',
      error: '专用账号必须是普通用户账号',
    };
  }
  if (account.disabled) {
    return { ok: false, status: 409, code: 'account_disabled', error: '专用账号已停用' };
  }
  return { ok: true };
}

export function createExternalAgentClientsAdminRouter(
  deps: ExternalAgentClientsRouterDeps,
): Router {
  const router = Router();

  router.use((req, res, next) => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (req.user.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }
    next();
  });

  router.get('/', async (req, res) => {
    if (!requireDependencies(deps, res)) return;
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query', issues: parsed.error.issues });
      return;
    }
    const tenantId = resolveTenantId(req, parsed.data.tenantId);
    if (isPlatformAdmin(req.user) && !tenantId) {
      res.status(400).json({ error: 'tenantId required', code: 'tenant_id_required' });
      return;
    }
    const records = await deps.store.list(tenantId);
    res.json({ clients: records.map((record) => toExternalClientView(record)) });
  });

  router.post('/', async (req, res) => {
    if (!requireDependencies(deps, res)) return;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid body', issues: parsed.error.issues });
      return;
    }
    const tenantId = resolveTenantId(req, parsed.data.tenantId);
    if (!tenantId) {
      res.status(400).json({ error: 'tenantId required', code: 'tenant_id_required' });
      return;
    }
    if (parsed.data.expiresAt && new Date(parsed.data.expiresAt).getTime() <= Date.now()) {
      res.status(400).json({ error: 'expiresAt must be in the future', code: 'invalid_expiry' });
      return;
    }
    const accountValidation = validateServiceAccount(
      deps,
      tenantId,
      parsed.data.serviceAccountUserId,
    );
    if (!accountValidation.ok) {
      res
        .status(accountValidation.status)
        .json({ error: accountValidation.error, code: accountValidation.code });
      return;
    }

    const key = generateExternalApiKey();
    const allowedAgentIds = [...new Set(parsed.data.allowedAgentIds ?? [])];
    if (
      allowedAgentIds.some((id) => {
        const agent = deps.orgAgentStore?.get(id);
        return !agent || agent.tenantId !== tenantId || !agent.enabled;
      })
    ) {
      res.status(404).json({ error: 'Agent not found', code: 'agent_not_found' });
      return;
    }
    const record = await deps.store.create({
      tenantId,
      serviceAccountUserId: parsed.data.serviceAccountUserId,
      name: parsed.data.name,
      keyHash: key.keyHash,
      keyPrefix: key.keyPrefix,
      scopes: (parsed.data.scopes ?? [...EXTERNAL_CLIENT_SCOPES]) as ExternalClientScope[],
      allowedConnectionIds: [...new Set(parsed.data.allowedConnectionIds ?? [])],
      allowedAgentIds,
      ...(parsed.data.expiresAt ? { expiresAt: parsed.data.expiresAt } : {}),
      actorUserId: req.user!.sub,
    });
    res.status(201).json({ client: toExternalClientView(record), apiKey: key.apiKey });
  });

  router.post('/:clientId/rotate-key', async (req, res) => {
    if (!requireDependencies(deps, res)) return;
    const record = await deps.store.get(req.params.clientId);
    if (!record || !canAccessRecord(req, record)) {
      res.status(404).json({ error: 'API Client not found', code: 'api_client_not_found' });
      return;
    }
    if (record.status !== 'active') {
      res
        .status(409)
        .json({ error: 'Revoked API Client cannot be rotated', code: 'api_client_revoked' });
      return;
    }
    const key = generateExternalApiKey();
    const updated = await deps.store.rotateKey({
      clientId: record.clientId,
      keyHash: key.keyHash,
      keyPrefix: key.keyPrefix,
      actorUserId: req.user!.sub,
    });
    if (!updated) {
      res
        .status(409)
        .json({ error: 'API Client changed concurrently', code: 'api_client_conflict' });
      return;
    }
    res.json({ client: toExternalClientView(updated), apiKey: key.apiKey });
  });

  router.post('/:clientId/revoke', async (req, res) => {
    if (!requireDependencies(deps, res)) return;
    const record = await deps.store.get(req.params.clientId);
    if (!record || !canAccessRecord(req, record)) {
      res.status(404).json({ error: 'API Client not found', code: 'api_client_not_found' });
      return;
    }
    const updated = await deps.store.revoke({
      clientId: record.clientId,
      actorUserId: req.user!.sub,
    });
    res.json({ client: toExternalClientView(updated!) });
  });

  router.put('/:clientId/agents', async (req, res) => {
    if (!requireDependencies(deps, res)) return;
    const parsed = z
      .object({ agentIds: z.array(z.string().trim().min(1).max(128)).max(100) })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid body', issues: parsed.error.issues });
      return;
    }
    const record = await deps.store.get(req.params.clientId);
    if (!record || !canAccessRecord(req, record)) {
      res.status(404).json({ error: 'API Client not found', code: 'api_client_not_found' });
      return;
    }
    const agentIds = [...new Set(parsed.data.agentIds)];
    if (
      agentIds.some((id) => {
        const agent = deps.orgAgentStore?.get(id);
        return !agent || agent.tenantId !== record.tenantId || !agent.enabled;
      })
    ) {
      res.status(404).json({ error: 'Agent not found', code: 'agent_not_found' });
      return;
    }
    const updated = await deps.store.setAllowedAgentIds({
      clientId: record.clientId,
      tenantId: record.tenantId,
      allowedAgentIds: agentIds,
      actorUserId: req.user!.sub,
    });
    if (!updated) {
      res
        .status(409)
        .json({ error: 'API Client changed concurrently', code: 'api_client_conflict' });
      return;
    }
    res.json({ client: toExternalClientView(updated) });
  });

  return router;
}
