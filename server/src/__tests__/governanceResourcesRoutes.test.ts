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

function skillUploadBody(name = 'uploaded-skill', scope: 'tenant' | 'personal' = 'tenant'): FormData {
  const form = new FormData();
  form.set('scope', scope);
  form.append('files', new Blob([
    `---\nname: ${name}\ndescription: uploaded\n---\nbody`,
  ], { type: 'text/markdown' }), 'SKILL.md');
  return form;
}

async function rig(input: {
  user?: JwtPayload;
  auditAppend?: ReturnType<typeof vi.fn>;
  agentCreate?: ReturnType<typeof vi.fn>;
  agentPublish?: ReturnType<typeof vi.fn>;
  agentSetStatus?: ReturnType<typeof vi.fn>;
  agentArchive?: ReturnType<typeof vi.fn>;
  getAgent?: ReturnType<typeof vi.fn>;
  getSkill?: ReturnType<typeof vi.fn>;
  getCandidate?: ReturnType<typeof vi.fn>;
  skillCreate?: ReturnType<typeof vi.fn>;
  skillPublishVersion?: ReturnType<typeof vi.fn>;
  skillCreateCandidate?: ReturnType<typeof vi.fn>;
  skillSubmitCandidate?: ReturnType<typeof vi.fn>;
  skillReviewCandidate?: ReturnType<typeof vi.fn>;
  skillPublishCandidate?: ReturnType<typeof vi.fn>;
  skillImport?: ReturnType<typeof vi.fn>;
  personalSkillImport?: ReturnType<typeof vi.fn>;
  listCredentials?: ReturnType<typeof vi.fn>;
  getCredential?: ReturnType<typeof vi.fn>;
  updateCredential?: ReturnType<typeof vi.fn>;
  connectorUpdateStatus?: ReturnType<typeof vi.fn>;
  environmentRetire?: ReturnType<typeof vi.fn>;
  listOwnedAgents?: ReturnType<typeof vi.fn>;
  listOwnedSkills?: ReturnType<typeof vi.fn>;
  credentialCreate?: ReturnType<typeof vi.fn>;
  putSecret?: ReturnType<typeof vi.fn>;
  executeUserOffboarding?: ReturnType<typeof vi.fn> & { retry?: ReturnType<typeof vi.fn> };
  getChangeJob?: ReturnType<typeof vi.fn>;
  projectionEnqueue?: ReturnType<typeof vi.fn>;
  getMembership?: ReturnType<typeof vi.fn>;
  listCronIdsByOwner?: (userId: string) => Promise<Array<{ id: string; version: string }>>;
  listActiveRunIdsByUser?: (tenantId: string, userId: string) => Promise<Array<{ id: string; version: string }>>;
  listActiveSessionIdsByUser?: (tenantId: string, userId: string) => Promise<Array<{ id: string; version: string }>>;
  listActiveOAuthGrantIdsByUser?: (tenantId: string, userId: string) => Promise<Array<{ id: string; version: string }>>;
  listExternalConnectionIdsByUser?: (tenantId: string, userId: string) => Promise<Array<{ id: string; version: string }>>;
  listPersonalMemoryIds?: (tenantId: string, userId: string) => Promise<string[]>;
  listFileOwnership?: (tenantId: string, userId: string) => Promise<{ personalFileIds: string[]; organizationFileIds: string[] }>;
  platformAdmin?: boolean;
  tenantExists?: (tenantId: string) => boolean;
  omitRetentionAuthorities?: boolean;
  omitExecutionAuthorities?: boolean;
}) {
  const auditAppend = input.auditAppend ?? vi.fn().mockResolvedValue({});
  const agentCreate = input.agentCreate ?? vi.fn().mockImplementation(async value => ({
    ...value, agentId: value.agentId ?? 'pa-1', status: 'draft', revision: 1,
  }));
  const credentialCreate = input.credentialCreate ?? vi.fn().mockImplementation(async value => ({
    ...value, credentialId: 'cred-1', secretRef: value.secretRef,
    status: 'active', generation: 1, version: 1,
  }));
  const skillCreate = input.skillCreate ?? vi.fn().mockImplementation(async value => ({
    ...value, status: 'draft', revision: 1,
  }));
  const agentPublish = input.agentPublish ?? vi.fn();
  const agentSetStatus = input.agentSetStatus ?? vi.fn();
  const agentArchive = input.agentArchive ?? vi.fn();
  const skillPublishVersion = input.skillPublishVersion ?? vi.fn();
  const skillCreateCandidate = input.skillCreateCandidate ?? vi.fn();
  const skillSubmitCandidate = input.skillSubmitCandidate ?? vi.fn();
  const skillReviewCandidate = input.skillReviewCandidate ?? vi.fn();
  const skillPublishCandidate = input.skillPublishCandidate ?? vi.fn();
  const skillImport = input.skillImport ?? vi.fn().mockResolvedValue({
    ok: true,
    status: 'succeeded',
    skill: { id: 'uploaded-skill', name: 'uploaded-skill', description: 'uploaded' },
    resource: { skillId: 'uploaded-skill', tenantId: 'tenant-a', scope: 'tenant', status: 'published', revision: 2 },
    version: { versionId: 'skillv-1', skillId: 'uploaded-skill', versionNumber: 1 },
  });
  const personalSkillImport = input.personalSkillImport ?? vi.fn().mockResolvedValue({
    ok: true, status: 'succeeded', selected: true,
    skill: { id: 'personal-skill', name: 'personal-skill', description: 'uploaded' },
    resource: { skillId: 'personal-hash', tenantId: 'tenant-a', scope: 'personal', ownerUserId: 'user-1', status: 'published', revision: 2 },
    version: { versionId: 'skillv-personal', skillId: 'personal-hash', versionNumber: 1 },
  });
  const connectorUpdateStatus = input.connectorUpdateStatus ?? vi.fn();
  const environmentRetire = input.environmentRetire ?? vi.fn();
  const updateCredential = input.updateCredential ?? vi.fn();
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
      getPlatformAdmin: vi.fn().mockResolvedValue(input.platformAdmin ? { userId: input.user?.sub ?? 'platform-1', status: 'active' } : null),
      getMembership: input.getMembership ?? vi.fn().mockResolvedValue({
        tenantId: 'tenant-a', userId: input.user?.sub ?? 'user-1',
        persona: (input.user?.role ?? 'user') === 'admin' ? 'org_admin' : 'member',
        isOwner: false, status: 'active', version: 1,
      }),
    } as never,
    agents: {
      create: agentCreate,
      publishVersion: agentPublish,
      setStatus: agentSetStatus,
      archive: agentArchive,
      getForTenant: input.getAgent ?? vi.fn().mockResolvedValue(null),
      listByOwner: input.listOwnedAgents ?? vi.fn().mockResolvedValue([]),
      listByKind: vi.fn().mockResolvedValue([{ agentId: 'template-1', kind: 'agent_template', status: 'draft', revision: 1 }]),
    } as never,
    skills: {
      getResource: input.getSkill ?? vi.fn().mockResolvedValue(null),
      getCandidate: input.getCandidate ?? vi.fn().mockResolvedValue(null),
      createResource: skillCreate,
      publishVersion: skillPublishVersion,
      createCandidate: skillCreateCandidate,
      submitCandidate: skillSubmitCandidate,
      reviewCandidate: skillReviewCandidate,
      publishApprovedCandidate: skillPublishCandidate,
      listPersonalByOwner: input.listOwnedSkills ?? vi.fn().mockResolvedValue([]),
      listPublishedPlatform: vi.fn().mockResolvedValue([]),
    } as never,
    importTenantSkill: skillImport as never,
    importPersonalSkill: personalSkillImport as never,
    connectors: {
      get: vi.fn().mockResolvedValue({ connectorId: 'github', status: 'published' }),
      list: vi.fn().mockResolvedValue([]), updateStatus: connectorUpdateStatus,
    } as never,
    credentials: {
      create: credentialCreate,
      get: input.getCredential ?? vi.fn().mockResolvedValue(null),
      updateStatus: updateCredential,
      listForTenant: input.listCredentials ?? vi.fn().mockResolvedValue([]),
      listForOwner: vi.fn().mockResolvedValue([]),
      listForCustodian: vi.fn().mockResolvedValue([]),
    } as never,
    environments: {
      listTemplates: vi.fn().mockResolvedValue([{ templateId: 'env-1', name: 'Node', status: 'published', revision: 2 }]),
      retireTemplate: environmentRetire,
    } as never,
    changeJobs: {
      get: input.getChangeJob ?? vi.fn().mockResolvedValue(null),
      findActiveForTarget: vi.fn().mockResolvedValue(null),
      listDomains: vi.fn().mockResolvedValue([]),
    } as never,
    changePlanner: {} as never,
    offboardingPreviewSecret: 'test-offboarding-preview-secret-32-characters',
    tenantExists: input.tenantExists ?? (() => true),
    listCronIdsByOwner: input.listCronIdsByOwner ?? (async () => []),
    ...(!input.omitExecutionAuthorities ? {
      listActiveRunIdsByUser: input.listActiveRunIdsByUser ?? (async () => []),
      listActiveSessionIdsByUser: input.listActiveSessionIdsByUser ?? (async () => []),
      listActiveOAuthGrantIdsByUser: input.listActiveOAuthGrantIdsByUser ?? (async () => []),
      listExternalConnectionIdsByUser: input.listExternalConnectionIdsByUser ?? (async () => []),
    } : {}),
    ...(!input.omitRetentionAuthorities ? {
      listPersonalMemoryIds: input.listPersonalMemoryIds ?? (async () => []),
      listFileOwnership: input.listFileOwnership ?? (async () => ({ personalFileIds: [], organizationFileIds: [] })),
    } : {}),
    ...(input.executeUserOffboarding ? { executeUserOffboarding: input.executeUserOffboarding as never } : {}),
    ...(input.projectionEnqueue ? {
      projectionOutbox: { enqueue: input.projectionEnqueue } as never,
      projectionReconciler: { reconcileOne: vi.fn().mockResolvedValue(null) } as never,
    } : {}),
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
    auditAppend, agentCreate, agentPublish, agentSetStatus, agentArchive,
    skillCreate, skillPublishVersion, skillCreateCandidate, skillSubmitCandidate,
    skillReviewCandidate, skillPublishCandidate, skillImport, personalSkillImport, credentialCreate, updateCredential,
    connectorUpdateStatus, environmentRetire, putSecret,
  };
}

