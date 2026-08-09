import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JwtPayload } from '../auth/types.js';
import { createGovernanceAccessRouter } from '../routes/governanceAccess.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function rig(input: {
  user?: JwtPayload;
  auditAppend?: ReturnType<typeof vi.fn>;
  updateMembership?: ReturnType<typeof vi.fn>;
  replaceAssignments?: ReturnType<typeof vi.fn>;
  governancePersona?: 'org_admin' | 'member';
} = {}) {
  const auditAppend = input.auditAppend ?? vi.fn().mockResolvedValue({ auditId: 'audit-1' });
  const updateMembership = input.updateMembership ?? vi.fn().mockResolvedValue({
    tenantId: 'tenant-a', userId: 'user-2', persona: 'member', isOwner: false, status: 'disabled', version: 2,
  });
  const replaceAssignments = input.replaceAssignments ?? vi.fn().mockResolvedValue({
    tenantId: 'tenant-a', resourceType: 'skill', resourceId: 'skill-1', version: 2, assignments: [],
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = input.user ?? { sub: 'admin-1', username: 'admin', tenantId: 'tenant-a', role: 'admin' };
    next();
  });
  app.use('/api/governance/access', createGovernanceAccessRouter({
    memberships: {
      getPlatformAdmin: vi.fn().mockResolvedValue(null),
      getMembership: vi.fn().mockResolvedValue({
        tenantId: 'tenant-a', userId: input.user?.sub ?? 'admin-1',
        persona: input.governancePersona ?? ((input.user?.role ?? 'admin') === 'admin' ? 'org_admin' : 'member'), status: 'active',
      }),
      updateMembershipIdentity: updateMembership,
      listMemberships: vi.fn().mockResolvedValue([]),
    } as never,
    entitlements: {} as never,
    assignments: { replaceAssignments, listUserPreferences: vi.fn().mockResolvedValue([]) } as never,
    audit: { append: auditAppend } as never,
  }));
  const server: Server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  servers.push(server);
  const address = server.address();
  const base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  return { request: (path: string, init?: RequestInit) => fetch(`${base}${path}`, init), updateMembership, replaceAssignments };
}

describe('governance access routes', () => {
  it('组织管理员只能修改本 tenant Membership', async () => {
    const test = await rig();
    const denied = await test.request('/api/governance/access/memberships/user-2?tenantId=tenant-b', json('PATCH', {
      expectedVersion: 1, status: 'disabled',
    }));
    expect(denied.status).toBe(403);
    expect(test.updateMembership).not.toHaveBeenCalled();

    const allowed = await test.request('/api/governance/access/memberships/user-2', json('PATCH', {
      expectedVersion: 1, status: 'disabled',
    }));
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ tenantId: 'tenant-a', auditId: 'audit-1' });
    expect(test.updateMembership).toHaveBeenCalledWith('tenant-a', 'user-2', expect.objectContaining({
      expectedVersion: 1, status: 'disabled', updatedBy: 'admin-1',
    }));
  });

  it('治理 Persona 是授权真源：legacy role=admin 但 Membership=member 仍不能管理 Assignment', async () => {
    const test = await rig({
      user: { sub: 'user-1', username: 'alice', tenantId: 'tenant-a', role: 'admin' },
      governancePersona: 'member',
    });
    const response = await test.request('/api/governance/access/assignments/skill/skill-1', json('PUT', {
      expectedVersion: 1, assignments: [],
    }));
    expect(response.status).toBe(403);
    expect(test.replaceAssignments).not.toHaveBeenCalled();
  });

  it('审计 intent 失败时 Membership Store 不得执行', async () => {
    const test = await rig({ auditAppend: vi.fn().mockRejectedValue(new Error('audit down')) });
    const response = await test.request('/api/governance/access/memberships/user-2', json('PATCH', {
      expectedVersion: 1, status: 'disabled',
    }));
    expect(response.status).toBe(503);
    expect(test.updateMembership).not.toHaveBeenCalled();
  });
});
