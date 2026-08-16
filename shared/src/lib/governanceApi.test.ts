import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./authFetch', () => ({ authFetch: vi.fn() }));

import { authFetch } from './authFetch';
import {
  evaluateAccess,
  fetchEffectiveResources,
  fetchMyGovernanceSummary,
  governanceAccessApi,
  governanceResourcesApi,
  GovernanceApiError,
  preflightExecution,
} from './governanceApi';

const mockAuthFetch = vi.mocked(authFetch);

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  }) as unknown as Response;
}

const resource = {
  type: 'connector', id: 'github', tenantId: 'tenant-1', displayName: 'GitHub', domain: 'connector',
};
const effective = {
  resource,
  lifecycle: { state: 'active', blocksNewUse: false },
  access: {
    decisionId: 'decision-1', verdict: 'allow', accessState: 'allowed', action: 'use',
    subject: { subjectId: 'user-1', tenantId: 'tenant-1', persona: 'member', isOwner: false },
    resource, decisiveLayer: 'assignment', reasonCode: 'ASSIGNED', reason: '已指派',
    chain: [{ layer: 'assignment', result: 'pass', code: 'ASSIGNED', label: '组织指派' }],
    policySnapshot: { membershipVersion: 1, assignmentVersion: 2 },
    nextActions: [{ code: 'use', label: '使用' }], evaluatedAt: '2026-08-10T07:00:00Z',
  },
  readiness: { ready: true, blockers: [], resolved: {}, evaluatedAt: '2026-08-10T07:00:00Z' },
  primaryResult: { code: 'available', label: '可用' },
  decisiveFactor: { code: 'ASSIGNED', label: '组织指派' },
};

