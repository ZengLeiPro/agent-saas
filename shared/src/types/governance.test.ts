import { describe, expect, it } from 'vitest';
import {
  accessDecisionSchema,
  assertGovernanceUiSafe,
  changePreviewSchema,
  connectionAuthorizationSchema,
  effectiveResourceViewSchema,
  executionReadinessSchema,
  expectedPrimaryResultCode,
  MANAGEMENT_ACTIONS_V1,
  managementActionV1Schema,
  managementSnapshotRequestV1Schema,
  managementSnapshotResponseV1Schema,
  type AccessDecision,
  type EffectiveResourceView,
} from './governance';

const resource = {
  type: 'connector',
  id: 'github',
  tenantId: 'tenant-1',
  displayName: 'GitHub',
  domain: 'connector' as const,
};

const access: AccessDecision = {
  decisionId: 'decision-1',
  verdict: 'allow',
  accessState: 'allowed',
  action: 'use',
  subject: { subjectId: 'user-1', tenantId: 'tenant-1', persona: 'member', isOwner: false },
  resource,
  decisiveLayer: 'assignment',
  reasonCode: 'ASSIGNED',
  reason: '已由组织指派',
  chain: [{ layer: 'assignment', result: 'pass', code: 'ASSIGNED', label: '组织指派' }],
  policySnapshot: { membershipVersion: 3, assignmentVersion: 7 },
  nextActions: [{ code: 'use', label: '使用' }],
  evaluatedAt: '2026-08-10T07:00:00.000Z',
};

