import type {
  AccessChainStep,
  AccessState,
  EffectiveResourceView,
  GovernanceDomain,
  NextAction,
  PrimaryResultCode,
} from '@agent/shared/types/governance';

const chain: AccessChainStep[] = [
  'invariant', 'entitlement', 'persona', 'tenant_policy', 'assignment', 'long_term_grant', 'runtime_approval',
].map((layer) => ({
  layer: layer as AccessChainStep['layer'],
  result: 'pass',
  code: `${layer}.pass`,
  label: `${layer} passed`,
  sourceVersion: 'policy-public-v1',
}));

export function governanceFixture(options: {
  domain?: GovernanceDomain;
  accessState?: AccessState;
  primaryResult?: PrimaryResultCode;
  primaryLabel?: string;
  decisiveLabel?: string;
  ready?: boolean;
  actions?: NextAction[];
} = {}): EffectiveResourceView {
  const accessState = options.accessState ?? 'allowed';
  const ready = options.ready ?? true;
  const primaryResult = options.primaryResult ?? 'available';
  const verdict = accessState === 'allowed'
    ? 'allow'
    : accessState === 'runtime_approval_required' ? 'conditional' : 'deny';

  return {
    resource: {
      type: 'skill',
      id: 'resource-secret-id',
      tenantId: 'tenant-secret-id',
      displayName: '客户分析技能',
      domain: options.domain ?? 'skill',
    },
    lifecycle: { state: 'active', blocksNewUse: false },
    access: {
      decisionId: 'decision-public-id',
      verdict,
      accessState,
      action: 'execute',
      subject: {
        subjectId: 'subject-secret-id',
        tenantId: 'subject-tenant-secret',
        persona: 'member',
        isOwner: false,
      },
      resource: {
        type: 'skill',
        id: 'resource-secret-id',
        tenantId: 'tenant-secret-id',
        displayName: '客户分析技能',
        domain: options.domain ?? 'skill',
      },
      decisiveLayer: accessState === 'needs_user_authorization' ? 'long_term_grant' : 'tenant_policy',
      reasonCode: accessState === 'allowed' ? 'POLICY_ALLOW' : 'POLICY_BLOCK',
      reason: accessState === 'allowed' ? '策略允许本次访问' : '当前条件不允许访问',
      chain,
      policySnapshot: {
        membershipVersion: 4,
        entitlementVersion: 3,
        tenantPolicyVersion: 8,
        assignmentVersion: 2,
        grantGeneration: 1,
      },
      nextActions: options.actions ?? [{ code: 'use', label: '使用' }],
      evaluatedAt: '2026-08-10T08:00:00.000Z',
    },
    readiness: {
      ready,
      evaluatedAt: '2026-08-10T08:00:01.000Z',
      blockers: ready ? [] : [{
        code: 'CREDENTIAL_EXPIRED',
        message: '连接凭据已过期',
        retryable: true,
        nextAction: { code: 'authorize', label: '重新授权', href: '/settings/connectors' },
      }],
      resolved: {
        credentialId: 'credential-secret-id',
        providerId: 'provider-secret-id',
      },
    },
    primaryResult: {
      code: primaryResult,
      label: options.primaryLabel ?? (primaryResult === 'available' ? '可用' : '不可用'),
    },
    decisiveFactor: {
      code: 'DECISIVE_PUBLIC_CODE',
      label: options.decisiveLabel ?? '租户策略决定',
    },
  };
}
