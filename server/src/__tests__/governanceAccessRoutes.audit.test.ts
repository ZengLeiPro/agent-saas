import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JwtPayload } from '../auth/types.js';
import { MembershipInvariantError, type TenantMembership } from '../data/memberships/index.js';
import type { OAuthGrant } from '../data/oauthGrants/types.js';
import type { BillingMemberBudgetOverview } from '../data/billing/types.js';
import { createGovernanceAccessRouter } from '../routes/governanceAccess.js';

const PREVIEW_SECRET = 'governance-membership-preview-test-secret-2026';
const NOW = '2026-08-10T09:00:00.000Z';
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function membership(overrides: Partial<TenantMembership> = {}): TenantMembership {
  return {
    tenantId: 'tenant-a',
    userId: 'user-2',
    persona: 'member',
    isOwner: false,
    status: 'active',
    source: 'governance',
    version: 1,
    createdAt: NOW,
    createdBy: 'system',
    updatedAt: NOW,
    updatedBy: 'system',
    ...overrides,
  };
}

async function rig(input: {
  user?: JwtPayload;
  actor?: TenantMembership;
  target?: TenantMembership;
  memberships?: TenantMembership[];
  getMembership?: ReturnType<typeof vi.fn>;
  auditAppend?: ReturnType<typeof vi.fn>;
  auditList?: ReturnType<typeof vi.fn>;
  updateMembership?: ReturnType<typeof vi.fn>;
  replaceAssignments?: ReturnType<typeof vi.fn>;
  getAssignmentSet?: ReturnType<typeof vi.fn>;
  listEffectiveResources?: ReturnType<typeof vi.fn>;
  resolveAssignmentResource?: (tenantId: string, resourceType: string, resourceId: string) => Promise<'valid' | 'not_found' | 'unavailable'>;
  resolveEntitlementResource?: (resourceType: string, resourceId: string) => Promise<{ status: 'valid'; version: number } | { status: 'not_found' | 'unavailable' }>;
  listEntitlementResources?: (resourceType: string) => Promise<{ status: 'valid'; items: Array<{ resourceId: string; version: number }> } | { status: 'unavailable' }>;
  oauthGrants?: { listForSubject(tenantId: string, subjectUserId: string): Promise<unknown[]>; getForSubject?: ReturnType<typeof vi.fn>; markRevocationPending?: ReturnType<typeof vi.fn>; markProviderRevoking?: ReturnType<typeof vi.fn>; markProviderRevoked?: ReturnType<typeof vi.fn>; markRevocationRetry?: ReturnType<typeof vi.fn>; recordRevocation?: ReturnType<typeof vi.fn> };
  revokeOAuthGrant?: (grant: OAuthGrant, user: JwtPayload) => Promise<void>;
  createTenant?: (input: { id: string; name: string; createdBy: string }) => Promise<{
    id: string; name: string; createdAt: string; createdBy: string; updatedAt: string;
  }>;
  rollbackTenantCreate?: (tenantId: string) => Promise<void>;
  tenantLifecycle?: { id: string; disabled?: boolean; updatedAt: string };
  setTenantDisabled?: (
    tenantId: string, disabled: boolean, actorUserId: string,
  ) => Promise<{ id: string; disabled?: boolean; updatedAt: string }>;
  directoryGroups?: {
    getGroup(tenantId: string, groupId: string): Promise<{ groupId: string; status: 'active' | 'disabled' } | null>;
    listGroups(tenantId: string): Promise<unknown[]>;
  };
  platformAdmin?: boolean;
  activeOffboardingUserId?: string;
  projectionEnqueue?: ReturnType<typeof vi.fn>;
  getMemberBudgetOverview?: (tenantId: string, userId: string) => Promise<BillingMemberBudgetOverview>;
  now?: () => Date;
} = {}) {
  const user = input.user ?? { sub: 'admin-1', username: 'admin', tenantId: 'tenant-a', role: 'admin' };
  const actor = input.actor ?? membership({
    userId: user.sub,
    tenantId: user.tenantId,
    persona: 'org_admin',
    isOwner: false,
  });
  const target = input.target ?? membership();
  const auditAppend = input.auditAppend ?? vi.fn().mockResolvedValue({ auditId: 'audit-1' });
  const updateMembership = input.updateMembership ?? vi.fn().mockImplementation(async (
    tenantId: string,
    userId: string,
    patch: { persona?: TenantMembership['persona']; isOwner?: boolean; status?: TenantMembership['status'] },
  ) => membership({
    ...target,
    tenantId,
    userId,
    persona: patch.persona ?? target.persona,
    isOwner: patch.isOwner ?? target.isOwner,
    status: patch.status ?? target.status,
    version: target.version + 1,
    updatedAt: '2026-08-10T09:01:00.000Z',
  }));
  const getMembership = input.getMembership ?? vi.fn().mockImplementation(async (tenantId: string, userId: string) => {
    if (tenantId !== actor.tenantId) return null;
    if (userId === actor.userId) return actor;
    if (userId === target.userId) return target;
    return null;
  });
  const getAssignmentSet = input.getAssignmentSet ?? vi.fn().mockResolvedValue({
    tenantId: 'tenant-a', resourceType: 'skill', resourceId: 'skill-1', source: 'governance',
    version: 1, assignments: [], createdAt: NOW, createdBy: 'admin-1', updatedAt: NOW, updatedBy: 'admin-1',
  });
  const replaceAssignments = input.replaceAssignments ?? vi.fn().mockResolvedValue({
    tenantId: 'tenant-a', resourceType: 'skill', resourceId: 'skill-1', version: 2, assignments: [],
  });
  const listEffectiveResources = input.listEffectiveResources ?? vi.fn().mockResolvedValue([]);
  const entitlement = {
    tenantId: 'tenant-a', source: 'governance', status: 'active', limits: {}, version: 1,
    createdAt: NOW, createdBy: 'platform-1', updatedAt: NOW, updatedBy: 'platform-1',
  };
  const scope = {
    tenantId: 'tenant-a', resourceType: 'skill', mode: 'all', resourceIds: [], source: 'governance',
    version: 1, createdAt: NOW, createdBy: 'platform-1', updatedAt: NOW, updatedBy: 'platform-1',
  };
  const updateEntitlement = vi.fn().mockResolvedValue({ ...entitlement, status: 'suspended', version: 2 });
  const replaceScope = vi.fn().mockResolvedValue({ ...scope, mode: 'selected', resourceIds: ['skill-1'], version: 2 });
  const createTenant = vi.fn(input.createTenant ?? (async (tenantInput: { id: string; name: string; createdBy: string }) => ({
    ...tenantInput,
    createdAt: NOW,
    updatedAt: NOW,
  })));
  const rollbackTenantCreate = vi.fn(input.rollbackTenantCreate ?? (async () => undefined));
  let tenantLifecycle = input.tenantLifecycle ?? { id: 'tenant-a', updatedAt: NOW };
  const setTenantDisabled = vi.fn(input.setTenantDisabled ?? (async (
    tenantId: string, disabled: boolean,
  ) => {
    tenantLifecycle = { id: tenantId, ...(disabled ? { disabled: true } : {}), updatedAt: '2026-08-10T09:02:00.000Z' };
    return tenantLifecycle;
  }));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use('/api/governance/access', createGovernanceAccessRouter({
    memberships: {
      getPlatformAdmin: vi.fn().mockResolvedValue(input.platformAdmin ? {
        userId: user.sub, status: 'active', version: 1,
      } : null),
      getMembership,
      updateMembershipIdentity: updateMembership,
      listMemberships: vi.fn().mockResolvedValue(input.memberships ?? [actor, target]),
    } as never,
    entitlements: {
      getEntitlementSet: vi.fn().mockResolvedValue(entitlement),
      listResourceScopes: vi.fn().mockResolvedValue([scope]),
      getPolicies: vi.fn().mockResolvedValue([]),
      updateEntitlementSet: updateEntitlement,
      replaceResourceScope: replaceScope,
    } as never,
    assignments: {
      getAssignmentSet,
      replaceAssignments,
      listUserPreferences: vi.fn().mockResolvedValue([]),
      listEffectiveResourceIds: listEffectiveResources,
    } as never,
    changeJobs: { findActiveForTarget: vi.fn().mockImplementation(async (
      _tenantId: string, _jobType: string, _targetType: string, userId: string,
    ) => userId === input.activeOffboardingUserId ? { jobId: 'offboarding-1' } : null) },
    ...(input.directoryGroups ? { directoryGroups: {
      ...input.directoryGroups,
      getAssignmentSnapshot: async (tenantId: string, groupId: string) => {
        const group = await input.directoryGroups!.getGroup(tenantId, groupId);
        return group ? { memberUserIds: [], digest: `snapshot:${groupId}`, fresh: true } : null;
      },
    } } : {}),
    ...(input.oauthGrants ? { oauthGrants: input.oauthGrants as never } : {}),
    ...(input.revokeOAuthGrant ? { revokeOAuthGrant: input.revokeOAuthGrant } : {}),
    resolveAssignmentResource: input.resolveAssignmentResource ?? (async () => 'valid'),
    resolveEntitlementResource: input.resolveEntitlementResource ?? (async () => ({ status: 'valid', version: 1 })),
    listEntitlementResources: input.listEntitlementResources ?? (async () => ({ status: 'valid', items: [{ resourceId: 'skill-1', version: 1 }] })),
    resolveDependencyImpact: async () => ({
      affectedResources: [], blockers: [], affectedAgents: [], affectedAutomations: [], brokenReferences: [],
    }),
    getMemberProfile: (tenantId, userId) => tenantId === target.tenantId && userId === target.userId ? {
      userId, username: 'member', displayName: '测试成员', accountStatus: 'active', dingtalkBound: false,
      createdAt: NOW, updatedAt: NOW,
    } : null,
    createTenant,
    rollbackTenantCreate,
    getTenantLifecycle: tenantId => tenantId === tenantLifecycle.id ? tenantLifecycle : undefined,
    setTenantDisabled,
    ...(input.getMemberBudgetOverview ? { getMemberBudgetOverview: input.getMemberBudgetOverview } : {}),
    audit: { append: auditAppend, ...(input.auditList ? { list: input.auditList } : {}) } as never,
    membershipPreviewSecret: PREVIEW_SECRET,
    ...(input.now ? { now: input.now } : {}),
    ...(input.projectionEnqueue ? {
      projectionOutbox: { enqueue: input.projectionEnqueue } as never,
      projectionReconciler: { reconcileOne: vi.fn().mockResolvedValue(null) } as never,
    } : {}),
  }));
  const server: Server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  servers.push(server);
  const address = server.address();
  const base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  return {
    request: (path: string, init?: RequestInit) => fetch(`${base}${path}`, init),
    auditAppend,
    updateMembership,
    getAssignmentSet,
    replaceAssignments,
    listEffectiveResources,
    createTenant,
    rollbackTenantCreate,
    setTenantDisabled,
    updateEntitlement,
    replaceScope,
    getMembership,
  };
}

