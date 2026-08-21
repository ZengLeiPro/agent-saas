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

function skillUploadBody(name = 'uploaded-skill'): FormData {
  const form = new FormData();
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
  credentialClaimCommit?: ReturnType<typeof vi.fn>;
  credentialFinishCommit?: ReturnType<typeof vi.fn>;
  putSecret?: ReturnType<typeof vi.fn>;
  revokeSecret?: ReturnType<typeof vi.fn>;
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
  customSkillsEnabled?: (tenantId: string) => boolean;
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
  const revokeSecret = input.revokeSecret ?? vi.fn().mockResolvedValue(undefined);
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
      claimCommit: input.credentialClaimCommit ?? vi.fn().mockResolvedValue({ state: 'acquired', leaseToken: 'lease-1' }),
      recordCommitProgress: vi.fn().mockResolvedValue(undefined),
      finishCommit: input.credentialFinishCommit ?? vi.fn().mockResolvedValue(undefined),
      get: input.getCredential ?? vi.fn().mockResolvedValue(null),
      getBySecretRef: vi.fn().mockResolvedValue(null),
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
    isCustomSkillsEnabled: input.customSkillsEnabled ?? (() => true),
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
    vault: { putSecret, revokeSecret } as never,
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
    connectorUpdateStatus, environmentRetire, putSecret, revokeSecret,
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

describe('typed governance resource routes: authorization and credential boundaries', () => {
  it('平台管理员可跨租户只读查看组织凭据，但跨租户写管理仍 fail closed', async () => {
    const getAgent = vi.fn();
    const getSkill = vi.fn();
    const listCredentials = vi.fn().mockResolvedValue([{
      credentialId: 'cred-a', tenantId: 'tenant-a', connectorId: 'github', kind: 'org_shared',
      custodianUserId: 'admin-1', secretRef: 'sec-a', status: 'active', version: 1,
    }]);
    const getCredential = vi.fn();
    const test = await rig({
      platformAdmin: true,
      user: { sub: 'platform-1', username: 'root', tenantId: 'pantheon', role: 'admin' },
      getAgent, getSkill, listCredentials, getCredential,
    });
    // 平台管理员在组织控制台可跨租户只读查看组织凭据（与成员/权限策略等治理页一致）
    const read = await test.request('/api/governance/resources/credentials?tenantId=tenant-a');
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({ credentials: [{ credentialId: 'cred-a' }] });
    expect(listCredentials).toHaveBeenCalledWith('tenant-a');

    // 平台管理员跨租户仍不可读取或管理客户组织 Agent/Skill 资源，
    // 也不可跨租户写组织凭据（创建、状态变更）
    const forbidden = [
      await test.request('/api/governance/resources/agents/org-a?tenantId=tenant-a'),
      await test.request('/api/governance/resources/agents', json('POST', { tenantId: 'tenant-a', kind: 'org_agent' })),
      await test.request('/api/governance/resources/agents/org-a/versions?tenantId=tenant-a', json('POST', { expectedRevision: 1, definition: {} })),
      await test.request('/api/governance/resources/agents/org-a/status?tenantId=tenant-a', json('PATCH', { expectedRevision: 1, status: 'disabled' })),
      await test.request('/api/governance/resources/agents/org-a/archive?tenantId=tenant-a', json('POST', { expectedRevision: 1 })),
      await test.request('/api/governance/resources/skills/tenant-s?tenantId=tenant-a'),
      await test.request('/api/governance/resources/skills', json('POST', { tenantId: 'tenant-a', skillId: 'tenant-s', scope: 'tenant' })),
      await test.request('/api/governance/resources/skills/tenant-s/versions?tenantId=tenant-a', json('POST', { expectedRevision: 1, definition: {} })),
      await test.request('/api/governance/resources/credentials', json('POST', {
        tenantId: 'tenant-a', connectorId: 'github', kind: 'org_shared', purpose: 'shared', secret: 'sensitive',
      })),
      await test.request('/api/governance/resources/credentials/cred-a/status?tenantId=tenant-a', json('PATCH', {
        expectedVersion: 1, status: 'rotation_due', reason: 'rotation',
      })),
    ];
    expect(forbidden.every(response => response.status === 403)).toBe(true);
    expect(getAgent).not.toHaveBeenCalled();
    expect(getSkill).not.toHaveBeenCalled();
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

  it('组织管理员读取治理凭据时仍能看到自己的个人 Credential，但不能看到他人的个人 Credential', async () => {
    const listCredentials = vi.fn().mockResolvedValue([
      { credentialId: 'org-credential', tenantId: 'tenant-a', kind: 'org_shared', status: 'active', version: 1 },
      { credentialId: 'own-personal', tenantId: 'tenant-a', kind: 'personal_grant', ownerUserId: 'admin-1', status: 'active', version: 1 },
      { credentialId: 'other-personal', tenantId: 'tenant-a', kind: 'personal_grant', ownerUserId: 'member-1', status: 'active', version: 1 },
    ]);
    const test = await rig({
      user: { sub: 'admin-1', username: 'admin', tenantId: 'tenant-a', role: 'admin' },
      listCredentials,
    });
    const response = await test.request('/api/governance/resources/credentials');
    expect(response.status).toBe(200);
    const body = await response.json() as { credentials: Array<{ credentialId: string }> };
    expect(body.credentials.map(item => item.credentialId)).toEqual(['org-credential', 'own-personal']);
    expect(listCredentials).toHaveBeenCalledWith('tenant-a');
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

  it('个人 Credential 所有者可通过签名治理撤销，并同步撤销 SecretVault Secret', async () => {
    const personalCredential = {
      credentialId: 'credential-x', tenantId: 'tenant-a', connectorId: 'x', kind: 'personal_grant',
      ownerUserId: 'user-1', purpose: 'X bird CLI 用户凭据', scopeSummary: { scopes: ['x:*'] },
      secretRef: 'secret-x', status: 'active', generation: 1, version: 1,
    };
    const getCredential = vi.fn().mockResolvedValue(personalCredential);
    const updateCredential = vi.fn().mockResolvedValue({ ...personalCredential, status: 'revoked', generation: 2, version: 2 });
    const test = await rig({ getCredential, updateCredential });

    const preview = await test.request('/api/governance/resources/credentials/credential-x/revoke/preview', json('POST', {
      expectedVersion: 1, reason: '用户主动断开 X',
    }));
    expect(preview.status).toBe(200);
    const previewBody = await preview.json() as { previewId: string; baselineDigest: string; expiresAt: string };
    const response = await test.request('/api/governance/resources/credentials/credential-x/revoke', json('POST', {
      expectedVersion: 1, reason: '用户主动断开 X',
      previewId: previewBody.previewId, baselineDigest: previewBody.baselineDigest, expiresAt: previewBody.expiresAt,
    }));


    expect(response.status).toBe(200);
    expect(updateCredential).toHaveBeenCalledWith('credential-x', expect.objectContaining({
      status: 'revoked', expectedVersion: 1, updatedBy: 'user-1', updateReason: '用户主动断开 X',
    }));
    expect(test.revokeSecret).toHaveBeenCalledWith('secret-x', expect.objectContaining({
      actor: 'connector_proxy', userId: 'user-1', tenantId: 'tenant-a',
      scopes: ['secret:connector:revoke'],
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
