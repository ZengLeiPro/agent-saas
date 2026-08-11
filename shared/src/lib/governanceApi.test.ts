import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./authFetch', () => ({ authFetch: vi.fn() }));

import { authFetch } from './authFetch';
import {
  evaluateAccess,
  fetchEffectiveResources,
  fetchMyGovernanceSummary,
  governanceAccessApi,
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

  it('成功 envelope 解包 data 后再校验 schema', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse({ code: 0, data: [effective] }));
    await expect(fetchEffectiveResources(['connector'])).resolves.toEqual([effective]);
    expect(mockAuthFetch).toHaveBeenCalledWith(
      '/api/me/effective-resources?domains=connector',
      undefined,
    );
  });
});
