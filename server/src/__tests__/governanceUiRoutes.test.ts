import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { effectiveResourceViewSchema, executionReadinessSchema } from '../../../shared/src/types/governance.js';
import type { JwtPayload } from '../auth/types.js';
import { createGovernanceUiRouter } from '../routes/governanceUi.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

const now = '2026-08-10T07:00:00.000Z';
const user = (id: string, tenantId: string, role: 'admin' | 'user' = 'user') => ({
  id, tenantId, role, username: id, passwordHash: 'x', createdAt: now, createdBy: 'system', updatedAt: now,
});
const membership = (userId: string, tenantId: string, persona: 'org_admin' | 'member' = 'member') => ({
  tenantId, userId, persona, isOwner: persona === 'org_admin', status: 'active' as const,
  source: 'governance' as const, version: 3, createdAt: now, createdBy: 'system', updatedAt: now, updatedBy: 'system',
});
const assignmentSet = (tenantId: string, type: 'skill' | 'environment_template', resourceId: string, userId: string) => ({
  tenantId, resourceType: type, resourceId, source: 'governance' as const, version: 4,
  assignments: [{
    assignmentId: `a-${resourceId}`, tenantId, resourceType: type, resourceId,
    assigneeType: 'user' as const, assigneeId: userId, effect: 'allow' as const, origin: 'direct' as const,
    version: 1, createdAt: now, createdBy: 'admin', updatedAt: now, updatedBy: 'admin',
  }],
  createdAt: now, createdBy: 'admin', updatedAt: now, updatedBy: 'admin',
});

