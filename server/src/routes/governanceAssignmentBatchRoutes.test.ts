import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerGovernanceAssignmentBatchRoutes } from './governanceAssignmentBatchRoutes.js';

const NOW = '2026-08-25T12:00:00.000Z';
const SECRET = 'assignment-batch-preview-secret-2026';
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

function body(method: string, value: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) };
}

async function rig(options: {
  projectionFailureAt?: number;
  persona?: 'platform_admin' | 'org_admin';
} = {}) {
  const current = (resourceId: string) => ({
    tenantId: 'tenant-a', resourceType: 'org_knowledge', resourceId, source: 'governance',
    version: 1, assignments: [], createdAt: NOW, createdBy: 'admin-1', updatedAt: NOW, updatedBy: 'admin-1',
  });
  const getAssignmentSet = vi.fn(async (_tenant: string, _type: string, resourceId: string) => current(resourceId));
  const replaceAssignmentSetsAtomically = vi.fn(async (_tenant: string, changes: Array<Record<string, unknown>>,
    _actor: string, afterWrite?: (client: never, sets: Array<Record<string, unknown>>) => Promise<void>) => {
    const sets = changes.map(change => ({ ...change, tenantId: 'tenant-a', source: 'governance', version: 2,
      createdAt: NOW, createdBy: 'admin-1', updatedAt: NOW, updatedBy: 'admin-1' }));
    await afterWrite?.({} as never, sets);
    return sets;
  });
  let projectionCall = 0;
  const enqueueWithClient = vi.fn(async () => {
    projectionCall += 1;
    if (projectionCall === options.projectionFailureAt) throw new Error('OUTBOX_FAILED');
    return { outboxId: `projection-${projectionCall}` };
  });
  const router = express.Router();
  registerGovernanceAssignmentBatchRoutes({
    router,
    assignments: { getAssignmentSet, replaceAssignmentSetsAtomically } as never,
    memberships: { listMemberships: vi.fn(async () => ['user-2', 'user-3'].map(userId => ({
      tenantId: 'tenant-a', userId, persona: 'member', isOwner: false,
      status: 'active', source: 'governance', version: 1,
      createdAt: NOW, createdBy: 'admin-1', updatedAt: NOW, updatedBy: 'admin-1',
    }))) } as never,
    secret: SECRET,
    previewTtlMs: 300_000,
    now: () => new Date(NOW),
    personaFor: () => options.persona ?? 'org_admin',
    tenantFor: () => 'tenant-a',
    validateSubjects: async () => null,
    validateResource: async () => null,
    assignmentSnapshot: async () => ({
      activeMemberships: [{ userId: 'user-2' }, { userId: 'user-3' }],
      groups: [{ groupId: 'dept-rd', displayName: '研发部', memberUserIds: ['user-2', 'user-3'] }],
    }),
    getMemberProfile: (_tenantId, userId) => ({ displayName: userId === 'user-2' ? '测试成员' : userId }),
    ...(options.projectionFailureAt ? { projectionOutbox: { enqueueWithClient } as never } : {}),
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { sub: 'admin-1', username: 'admin', tenantId: 'tenant-a', role: 'admin' };
    next();
  });
  app.use('/api/governance/access', router);
  const server = await new Promise<Server>(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  servers.push(server);
  const address = server.address();
  const baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  return { request: (path: string, init?: RequestInit) => fetch(`${baseUrl}${path}`, init),
    replaceAssignmentSetsAtomically, enqueueWithClient };
}

describe('Assignment batch routes', () => {
  it('一次预览并原子提交 Taskboard 套件，任一篡改不会执行写入', async () => {
    const test = await rig();
    const change = { reason: '开放 Taskboard 给指定成员', changes: [
      'taskboard-projects', 'taskboard-tasks', 'taskboard-events',
    ].map(resourceId => ({ resourceType: 'org_knowledge', resourceId, expectedVersion: 1,
      assignments: [{ assigneeType: 'user', assigneeId: 'user-2', effect: 'allow' }] })) };
    const previewResponse = await test.request('/api/governance/access/assignments/batch/preview', body('POST', change));
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json() as Record<string, unknown>;
    expect(preview).toMatchObject({ impact: { resourceCount: 3, directSubjectCount: 1,
      effectiveUserCount: 1, addedUserCount: 1, removedUserCount: 0, atomic: true } });
    expect((preview.changes as Array<Record<string, unknown>>)[0]).toMatchObject({
      resourceId: 'taskboard-projects', addedCount: 1, removedCount: 0,
      after: [{ assigneeType: 'user', assigneeId: 'user-2', effect: 'allow', label: '测试成员' }],
    });

    const tampered = structuredClone(change);
    tampered.changes[0]!.assignments = [];
    const previewFields = { previewId: preview.previewId, baselineDigest: preview.baselineDigest, expiresAt: preview.expiresAt };
    const denied = await test.request('/api/governance/access/assignments/batch',
      body('PUT', { ...tampered, ...previewFields }));
    expect(denied.status).toBe(409);
    expect(test.replaceAssignmentSetsAtomically).not.toHaveBeenCalled();

    const committed = await test.request('/api/governance/access/assignments/batch',
      body('PUT', { ...change, ...previewFields }));
    expect(committed.status).toBe(200);
    expect(test.replaceAssignmentSetsAtomically).toHaveBeenCalledWith('tenant-a', change.changes, 'admin-1', undefined);
    const receipt = await committed.json() as Record<string, unknown>;
    expect(receipt).toMatchObject({ changed: true, requiresNewSession: true });
    expect((receipt.sets as Array<Record<string, unknown>>)[0]).toMatchObject({ version: 2 });
  });

  it('平台管理员可使用相同签名合同批量管理显式目标组织 Assignment', async () => {
    const test = await rig({ persona: 'platform_admin' });
    const change = {
      reason: 'platform organization assignment update',
      changes: [{
        resourceType: 'org_knowledge', resourceId: 'taskboard-projects', expectedVersion: 1,
        assignments: [{ assigneeType: 'everyone', effect: 'allow' }],
      }],
    };
    const previewResponse = await test.request(
      '/api/governance/access/assignments/batch/preview?tenantId=tenant-a',
      body('POST', change),
    );
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json() as Record<string, unknown>;
    const committed = await test.request(
      '/api/governance/access/assignments/batch?tenantId=tenant-a',
      body('PUT', { ...change, previewId: preview.previewId,
        baselineDigest: preview.baselineDigest, expiresAt: preview.expiresAt }),
    );
    expect(committed.status).toBe(200);
    expect(test.replaceAssignmentSetsAtomically).toHaveBeenCalled();
  });

  it('批量规则总数超过 500 时在进入目录与事务前拒绝', async () => {
    const test = await rig();
    const response = await test.request('/api/governance/access/assignments/batch/preview', body('POST', {
      reason: '验证批量安全上限',
      changes: [{ resourceType: 'org_knowledge', resourceId: 'taskboard-projects', expectedVersion: 1,
        assignments: Array.from({ length: 501 }, (_, index) => ({
          assigneeType: 'user', assigneeId: `user-${index}`, effect: 'allow',
        })) }],
    }));
    expect(response.status).toBe(400);
    expect(test.replaceAssignmentSetsAtomically).not.toHaveBeenCalled();
  });

  it('预览解析真实群组名称并按去重后的 effective audience 计算人数', async () => {
    const test = await rig();
    const change = { reason: '按部门授权 Taskboard', changes: [{ resourceType: 'org_knowledge',
      resourceId: 'taskboard-projects', expectedVersion: 1,
      assignments: [{ assigneeType: 'directory_group', assigneeId: 'dept-rd', effect: 'allow' },
        { assigneeType: 'user', assigneeId: 'user-2', effect: 'allow' }] }] };
    const response = await test.request('/api/governance/access/assignments/batch/preview', body('POST', change));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      changes: [{ after: [
        { assigneeType: 'directory_group', assigneeId: 'dept-rd', label: '研发部' },
        { assigneeType: 'user', assigneeId: 'user-2', label: '测试成员' },
      ], beforeUserCount: 0, afterUserCount: 2, addedUserCount: 2 }],
      impact: { effectiveUserCount: 2, addedUserCount: 2 },
    });
  });

  it('projection outbox 任一写入失败时整批返回 changed=false', async () => {
    const test = await rig({ projectionFailureAt: 2 });
    const change = { reason: '原子提交 Taskboard 与投影', changes: [
      'taskboard-projects', 'taskboard-tasks', 'taskboard-events',
    ].map(resourceId => ({ resourceType: 'org_knowledge', resourceId, expectedVersion: 1,
      assignments: [{ assigneeType: 'user', assigneeId: 'user-2', effect: 'allow' }] })) };
    const previewResponse = await test.request('/api/governance/access/assignments/batch/preview', body('POST', change));
    const preview = await previewResponse.json() as Record<string, unknown>;
    const committed = await test.request('/api/governance/access/assignments/batch', body('PUT', { ...change,
      previewId: preview.previewId, baselineDigest: preview.baselineDigest, expiresAt: preview.expiresAt }));
    expect(committed.status).toBe(500);
    await expect(committed.json()).resolves.toMatchObject({ changed: false, code: 'ASSIGNMENT_BATCH_WRITE_FAILED' });
    expect(test.enqueueWithClient).toHaveBeenCalledTimes(2);
  });
});
