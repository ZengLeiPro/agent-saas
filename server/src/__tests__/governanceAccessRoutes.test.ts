import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JwtPayload } from '../auth/types.js';
import { MembershipInvariantError, type TenantMembership } from '../data/memberships/index.js';
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
  getMembership?: ReturnType<typeof vi.fn>;
  auditAppend?: ReturnType<typeof vi.fn>;
  auditList?: ReturnType<typeof vi.fn>;
  updateMembership?: ReturnType<typeof vi.fn>;
  replaceAssignments?: ReturnType<typeof vi.fn>;
  platformAdmin?: boolean;
  projectionEnqueue?: ReturnType<typeof vi.fn>;
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
  const replaceAssignments = input.replaceAssignments ?? vi.fn().mockResolvedValue({
    tenantId: 'tenant-a', resourceType: 'skill', resourceId: 'skill-1', version: 2, assignments: [],
  });
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
      listMemberships: vi.fn().mockResolvedValue([]),
    } as never,
    entitlements: {} as never,
    assignments: { replaceAssignments, listUserPreferences: vi.fn().mockResolvedValue([]) } as never,
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
    updateMembership,
    replaceAssignments,
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

function commitBody(change: Record<string, unknown>, preview: Record<string, unknown>): Record<string, unknown> {
  return {
    ...change,
    previewId: preview.previewId,
    baselineDigest: preview.baselineDigest,
    expiresAt: preview.expiresAt,
  };
}

describe('governance access routes', () => {
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

  it('Assignment mutation 返回 projection pending 回执并写 durable outbox', async () => {
    const projectionEnqueue = vi.fn().mockResolvedValue({ outboxId: 'projection-1' });
    const test = await rig({ projectionEnqueue });
    const response = await test.request('/api/governance/access/assignments/skill/skill-1', json('PUT', {
      expectedVersion: 1, assignments: [],
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ compatibilityProjection: 'applied_with_projection_pending' });
    expect(projectionEnqueue).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a', projector: 'assignment', idempotencyKey: 'skill:skill-1:2',
    }));
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
      auditId: 'commit-intent', changeId: 'commit-intent', auditCompletion: 'pending',
    });
    expect(projectionEnqueue).toHaveBeenCalledWith(expect.objectContaining({ projector: 'audit_terminal' }));
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
});