const effective: EffectiveResourceView = {
  resource,
  lifecycle: { state: 'active', blocksNewUse: false },
  access,
  readiness: { ready: true, evaluatedAt: '2026-08-10T07:00:00.000Z', blockers: [], resolved: {} },
  primaryResult: { code: 'available', label: '可用' },
  decisiveFactor: { code: 'ASSIGNED', label: '组织指派' },
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('governance v1 schemas', () => {
  it('接受 UI-safe Access/Readiness/EffectiveResource 正例', () => {
    expect(accessDecisionSchema.parse(access)).toEqual(access);
    expect(executionReadinessSchema.parse(effective.readiness)).toEqual(effective.readiness);
    expect(effectiveResourceViewSchema.parse(effective)).toEqual(effective);
  });

  it('拒绝缺少解释字段及 ready/blockers 矛盾的反例', () => {
    const invalidAccess = { ...access } as Record<string, unknown>;
    delete invalidAccess.reason;
    expect(accessDecisionSchema.safeParse(invalidAccess).success).toBe(false);
    expect(executionReadinessSchema.safeParse({
      ready: true,
      evaluatedAt: '2026-08-10T07:00:00.000Z',
      blockers: [{ code: 'CREDENTIAL_EXPIRED', message: '已过期', retryable: false }],
      resolved: {},
    }).success).toBe(false);
  });

  it('按硬拒绝 > 生命周期 > 指派/授权 > runtime > readiness > 可用校验主结果', () => {
    const cases = [
      [{ access: { accessState: 'denied' }, lifecycle: { blocksNewUse: true }, readiness: { ready: false } }, 'unavailable'],
      [{ access: { accessState: 'allowed' }, lifecycle: { blocksNewUse: true }, readiness: { ready: false } }, 'blocked_lifecycle'],
      [{ access: { accessState: 'needs_assignment' }, lifecycle: { blocksNewUse: false }, readiness: { ready: false } }, 'needs_assignment'],
      [{ access: { accessState: 'needs_user_authorization' }, lifecycle: { blocksNewUse: false }, readiness: { ready: false } }, 'needs_authorization'],
      [{ access: { accessState: 'runtime_approval_required' }, lifecycle: { blocksNewUse: false }, readiness: { ready: false } }, 'needs_runtime_approval'],
      [{ access: { accessState: 'allowed' }, lifecycle: { blocksNewUse: false }, readiness: { ready: false } }, 'not_ready'],
      [{ access: { accessState: 'allowed' }, lifecycle: { blocksNewUse: false }, readiness: { ready: true } }, 'available'],
    ] as const;
    for (const [axes, expected] of cases) expect(expectedPrimaryResultCode(axes)).toBe(expected);

    const inconsistent = clone(effective);
    inconsistent.access.accessState = 'denied';
    expect(effectiveResourceViewSchema.safeParse(inconsistent).success).toBe(false);
  });

  it('允许非敏感的 Token 用量与配额字段', () => {
    expect(() => assertGovernanceUiSafe({ tokenBudget: 1000, contextTokens: 32_000 })).not.toThrow();
  });

  it.each(['secret', 'token', 'secretRef', 'verifier', 'externalAccountId'])(
    '拒绝任意层级敏感字段 %s',
    (field) => {
      expect(() => assertGovernanceUiSafe({ safe: { [field]: 'redacted?' } })).toThrow(/forbidden field/);
      expect(accessDecisionSchema.safeParse({ ...access, [field]: 'x' }).success).toBe(false);
    },
  );

  it('严格校验 v1 管理动作、scope、批量上限与安全响应', () => {
    expect(managementActionV1Schema.options).toEqual(MANAGEMENT_ACTIONS_V1);
    const request = {
      decisions: [
        { action: 'settings.personal.view', scope: { kind: 'personal' } },
        { action: 'settings.tenant.view', scope: { kind: 'tenant', tenantId: 'tenant-1' } },
        { action: 'settings.tenant.view', scope: { kind: 'platform' } },
      ],
    };
    expect(managementSnapshotRequestV1Schema.parse(request)).toEqual(request);
    expect(managementSnapshotRequestV1Schema.safeParse({ decisions: [] }).success).toBe(false);
    expect(managementSnapshotRequestV1Schema.safeParse({
      decisions: Array.from({ length: 65 }, () => request.decisions[0]),
    }).success).toBe(false);
    expect(managementSnapshotRequestV1Schema.safeParse({
      decisions: [{ action: 'tenant.settings.write', scope: { kind: 'tenant', tenantId: 'tenant-1' } }],
    }).success).toBe(false);
    expect(managementSnapshotRequestV1Schema.safeParse({
      decisions: [{ action: 'settings.tenant.view', scope: { kind: 'tenant' } }],
    }).success).toBe(false);

    const response = {
      contractVersion: 'v1',
      subject: { userId: 'user-1', tenantId: 'tenant-1', persona: 'org_admin', isOwner: true },
      decisions: [{
        ...request.decisions[1], allowed: true,
        reason: { code: 'SAME_TENANT_ORG_ADMIN_ALLOWED', label: '允许', layer: 'management_authority' },
        constraints: ['SAME_TENANT_ONLY'],
      }, {
        ...request.decisions[2], allowed: true,
        reason: {
          code: 'PLATFORM_TENANT_MANAGEMENT_ALLOWED',
          label: '平台管理员可进入跨组织管理',
          layer: 'management_authority',
        },
        constraints: ['EXPLICIT_TENANT_SCOPE'],
      }],
      policySnapshot: { membershipVersion: 3 },
      evaluatedAt: '2026-08-10T07:00:00.000Z',
    };
    expect(managementSnapshotResponseV1Schema.parse(response)).toEqual(response);
    expect(managementSnapshotResponseV1Schema.safeParse({ ...response, token: 'forbidden' }).success).toBe(false);
    expect(managementSnapshotResponseV1Schema.safeParse({
      ...response,
      decisions: [{ ...response.decisions[0], reason: { code: 'UNKNOWN', label: '未知', layer: 'other' } }],
    }).success).toBe(false);
  });

  it('接受统一连接授权与有基线的变更预览，但拒绝外部账号明细', () => {
    const connection = {
      connector: resource,
      authMethod: 'oauth',
      grant: {
        state: 'connected',
        generation: 2,
        requestedScopes: [{ code: 'repo:read', label: '读取仓库' }],
        purpose: '读取代码',
        dataDestination: '组织工作区',
      },
      effective,
      actions: [{ code: 'use', label: '使用' }],
    };
    expect(connectionAuthorizationSchema.safeParse(connection).success).toBe(true);
    expect(connectionAuthorizationSchema.safeParse({
      ...connection,
      grant: { ...connection.grant, externalUsername: 'alice' },
    }).success).toBe(false);
    expect(changePreviewSchema.safeParse({
      previewId: 'preview-1', baselineDigest: 'sha256:abc', expiresAt: '2026-08-10T08:00:00Z',
      immediate: [], nextRun: [], unaffectedCount: 2, brokenReferences: [], reversible: true,
    }).success).toBe(true);
  });
});
