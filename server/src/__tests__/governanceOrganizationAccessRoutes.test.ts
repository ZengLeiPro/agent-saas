import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TenantMembership } from '../data/memberships/index.js';
import { createGovernanceAccessRouter } from '../routes/governanceAccess.js';

const PREVIEW_SECRET = 'governance-membership-preview-test-secret-2026';
const NOW = '2026-08-10T09:00:00.000Z';
const servers: Server[] = [];

const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const commitBody = (change: Record<string, unknown>, preview: Record<string, unknown>) => ({
  ...change,
  previewId: preview.previewId,
  baselineDigest: preview.baselineDigest,
  expiresAt: preview.expiresAt,
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function rig(input: {
  getPolicies?: ReturnType<typeof vi.fn>;
  updatePolicy?: ReturnType<typeof vi.fn>;
  onDebugModeDisabled?: (tenantId: string) => Promise<void>;
  listResourceSets?: ReturnType<typeof vi.fn>;
  getAssignmentSet?: ReturnType<typeof vi.fn>;
  replaceAssignments?: ReturnType<typeof vi.fn>;
  listEffectiveResourceIds?: ReturnType<typeof vi.fn>;
  actorPersona?: 'org_admin' | 'member';
} = {}) {
  const actor: TenantMembership = {
    tenantId: 'tenant-a', userId: 'admin-1', persona: input.actorPersona ?? 'org_admin', isOwner: input.actorPersona === 'member' ? false : true,
    status: 'active', source: 'governance', version: 1,
    createdAt: NOW, createdBy: 'system', updatedAt: NOW, updatedBy: 'system',
  };
  let auditSequence = 0;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { sub: 'admin-1', username: 'admin', tenantId: 'tenant-a', role: 'admin' };
    next();
  });
  app.use('/api/governance/access', createGovernanceAccessRouter({
    memberships: {
      getPlatformAdmin: vi.fn().mockResolvedValue(null),
      getMembership: vi.fn().mockImplementation(async (tenantId: string, userId: string) =>
        tenantId === actor.tenantId && userId === actor.userId ? actor : null),
      listMemberships: vi.fn().mockResolvedValue([actor]),
    } as never,
    entitlements: {
      getEntitlementSet: vi.fn().mockResolvedValue(null),
      listResourceScopes: vi.fn().mockResolvedValue([]),
      getPolicies: input.getPolicies ?? vi.fn().mockResolvedValue([]),
      updatePolicy: input.updatePolicy ?? vi.fn(),
    } as never,
    assignments: {
      listResourceSets: input.listResourceSets ?? vi.fn().mockResolvedValue([]),
      getAssignmentSet: input.getAssignmentSet ?? vi.fn().mockResolvedValue(null),
      replaceAssignments: input.replaceAssignments ?? vi.fn(),
      listEffectiveResourceIds: input.listEffectiveResourceIds ?? vi.fn().mockResolvedValue([]),
    } as never,
    audit: {
      append: vi.fn().mockImplementation(async (event: Record<string, unknown>) => ({
        ...event, auditId: `audit-${++auditSequence}`, occurredAt: NOW,
      })),
    } as never,
    membershipPreviewSecret: PREVIEW_SECRET,
    now: () => new Date(NOW),
    ...(input.onDebugModeDisabled ? { onDebugModeDisabled: input.onDebugModeDisabled } : {}),
  }));
  const server: Server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  servers.push(server);
  const address = server.address();
  const base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  return { request: (path: string, init?: RequestInit) => fetch(`${base}${path}`, init) };
}