async function createOffboardingPreview(
  test: Awaited<ReturnType<typeof rig>>,
  change: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await test.request(
    '/api/governance/resources/previews/user-offboarding',
    json('POST', change),
  );
  expect(response.status).toBe(200);
  return await response.json() as Record<string, unknown>;
}

function withOffboardingPreview(change: Record<string, unknown>, preview: Record<string, unknown>) {
  return {
    ...change,
    idempotencyKey: preview.idempotencyKey,
    previewId: preview.previewId,
    baselineDigest: preview.baselineDigest,
    expiresAt: preview.expiresAt,
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
    const projectionEnqueue = vi.fn().mockResolvedValue({ outboxId: 'audit-terminal-1' });
    const test = await rig({ auditAppend, projectionEnqueue });
    const response = await test.request('/api/governance/resources/agents', json('POST', {
      kind: 'personal_agent', ownerUserId: 'user-1',
    }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ auditId: 'intent-1', auditCompletion: 'pending', auditProjectionId: 'audit-terminal-1' });
    expect(test.agentCreate).toHaveBeenCalledOnce();
    expect(projectionEnqueue).toHaveBeenCalledWith(expect.objectContaining({ projector: 'audit_terminal' }));
  });

  it('平台管理员代管组织通过治理 multipart 入口上传，目标租户与创建人保持显式绑定', async () => {
    const test = await rig({
      platformAdmin: true,
      user: { sub: 'platform-1', username: 'root', tenantId: 'pantheon', role: 'admin' },
    });

    const response = await test.request('/api/governance/resources/skills/import?tenantId=tenant-a', {
      method: 'POST',
      body: skillUploadBody(),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      ok: true,
      status: 'succeeded',
      skill: { id: 'uploaded-skill' },
    });
    expect(test.skillImport).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      actorUserId: 'platform-1',
      files: [expect.objectContaining({ originalname: 'SKILL.md' })],
    });
  });

  it('组织管理员仅可上传到本组织，普通成员和跨组织请求均被拒绝', async () => {
    const admin = await rig({
      user: { sub: 'admin-1', username: 'admin', tenantId: 'tenant-a', role: 'admin' },
    });
    const own = await admin.request('/api/governance/resources/skills/import?tenantId=tenant-a', {
      method: 'POST', body: skillUploadBody('own-skill'),
    });
    expect(own.status).toBe(201);
    expect(admin.skillImport).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-a' }));

    const cross = await admin.request('/api/governance/resources/skills/import?tenantId=tenant-b', {
      method: 'POST', body: skillUploadBody('cross-skill'),
    });
    expect(cross.status).toBe(403);
    expect(admin.skillImport).toHaveBeenCalledTimes(1);

    const member = await rig({
      user: { sub: 'member-1', username: 'member', tenantId: 'tenant-a', role: 'user' },
    });
    const denied = await member.request('/api/governance/resources/skills/import?tenantId=tenant-a', {
      method: 'POST', body: skillUploadBody('member-skill'),
    });
    expect(denied.status).toBe(403);
    expect(member.skillImport).not.toHaveBeenCalled();
  });

  it('普通成员通过治理入口导入个人 Skill，并强制绑定当前用户与组织', async () => {
    const member = await rig({ user: { sub: 'member-1', username: 'member', tenantId: 'tenant-a', role: 'user' } });
    const response = await member.request('/api/governance/resources/skills/import', { method: 'POST', body: skillUploadBody('personal-skill', 'personal') });
    expect(response.status).toBe(201);
    expect(member.personalSkillImport).toHaveBeenCalledWith({ tenantId: 'tenant-a', actorUserId: 'member-1', files: [expect.objectContaining({ originalname: 'SKILL.md' })] });
    expect(member.skillImport).not.toHaveBeenCalled();
  });

  it('Skill 上传缺少合法 scope 时拒绝且不调用写服务', async () => {
    const test = await rig({}); const form = new FormData(); form.append('files', new Blob(['content']), 'SKILL.md');
    const response = await test.request('/api/governance/resources/skills/import', { method: 'POST', body: form });
    expect(response.status).toBe(400); await expect(response.json()).resolves.toMatchObject({ code: 'SKILL_SCOPE_INVALID' });
    expect(test.skillImport).not.toHaveBeenCalled(); expect(test.personalSkillImport).not.toHaveBeenCalled();
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

  it('平台模板目录枚举稳定 Agent/Environment Template 资源', async () => {
    const test = await rig({
      user: { sub: 'platform-1', username: 'platform', tenantId: 'pantheon', role: 'admin' },
      platformAdmin: true,
    });
    const agents = await test.request('/api/governance/resources/agents?kind=agent_template');
    expect(agents.status).toBe(200);
    expect(await agents.json()).toMatchObject({ agents: [{ agentId: 'template-1', kind: 'agent_template' }] });
    const environments = await test.request('/api/governance/resources/environment/templates');
    expect(environments.status).toBe(200);
    expect(await environments.json()).toMatchObject({ templates: [{ templateId: 'env-1', revision: 2 }] });
  });

  it('组织管理员可通过 HTTP 创建 durable user offboarding Change Job', async () => {
    const executeUserOffboarding = vi.fn().mockResolvedValue({
      job: { jobId: 'job-offboard-1', status: 'pending', jobType: 'user_offboarding' },
      receipt: { status: 'accepted' },
    });
    const test = await rig({
      user: { sub: 'admin-1', username: 'admin', tenantId: 'tenant-a', role: 'admin' },
      executeUserOffboarding,
    });
    const change = {
      userId: 'user-leaving', handoffTargetUserId: 'user-owner', reasonCode: 'employee_departure',
    };
    const preview = await createOffboardingPreview(test, change);
    expect(preview).toMatchObject({ canCommit: true, blockers: [] });
    const response = await test.request(
      '/api/governance/resources/change-jobs/user-offboarding',
      json('POST', withOffboardingPreview({ ...change, idempotencyKey: 'offboard-20260809-1' }, preview)),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ job: { jobId: 'job-offboard-1' } });
    expect(executeUserOffboarding).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a', userId: 'user-leaving', handoffTargetUserId: 'user-owner',
      idempotencyKey: preview.idempotencyKey, reasonCode: 'employee_departure', requestedBy: 'admin-1',
      manifest: expect.objectContaining({ baselineDigest: preview.baselineDigest }),
    }));
  });

  it('offboarding retry endpoint 以 jobId/revision 恢复后台执行', async () => {
    const retry = vi.fn().mockResolvedValue({ job: { jobId: 'job-offboard-1', status: 'succeeded' } });
    const executeUserOffboarding = Object.assign(vi.fn(), { retry });
    const getChangeJob = vi.fn();
    const test = await rig({
      user: { sub: 'admin-1', username: 'admin', tenantId: 'tenant-a', role: 'admin' },
      executeUserOffboarding,
      getChangeJob,
    });
    const preview = await createOffboardingPreview(test, {
      userId: 'user-leaving', handoffTargetUserId: 'user-owner', reasonCode: 'employee_departure',
    });
    getChangeJob.mockResolvedValue({
      jobId: 'job-offboard-1', tenantId: 'tenant-a', jobType: 'user_offboarding',
      targetId: 'user-leaving', revision: 4, status: 'retry_wait',
      request: {
        handoffTarget: { userId: 'user-owner' },
        manifest: { baselineDigest: preview.baselineDigest },
      },
    });
    const response = await test.request(
      '/api/governance/resources/change-jobs/job-offboard-1/retry',
      json('POST', { expectedRevision: 4 }),
    );
    expect(response.status).toBe(202);
    expect(retry).toHaveBeenCalledWith({
      tenantId: 'tenant-a', jobId: 'job-offboard-1', expectedRevision: 4, requestedBy: 'admin-1',
    });
  });

  it('offboarding 对个人 Agent 与 Skill 使用 retain_and_disable，不转给接手人', async () => {
    const test = await rig({
      user: { sub: 'admin-1', username: 'admin', tenantId: 'tenant-a', role: 'admin' },
      listOwnedAgents: vi.fn().mockResolvedValue([{ agentId: 'personal-a', kind: 'personal_agent', status: 'enabled', revision: 1 }]),
      listOwnedSkills: vi.fn().mockResolvedValue([{ skillId: 'personal-s', status: 'published', revision: 1 }]),
    });
    const preview = await createOffboardingPreview(test, {
      userId: 'user-leaving', handoffTargetUserId: 'user-owner', reasonCode: 'employee_departure',
    });
    expect(preview).toMatchObject({
      canCommit: true,
      impact: {
        personalAgents: [{ id: 'personal-a', action: 'archive' }],
        skills: [{ id: 'personal-s', action: 'retain_and_disable' }],
      },
    });
    expect(preview.blockers).toEqual([]);
  });

  it('offboarding 在个人 Memory 或文件 ownership authority 缺失时 fail closed', async () => {
    const test = await rig({
      user: { sub: 'admin-1', username: 'admin', tenantId: 'tenant-a', role: 'admin' },
      omitRetentionAuthorities: true,
    });
    const preview = await createOffboardingPreview(test, {
      userId: 'user-leaving', handoffTargetUserId: 'user-owner', reasonCode: 'employee_departure',
    });
    expect(preview).toMatchObject({ canCommit: false });
    expect(preview.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PERSONAL_MEMORY_AUTHORITY_UNAVAILABLE' }),
      expect.objectContaining({ code: 'FILE_OWNERSHIP_AUTHORITY_UNAVAILABLE' }),
    ]));
  });

  it('active Run、Session、OAuth Grant 或外部连接 authority 缺失时 preview fail closed', async () => {
    const test = await rig({
      user: { sub: 'admin-1', username: 'admin', tenantId: 'tenant-a', role: 'admin' },
      omitExecutionAuthorities: true,
    });
    const preview = await createOffboardingPreview(test, {
      userId: 'user-leaving', handoffTargetUserId: 'user-owner', reasonCode: 'employee_departure',
    });
    expect(preview).toMatchObject({ canCommit: false });
    expect(preview.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ACTIVE_RUN_AUTHORITY_UNAVAILABLE' }),
      expect.objectContaining({ code: 'SESSION_RETENTION_AUTHORITY_UNAVAILABLE' }),
      expect.objectContaining({ code: 'OAUTH_GRANT_AUTHORITY_UNAVAILABLE' }),
      expect.objectContaining({ code: 'EXTERNAL_CONNECTION_AUTHORITY_UNAVAILABLE' }),
    ]));
  });

  it('offboarding 将个人 Memory 与个人文件纳入归档快照，组织文件仍 fail closed', async () => {
    const personalOnly = await rig({
      user: { sub: 'admin-1', username: 'admin', tenantId: 'tenant-a', role: 'admin' },
      listPersonalMemoryIds: async () => ['MEMORY.md'],
      listFileOwnership: async () => ({ personalFileIds: ['uploads/a.pdf'], organizationFileIds: [] }),
    });
    const personalPreview = await createOffboardingPreview(personalOnly, {
      userId: 'user-leaving', handoffTargetUserId: 'user-owner', reasonCode: 'employee_departure',
    });
    expect(personalPreview).toMatchObject({
      canCommit: true,
      impact: { personalMemory: { status: 'archive' }, fileOwnership: { status: 'archive' } },
    });

    const withOrganizationFile = await rig({
      user: { sub: 'admin-1', username: 'admin', tenantId: 'tenant-a', role: 'admin' },
      listFileOwnership: async () => ({ personalFileIds: [], organizationFileIds: ['org/contracts/a.pdf'] }),
    });
    const blocked = await createOffboardingPreview(withOrganizationFile, {
      userId: 'user-leaving', handoffTargetUserId: 'user-owner', reasonCode: 'employee_departure',
    });
    expect(blocked).toMatchObject({ canCommit: false });
    expect(blocked.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ORGANIZATION_FILE_HANDOFF_UNSUPPORTED', targetId: 'org/contracts/a.pdf' }),
    ]));
  });

  it('offboarding 将 Cron 纳入可执行 manifest，不再因存在 Cron 永久预阻断', async () => {
    const executeUserOffboarding = vi.fn().mockResolvedValue({ job: { jobId: 'job-cron', status: 'pending' } });
    const test = await rig({
      user: { sub: 'admin-1', username: 'admin', tenantId: 'tenant-a', role: 'admin' },
      executeUserOffboarding,
      listCronIdsByOwner: async () => [{ id: 'cron-1', version: 'v1' }],
    });
    const change = { userId: 'user-leaving', handoffTargetUserId: 'user-owner', reasonCode: 'employee_departure' };
    const preview = await createOffboardingPreview(test, change);
    expect(preview).toMatchObject({
      canCommit: true,
      blockers: [],
      impact: { cronOwnership: { status: 'transfer', ids: ['cron-1'] } },
    });
    const response = await test.request(
      '/api/governance/resources/change-jobs/user-offboarding',
      json('POST', withOffboardingPreview({ ...change, idempotencyKey: 'offboard-cron-1' }, preview)),
    );
    expect(response.status).toBe(202);
    expect(executeUserOffboarding).toHaveBeenCalledOnce();
  });

  it('offboarding commit 检出 active Run inventory drift 并返回 409', async () => {
    const executeUserOffboarding = vi.fn();
    let call = 0;
    const test = await rig({
      user: { sub: 'admin-1', username: 'admin', tenantId: 'tenant-a', role: 'admin' },
      executeUserOffboarding,
      listActiveRunIdsByUser: async () => (++call === 1 ? [{ id: 'run-1', version: 'v1' }] : [{ id: 'run-1', version: 'v1' }, { id: 'run-2', version: 'v1' }]),
    });
    const change = { userId: 'user-leaving', handoffTargetUserId: 'user-owner', reasonCode: 'employee_departure' };
    const preview = await createOffboardingPreview(test, change);
    const response = await test.request(
      '/api/governance/resources/change-jobs/user-offboarding',
      json('POST', withOffboardingPreview({ ...change, idempotencyKey: 'offboard-drift-1' }, preview)),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'OFFBOARDING_PREVIEW_BASELINE_CONFLICT' });
    expect(executeUserOffboarding).not.toHaveBeenCalled();
  });

  it('offboarding commit 检出同一 OAuth Grant 的版本漂移', async () => {
    const executeUserOffboarding = vi.fn();
    let call = 0;
    const test = await rig({
      user: { sub: 'admin-1', username: 'admin', tenantId: 'tenant-a', role: 'admin' },
      executeUserOffboarding,
      listActiveOAuthGrantIdsByUser: async () => [{ id: 'grant-1', version: ++call === 1 ? 'v1' : 'v2' }],
    });
    const change = { userId: 'user-leaving', handoffTargetUserId: 'user-owner', reasonCode: 'employee_departure' };
    const preview = await createOffboardingPreview(test, change);
    const response = await test.request(
      '/api/governance/resources/change-jobs/user-offboarding',
      json('POST', withOffboardingPreview({ ...change, idempotencyKey: 'offboard-grant-drift-1' }, preview)),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'OFFBOARDING_PREVIEW_BASELINE_CONFLICT' });
    expect(executeUserOffboarding).not.toHaveBeenCalled();
  });

  it('offboarding 在创建 Change Job 前拒绝跨租户目标或失效 handoff', async () => {
    const executeUserOffboarding = vi.fn();
    const getMembership = vi.fn(async (_tenantId: string, userId: string) =>
      ['admin-1', 'user-owner'].includes(userId)
        ? { tenantId: 'tenant-a', userId, persona: 'org_admin', status: 'active' }
        : null,
    );
    const test = await rig({
      user: { sub: 'admin-1', username: 'admin', tenantId: 'tenant-a', role: 'admin' },
      executeUserOffboarding,
      getMembership,
    });
    const response = await test.request('/api/governance/resources/previews/user-offboarding', json('POST', {
      userId: 'user-from-other-tenant', handoffTargetUserId: 'user-owner', reasonCode: 'employee_departure',
    }));
    expect(response.status).toBe(404);
    expect(executeUserOffboarding).not.toHaveBeenCalled();
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

  it('组织管理员不得读取成员个人 Agent、个人 Skill 或个人 Credential 元数据', async () => {
    const personalAgent = { agentId: 'personal-a', tenantId: 'tenant-a', kind: 'personal_agent', ownerUserId: 'member-2', status: 'enabled', revision: 1 };
    const personalSkill = { skillId: 'personal-s', tenantId: 'tenant-a', scope: 'personal', ownerUserId: 'member-2', status: 'published', revision: 1 };
    const test = await rig({
      user: { sub: 'admin-1', username: 'admin', tenantId: 'tenant-a', role: 'admin' },
      getAgent: vi.fn().mockResolvedValue(personalAgent),
      getSkill: vi.fn().mockResolvedValue(personalSkill),
      listCredentials: vi.fn().mockResolvedValue([
        { credentialId: 'personal-c', tenantId: 'tenant-a', kind: 'personal_grant', purpose: 'private', secretRef: 'hidden' },
        { credentialId: 'shared-c', tenantId: 'tenant-a', kind: 'org_shared', purpose: 'shared', secretRef: 'hidden' },
      ]),
    });
    expect((await test.request('/api/governance/resources/agents/personal-a?tenantId=tenant-a')).status).toBe(404);
    expect((await test.request('/api/governance/resources/skills/personal-s?tenantId=tenant-a')).status).toBe(404);
    const credentials = await (await test.request('/api/governance/resources/credentials?tenantId=tenant-a')).json() as { credentials: Array<{ credentialId: string }> };
    expect(credentials.credentials.map(item => item.credentialId)).toEqual(['shared-c']);
  });

  it.each([
    ['member owner', { sub: 'member-1', username: 'member', tenantId: 'tenant-a', role: 'user' } as JwtPayload, false],
    ['member non-owner', { sub: 'member-2', username: 'member2', tenantId: 'tenant-a', role: 'user' } as JwtPayload, false],
    ['org_admin non-owner', { sub: 'admin-1', username: 'admin', tenantId: 'tenant-a', role: 'admin' } as JwtPayload, false],
    ['platform_admin non-owner', { sub: 'platform-1', username: 'root', tenantId: 'tenant-a', role: 'admin' } as JwtPayload, true],
  ])('%s 对 personal Skill candidate create/submit/review/publish 一律 404', async (_label, user, platformAdmin) => {
    const personalSkill = {
      skillId: 'personal-s', tenantId: 'tenant-a', scope: 'personal', ownerUserId: 'member-1',
      status: 'draft', revision: 1,
    };
    const candidate = {
      candidateId: 'skillc-personal', tenantId: 'tenant-a', ownerUserId: 'member-1',
      targetSkillId: 'personal-s', status: 'draft', revision: 1,
    };
    const test = await rig({
      user, platformAdmin,
      getSkill: vi.fn().mockResolvedValue(personalSkill),
      getCandidate: vi.fn().mockResolvedValue(candidate),
    });
    const responses = [
      await test.request('/api/governance/resources/skills/personal-s/candidates', json('POST', { definition: { name: 'x' } })),
      await test.request('/api/governance/resources/skill-candidates/skillc-personal/submit', json('POST', { expectedRevision: 1 })),
      await test.request('/api/governance/resources/skill-candidates/skillc-personal/review', json('POST', {
        expectedRevision: 1, verdict: 'approved', reason: 'no',
      })),
      await test.request('/api/governance/resources/skill-candidates/skillc-personal/publish', json('POST', {
        expectedCandidateRevision: 1, expectedSkillRevision: 1,
      })),
    ];
    expect(responses.map(response => response.status)).toEqual([404, 404, 404, 404]);
    expect(test.skillCreateCandidate).not.toHaveBeenCalled();
    expect(test.skillSubmitCandidate).not.toHaveBeenCalled();
    expect(test.skillReviewCandidate).not.toHaveBeenCalled();
    expect(test.skillPublishCandidate).not.toHaveBeenCalled();
  });

  it('平台管理员不得用 tenantId 跨租户读取或管理客户组织资源', async () => {
    const getAgent = vi.fn();
    const getSkill = vi.fn();
    const listCredentials = vi.fn();
    const getCredential = vi.fn();
    const test = await rig({
      platformAdmin: true,
      user: { sub: 'platform-1', username: 'root', tenantId: 'pantheon', role: 'admin' },
      getAgent, getSkill, listCredentials, getCredential,
    });
    const responses = [
      await test.request('/api/governance/resources/agents/org-a?tenantId=tenant-a'),
      await test.request('/api/governance/resources/agents', json('POST', { tenantId: 'tenant-a', kind: 'org_agent' })),
      await test.request('/api/governance/resources/agents/org-a/versions?tenantId=tenant-a', json('POST', { expectedRevision: 1, definition: {} })),
      await test.request('/api/governance/resources/agents/org-a/status?tenantId=tenant-a', json('PATCH', { expectedRevision: 1, status: 'disabled' })),
      await test.request('/api/governance/resources/agents/org-a/archive?tenantId=tenant-a', json('POST', { expectedRevision: 1 })),
      await test.request('/api/governance/resources/skills/tenant-s?tenantId=tenant-a'),
      await test.request('/api/governance/resources/skills', json('POST', { tenantId: 'tenant-a', skillId: 'tenant-s', scope: 'tenant' })),
      await test.request('/api/governance/resources/skills/tenant-s/versions?tenantId=tenant-a', json('POST', { expectedRevision: 1, definition: {} })),
      await test.request('/api/governance/resources/credentials?tenantId=tenant-a'),
      await test.request('/api/governance/resources/credentials', json('POST', {
        tenantId: 'tenant-a', connectorId: 'github', kind: 'org_shared', purpose: 'shared', secret: 'sensitive',
      })),
      await test.request('/api/governance/resources/credentials/cred-a/status?tenantId=tenant-a', json('PATCH', {
        expectedVersion: 1, status: 'rotation_due', reason: 'rotation',
      })),
    ];
    expect(responses.every(response => response.status === 403)).toBe(true);
    expect(getAgent).not.toHaveBeenCalled();
    expect(getSkill).not.toHaveBeenCalled();
    expect(listCredentials).not.toHaveBeenCalled();
    expect(getCredential).not.toHaveBeenCalled();
    expect(test.agentCreate).not.toHaveBeenCalled();
    expect(test.agentPublish).not.toHaveBeenCalled();
    expect(test.agentSetStatus).not.toHaveBeenCalled();
    expect(test.agentArchive).not.toHaveBeenCalled();
    expect(test.skillCreate).not.toHaveBeenCalled();
    expect(test.skillPublishVersion).not.toHaveBeenCalled();
    expect(test.credentialCreate).not.toHaveBeenCalled();
    expect(test.updateCredential).not.toHaveBeenCalled();

    const sameTenantPlatform = await rig({
      platformAdmin: true,
      user: { sub: 'platform-1', username: 'root', tenantId: 'tenant-a', role: 'admin' },
    });
    expect((await sameTenantPlatform.request('/api/governance/resources/agents', json('POST', { kind: 'org_agent' }))).status).toBe(403);
    expect((await sameTenantPlatform.request('/api/governance/resources/skills', json('POST', {
      skillId: 'tenant-s', scope: 'tenant',
    }))).status).toBe(403);
    expect((await sameTenantPlatform.request('/api/governance/resources/credentials', json('POST', {
      connectorId: 'github', kind: 'org_shared', purpose: 'shared', secret: 'sensitive',
    }))).status).toBe(403);
    expect(sameTenantPlatform.agentCreate).not.toHaveBeenCalled();
    expect(sameTenantPlatform.skillCreate).not.toHaveBeenCalled();
    expect(sameTenantPlatform.credentialCreate).not.toHaveBeenCalled();
  });

  it('同租户 active org_admin 可管理组织资源，member 即使 owner/custodian 也不可', async () => {
    const orgAgent = { agentId: 'org-a', tenantId: 'tenant-a', kind: 'org_agent', ownerUserId: 'member-1', status: 'enabled', revision: 1 };
    const tenantSkill = { skillId: 'tenant-s', tenantId: 'tenant-a', scope: 'tenant', ownerUserId: 'member-1', status: 'draft', revision: 1 };
    const orgCredential = { credentialId: 'cred-a', tenantId: 'tenant-a', kind: 'org_shared', custodianUserId: 'member-1', secretRef: 'sec-a', status: 'active', version: 1 };
    const member = await rig({
      user: { sub: 'member-1', username: 'member', tenantId: 'tenant-a', role: 'user' },
      getAgent: vi.fn().mockResolvedValue(orgAgent), getSkill: vi.fn().mockResolvedValue(tenantSkill),
      getCredential: vi.fn().mockResolvedValue(orgCredential),
    });
    expect((await member.request('/api/governance/resources/agents/org-a/versions', json('POST', { expectedRevision: 1, definition: {} }))).status).toBe(404);
    expect((await member.request('/api/governance/resources/skills/tenant-s/versions', json('POST', { expectedRevision: 1, definition: {} }))).status).toBe(404);
    expect((await member.request('/api/governance/resources/credentials/cred-a/status', json('PATCH', {
      expectedVersion: 1, status: 'rotation_due', reason: 'rotation',
    }))).status).toBe(403);
    expect(member.agentPublish).not.toHaveBeenCalled();
    expect(member.skillPublishVersion).not.toHaveBeenCalled();
    expect(member.updateCredential).not.toHaveBeenCalled();

    const inactiveAdmin = await rig({
      user: { sub: 'inactive-admin', username: 'inactive', tenantId: 'tenant-a', role: 'admin' },
      getMembership: vi.fn().mockResolvedValue({
        tenantId: 'tenant-a', userId: 'inactive-admin', persona: 'org_admin', status: 'suspended',
      }),
    });
    expect((await inactiveAdmin.request('/api/governance/resources/agents', json('POST', { kind: 'org_agent' }))).status).toBe(403);
    expect(inactiveAdmin.agentCreate).not.toHaveBeenCalled();

    const admin = await rig({
      user: { sub: 'admin-1', username: 'admin', tenantId: 'tenant-a', role: 'admin' },
      getAgent: vi.fn().mockResolvedValue(orgAgent), getSkill: vi.fn().mockResolvedValue(tenantSkill),
      getCredential: vi.fn().mockResolvedValue(orgCredential),
      agentPublish: vi.fn().mockResolvedValue({ resource: orgAgent }),
      skillPublishVersion: vi.fn().mockResolvedValue({ resource: tenantSkill }),
      updateCredential: vi.fn().mockResolvedValue(orgCredential),
    });
    const agentPreview = await admin.request('/api/governance/resources/agents/org-a/versions/preview', json('POST', {
      expectedRevision: 1, definition: { schemaVersion: 1, name: 'Agent' }, reason: '更新组织 Agent',
    }));
    expect(agentPreview.status).toBe(200);
    await expect(agentPreview.json()).resolves.toMatchObject({
      canCommit: false,
      impact: { blockers: ['GOVERNANCE_PROJECTION_AUTHORITY_UNAVAILABLE'] },
    });
    expect(admin.agentPublish).not.toHaveBeenCalled();
    expect((await admin.request('/api/governance/resources/skills/tenant-s/versions', json('POST', { expectedRevision: 1, definition: {} }))).status).toBe(200);
    expect((await admin.request('/api/governance/resources/credentials/cred-a/status', json('PATCH', {
      expectedVersion: 1, status: 'rotation_due', reason: 'rotation',
    }))).status).toBe(200);
  });

  it('高影响资源发布与生命周期直写在签名基线缺失时全部返回 503', async () => {
    const admin = await rig({ user: { sub: 'admin-1', username: 'admin', tenantId: 'tenant-a', role: 'admin' } });
    const archive = await admin.request('/api/governance/resources/agents/org-a/archive', json('POST', { expectedRevision: 1 }));
    expect(archive.status).toBe(503);
    await expect(archive.json()).resolves.toMatchObject({ code: 'GOVERNANCE_PREVIEW_AUTHORITY_UNAVAILABLE' });
    expect(admin.agentArchive).not.toHaveBeenCalled();

    const platform = await rig({
      platformAdmin: true,
      user: { sub: 'platform-1', username: 'root', tenantId: 'pantheon', role: 'admin' },
    });
    const responses = await Promise.all([
      platform.request('/api/governance/resources/connectors/github/versions', json('POST', {
        name: 'GitHub', authMethods: ['oauth'], capabilitySchema: {}, definition: {},
      })),
      platform.request('/api/governance/resources/connectors/github/status', json('PATCH', {
        expectedVersion: 1, status: 'disabled',
      })),
      platform.request('/api/governance/resources/environment/providers/acs', json('PUT', {
        expectedRevision: 1, status: 'enabled', endpointRef: 'acs-default',
      })),
      platform.request('/api/governance/resources/environment/templates/node/versions', json('POST', {
        name: 'Node', recipe: {},
      })),
      platform.request('/api/governance/resources/environment/templates/node/retire', json('POST', {
        expectedRevision: 1,
      })),
    ]);
    expect(responses.map(response => response.status)).toEqual([503, 503, 503, 503, 503]);
    expect(platform.connectorUpdateStatus).not.toHaveBeenCalled();
    expect(platform.environmentRetire).not.toHaveBeenCalled();
  });

  it('组织删除在缺少逐域 inventory authority 时 fail closed', async () => {
    const test = await rig({
      platformAdmin: true,
      user: { sub: 'platform-1', username: 'root', tenantId: 'pantheon', role: 'admin' },
    });
    const response = await test.request('/api/governance/resources/previews/tenant-delete', json('POST', {
      tenantId: 'tenant-a', reasonCode: 'customer_termination',
    }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: 'TENANT_DELETE_INVENTORY_AUTHORITY_UNAVAILABLE',
    });
  });

  it('平台资源范围目录只返回可分配的已发布稳定资源 ID', async () => {
    const test = await rig({
      platformAdmin: true,
      user: { sub: 'platform-1', username: 'root', tenantId: 'pantheon', role: 'admin' },
    });
    const response = await test.request('/api/governance/resources/entitlement-resource-catalog?resourceType=environment_template');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      resourceType: 'environment_template', items: [{ resourceId: 'env-1', label: 'Node', version: 2 }],
    });
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

  it('Credential scopeSummary 仅接受固定字段字符串列表并拒绝敏感键', async () => {
    const test = await rig({});
    const unsafe = await test.request('/api/governance/resources/credentials', json('POST', {
      connectorId: 'github', kind: 'personal_grant', purpose: 'repository automation',
      scopeSummary: { token: 'must-not-enter-governance-dto' }, secret: 'github_pat_sensitive',
    }));
    expect(unsafe.status).toBe(400);
    expect(test.putSecret).not.toHaveBeenCalled();

    const nested = await test.request('/api/governance/resources/credentials', json('POST', {
      connectorId: 'github', kind: 'personal_grant', purpose: 'repository automation',
      scopeSummary: { repository: { access: 'read' } }, secret: 'github_pat_sensitive',
    }));
    expect(nested.status).toBe(400);
    expect(test.putSecret).not.toHaveBeenCalled();
  });
});
