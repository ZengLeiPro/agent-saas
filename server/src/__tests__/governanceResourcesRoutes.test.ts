import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JwtPayload } from '../auth/types.js';
import { createGovernanceResourcesRouter } from '../routes/governanceResources.js';

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
  agentCreate?: ReturnType<typeof vi.fn>;
  credentialCreate?: ReturnType<typeof vi.fn>;
  putSecret?: ReturnType<typeof vi.fn>;
}) {
  const auditAppend = input.auditAppend ?? vi.fn().mockResolvedValue({});
  const agentCreate = input.agentCreate ?? vi.fn().mockImplementation(async value => ({
    ...value, agentId: value.agentId ?? 'pa-1', status: 'draft', revision: 1,
  }));
  const credentialCreate = input.credentialCreate ?? vi.fn().mockImplementation(async value => ({
    ...value, credentialId: 'cred-1', secretRef: value.secretRef,
    status: 'active', generation: 1, version: 1,
  }));
  const putSecret = input.putSecret ?? vi.fn().mockResolvedValue({ id: 'sec-1' });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = input.user ?? {
      sub: 'user-1', username: 'alice', tenantId: 'tenant-a', role: 'user',
    };
    next();
  });
  app.use('/api/governance/resources', createGovernanceResourcesRouter({
    memberships: {
      getPlatformAdmin: vi.fn().mockResolvedValue(null),
      getMembership: vi.fn().mockResolvedValue({
        tenantId: 'tenant-a', userId: input.user?.sub ?? 'user-1',
        persona: (input.user?.role ?? 'user') === 'admin' ? 'org_admin' : 'member', status: 'active',
      }),
    } as never,
    agents: { create: agentCreate } as never,
    skills: {} as never,
    connectors: { get: vi.fn().mockResolvedValue({ connectorId: 'github', status: 'published' }) } as never,
    credentials: { create: credentialCreate } as never,
    environments: {} as never,
    changeJobs: {} as never,
    changePlanner: {} as never,
    vault: { putSecret, revokeSecret: vi.fn().mockResolvedValue(undefined) } as never,
    audit: { append: auditAppend } as never,
  }));
  const server: Server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  servers.push(server);
  const address = server.address();
  const base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  return {
    request: (path: string, init?: RequestInit) => fetch(`${base}${path}`, init),
    auditAppend, agentCreate, credentialCreate, putSecret,
  };
}

describe('typed governance resource routes', () => {
  it('审计 intent 不可持久化时 fail closed，资源 Store 不得执行', async () => {
    const auditAppend = vi.fn().mockRejectedValue(new Error('audit down'));
    const test = await rig({ auditAppend });
    const response = await test.request('/api/governance/resources/agents', json('POST', {
      kind: 'personal_agent', ownerUserId: 'user-1',
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'GOVERNANCE_AUDIT_UNAVAILABLE' });
    expect(test.agentCreate).not.toHaveBeenCalled();
  });

  it('资源已变更但 succeeded 审计失败时返回 durable intent 回执并标记 completion pending', async () => {
    const auditAppend = vi.fn()
      .mockResolvedValueOnce({ auditId: 'intent-1' })
      .mockRejectedValueOnce(new Error('audit terminal down'));
    const test = await rig({ auditAppend });
    const response = await test.request('/api/governance/resources/agents', json('POST', {
      kind: 'personal_agent', ownerUserId: 'user-1',
    }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ auditId: 'intent-1', auditCompletion: 'pending' });
    expect(test.agentCreate).toHaveBeenCalledOnce();
  });

  it('个人 Agent owner 强制绑定当前用户，拒绝代他人创建', async () => {
    const test = await rig({});
    const denied = await test.request('/api/governance/resources/agents', json('POST', {
      kind: 'personal_agent', ownerUserId: 'user-2',
    }));
    expect(denied.status).toBe(403);
    expect(test.agentCreate).not.toHaveBeenCalled();

    const created = await test.request('/api/governance/resources/agents', json('POST', {
      kind: 'personal_agent', ownerUserId: 'user-1',
    }));
    expect(created.status).toBe(201);
    expect(test.agentCreate).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a', ownerUserId: 'user-1', kind: 'personal_agent',
    }));
  });

  it('org_shared Credential 使用 tenant owner，获授权成员可由 Broker 按 tenant 读取', async () => {
    const test = await rig({
      user: { sub: 'admin-1', username: 'admin', tenantId: 'tenant-a', role: 'admin' },
    });
    const response = await test.request('/api/governance/resources/credentials', json('POST', {
      connectorId: 'github', kind: 'org_shared', purpose: 'shared automation',
      secret: 'github_pat_shared_sensitive',
    }));
    expect(response.status).toBe(201);
    expect(test.putSecret).toHaveBeenCalledWith(
      'tenant:tenant-a', 'connector', 'github_pat_shared_sensitive', expect.any(Object), expect.any(Object),
    );
  });

  it('Credential Secret 仅写 Vault，API 与治理记录响应不暴露 secretRef', async () => {
    const test = await rig({});
    const response = await test.request('/api/governance/resources/credentials', json('POST', {
      connectorId: 'github', kind: 'personal_grant', purpose: 'repository automation',
      secret: 'github_pat_sensitive',
    }));
    expect(response.status).toBe(201);
    const body = await response.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty('secretRef');
    expect(JSON.stringify(body)).not.toContain('github_pat_sensitive');
    expect(test.putSecret).toHaveBeenCalledWith(
      'user-1', 'connector', 'github_pat_sensitive', expect.any(Object), expect.any(Object),
    );
    expect(test.credentialCreate).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a', ownerUserId: 'user-1', secretRef: 'sec-1',
    }));
  });
});