async function rig(input: {
  jwt?: JwtPayload;
  runtimePolicy?: unknown;
  assignments?: Record<string, ReturnType<typeof assignmentSet> | null>;
  effective?: Partial<Record<'org_agent' | 'skill' | 'credential' | 'environment_template', string[]>>;
  personalAgents?: string[];
  auditAppend?: ReturnType<typeof vi.fn>;
} = {}) {
  const jwt = input.jwt ?? { sub: 'user-1', username: 'user-1', tenantId: 'tenant-a', role: 'user' };
  const users = new Map([
    ['user-1', user('user-1', 'tenant-a')],
    ['admin-a', user('admin-a', 'tenant-a', 'admin')],
    ['user-b', user('user-b', 'tenant-b')],
    ['platform-1', user('platform-1', 'pantheon', 'admin')],
  ]);
  const memberships = new Map([
    ['tenant-a:user-1', membership('user-1', 'tenant-a')],
    ['tenant-a:admin-a', membership('admin-a', 'tenant-a', 'org_admin')],
    ['tenant-b:user-b', membership('user-b', 'tenant-b')],
  ]);
  const personalAgentRecords = (input.personalAgents ?? []).map(agentId => ({
    agentId, tenantId: 'tenant-a', kind: 'personal_agent' as const, ownerUserId: 'user-1',
    status: 'enabled' as const, revision: 1, createdAt: now, createdBy: 'system', updatedAt: now, updatedBy: 'system',
  }));
  const credentials = [{
    credentialId: 'cred-1', tenantId: 'tenant-a', connectorId: 'github', kind: 'personal_grant' as const,
    ownerUserId: 'user-1', ownerUsername: 'private-account', alias: 'private alias', purpose: 'source control',
    scopeSummary: { scopes: ['repo'] }, status: 'active' as const, generation: 2,
    secretRef: 'vault://must-never-leak', source: 'governance' as const, version: 2,
    createdAt: now, createdBy: 'user-1', updatedAt: now, updatedBy: 'user-1',
  }];
  const stores = {
    users: { findById: (id: string) => users.get(id) },
    tenants: { findById: (id: string) => ['tenant-a', 'tenant-b', 'pantheon'].includes(id) ? { id, disabled: false } : undefined },
    memberships: {
      getPlatformAdmin: vi.fn(async (id: string) => id === 'platform-1' ? {
        userId: id, status: 'active', source: 'governance', version: 1,
        createdAt: now, createdBy: 'system', updatedAt: now, updatedBy: 'system',
      } : null),
      getMembership: vi.fn(async (tenantId: string, id: string) => memberships.get(`${tenantId}:${id}`) ?? null),
    },
    entitlements: {
      getEntitlementSet: vi.fn(async (tenantId: string) => ({
        tenantId, source: 'governance' as never, status: 'active' as const, limits: {}, version: 2,
        createdAt: now, createdBy: 'system', updatedAt: now, updatedBy: 'system', updateReason: 'test',
      })),
      listResourceScopes: vi.fn(async (tenantId: string) => ['skill', 'connector', 'environment_template', 'tool'].map(resourceType => ({
        tenantId, resourceType, mode: 'all' as const, resourceIds: [], source: 'governance' as const, version: 2,
        createdAt: now, createdBy: 'system', updatedAt: now, updatedBy: 'system',
      }))),
      getPolicies: vi.fn(async (tenantId: string) => [
        { tenantId, policyKey: 'agent.personal.enabled', value: true },
        ...(input.runtimePolicy === undefined ? [] : [{ tenantId, policyKey: 'runtime.high_risk_tool.mode', value: input.runtimePolicy }]),
      ].map(item => ({ ...item, source: 'governance' as const, version: 2, createdAt: now, createdBy: 'system', updatedAt: now, updatedBy: 'system' }))),
    },
    assignments: {
      getAssignmentSet: vi.fn(async (tenantId: string, type: string, id: string) => input.assignments?.[`${tenantId}:${type}:${id}`] ?? null),
      listEffectiveResourceIds: vi.fn(async (_tenantId: string, _userId: string, type: 'org_agent' | 'skill' | 'credential' | 'environment_template') =>
        (input.effective?.[type] ?? []).map((resourceId, index) => ({ resourceId, bindingId: `binding-${index}`, assignmentVersion: 4 }))),
      listUserPreferences: vi.fn(async () => []),
    },
    agents: {
      get: vi.fn(async (id: string) => personalAgentRecords.find(item => item.agentId === id) ?? null),
      listPersonalByOwner: vi.fn(async (tenantId: string, ownerUserId: string) =>
        personalAgentRecords.filter(item => item.tenantId === tenantId && item.ownerUserId === ownerUserId)),
    },
    skills: {
      getResource: vi.fn(async (id: string) => ({
        skillId: id, tenantId: id === 'skill-b' ? 'tenant-b' : 'tenant-a', scope: 'tenant' as const,
        status: 'published' as const, currentVersionId: `v-${id}`, revision: 2,
        createdAt: now, createdBy: 'admin', updatedAt: now, updatedBy: 'admin',
      })),
      listPersonalByOwner: vi.fn(async () => []),
    },
    connectors: { get: vi.fn(async (id: string) => ({
      connectorId: id, name: id === 'github' ? 'GitHub' : id, status: 'published' as const,
      currentVersionId: `v-${id}`, authMethods: ['oauth'], capabilitySchema: {}, version: 2,
      createdAt: now, createdBy: 'system', updatedAt: now, updatedBy: 'system',
    })) },
    credentials: { listForTenant: vi.fn(async (tenantId: string) => credentials.filter(item => item.tenantId === tenantId)) },
    environments: {
      getTemplate: vi.fn(async (id: string) => ({
        templateId: id, name: 'Python', status: 'published' as const, currentVersionId: 'envv-1', revision: 2,
        createdAt: now, createdBy: 'system', updatedAt: now, updatedBy: 'system',
      })),
      getTemplateVersion: vi.fn(async () => null),
      listForTenant: vi.fn(async () => []),
      getProvider: vi.fn(async () => null),
    },
    audit: { append: input.auditAppend ?? vi.fn(async () => ({ auditId: 'audit-1' })) },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = jwt; next(); });
  app.use(createGovernanceUiRouter(stores as never));
  const server: Server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  servers.push(server);
  const address = server.address();
  const base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  return (path: string, init?: RequestInit) => fetch(`${base}${path}`, init);
}

function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
const resource = (domain: 'skill' | 'connector' | 'environment', id: string, type: string = domain) => ({
  type, id, tenantId: 'tenant-a', displayName: 'client supplied and ignored', domain,
});