describe('governanceApi fail closed', () => {
  beforeEach(() => mockAuthFetch.mockReset());

  it('调用权威 evaluate endpoint 并只接受有效三轴结果', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse([effective]));
    await expect(evaluateAccess({ action: 'use', resource })).resolves.toHaveLength(1);
    expect(mockAuthFetch).toHaveBeenCalledWith('/api/access/evaluate', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ action: 'use', resource }),
    }));
  });

  it('非 2xx 时保留后端 code 并明确抛错', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse({ code: 'ACCESS_DENIED', message: '无权评估' }, 403));
    const error = await evaluateAccess({}).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(GovernanceApiError);
    expect(error).toMatchObject({ code: 'ACCESS_DENIED', status: 403, message: '无权评估' });
  });

  it('2xx 错误 envelope 也抛错，不降级为本地 allow', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse({ code: 'EVALUATOR_UNAVAILABLE', message: '评估器不可用' }));
    await expect(fetchEffectiveResources()).rejects.toMatchObject({
      code: 'EVALUATOR_UNAVAILABLE', message: '评估器不可用',
    });
  });

  it('接受组织生命周期 200 applied 成功回执', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse({
      tenantId: 'tenant-1', status: 'suspended', updatedAt: '2026-08-15T05:00:00.000Z',
      changeId: 'change-1', auditId: 'audit-1', effectiveAt: '2026-08-15T05:00:00.000Z',
      propagationStatus: 'applied',
    }));

    await expect(governanceAccessApi.updateTenantLifecycle('tenant-1', {})).resolves.toMatchObject({
      tenantId: 'tenant-1', status: 'suspended', propagationStatus: 'applied',
    });
  });

  it('将组织生命周期 202 pending 解析为已持久化成功回执', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse({
      tenantId: 'tenant-1', status: 'suspended', updatedAt: '2026-08-15T05:00:00.000Z',
      changeId: 'change-1', auditId: 'audit-1', effectiveAt: '2026-08-15T05:00:00.000Z',
      propagationStatus: 'pending',
      warning: 'Tenant state persisted; cross-instance effects are retrying',
      code: 'TENANT_LIFECYCLE_PROPAGATION_PENDING',
    }, 202));

    await expect(governanceAccessApi.updateTenantLifecycle('tenant-1', {})).resolves.toMatchObject({
      tenantId: 'tenant-1', status: 'suspended', propagationStatus: 'pending',
      code: 'TENANT_LIFECYCLE_PROPAGATION_PENDING',
    });
  });

  it('无效 readiness 响应 fail closed', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse({
      ready: true,
      evaluatedAt: '2026-08-10T07:00:00Z',
      blockers: [{ code: 'CREDENTIAL_EXPIRED', message: '已过期', retryable: false }],
      resolved: {},
    }));
    await expect(preflightExecution({ action: 'run' })).rejects.toMatchObject({
      code: 'INVALID_GOVERNANCE_RESPONSE',
    });
  });

  it('接受组织控制台成员接口返回的完整持久化元数据', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse({ memberships: [{
      tenantId: 'tenant-1', userId: 'member-1', persona: 'member', isOwner: false,
      status: 'active', source: 'governance', version: 2,
      createdAt: '2026-08-10T07:00:00Z', createdBy: 'admin-1',
      updatedAt: '2026-08-10T08:00:00Z', updatedBy: 'admin-1',
      directoryProfile: {
        userId: 'member-1', username: 'member', displayName: '成员一', accountStatus: 'active',
        dingtalkBound: true, createdAt: '2026-08-01T07:00:00Z', updatedAt: '2026-08-10T08:00:00Z',
      },
      allowedActions: [{ id: 'disable', label: '停用账号', change: { status: 'disabled' }, requiresReason: false }],
    }] }));

    await expect(governanceAccessApi.listMemberships('tenant-1')).resolves.toMatchObject({
      memberships: [{ userId: 'member-1', createdBy: 'admin-1', updatedBy: 'admin-1' }],
    });
  });

  it('接受成员详情中的身份、用量与审计权威聚合', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse({
      profile: {
        userId: 'member-1', username: 'member', displayName: '成员一', accountStatus: 'active',
        dingtalkBound: true, createdAt: '2026-08-01T07:00:00Z', updatedAt: '2026-08-10T08:00:00Z',
      },
      identity: {
        tenantId: 'tenant-1', userId: 'member-1', persona: 'member', isOwner: false,
        status: 'active', source: 'governance', version: 2,
        createdAt: '2026-08-01T07:00:00Z', createdBy: 'admin-1',
        updatedAt: '2026-08-10T08:00:00Z', updatedBy: 'admin-1', allowedActions: [],
      },
      accessSummary: {
        effectivePersona: 'member', owner: false, accountStatus: 'active', decision: 'eligible',
        why: [{ source: 'membership', effect: 'allow', version: 2 }],
      },
      assignments: [],
      usagePolicy: {
        tenantId: 'tenant-1', timezone: 'Asia/Shanghai', periodStart: '2026-08-01', periodEnd: '2026-09-01',
        items: [{
          userId: 'member-1', enforcementMode: 'notify', active: true, version: 1,
          monthAttributedCreditsMicro: 10, canStartRun: true,
          lastUsedAt: '2026-08-10T08:00:00Z', updatedBy: 'admin-1', updatedAt: '2026-08-10T08:00:00Z',
        }],
      },
      recentAudit: {
        coverage: 'recent_membership_endpoint_events', limit: 100,
        events: [{
          auditId: 'audit-1', correlationId: 'correlation-1', actorType: 'user', actorUserId: 'admin-1',
          actorPersona: 'org_admin', actorTenantId: 'tenant-1', action: 'governance.access.patch',
          targetType: 'governance_access_api', targetId: '/memberships/member-1', targetTenantId: 'tenant-1',
          purpose: 'governance access mutation', result: 'succeeded', occurredAt: '2026-08-10T08:00:00Z',
          beforeDigest: 'before', afterDigest: 'after', metadata: { statusCode: 200 },
        }],
      },
      snapshot: { membershipVersion: 2, generatedAt: '2026-08-10T08:00:00Z' },
    }));

    await expect(governanceAccessApi.getMembershipDetails('member-1', 'tenant-1')).resolves.toMatchObject({
      identity: { updatedBy: 'admin-1' }, recentAudit: { events: [{ actorType: 'user' }] },
    });
  });

  it('接受权益接口的完整持久化记录与资源范围动作', async () => {
    const metadata = {
      createdAt: '2026-08-10T07:00:00Z', createdBy: 'system',
      updatedAt: '2026-08-10T08:00:00Z', updatedBy: 'platform-1',
    };
    mockAuthFetch.mockResolvedValue(jsonResponse({
      entitlement: {
        tenantId: 'tenant-1', source: 'platform_override', status: 'active', limits: {}, version: 2,
        updateReason: 'contract active', ...metadata,
      },
      scopes: [{
        tenantId: 'tenant-1', resourceType: 'skill', mode: 'selected', resourceIds: ['skill-1'],
        source: 'governance', version: 2, ...metadata,
        allowedActions: [{ id: 'edit_scope', label: '从目录编辑', resourceType: 'skill' }],
      }],
      policies: [{
        tenantId: 'tenant-1', policyKey: 'skill.custom.enabled', value: true,
        source: 'governance', version: 2, ...metadata,
      }],
      allowedActions: [{ id: 'suspend', label: '暂停权益', change: { status: 'suspended' }, requiresReason: true }],
    }));

    await expect(governanceAccessApi.getEntitlements('tenant-1')).resolves.toMatchObject({
      entitlement: { tenantId: 'tenant-1', updatedBy: 'platform-1' },
      scopes: [{ resourceType: 'skill', allowedActions: [{ resourceType: 'skill' }] }],
    });
  });

  it('接受治理写中间件追加审计字段后的成员预览与完整回执', async () => {
    const audit = {
      changeId: 'change-1', auditId: 'audit-1', effectiveAt: '2026-08-10T08:00:00Z',
    };
    mockAuthFetch
      .mockResolvedValueOnce(jsonResponse({
        previewId: `mpv1.${'a'.repeat(64)}`, baselineDigest: 'b'.repeat(64),
        expiresAt: '2026-08-10T08:05:00Z', expectedVersion: 2,
        impact: {
          from: { persona: 'member', isOwner: false, status: 'active' },
          to: { persona: 'member', isOwner: false, status: 'disabled' },
          blockers: [], reversible: true, effectiveMode: 'source_immediate',
        },
        ...audit,
      }))
      .mockResolvedValueOnce(jsonResponse({
        tenantId: 'tenant-1', userId: 'member-1', persona: 'member', isOwner: false,
        status: 'disabled', source: 'governance', version: 3,
        createdAt: '2026-08-10T07:00:00Z', createdBy: 'admin-1',
        updatedAt: '2026-08-10T08:00:00Z', updatedBy: 'admin-1',
        projectionStatus: 'pending', compatibilityProjection: 'applied_with_projection_pending',
        ...audit,
      }));

    await expect(governanceAccessApi.previewMembership('member-1', {
      expectedVersion: 2, status: 'disabled', reason: 'member left',
    }, 'tenant-1')).resolves.toMatchObject({ auditId: 'audit-1' });
    await expect(governanceAccessApi.updateMembership('member-1', {
      expectedVersion: 2, status: 'disabled', reason: 'member left',
      previewId: `mpv1.${'a'.repeat(64)}`, baselineDigest: 'b'.repeat(64),
      expiresAt: '2026-08-10T08:05:00Z',
    }, 'tenant-1')).resolves.toMatchObject({ version: 3, compatibilityProjection: 'applied_with_projection_pending' });
  });

  it('创建组织调用治理入口，并透传可理解的业务错误', async () => {
    mockAuthFetch.mockResolvedValueOnce(jsonResponse({ tenant: { id: 'test-org', name: '测试组织' } }, 201));
    await expect(governanceAccessApi.createTenant({ id: 'test-org', name: '测试组织' })).resolves.toMatchObject({
      tenant: { id: 'test-org', name: '测试组织' },
    });
    expect(mockAuthFetch).toHaveBeenCalledWith('/api/governance/access/tenants', expect.objectContaining({
      method: 'POST',
    }));

    mockAuthFetch.mockResolvedValueOnce(jsonResponse({
      code: 'TENANT_ALREADY_EXISTS', error: '该组织 slug 已存在，请更换后重试',
    }, 409));
    await expect(governanceAccessApi.createTenant({ id: 'test-org', name: '测试组织' })).rejects.toMatchObject({
      code: 'TENANT_ALREADY_EXISTS', message: '该组织 slug 已存在，请更换后重试', status: 409,
    });
  });

  it('组织设置读写使用治理入口并携带 CAS 基线', async () => {
    mockAuthFetch
      .mockResolvedValueOnce(jsonResponse({ tenantId: 'tenant-1', settings: {}, updatedAt: '2026-08-10T08:00:00Z' }))
      .mockResolvedValueOnce(jsonResponse({ tenantId: 'tenant-1', settings: {}, updatedAt: '2026-08-10T08:01:00Z' }));

    await governanceAccessApi.getTenantSettings('tenant-1');
    await governanceAccessApi.updateTenantSettings('tenant-1', {
      settings: {},
      expectedUpdatedAt: '2026-08-10T08:00:00Z',
    });

    expect(mockAuthFetch).toHaveBeenNthCalledWith(
      1,
      '/api/governance/access/tenant-settings?tenantId=tenant-1',
      undefined,
    );
    expect(mockAuthFetch).toHaveBeenNthCalledWith(
      2,
      '/api/governance/access/tenant-settings?tenantId=tenant-1',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('接受历史凭据的安全能力摘要', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse({ credentials: [{
      credentialId: 'credential-1', tenantId: 'tenant-1', connectorId: 'github', kind: 'org_shared',
      ownerUsername: 'member', purpose: 'legacy:github:default', status: 'active', generation: 1, version: 2,
      scopeSummary: { legacyCapability: 'connector', scopes: ['github:*'] }, source: 'legacy_projection',
      createdAt: '2026-08-01T07:00:00Z', createdBy: 'system', updatedAt: '2026-08-10T08:00:00Z', updatedBy: 'system',
    }] }));

    await expect(governanceResourcesApi.listCredentials('tenant-1')).resolves.toMatchObject({
      credentials: [{ ownerUsername: 'member', scopeSummary: { legacyCapability: 'connector' } }],
    });
  });

  it('接受离职预览中的治理写审计信封', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse({
      previewId: `opv1.${'a'.repeat(64)}`, idempotencyKey: 'offboard-1', baselineDigest: 'b'.repeat(64),
      expiresAt: '2026-08-10T08:05:00Z', canCommit: true, blockers: [],
      impact: {
        membership: 1, agents: [], personalAgents: [], skills: [], personalCredentials: [], custodialCredentials: [],
        cronOwnership: { status: 'clear', ids: [] },
        activeRuns: { authority: 'available', ids: ['run-1'], snapshots: [{ id: 'run-1', version: 'v1' }], count: 1 },
        activeSessions: { authority: 'available', ids: [], snapshots: [], count: 0 },
        oauthGrants: { authority: 'available', ids: [], snapshots: [], count: 0 },
        externalConnections: { authority: 'available', ids: [], snapshots: [], count: 0 },
        personalMemory: { status: 'clear', ids: [] },
        fileOwnership: { status: 'clear', personalFileIds: [], organizationFileIds: [] },
      },
      changeId: 'change-1', auditId: 'audit-1', effectiveAt: '2026-08-10T08:00:00Z',
    }));

    await expect(governanceResourcesApi.previewUserOffboarding({
      tenantId: 'tenant-1', userId: 'member-1', handoffTargetUserId: 'owner-1', reason: 'member left',
    })).resolves.toMatchObject({ changeId: 'change-1', canCommit: true });
  });

  it('离职预览严格校验 ownership 状态并拒绝 unknown 与 canCommit=true 的矛盾响应', async () => {
    const response = (status: 'unknown' | 'mystery', canCommit: boolean) => ({
      previewId: `opv1.${'a'.repeat(64)}`, idempotencyKey: 'offboard-unknown', baselineDigest: 'b'.repeat(64),
      expiresAt: '2026-08-10T08:05:00Z', canCommit, blockers: [],
      impact: {
        membership: 1, agents: [], personalAgents: [], skills: [], personalCredentials: [], custodialCredentials: [],
        cronOwnership: { status, ids: [] },
        personalMemory: { status: 'clear', ids: [] },
        fileOwnership: { status: 'clear', personalFileIds: [], organizationFileIds: [] },
      },
    });

    mockAuthFetch.mockResolvedValueOnce(jsonResponse(response('unknown', false)));
    await expect(governanceResourcesApi.previewUserOffboarding({
      tenantId: 'tenant-1', userId: 'member-1', handoffTargetUserId: 'owner-1', reason: 'member left',
    })).resolves.toMatchObject({ canCommit: false, impact: { cronOwnership: { status: 'unknown' } } });

    mockAuthFetch.mockResolvedValueOnce(jsonResponse(response('unknown', true)));
    await expect(governanceResourcesApi.previewUserOffboarding({
      tenantId: 'tenant-1', userId: 'member-1', handoffTargetUserId: 'owner-1', reason: 'member left',
    })).rejects.toMatchObject({ code: 'INVALID_GOVERNANCE_RESPONSE' });

    mockAuthFetch.mockResolvedValueOnce(jsonResponse(response('mystery', false)));
    await expect(governanceResourcesApi.previewUserOffboarding({
      tenantId: 'tenant-1', userId: 'member-1', handoffTargetUserId: 'owner-1', reason: 'member left',
    })).rejects.toMatchObject({ code: 'INVALID_GOVERNANCE_RESPONSE' });
  });

  it('组织 Skill 上传使用治理 multipart 入口并透传明确失败原因', async () => {
    mockAuthFetch.mockResolvedValueOnce(jsonResponse({
      ok: true,
      status: 'succeeded',
      skill: { id: 'managed-skill', name: 'managed-skill', description: 'managed' },
      resource: {
        skillId: 'managed-skill', tenantId: 'tenant-a/managed', scope: 'tenant', status: 'published',
        currentVersionId: 'skillv-1', revision: 2, createdBy: 'platform-1',
      },
      version: { versionId: 'skillv-1', skillId: 'managed-skill', versionNumber: 1, digest: 'digest-1' },
    }));
    const file = new File(['content'], 'SKILL.md', { type: 'text/markdown' });
    Object.defineProperty(file, 'webkitRelativePath', { value: 'managed-skill/SKILL.md' });

    await expect(governanceResourcesApi.importTenantSkillPackage('tenant-a/managed', [file]))
      .resolves.toMatchObject({ status: 'succeeded', version: { versionNumber: 1 } });
    expect(mockAuthFetch).toHaveBeenCalledWith(
      '/api/governance/resources/skills/import?scope=tenant&tenantId=tenant-a%2Fmanaged',
      expect.objectContaining({ method: 'POST', body: expect.any(FormData) }),
    );
    const request = mockAuthFetch.mock.calls[0]?.[1];
    expect(request?.headers).toBeUndefined();
    expect((request?.body as FormData).get('scope')).toBeNull();
    expect((request?.body as FormData).get('files')).toMatchObject({ name: 'managed-skill/SKILL.md' });

    mockAuthFetch.mockResolvedValueOnce(jsonResponse({
      code: 'SKILL_VERSION_CONFLICT', error: '技能版本已存在',
    }, 409));
    await expect(governanceResourcesApi.importTenantSkillPackage('tenant-a', [file]))
      .rejects.toMatchObject({ code: 'SKILL_VERSION_CONFLICT', status: 409, message: '技能版本已存在' });
  });

  it('个人 Skill 导入使用同一治理 multipart 入口并声明 personal scope', async () => {
    mockAuthFetch.mockResolvedValueOnce(jsonResponse({ ok: true, status: 'succeeded', selected: true, skill: { id: 'personal-skill', name: 'personal-skill', description: 'personal' }, resource: { skillId: 'personal-hash', tenantId: 'tenant-a', scope: 'personal', ownerUserId: 'user-1', status: 'published', currentVersionId: 'skillv-1', revision: 2, createdBy: 'user-1' }, version: { versionId: 'skillv-1', skillId: 'personal-hash', versionNumber: 1, digest: 'digest-1' } }));
    const file = new File(['content'], 'SKILL.md', { type: 'text/markdown' });
    await expect(governanceResourcesApi.importPersonalSkillPackage([file])).resolves.toMatchObject({ status: 'succeeded', selected: true, resource: { scope: 'personal' } });
    const request = mockAuthFetch.mock.calls[0]?.[1]; expect(mockAuthFetch.mock.calls[0]?.[0]).toBe('/api/governance/resources/skills/import?scope=personal'); expect((request?.body as FormData).get('scope')).toBeNull();
  });

  it('当前治理 endpoint 同样拒绝泄漏敏感字段', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse({ tenantId: 'tenant-1', secretRef: 'vault://x' }));
    await expect(governanceAccessApi.getEntitlements()).rejects.toMatchObject({
      code: 'INVALID_GOVERNANCE_RESPONSE',
    });
  });

  it('OAuth Grant DTO 结构漂移时 fail closed，而不是把假类型交给页面', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse({ grants: [{ grantId: 'g-1', status: 'active', token: 'forbidden' }] }));
    await expect(governanceAccessApi.listOAuthGrants()).rejects.toMatchObject({
      code: 'INVALID_GOVERNANCE_RESPONSE',
    });
  });

  it('接受治理写中间件补齐 auditId/changeId 的 OAuth 撤销预览真实回执', async () => {
    const envelope = {
      previewId: `ogpv1.${'a'.repeat(64)}`,
      baselineDigest: 'b'.repeat(64),
      expiresAt: '2026-08-10T08:00:00.000Z',
      impact: {
        provider: 'google', connectorId: 'google-workspace', action: 'revoke', immediatelyUnavailable: true,
        newRuns: 'blocked', reversible: false, effectiveMode: 'immediate', affectedAgents: [],
        affectedAutomations: [], brokenReferences: [], blockers: [], warnings: ['DEPENDENCY_IMPACT_AUTHORITY_UNAVAILABLE'],
        currentVersion: 1, nextVersion: 2,
      },
      changeId: 'preview-intent',
      auditId: 'preview-terminal',
    };
    mockAuthFetch.mockResolvedValue(jsonResponse(envelope));
    await expect(governanceAccessApi.previewOAuthGrantRevocation('grant-1', '用户主动撤销长期账号授权')).resolves.toEqual(envelope);
  });

  it('接受终态审计转 durable outbox 时带 auditCompletion=pending 的 OAuth 撤销真实回执', async () => {
    const envelope = {
      grantId: 'grant-1', status: 'revoked', version: 2,
      changeId: 'commit-intent', auditId: 'commit-intent', auditCompletion: 'pending',
    };
    mockAuthFetch.mockResolvedValue(jsonResponse(envelope));
    await expect(governanceAccessApi.revokeOAuthGrant('grant-1', {
      reason: '用户主动撤销长期账号授权',
      previewId: `ogpv1.${'a'.repeat(64)}`,
      baselineDigest: 'b'.repeat(64),
      expiresAt: '2026-08-10T08:00:00.000Z',
    })).resolves.toEqual(envelope);
  });

  it('OAuth 撤销回执仍为 strict schema，拒绝中间件合同外字段', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse({
      grantId: 'grant-1', status: 'revoked', version: 2,
      changeId: 'commit-intent', auditId: 'commit-terminal', unexpected: true,
    }));
    await expect(governanceAccessApi.revokeOAuthGrant('grant-1', {})).rejects.toMatchObject({
      code: 'INVALID_GOVERNANCE_RESPONSE',
    });
  });

  it('本人治理摘要只接受服务端权威 Persona 与站内桌面路径', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse({
      persona: 'org_admin', label: '组织管理员', desktopPath: '/organization-console/overview/overview',
      attention: { status: 'desktop_required' },
    }));
    await expect(fetchMyGovernanceSummary()).resolves.toMatchObject({ persona: 'org_admin' });
    expect(mockAuthFetch).toHaveBeenCalledWith('/api/me/governance-summary', undefined);
  });

  it('凭据预览接受审计信封且客户端不要求 secret 回显', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse({
      previewId: `cpv1.${'a'.repeat(64)}`, baselineDigest: 'b'.repeat(64), expiresAt: '2026-08-10T08:05:00Z',
      impact: { connectorId: 'github', secretStoredInVault: true }, changeId: 'intent-1', auditId: 'audit-1', effectiveAt: '2026-08-10T08:00:00Z',
    }));
    await expect(governanceResourcesApi.previewCredentialCreate({
      connectorId: 'github', kind: 'org_shared', purpose: 'deploy', secret: 'write-only', reason: 'initial setup',
    })).resolves.toMatchObject({ changeId: 'intent-1', impact: { secretStoredInVault: true } });
  });

  it('组织记忆知识列表严格接受真实空列表', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse({ tenantId: 'tenant-1', authority: 'governance_assignment_sets', accessMode: 'manage', knowledge: [], memory: [], effective: { organizationKnowledge: false, organizationMemory: false } }));
    await expect(governanceAccessApi.listMemoryKnowledge('tenant-1')).resolves.toMatchObject({ knowledge: [], memory: [] });
  });

  it('组织记忆写入客户端严格调用 signed preview→commit 端点', async () => {
    const command = { resourceId: 'mem-1', name: '团队决策', status: 'enabled', assignments: [], expectedVersion: 0, reason: '建立组织记忆' };
    mockAuthFetch.mockResolvedValueOnce(jsonResponse({
      previewId: `mrpv1.${'a'.repeat(64)}`, baselineDigest: 'b'.repeat(64), expiresAt: '2099-08-10T08:05:00Z',
      impact: { operation: 'create', resourceId: 'mem-1', currentVersion: 0, nextVersion: 1, fromStatus: null, toStatus: 'enabled', assignmentCount: 0, reversible: true }, changeId: 'intent-1',
    }));
    const preview = await governanceAccessApi.previewMemoryResource<Record<string, unknown>>(command, 'tenant-1');
    expect(mockAuthFetch).toHaveBeenLastCalledWith('/api/governance/access/organization-resources/memory/preview?tenantId=tenant-1', expect.objectContaining({ method: 'POST' }));
    mockAuthFetch.mockResolvedValueOnce(jsonResponse({ changeId: 'change-1', auditId: 'audit-1' }));
    await governanceAccessApi.updateMemoryResource('mem-1', { ...command, previewId: preview.previewId }, 'tenant-1');
    expect(mockAuthFetch).toHaveBeenLastCalledWith('/api/governance/access/organization-resources/memory/mem-1?tenantId=tenant-1', expect.objectContaining({ method: 'PUT' }));
  });

  it('成功 envelope 解包 data 后再校验 schema', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse({ code: 0, data: [effective] }));
    await expect(fetchEffectiveResources(['connector'])).resolves.toEqual([effective]);
    expect(mockAuthFetch).toHaveBeenCalledWith(
      '/api/me/effective-resources?domains=connector',
      undefined,
    );
  });
});
