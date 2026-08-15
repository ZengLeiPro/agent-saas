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
  tenantLifecycle?: { id: string; name?: string; disabled?: boolean; updatedAt: string };
  setTenantDisabled?: (
    tenantId: string, disabled: boolean, actorUserId: string, expectedUpdatedAt: string,
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

describe('governance access routes', () => {
  it('个人 OAuth Grant 只按当前 tenant/user 查询权威批准记录', async () => {
    const listForSubject = vi.fn().mockResolvedValue([{
      grantId: 'grant-1', provider: 'github', status: 'active', scopeSummary: ['repo:read'], approvals: [],
    }]);
    const test = await rig({ oauthGrants: { listForSubject } });
    const response = await test.request('/api/governance/access/oauth-grants');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ grants: [{ grantId: 'grant-1', provider: 'github' }] });
    expect(listForSubject).toHaveBeenCalledWith('tenant-a', 'admin-1');
  });

  it('Membership 列表由后端返回动作，普通管理员不能获得身份治理动作', async () => {
    const target = membership({ userId: 'user-2', persona: 'member' });
    const test = await rig({ memberships: [target] });
    const response = await test.request('/api/governance/access/memberships');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ memberships: [{
      userId: 'user-2',
      allowedActions: [{ id: 'disable', change: { status: 'disabled' } }],
    }] });
  });

  it('Owner 与平台恢复动作均由服务端作用域授权生成', async () => {
    const target = membership({ userId: 'user-2', persona: 'org_admin' });
    const owner = await rig({
      actor: membership({ userId: 'admin-1', persona: 'org_admin', isOwner: true }),
      memberships: [target],
    });
    const ownerResponse = await owner.request('/api/governance/access/memberships');
    expect((await ownerResponse.json()).memberships[0].allowedActions.map((item: { id: string }) => item.id))
      .toEqual(['grant_owner', 'demote_member', 'disable']);

    const platform = await rig({
      user: { sub: 'platform-1', username: 'platform', tenantId: 'pantheon', role: 'admin' },
      platformAdmin: true,
      memberships: [target],
    });
    const platformResponse = await platform.request('/api/governance/access/memberships?tenantId=tenant-a');
    expect(await platformResponse.json()).toMatchObject({ memberships: [{
      allowedActions: [{ id: 'recover_owner', requiresReason: true }],
    }] });
  });

  it('成员详情按七类资源（含组织记忆）返回权威 Assignment 聚合，解析失败则整体 fail closed', async () => {
    const listEffectiveResources = vi.fn().mockImplementation(async (
      _tenantId: string, _userId: string, resourceType: string,
    ) => resourceType === 'skill' ? [{
      resourceId: 'skill-1', bindingId: 'binding-1', assignmentVersion: 2, finalEffect: 'allow',
      bindings: [{ assignmentId: 'binding-1', assigneeType: 'user', assigneeId: 'user-2', effect: 'allow', origin: 'direct' }],
    }] : []);
    const test = await rig({
      listEffectiveResources,
      getMemberBudgetOverview: vi.fn().mockResolvedValue({
        tenantId: 'tenant-a', timezone: 'Asia/Shanghai',
        periodStart: '2026-07-31T16:00:00.000Z', periodEnd: '2026-08-31T16:00:00.000Z',
        monthUsedCreditsMicro: 999, unattributedCreditsMicro: 7,
        items: [{
          userId: 'user-2', enforcementMode: 'notify', active: true, version: 1,
          monthUsedCreditsMicro: 125, canStartRun: true,
        }],
      }),
    });
    const response = await test.request('/api/governance/access/memberships/user-2/details');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      profile: { userId: 'user-2', displayName: '测试成员', accountStatus: 'active' },
      identity: { userId: 'user-2' },
      accessSummary: { effectivePersona: 'member', decision: 'eligible', why: [{ source: 'membership', effect: 'allow' }] },
      snapshot: { membershipVersion: 1 },
    });
    expect(body.assignments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resourceType: 'skill',
        resources: expect.arrayContaining([expect.objectContaining({ resourceId: 'skill-1' })]),
      }),
    ]));
    expect(listEffectiveResources).toHaveBeenCalledTimes(7);
    expect(body.usagePolicy).toMatchObject({
      items: [{ userId: 'user-2', monthAttributedCreditsMicro: 125 }],
    });
    expect(body.usagePolicy).not.toHaveProperty('monthUsedCreditsMicro');
    expect(body.usagePolicy).not.toHaveProperty('unattributedCreditsMicro');
    expect(body.usagePolicy.items[0]).not.toHaveProperty('monthUsedCreditsMicro');

    const failed = await rig({ listEffectiveResources: vi.fn().mockRejectedValue(new Error('ASSIGNMENT_GROUP_SUBJECT_UNRESOLVED')) });
    const failedResponse = await failed.request('/api/governance/access/memberships/user-2/details');
    expect(failedResponse.status).toBe(503);
    expect(await failedResponse.json()).toMatchObject({ code: 'ASSIGNMENT_GROUP_SUBJECT_UNRESOLVED' });
  });

  it('平台管理员通过治理 API 创建组织，重复与权限失败返回可理解提示', async () => {
    const platformUser = { sub: 'platform-1', username: 'platform', tenantId: 'pantheon', role: 'admin' } as const;
    const created = await rig({ user: platformUser, platformAdmin: true });
    const response = await created.request('/api/governance/access/tenants', json('POST', {
      id: 'test-org', name: '测试组织',
    }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ tenant: { id: 'test-org', name: '测试组织' } });
    expect(created.createTenant).toHaveBeenCalledWith({
      id: 'test-org', name: '测试组织', createdBy: 'platform-1',
    });
    expect(created.auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      targetTenantId: 'test-org', result: 'intent',
    }));

    const duplicate = await rig({
      user: platformUser,
      platformAdmin: true,
      createTenant: async () => { throw new Error('Tenant id "test-org" already exists'); },
    });
    const duplicateResponse = await duplicate.request('/api/governance/access/tenants', json('POST', {
      id: 'test-org', name: '测试组织',
    }));
    expect(duplicateResponse.status).toBe(409);
    expect(await duplicateResponse.json()).toMatchObject({
      code: 'TENANT_ALREADY_EXISTS', error: '该组织 slug 已存在，请更换后重试',
    });

    const failed = await rig({
      user: platformUser,
      platformAdmin: true,
      createTenant: async () => { throw new Error('EACCES: /internal/tenants.json'); },
    });
    const failedResponse = await failed.request('/api/governance/access/tenants', json('POST', {
      id: 'failed-org', name: '失败组织',
    }));
    expect(failedResponse.status).toBe(500);
    expect(await failedResponse.json()).toMatchObject({
      code: 'TENANT_CREATE_FAILED',
      error: '创建组织失败，未保存任何组织信息，请稍后重试；如问题持续，请联系平台运维人员',
    });

    const organizationAdmin = await rig();
    const denied = await organizationAdmin.request('/api/governance/access/tenants', json('POST', {
      id: 'other-org', name: '其他组织',
    }));
    expect(denied.status).toBe(403);
    expect(organizationAdmin.createTenant).not.toHaveBeenCalled();
  });

  it('创建组织后终态审计与 outbox 同时失败时回滚 Tenant 且返回友好错误', async () => {
    const platformUser = { sub: 'platform-1', username: 'platform', tenantId: 'pantheon', role: 'admin' } as const;
    const persistedTenants = new Set<string>();
    const rollbackTenantCreate = vi.fn(async (tenantId: string) => {
      persistedTenants.delete(tenantId);
    });
    const test = await rig({
      user: platformUser,
      platformAdmin: true,
      auditAppend: vi.fn()
        .mockResolvedValueOnce({ auditId: 'create-intent' })
        .mockRejectedValueOnce(new Error('audit terminal down')),
      projectionEnqueue: vi.fn().mockRejectedValue(new Error('outbox down')),
      createTenant: async input => {
        persistedTenants.add(input.id);
        return { ...input, createdAt: NOW, updatedAt: NOW };
      },
      rollbackTenantCreate,
    });

    const response = await test.request('/api/governance/access/tenants', json('POST', {
      id: 'rollback-org', name: '回滚组织',
    }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      code: 'TENANT_CREATE_FAILED',
      error: '创建组织失败，未保存任何组织信息，请稍后重试；如问题持续，请联系平台运维人员',
    });
    expect(rollbackTenantCreate).toHaveBeenCalledWith('rollback-org');
    expect(persistedTenants.has('rollback-org')).toBe(false);
  });

  it('平台组织生命周期动作由后端返回，并强制 preview baseline 后提交', async () => {
    const test = await rig({
      user: { sub: 'platform-1', username: 'platform', tenantId: 'pantheon', role: 'admin' },
      platformAdmin: true,
    });
    const lifecycle = await test.request('/api/governance/access/tenant-lifecycle?tenantId=tenant-a');
    expect(await lifecycle.json()).toMatchObject({
      tenantName: 'tenant-a', status: 'active', allowedActions: [{ id: 'suspend', action: 'suspend', requiresReason: true }],
    });
    const change = { action: 'suspend', reason: 'customer security incident' };
    const previewResponse = await test.request(
      '/api/governance/access/tenant-lifecycle/preview?tenantId=tenant-a', json('POST', change),
    );
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json() as Record<string, unknown>;
    const committed = await test.request(
      '/api/governance/access/tenant-lifecycle?tenantId=tenant-a',
      json('POST', commitBody(change, preview)),
    );
    expect(committed.status).toBe(200);
    expect(await committed.json()).toMatchObject({ tenantId: 'tenant-a', status: 'suspended' });
    expect(test.setTenantDisabled).toHaveBeenCalledWith('tenant-a', true, 'platform-1', NOW);
  });

  it('生命周期恢复只向平台管理员开放，并沿用 preview baseline', async () => {
    const unauthorized = await rig();
    const denied = await unauthorized.request('/api/governance/access/tenant-lifecycle?tenantId=tenant-a');
    expect(denied.status).toBe(403);
    expect(unauthorized.setTenantDisabled).not.toHaveBeenCalled();

    const test = await rig({
      user: { sub: 'platform-1', username: 'platform', tenantId: 'pantheon', role: 'admin' },
      platformAdmin: true,
      tenantLifecycle: { id: 'tenant-a', disabled: true, updatedAt: NOW },
    });
    const lifecycle = await test.request('/api/governance/access/tenant-lifecycle?tenantId=tenant-a');
    expect(await lifecycle.json()).toMatchObject({ status: 'suspended', allowedActions: [{ action: 'resume' }] });
    const change = { action: 'resume', reason: 'security review completed' };
    const previewResponse = await test.request(
      '/api/governance/access/tenant-lifecycle/preview?tenantId=tenant-a', json('POST', change),
    );
    const preview = await previewResponse.json() as Record<string, unknown>;
    expect(preview).toMatchObject({ impact: { from: 'suspended', to: 'active', reversible: true } });
    const committed = await test.request(
      '/api/governance/access/tenant-lifecycle?tenantId=tenant-a', json('POST', commitBody(change, preview)),
    );
    expect(committed.status).toBe(200);
    expect(await committed.json()).toMatchObject({ status: 'active' });
    expect(test.setTenantDisabled).toHaveBeenCalledWith('tenant-a', false, 'platform-1', NOW);
  });

  it('Entitlement 与 Scope 写入统一绑定 previewId 和 baselineDigest', async () => {
    const test = await rig({
      user: { sub: 'platform-1', username: 'platform', tenantId: 'pantheon', role: 'admin' },
      platformAdmin: true,
    });
    const entitlementChange = { expectedVersion: 1, status: 'suspended', reason: 'contract suspended' };
    const entitlementPreviewResponse = await test.request(
      '/api/governance/access/entitlements/preview?tenantId=tenant-a', json('POST', entitlementChange),
    );
    const entitlementPreview = await entitlementPreviewResponse.json() as Record<string, unknown>;
    const entitlementCommit = await test.request(
      '/api/governance/access/entitlements?tenantId=tenant-a',
      json('PATCH', commitBody(entitlementChange, entitlementPreview)),
    );
    expect(entitlementCommit.status).toBe(200);
    expect(test.updateEntitlement).toHaveBeenCalledWith('tenant-a', expect.objectContaining({ expectedVersion: 1, status: 'suspended' }));

    const scopeChange = { expectedVersion: 1, mode: 'selected', resourceIds: ['skill-1'] };
    const scopePreviewResponse = await test.request(
      '/api/governance/access/entitlement-scopes/skill/preview?tenantId=tenant-a', json('POST', scopeChange),
    );
    const scopePreview = await scopePreviewResponse.json() as Record<string, unknown>;
    const scopeCommit = await test.request(
      '/api/governance/access/entitlement-scopes/skill?tenantId=tenant-a',
      json('PUT', commitBody(scopeChange, scopePreview)),
    );
    expect(scopeCommit.status).toBe(200);
    expect(test.replaceScope).toHaveBeenCalledWith('tenant-a', 'skill', expect.objectContaining({ expectedVersion: 1, mode: 'selected' }));
  });

  it('普通 org_admin 不能提升成员或修改同级管理员状态', async () => {
    const promote = await rig();
    const promoteResponse = await promote.request(
      '/api/governance/access/memberships/user-2/preview',
      json('POST', { expectedVersion: 1, persona: 'org_admin' }),
    );
    expect(promoteResponse.status).toBe(403);
    expect(promote.updateMembership).not.toHaveBeenCalled();

    const peer = await rig({ target: membership({ persona: 'org_admin' }) });
    const peerResponse = await peer.request(
      '/api/governance/access/memberships/user-2/preview',
      json('POST', { expectedVersion: 1, status: 'disabled' }),
    );
    expect(peerResponse.status).toBe(403);
    expect(peer.updateMembership).not.toHaveBeenCalled();
  });

  it('Owner 可经 preview→commit 管理其他管理员并返回完整治理回执', async () => {
    const projectionEnqueue = vi.fn().mockResolvedValue({ outboxId: 'projection-1' });
    const test = await rig({
      actor: membership({ userId: 'admin-1', persona: 'org_admin', isOwner: true }),
      target: membership({ persona: 'org_admin' }),
      projectionEnqueue,
    });
    const change = { expectedVersion: 1, isOwner: true };
    const preview = await createPreview(test, 'user-2', change);
    const response = await test.request(
      '/api/governance/access/memberships/user-2',
      json('PATCH', commitBody(change, preview)),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      tenantId: 'tenant-a', userId: 'user-2', isOwner: true,
      auditId: 'audit-1', changeId: 'audit-1',
      effectiveAt: '2026-08-10T09:01:00.000Z', projectionStatus: 'pending',
    });
    expect(test.updateMembership).toHaveBeenCalledWith('tenant-a', 'user-2', expect.objectContaining({
      expectedVersion: 1,
      isOwner: true,
      updatedBy: 'admin-1',
      authorization: { kind: 'tenant_member', actorTenantId: 'tenant-a' },
    }));
    expect(projectionEnqueue).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a', projector: 'membership', idempotencyKey: 'user-2:2',
    }));
  });

  it('Owner 修改自己的高风险身份仍不能绕过最后 active Owner 不变量', async () => {
    const actor = membership({ userId: 'admin-1', persona: 'org_admin', isOwner: true });
    const updateMembership = vi.fn().mockRejectedValue(
      new MembershipInvariantError('LAST_EFFECTIVE_OWNER_PROTECTED'),
    );
    const test = await rig({ actor, target: actor, updateMembership });
    const change = { expectedVersion: 1, isOwner: false };
    const preview = await createPreview(test, 'admin-1', change);
    const response = await test.request(
      '/api/governance/access/memberships/admin-1',
      json('PATCH', commitBody(change, preview)),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'LAST_EFFECTIVE_OWNER_PROTECTED' });
  });

  it('preview 过期时 fail closed，不执行 Membership Store', async () => {
    let clock = new Date(NOW);
    const test = await rig({
      actor: membership({ userId: 'admin-1', persona: 'org_admin', isOwner: true }),
      now: () => clock,
    });
    const change = { expectedVersion: 1, status: 'disabled' };
    const preview = await createPreview(test, 'user-2', change);
    clock = new Date(clock.getTime() + 5 * 60_000 + 1);
    const response = await test.request(
      '/api/governance/access/memberships/user-2',
      json('PATCH', commitBody(change, preview)),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'MEMBERSHIP_PREVIEW_EXPIRED' });
    expect(test.updateMembership).not.toHaveBeenCalled();
  });

  it('preview 后 baseline/version 并发变化时 fail closed', async () => {
    const actor = membership({ userId: 'admin-1', persona: 'org_admin', isOwner: true });
    let target = membership();
    const getMembership = vi.fn().mockImplementation(async (tenantId: string, userId: string) => {
      if (tenantId !== 'tenant-a') return null;
      return userId === actor.userId ? actor : userId === target.userId ? target : null;
    });
    const test = await rig({ actor, getMembership });
    const change = { expectedVersion: 1, status: 'disabled' };
    const preview = await createPreview(test, 'user-2', change);
    target = membership({ version: 2, status: 'disabled' });
    const response = await test.request(
      '/api/governance/access/memberships/user-2',
      json('PATCH', commitBody(change, preview)),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'MEMBERSHIP_PREVIEW_BASELINE_CONFLICT' });
    expect(test.updateMembership).not.toHaveBeenCalled();
  });

  it('个人 OAuth Grant 撤销严格执行签名 preview→真实断开→revoked 投影', async () => {
    const grant = {
      grantId: 'grant-1', tenantId: 'tenant-a', subjectUserId: 'admin-1', provider: 'google', connectorId: 'google-workspace',
      status: 'active', scopeSummary: ['drive.readonly'], approvedAt: NOW, version: 1, approvals: [],
    };
    const getForSubject = vi.fn().mockResolvedValue(grant);
    const markRevocationPending = vi.fn().mockResolvedValue({ ...grant, status: 'error', version: 2 });
    const markProviderRevoking = vi.fn().mockResolvedValue({ ...grant, status: 'error', revocationStage: 'provider_revoking', version: 3 });
    const markProviderRevoked = vi.fn().mockResolvedValue({ ...grant, status: 'error', revocationStage: 'provider_revoked', version: 4 });
    const markRevocationRetry = vi.fn();
    const recordRevocation = vi.fn().mockResolvedValue({ ...grant, status: 'revoked', version: 5 });
    const revokeOAuthGrant = vi.fn().mockResolvedValue(undefined);
    const test = await rig({
      oauthGrants: { listForSubject: vi.fn().mockResolvedValue([grant]), getForSubject, markRevocationPending, markProviderRevoking, markProviderRevoked, markRevocationRetry, recordRevocation },
      revokeOAuthGrant,
    });
    const reason = '用户主动撤销长期账号授权';
    const previewResponse = await test.request('/api/governance/access/oauth-grants/grant-1/revoke/preview', json('POST', { reason }));
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json() as Record<string, unknown>;
    const commit = await test.request('/api/governance/access/oauth-grants/grant-1/revoke', json('POST', {
      reason, previewId: preview.previewId, baselineDigest: preview.baselineDigest, expiresAt: preview.expiresAt,
    }));
    expect(commit.status).toBe(200);
    await expect(commit.json()).resolves.toMatchObject({ grantId: 'grant-1', status: 'revoked', version: 5 });
    expect(markRevocationPending).toHaveBeenCalledWith(expect.objectContaining({ grantId: 'grant-1' }));
    expect(markProviderRevoking).toHaveBeenCalledWith(expect.objectContaining({ grantId: 'grant-1' }));
    expect(revokeOAuthGrant).toHaveBeenCalledWith(grant, expect.objectContaining({ sub: 'admin-1' }));
    expect(markProviderRevoked).toHaveBeenCalledWith(expect.objectContaining({ grantId: 'grant-1' }));
    expect(recordRevocation).toHaveBeenCalledWith(expect.objectContaining({ grantId: 'grant-1', actorUserId: 'admin-1' }));
  });

  it('Scope all 模式也必须绑定完整目录，authority 缺失或目录漂移时 fail closed', async () => {
    const unavailable = await rig({ platformAdmin: true, listEntitlementResources: async () => ({ status: 'unavailable' }) });
    const change = { expectedVersion: 1, mode: 'all', resourceIds: [] };
    expect((await unavailable.request(
      '/api/governance/access/entitlement-scopes/skill/preview?tenantId=tenant-a', json('POST', change),
    )).status).toBe(503);

    const listEntitlementResources = vi.fn()
      .mockResolvedValueOnce({ status: 'valid', items: [{ resourceId: 'skill-1', version: 1 }] })
      .mockResolvedValueOnce({ status: 'valid', items: [{ resourceId: 'skill-1', version: 2 }] });
    const test = await rig({ platformAdmin: true, listEntitlementResources });
    const previewResponse = await test.request(
      '/api/governance/access/entitlement-scopes/skill/preview?tenantId=tenant-a', json('POST', change),
    );
    const preview = await previewResponse.json() as Record<string, unknown>;
    const commit = await test.request(
      '/api/governance/access/entitlement-scopes/skill?tenantId=tenant-a', json('PUT', commitBody(change, preview)),
    );
    expect(commit.status).toBe(409);
    await expect(commit.json()).resolves.toMatchObject({ code: 'GOVERNANCE_PREVIEW_BASELINE_CONFLICT' });
  });

  it('Scope 预览后目录资源版本变化时提交必须 409', async () => {
    const resolveEntitlementResource = vi.fn()
      .mockResolvedValueOnce({ status: 'valid', version: 1 })
      .mockResolvedValueOnce({ status: 'valid', version: 2 });
    const test = await rig({ platformAdmin: true, resolveEntitlementResource });
    const change = { expectedVersion: 1, mode: 'selected', resourceIds: ['skill-1'] };
    const previewResponse = await test.request(
      '/api/governance/access/entitlement-scopes/skill/preview?tenantId=tenant-a', json('POST', change),
    );
    const preview = await previewResponse.json() as Record<string, unknown>;
    const commit = await test.request(
      '/api/governance/access/entitlement-scopes/skill?tenantId=tenant-a',
      json('PUT', commitBody(change, preview)),
    );
    expect(commit.status).toBe(409);
    await expect(commit.json()).resolves.toMatchObject({ code: 'GOVERNANCE_PREVIEW_BASELINE_CONFLICT' });
  });

  it('跨租户被拒；platform admin 仅可在显式客户 tenant scope 带 reason 恢复 Owner', async () => {
    const org = await rig();
    const denied = await org.request(
      '/api/governance/access/memberships/user-2/preview?tenantId=tenant-b',
      json('POST', { expectedVersion: 1, status: 'disabled' }),
    );
    expect(denied.status).toBe(403);

    const platformUser = { sub: 'platform-1', username: 'platform', tenantId: 'pantheon', role: 'admin' as const };
    const target = membership({ tenantId: 'tenant-a', persona: 'org_admin', isOwner: true, status: 'disabled' });
    const getMembership = vi.fn().mockImplementation(async (tenantId: string, userId: string) =>
      tenantId === 'tenant-a' && userId === 'user-2' ? target : null);
    const platform = await rig({ user: platformUser, platformAdmin: true, target, getMembership });
    const missingScope = await platform.request(
      '/api/governance/access/memberships/user-2/preview',
      json('POST', { expectedVersion: 1, status: 'active', reason: 'owner recovery' }),
    );
    expect(missingScope.status).toBe(403);
    const destructive = await platform.request(
      '/api/governance/access/memberships/user-2/preview?tenantId=tenant-a',
      json('POST', { expectedVersion: 1, status: 'disabled', reason: 'not recovery' }),
    );
    expect(destructive.status).toBe(403);

    const change = { expectedVersion: 1, status: 'active', reason: 'customer owner recovery' };
    const preview = await createPreview(platform, 'user-2', change, '?tenantId=tenant-a');
    const restored = await platform.request(
      '/api/governance/access/memberships/user-2?tenantId=tenant-a',
      json('PATCH', commitBody(change, preview)),
    );
    expect(restored.status).toBe(200);
    expect(platform.updateMembership).toHaveBeenCalledWith('tenant-a', 'user-2', expect.objectContaining({
      authorization: {
        kind: 'platform_recovery', actorTenantId: 'pantheon', reason: 'customer owner recovery',
      },
    }));
  });

  it('治理 Persona 是授权真源：legacy role=admin 但 Membership=member 仍不能管理 Assignment', async () => {
    const test = await rig({
      user: { sub: 'user-1', username: 'alice', tenantId: 'tenant-a', role: 'admin' },
      actor: membership({ userId: 'user-1', persona: 'member' }),
    });
    const response = await test.request('/api/governance/access/assignments/skill/skill-1', json('PUT', {
      expectedVersion: 1, assignments: [],
    }));
    expect(response.status).toBe(403);
    expect(test.replaceAssignments).not.toHaveBeenCalled();
  });

  it('Assignment 写入校验同租户成员和目录群组，平台管理员默认禁止代写', async () => {
    const invalidResource = await rig({ resolveAssignmentResource: async () => 'not_found' });
    const resourceResponse = await invalidResource.request(
      '/api/governance/access/assignments/skill/cross-tenant/preview',
      json('POST', { expectedVersion: 1, assignments: [] }),
    );
    expect(resourceResponse.status).toBe(409);
    expect(await resourceResponse.json()).toMatchObject({ code: 'ASSIGNMENT_RESOURCE_INVALID' });

    const invalidUser = await rig();
    const userResponse = await invalidUser.request('/api/governance/access/assignments/skill/skill-1/preview', json('POST', {
      expectedVersion: 1,
      assignments: [{ assigneeType: 'user', assigneeId: 'unknown', effect: 'allow' }],
    }));
    expect(userResponse.status).toBe(409);
    expect(await userResponse.json()).toMatchObject({ code: 'ASSIGNMENT_USER_SUBJECT_INVALID' });

    const offboardingUser = await rig({ activeOffboardingUserId: 'user-2' });
    const offboardingResponse = await offboardingUser.request('/api/governance/access/assignments/skill/skill-1/preview', json('POST', {
      expectedVersion: 1,
      assignments: [{ assigneeType: 'user', assigneeId: 'user-2', effect: 'allow' }],
    }));
    expect(offboardingResponse.status).toBe(409);
    expect(await offboardingResponse.json()).toMatchObject({ code: 'ASSIGNMENT_SUBJECT_OFFBOARDING_ACTIVE' });

    const directoryGroups = {
      getGroup: vi.fn(async () => ({ groupId: 'group-1', status: 'active' as const })),
      listGroups: vi.fn(async () => []),
    };
    const validGroup = await rig({ directoryGroups });
    const groupChange = {
      expectedVersion: 1,
      assignments: [{ assigneeType: 'directory_group', assigneeId: 'group-1', effect: 'allow' }],
    };
    const groupPreview = await createAssignmentPreview(validGroup, groupChange);
    const groupResponse = await validGroup.request(
      '/api/governance/access/assignments/skill/skill-1',
      json('PUT', commitBody(groupChange, groupPreview)),
    );
    expect(groupResponse.status).toBe(200);
    expect(directoryGroups.getGroup).toHaveBeenCalledWith('tenant-a', 'group-1');

    const platform = await rig({
      user: { sub: 'platform-1', username: 'platform', tenantId: 'pantheon', role: 'admin' },
      platformAdmin: true,
    });
    const platformResponse = await platform.request(
      '/api/governance/access/assignments/skill/skill-1?tenantId=tenant-a',
      json('PUT', { expectedVersion: 1, assignments: [] }),
    );
    expect(platformResponse.status).toBe(403);
    expect(await platformResponse.json()).toMatchObject({ code: 'PLATFORM_ASSIGNMENT_WRITE_FORBIDDEN' });
  });
});