async function createPreview(
  test: Awaited<ReturnType<typeof rig>>,
  userId: string,
  change: Record<string, unknown>,
  query = '',
): Promise<Record<string, unknown>> {
  const response = await test.request(
    `/api/governance/access/memberships/${userId}/preview${query}`,
    json('POST', change),
  );
  expect(response.status).toBe(200);
  return await response.json() as Record<string, unknown>;
}

async function createAssignmentPreview(
  test: Awaited<ReturnType<typeof rig>>,
  change: Record<string, unknown>,
  query = '',
): Promise<Record<string, unknown>> {
  const response = await test.request(
    `/api/governance/access/assignments/skill/skill-1/preview${query}`,
    json('POST', change),
  );
  expect(response.status).toBe(200);
  return await response.json() as Record<string, unknown>;
}

function commitBody(change: Record<string, unknown>, preview: Record<string, unknown>): Record<string, unknown> {
  return {
    ...change,
    previewId: preview.previewId,
    baselineDigest: preview.baselineDigest,
    expiresAt: preview.expiresAt,
  };
}

describe('governance access routes: assignment projection and audit', () => {
  it('Assignment mutation 返回 projection pending 回执并写 durable outbox', async () => {
    const projectionEnqueue = vi.fn().mockResolvedValue({ outboxId: 'projection-1' });
    const test = await rig({ projectionEnqueue });
    const change = { expectedVersion: 1, assignments: [] };
    const preview = await createAssignmentPreview(test, change);
    const response = await test.request(
      '/api/governance/access/assignments/skill/skill-1',
      json('PUT', commitBody(change, preview)),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ compatibilityProjection: 'applied_with_projection_pending' });
    expect(projectionEnqueue).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a', projector: 'assignment', idempotencyKey: 'skill:skill-1:2',
    }));
  });

  it('Assignment Set 支持 expectedVersion=0 创建，commit 强制绑定 preview baseline', async () => {
    const getAssignmentSet = vi.fn().mockResolvedValue(null);
    const replaceAssignments = vi.fn().mockResolvedValue({
      tenantId: 'tenant-a', resourceType: 'skill', resourceId: 'skill-1', version: 1, assignments: [],
    });
    const test = await rig({ getAssignmentSet, replaceAssignments });
    const change = { expectedVersion: 0, assignments: [] };
    const preview = await createAssignmentPreview(test, change);
    expect(preview).toMatchObject({ impact: { assignmentCount: 0, createsAssignmentSet: true } });

    const tampered = await test.request(
      '/api/governance/access/assignments/skill/skill-1',
      json('PUT', { ...commitBody(change, preview), assignments: [{ assigneeType: 'everyone', effect: 'allow' }] }),
    );
    expect(tampered.status).toBe(409);
    expect(await tampered.json()).toMatchObject({ code: 'ASSIGNMENT_PREVIEW_INVALID' });
    expect(replaceAssignments).not.toHaveBeenCalled();

    const committed = await test.request(
      '/api/governance/access/assignments/skill/skill-1',
      json('PUT', commitBody(change, preview)),
    );
    expect(committed.status).toBe(200);
    expect(replaceAssignments).toHaveBeenCalledWith('tenant-a', 'skill', 'skill-1', [], 0, 'admin-1');
  });

  it('terminal audit 失败时回执标 pending，并把终态审计写入 durable outbox', async () => {
    const auditAppend = vi.fn()
      .mockResolvedValueOnce({ auditId: 'preview-intent' })
      .mockResolvedValueOnce({ auditId: 'preview-terminal' })
      .mockResolvedValueOnce({ auditId: 'commit-intent' })
      .mockRejectedValueOnce(new Error('audit terminal down'));
    const projectionEnqueue = vi.fn().mockResolvedValue({ outboxId: 'projection-1' });
    const test = await rig({
      actor: membership({ userId: 'admin-1', persona: 'org_admin', isOwner: true }),
      auditAppend,
      projectionEnqueue,
    });
    const change = { expectedVersion: 1, status: 'disabled' };
    const preview = await createPreview(test, 'user-2', change);
    const response = await test.request(
      '/api/governance/access/memberships/user-2',
      json('PATCH', commitBody(change, preview)),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      auditId: 'commit-intent', changeId: 'commit-intent', auditCompletion: 'pending', auditProjectionId: 'projection-1',
    });
    expect(projectionEnqueue).toHaveBeenCalledWith(expect.objectContaining({ projector: 'audit_terminal' }));
  });

  it('terminal audit 与 outbox 同时失败时不虚报 pending，并明确返回 changed=true', async () => {
    const auditAppend = vi.fn()
      .mockResolvedValueOnce({ auditId: 'preview-intent' })
      .mockResolvedValueOnce({ auditId: 'preview-terminal' })
      .mockResolvedValueOnce({ auditId: 'commit-intent' })
      .mockRejectedValueOnce(new Error('audit terminal down'));
    const test = await rig({
      actor: membership({ userId: 'admin-1', persona: 'org_admin', isOwner: true }),
      auditAppend,
      projectionEnqueue: vi.fn().mockRejectedValue(new Error('outbox down')),
    });
    const change = { expectedVersion: 1, status: 'disabled' };
    const preview = await createPreview(test, 'user-2', change);
    const response = await test.request('/api/governance/access/memberships/user-2', json('PATCH', commitBody(change, preview)));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      code: 'GOVERNANCE_AUDIT_TERMINAL_NOT_DURABLE', changed: true, auditId: 'commit-intent',
    });
  });

  it('组织管理员只能查询本组织治理审计', async () => {
    const auditList = vi.fn().mockResolvedValue([]);
    const test = await rig({ auditList });
    const allowed = await test.request('/api/governance/access/audit-events?limit=20');
    expect(allowed.status).toBe(200);
    expect(auditList).toHaveBeenCalledWith({ targetTenantId: 'tenant-a', limit: 20 });
    const denied = await test.request('/api/governance/access/audit-events?tenantId=tenant-b');
    expect(denied.status).toBe(403);
  });

  it('平台管理员可显式查询客户组织或全平台治理审计', async () => {
    const auditList = vi.fn().mockResolvedValue([]);
    const test = await rig({
      user: { sub: 'platform-1', username: 'platform', tenantId: 'pantheon', role: 'admin' },
      platformAdmin: true,
      auditList,
    });
    expect((await test.request('/api/governance/access/audit-events?tenantId=tenant-a')).status).toBe(200);
    expect(auditList).toHaveBeenCalledWith({ targetTenantId: 'tenant-a', limit: 50 });
    expect((await test.request('/api/governance/access/audit-events')).status).toBe(200);
    expect(auditList).toHaveBeenCalledWith({ limit: 50 });
  });

  it('审计 intent 失败时 preview/commit 均 fail closed，Membership Store 不执行', async () => {
    const test = await rig({ auditAppend: vi.fn().mockRejectedValue(new Error('audit down')) });
    const response = await test.request(
      '/api/governance/access/memberships/user-2/preview',
      json('POST', { expectedVersion: 1, status: 'disabled' }),
    );
    expect(response.status).toBe(503);
    expect(test.updateMembership).not.toHaveBeenCalled();
  });

  it('平台管理员可在组织控制台跨租户只读查看部门/群组', async () => {
    const listGroups = vi.fn(async () => [{ groupId: 'group-1', displayName: '研发部', status: 'active', version: 1 }]);
    const platform = await rig({
      user: { sub: 'platform-1', username: 'platform', tenantId: 'pantheon', role: 'admin' },
      platformAdmin: true,
      directoryGroups: { getGroup: vi.fn(), listGroups },
    });
    const response = await platform.request('/api/governance/access/directory-groups?tenantId=tenant-a');
    expect(response.status).toBe(200);
    expect(listGroups).toHaveBeenCalledWith('tenant-a');
  });
});