describe('governance organization access routes', () => {
  it('org_admin 的策略写入绑定版本化 preview→commit，且不能越租户', async () => {
    const policy = { tenantId: 'tenant-a', policyKey: 'knowledge.org.enabled', value: true, source: 'legacy_projection', version: 3, createdAt: NOW, createdBy: 'system', updatedAt: NOW, updatedBy: 'system' };
    const getPolicies = vi.fn().mockResolvedValue([policy]);
    const updatePolicy = vi.fn().mockResolvedValue({ ...policy, value: false, source: 'governance', version: 4, updatedAt: '2026-08-10T09:01:00.000Z', updatedBy: 'admin-1' });
    const test = await rig({ getPolicies, updatePolicy });
    const change = { expectedVersion: 3, value: false, reason: '组织知识暂停' };
    const previewResponse = await test.request('/api/governance/access/policies/knowledge.org.enabled/preview?tenantId=tenant-a', json('POST', change));
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json() as Record<string, unknown>;
    const commit = await test.request('/api/governance/access/policies/knowledge.org.enabled?tenantId=tenant-a', json('PUT', commitBody(change, preview)));
    expect(commit.status).toBe(200);
    expect(updatePolicy).toHaveBeenCalledWith('tenant-a', 'knowledge.org.enabled', false, 3, 'admin-1');
    expect((await commit.json())).toMatchObject({ value: false, version: 4, changeId: expect.any(String), auditId: expect.any(String) });

    const crossTenant = await test.request('/api/governance/access/policies/knowledge.org.enabled/preview?tenantId=tenant-b', json('POST', change));
    expect(crossTenant.status).toBe(403);
  });

  it('通过组织治理策略关闭调试模式时清理成员个人状态', async () => {
    const policy = { tenantId: 'tenant-a', policyKey: 'runtime.debug_mode.enabled', value: true, source: 'governance', version: 3, createdAt: NOW, createdBy: 'system', updatedAt: NOW, updatedBy: 'system' };
    const getPolicies = vi.fn().mockResolvedValue([policy]);
    const updatePolicy = vi.fn().mockResolvedValue({ ...policy, value: false, version: 4, updatedAt: '2026-08-10T09:01:00.000Z', updatedBy: 'admin-1' });
    const onDebugModeDisabled = vi.fn().mockResolvedValue(undefined);
    const test = await rig({ getPolicies, updatePolicy, onDebugModeDisabled });
    const change = { expectedVersion: 3, value: false, reason: '组织关闭调试模式' };
    const previewResponse = await test.request('/api/governance/access/policies/runtime.debug_mode.enabled/preview?tenantId=tenant-a', json('POST', change));
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json() as Record<string, unknown>;
    const commit = await test.request('/api/governance/access/policies/runtime.debug_mode.enabled?tenantId=tenant-a', json('PUT', commitBody(change, preview)));
    expect(commit.status).toBe(200);
    expect(onDebugModeDisabled).toHaveBeenCalledWith('tenant-a');
  });

  it('组织管理员不能预览或提交平台专属调试模式授权', async () => {
    const policy = { tenantId: 'tenant-a', policyKey: 'runtime.debug_mode.allowed', value: false, source: 'legacy_projection', version: 1, createdAt: NOW, createdBy: 'system', updatedAt: NOW, updatedBy: 'system' };
    const updatePolicy = vi.fn();
    const test = await rig({ getPolicies: vi.fn().mockResolvedValue([policy]), updatePolicy });
    const change = { expectedVersion: 1, value: true, reason: '尝试越权授权' };

    const preview = await test.request('/api/governance/access/policies/runtime.debug_mode.allowed/preview?tenantId=tenant-a', json('POST', change));
    expect(preview.status).toBe(403);
    await expect(preview.json()).resolves.toMatchObject({ error: 'Policy is managed by the platform' });

    const commit = await test.request('/api/governance/access/policies/runtime.debug_mode.allowed?tenantId=tenant-a', json('PUT', {
      ...change,
      previewId: `gpv1.${'a'.repeat(64)}`,
      baselineDigest: 'b'.repeat(64),
      expiresAt: '2099-01-01T00:00:00.000Z',
    }));
    expect(commit.status).toBe(403);
    expect(updatePolicy).not.toHaveBeenCalled();
  });

  it('平台未授权时组织管理员不能通过策略接口开启成员调试模式', async () => {
    const policies = [
      { tenantId: 'tenant-a', policyKey: 'runtime.debug_mode.allowed', value: false, source: 'legacy_projection', version: 1, createdAt: NOW, createdBy: 'system', updatedAt: NOW, updatedBy: 'system' },
      { tenantId: 'tenant-a', policyKey: 'runtime.debug_mode.enabled', value: false, source: 'legacy_projection', version: 1, createdAt: NOW, createdBy: 'system', updatedAt: NOW, updatedBy: 'system' },
    ];
    const updatePolicy = vi.fn();
    const test = await rig({ getPolicies: vi.fn().mockResolvedValue(policies), updatePolicy });
    const response = await test.request('/api/governance/access/policies/runtime.debug_mode.enabled/preview?tenantId=tenant-a', json('POST', {
      expectedVersion: 1, value: true, reason: '组织尝试越级开启',
    }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: '平台尚未授予调试模式，组织不能开启' });
    expect(updatePolicy).not.toHaveBeenCalled();
  });

  it('组织策略列表不向组织管理员开放平台专属授权动作', async () => {
    const policies = [
      { tenantId: 'tenant-a', policyKey: 'runtime.debug_mode.allowed', value: false, source: 'legacy_projection', version: 1, createdAt: NOW, createdBy: 'system', updatedAt: NOW, updatedBy: 'system' },
      { tenantId: 'tenant-a', policyKey: 'runtime.debug_mode.enabled', value: false, source: 'legacy_projection', version: 1, createdAt: NOW, createdBy: 'system', updatedAt: NOW, updatedBy: 'system' },
    ];
    const test = await rig({ getPolicies: vi.fn().mockResolvedValue(policies) });

    const response = await test.request('/api/governance/access/entitlements?tenantId=tenant-a');
    expect(response.status).toBe(200);
    const body = await response.json() as { policies: Array<{ policyKey: string; allowedActions: unknown[] }> };
    expect(body.policies.find(policy => policy.policyKey === 'runtime.debug_mode.allowed')?.allowedActions).toEqual([]);
    expect(body.policies.find(policy => policy.policyKey === 'runtime.debug_mode.enabled')?.allowedActions).toHaveLength(1);
  });

  it('记忆与知识资源端点只返回组织 Assignment 权威元数据，不含个人记忆正文', async () => {
    const listResourceSets = vi.fn().mockImplementation(async (_tenantId: string, resourceType: string) => resourceType === 'org_knowledge'
      ? [{ tenantId: 'tenant-a', resourceType, resourceId: 'kb-1', status: 'enabled', source: 'governance', version: 2, assignments: [{ assigneeType: 'everyone', effect: 'allow' }], createdAt: NOW, createdBy: 'admin-1', updatedAt: NOW, updatedBy: 'admin-1' }]
      : [{ tenantId: 'tenant-a', resourceType, resourceId: 'mem-1', resourceName: '团队决策', status: 'enabled', source: 'governance', version: 3, assignments: [{ assigneeType: 'everyone', effect: 'allow' }], createdAt: NOW, createdBy: 'admin-1', updatedAt: NOW, updatedBy: 'admin-1' }]);
    const getPolicies = vi.fn().mockResolvedValue([{ policyKey: 'knowledge.org.enabled', value: true }, { policyKey: 'memory.consolidation.enabled', value: false }]);
    const test = await rig({ listResourceSets, getPolicies });
    const response = await test.request('/api/governance/access/organization-resources/memory-knowledge?tenantId=tenant-a');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ authority: 'governance_assignment_sets', accessMode: 'manage', knowledge: [{ resourceId: 'kb-1', status: 'enabled' }], memory: [{ resourceId: 'mem-1', name: '团队决策', status: 'enabled', version: 3 }], effective: { organizationKnowledge: true, organizationMemory: false } });
    expect(body.memory[0]).not.toHaveProperty('content');
    expect(body.memory[0]).not.toHaveProperty('body');
    expect(body.memory[0]).not.toHaveProperty('ownerUserId');
  });

  it('普通成员只获得 effective memory/knowledge 元数据且不能进入管理写入', async () => {
    const sets = [
      { tenantId: 'tenant-a', resourceType: 'org_memory', resourceId: 'mem-allow', resourceName: '可用记忆', status: 'enabled', source: 'governance', version: 1, assignments: [], createdAt: NOW, createdBy: 'admin-1', updatedAt: NOW, updatedBy: 'admin-1' },
      { tenantId: 'tenant-a', resourceType: 'org_memory', resourceId: 'mem-private', resourceName: '未授权记忆', status: 'enabled', source: 'governance', version: 1, assignments: [], createdAt: NOW, createdBy: 'admin-1', updatedAt: NOW, updatedBy: 'admin-1' },
    ];
    const listResourceSets = vi.fn().mockImplementation(async (_tenantId: string, resourceType: string) => resourceType === 'org_memory' ? sets : []);
    const listEffectiveResourceIds = vi.fn().mockImplementation(async (_tenantId: string, _userId: string, resourceType: string) => resourceType === 'org_memory' ? [{ resourceId: 'mem-allow' }] : []);
    const test = await rig({ actorPersona: 'member', listResourceSets, listEffectiveResourceIds });
    const response = await test.request('/api/governance/access/organization-resources/memory-knowledge');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accessMode: 'effective_only', memory: [{ resourceId: 'mem-allow', effectiveAssignment: 'assigned' }] });
    const forbidden = await test.request('/api/governance/access/organization-resources/memory/preview', json('POST', { resourceId: 'mem-new', name: '新记忆', status: 'enabled', assignments: [], expectedVersion: 0, reason: '成员尝试管理' }));
    expect(forbidden.status).toBe(403);
  });

  it('组织管理员通过 signed preview→commit 创建 memory，执行 CAS 并返回审计回执', async () => {
    const getAssignmentSet = vi.fn().mockResolvedValue(null);
    const stored = { tenantId: 'tenant-a', resourceType: 'org_memory', resourceId: 'mem-1', resourceName: '团队决策', status: 'enabled', source: 'governance', version: 1, assignments: [{ assigneeType: 'everyone', effect: 'allow' }], createdAt: NOW, createdBy: 'admin-1', updatedAt: NOW, updatedBy: 'admin-1' };
    const replaceAssignments = vi.fn().mockResolvedValue(stored);
    const test = await rig({ getAssignmentSet, replaceAssignments });
    const change = { resourceId: 'mem-1', name: '团队决策', status: 'enabled', assignments: [{ assigneeType: 'everyone', effect: 'allow' }], expectedVersion: 0, reason: '建立团队记忆范围' };
    const previewResponse = await test.request('/api/governance/access/organization-resources/memory/preview?tenantId=tenant-a', json('POST', change));
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json() as Record<string, unknown>;
    const commit = await test.request('/api/governance/access/organization-resources/memory/mem-1?tenantId=tenant-a', json('PUT', commitBody(change, preview)));
    expect(commit.status).toBe(200);
    expect(replaceAssignments).toHaveBeenCalledWith('tenant-a', 'org_memory', 'mem-1', change.assignments, 0, 'admin-1', { resourceName: '团队决策', status: 'enabled' });
    expect(await commit.json()).toMatchObject({ resourceId: 'mem-1', name: '团队决策', version: 1, changeId: expect.any(String), auditId: expect.any(String) });
  });

  it('memory commit 拒绝跨租户与过期或变化的 CAS baseline', async () => {
    const current = { tenantId: 'tenant-a', resourceType: 'org_memory', resourceId: 'mem-1', resourceName: '团队决策', status: 'enabled', source: 'governance', version: 2, assignments: [], createdAt: NOW, createdBy: 'admin-1', updatedAt: NOW, updatedBy: 'admin-1' };
    const getAssignmentSet = vi.fn().mockResolvedValue(current);
    const replaceAssignments = vi.fn();
    const test = await rig({ getAssignmentSet, replaceAssignments });
    const change = { resourceId: 'mem-1', name: '团队决策', status: 'disabled', assignments: [], expectedVersion: 2, reason: '暂停组织记忆' };
    const crossTenant = await test.request('/api/governance/access/organization-resources/memory/preview?tenantId=tenant-b', json('POST', change));
    expect(crossTenant.status).toBe(403);
    const previewResponse = await test.request('/api/governance/access/organization-resources/memory/preview?tenantId=tenant-a', json('POST', change));
    const preview = await previewResponse.json() as Record<string, unknown>;
    getAssignmentSet.mockResolvedValueOnce({ ...current, version: 3 });
    const conflict = await test.request('/api/governance/access/organization-resources/memory/mem-1?tenantId=tenant-a', json('PUT', commitBody(change, preview)));
    expect(conflict.status).toBe(409);
    expect(replaceAssignments).not.toHaveBeenCalled();
  });
});