describe('authoritative governance UI routes', () => {
  it('通过七层评估分别返回 allow、deny 与 runtime conditional', async () => {
    const allow = await rig({ effective: { credential: ['cred-1'] } });
    const allowResponse = await allow('/api/access/evaluate', post({ action: 'use', resource: resource('connector', 'github') }));
    expect(allowResponse.status).toBe(200);
    const allowed = await allowResponse.json();
    expect(allowed[0].access).toMatchObject({ verdict: 'allow', accessState: 'allowed' });
    expect(effectiveResourceViewSchema.array().parse(allowed)).toHaveLength(1);

    const deny = await rig();
    const denyResponse = await deny('/api/access/evaluate', post({ action: 'use', resource: resource('skill', 'skill-1') }));
    expect(denyResponse.status).toBe(200);
    expect((await denyResponse.json())[0].access).toMatchObject({ verdict: 'deny', accessState: 'needs_assignment' });

    const conditional = await rig({ runtimePolicy: 'require_approval', effective: { credential: ['cred-1'] } });
    const conditionalResponse = await conditional('/api/access/evaluate', post({ action: 'use', resource: resource('connector', 'github') }));
    expect(conditionalResponse.status).toBe(200);
    expect((await conditionalResponse.json())[0].access).toMatchObject({ verdict: 'conditional', accessState: 'runtime_approval_required' });
  });

  it('access allow 但 environment readiness 被权威 blocker 阻断', async () => {
    const request = await rig({
      assignments: { 'tenant-a:environment_template:env-1': assignmentSet('tenant-a', 'environment_template', 'env-1', 'user-1') },
    });
    const response = await request('/api/execution/preflight', post({
      action: 'use', resource: resource('environment', 'env-1', 'environment_template'),
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ready: false, blockers: [{ code: 'ENVIRONMENT_UNAVAILABLE' }] });
    expect(executionReadinessSchema.parse(body).ready).toBe(false);

    const incomplete = await rig({
      assignments: { 'tenant-a:skill:skill-1': assignmentSet('tenant-a', 'skill', 'skill-1', 'user-1') },
    });
    const unavailable = await incomplete('/api/execution/preflight', post({ action: 'use', resource: resource('skill', 'skill-1') }));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ code: 'READINESS_UNAVAILABLE' });
  });

  it('普通用户和组织管理员均不能跨租户评估，平台管理员也必须匹配 tenant scope', async () => {
    const member = await rig();
    const memberResponse = await member('/api/access/evaluate', post({
      action: 'use', subjectUserId: 'user-b', resource: resource('skill', 'skill-b'),
    }));
    expect(memberResponse.status).toBe(403);

    const admin = await rig({ jwt: { sub: 'admin-a', username: 'admin-a', tenantId: 'tenant-a', role: 'admin' } });
    const adminResponse = await admin('/api/access/evaluate', post({
      action: 'use', subjectUserId: 'user-b', resource: { ...resource('skill', 'skill-b'), tenantId: 'tenant-b' },
    }));
    expect(adminResponse.status).toBe(403);

    const sameTenantAdmin = await rig({
      jwt: { sub: 'admin-a', username: 'admin-a', tenantId: 'tenant-a', role: 'admin' },
      effective: { credential: ['cred-1'] },
    });
    const sameTenantResponse = await sameTenantAdmin('/api/access/evaluate', post({
      action: 'use', subjectUserId: 'user-1', resource: resource('connector', 'github'),
    }));
    expect(sameTenantResponse.status).toBe(200);
    const sameTenantText = await sameTenantResponse.text();
    expect(sameTenantText).not.toMatch(/ownerUsername|private-account|secretRef/i);

    const platform = await rig({ jwt: { sub: 'platform-1', username: 'platform-1', tenantId: 'pantheon', role: 'admin' } });
    const platformResponse = await platform('/api/access/evaluate', post({
      action: 'use', subjectUserId: 'user-b', resource: { ...resource('skill', 'skill-b'), tenantId: 'tenant-a' },
    }));
    expect(platformResponse.status).toBe(403);
  });

  it('effective list 只输出安全 DTO，不泄漏 credential secret 或外部账号字段', async () => {
    const request = await rig({ effective: { credential: ['cred-1'] } });
    const response = await request('/api/me/effective-resources?domains=connector');
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toMatch(/secretRef|vault:\/\/|ownerUsername|private-account/i);
    const body = JSON.parse(text);
    expect(effectiveResourceViewSchema.array().parse(body)[0].resource).toMatchObject({ id: 'github', displayName: 'GitHub' });

    const forged = await request('/api/access/evaluate', post({
      action: 'use', resource: resource('connector', 'github'), secretRef: 'vault://forged',
    }));
    expect(forged.status).toBe(400);

    const partial = await request('/api/me/effective-resources?domains=file');
    expect(partial.status).toBe(503);
    expect(await partial.json()).toMatchObject({ code: 'EFFECTIVE_RESOURCES_PARTIAL' });
  });

  it('effective list 忽略已删除资源的陈旧赋权引用，显式评估仍保持 404', async () => {
    const request = await rig({
      effective: { org_agent: ['deleted-agent'], skill: ['skill-1'] },
    });
    const response = await request('/api/me/effective-resources');
    expect(response.status).toBe(200);
    const body = effectiveResourceViewSchema.array().parse(await response.json());
    expect(body.map(item => item.resource.id)).toEqual(['skill-1']);

    const evaluate = await request('/api/access/evaluate', post({
      action: 'use',
      resource: { type: 'org_agent', id: 'deleted-agent', tenantId: 'tenant-a', domain: 'agent' },
    }));
    expect(evaluate.status).toBe(404);
    expect(await evaluate.json()).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  it('允许的个人 Agent 没有运行依赖索引时 effective list 省略 readiness 而不是 503', async () => {
    const request = await rig({ personalAgents: ['personal_agent_user-1'] });
    const response = await request('/api/me/effective-resources');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      resource: { id: 'personal_agent_user-1', domain: 'agent' },
      access: { verdict: 'allow', accessState: 'allowed' },
      primaryResult: { code: 'available' },
    });
    expect(body[0].readiness).toBeUndefined();
    expect(effectiveResourceViewSchema.array().parse(body)).toHaveLength(1);

    const evaluate = await request('/api/access/evaluate', post({
      action: 'use', resource: { type: 'personal_agent', id: 'personal_agent_user-1', tenantId: 'tenant-a', domain: 'agent' },
    }));
    expect(evaluate.status).toBe(200);
    const evaluated = await evaluate.json();
    expect(evaluated[0].access).toMatchObject({ verdict: 'allow' });
    expect(evaluated[0].readiness).toBeUndefined();

    // 执行门禁仍 fail closed：allow 但缺少就绪索引时 preflight 必须 503。
    const preflight = await request('/api/execution/preflight', post({
      action: 'use', resource: { type: 'personal_agent', id: 'personal_agent_user-1', tenantId: 'tenant-a', domain: 'agent' },
    }));
    expect(preflight.status).toBe(503);
    expect(await preflight.json()).toMatchObject({ code: 'READINESS_UNAVAILABLE' });
  });

  it('本人治理摘要由服务端 Membership 权威返回 Persona 与桌面续办路径', async () => {
    const member = await rig();
    const memberResponse = await member('/api/me/governance-summary');
    expect(memberResponse.status).toBe(200);
    expect(await memberResponse.json()).toEqual({
      persona: 'member', label: '普通成员', desktopPath: '/settings/my-agent', attention: { status: 'none' },
    });

    const platform = await rig({ jwt: { sub: 'platform-1', username: 'root', tenantId: 'pantheon', role: 'admin' } });
    const platformResponse = await platform('/api/me/governance-summary');
    expect(platformResponse.status).toBe(200);
    expect(await platformResponse.json()).toMatchObject({
      persona: 'platform_admin', desktopPath: '/platform-console/overview/overview', attention: { status: 'desktop_required' },
    });
  });

  it('依赖或审计不可用时返回 503 并 fail closed', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { sub: 'user-1', username: 'u', tenantId: 'tenant-a', role: 'user' }; next(); });
    app.use(createGovernanceUiRouter({}));
    const server: Server = await new Promise(resolve => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    servers.push(server);
    const address = server.address();
    const base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
    const unavailable = await fetch(`${base}/api/me/effective-resources`);
    expect(unavailable.status).toBe(503);

    const auditDown = await rig({ auditAppend: vi.fn().mockRejectedValue(new Error('audit down')) });
    const response = await auditDown('/api/access/evaluate', post({ action: 'use', resource: resource('skill', 'skill-1') }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'GOVERNANCE_AUDIT_UNAVAILABLE' });
  });
});
