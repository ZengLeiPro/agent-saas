import { describe, expect, it } from 'vitest';
import { AccessEvaluator } from '../governance/access/evaluator.js';
import {
  AssignmentPolicy,
  EntitlementPolicy,
  LongTermGrantPolicy,
  PersonaPolicy,
  PlatformInvariantPolicy,
  RuntimeApprovalPolicy,
  TenantPolicy,
} from '../governance/access/policies/index.js';
import { POLICY_LAYERS, type AccessEvaluationRequest, type PolicyProviderResult } from '../governance/access/types.js';
import type { TenantMembership } from '../data/memberships/types.js';
import type { EntitlementResourceScope, TenantEntitlementSet, TenantPolicy as TenantPolicyRecord } from '../data/entitlements/types.js';
import type { ResourceAssignmentSet } from '../data/assignments/types.js';
import type { HumanSubjectContext } from '../governance/subject/types.js';

function membership(persona: 'member' | 'org_admin', isOwner = false): TenantMembership {
  return {
    tenantId: 'tenant-1',
    userId: 'user-1',
    persona,
    isOwner,
    status: 'active',
    source: 'governance',
    version: 3,
    createdAt: '2026-08-08T00:00:00.000Z',
    createdBy: 'test',
    updatedAt: '2026-08-08T00:00:00.000Z',
    updatedBy: 'test',
  };
}

function subject(overrides: Partial<HumanSubjectContext> = {}): HumanSubjectContext {
  return {
    subjectType: 'human',
    subjectId: 'user-1',
    tenantId: 'tenant-1',
    persona: 'member',
    isOwner: false,
    accountStatus: 'active',
    membershipVersion: 3,
    ...overrides,
  };
}

function entitlementSet(): TenantEntitlementSet {
  return {
    tenantId: 'tenant-1',
    source: 'plan_default',
    status: 'active',
    limits: {},
    version: 5,
    createdAt: '2026-08-08T00:00:00.000Z',
    createdBy: 'test',
    updatedAt: '2026-08-08T00:00:00.000Z',
    updatedBy: 'test',
    updateReason: 'test',
  };
}

function scope(mode: 'all' | 'selected', resourceIds: string[] = []): EntitlementResourceScope {
  return {
    tenantId: 'tenant-1',
    resourceType: 'tool',
    mode,
    resourceIds,
    source: 'governance',
    version: 7,
    createdAt: '2026-08-08T00:00:00.000Z',
    createdBy: 'test',
    updatedAt: '2026-08-08T00:00:00.000Z',
    updatedBy: 'test',
  };
}

function policy(value: TenantPolicyRecord['value']): TenantPolicyRecord {
  return {
    tenantId: 'tenant-1',
    policyKey: 'agent.personal.enabled',
    value,
    source: 'governance',
    version: 11,
    createdAt: '2026-08-08T00:00:00.000Z',
    createdBy: 'test',
    updatedAt: '2026-08-08T00:00:00.000Z',
    updatedBy: 'test',
  };
}

function assignmentSet(assignments: Array<{ assigneeType: 'everyone' | 'user'; assigneeId?: string; effect: 'allow' | 'deny' }>): ResourceAssignmentSet {
  return {
    tenantId: 'tenant-1',
    resourceType: 'org_agent',
    resourceId: 'oa-1',
    source: 'governance',
    version: 13,
    assignments: assignments.map((input, index) => ({
      assignmentId: `a-${index}`,
      tenantId: 'tenant-1',
      resourceType: 'org_agent' as const,
      resourceId: 'oa-1',
      assigneeType: input.assigneeType,
      ...(input.assigneeId ? { assigneeId: input.assigneeId } : {}),
      effect: input.effect,
      origin: 'direct' as const,
      version: 1,
      createdAt: '2026-08-08T00:00:00.000Z',
      createdBy: 'test',
      updatedAt: '2026-08-08T00:00:00.000Z',
      updatedBy: 'test',
    })),
    createdAt: '2026-08-08T00:00:00.000Z',
    createdBy: 'test',
    updatedAt: '2026-08-08T00:00:00.000Z',
    updatedBy: 'test',
  };
}

function buildEvaluator(overrides: {
  entitlement?: TenantEntitlementSet | null;
  scopes?: EntitlementResourceScope[];
  policies?: TenantPolicyRecord[];
  assignmentSet?: ResourceAssignmentSet | null;
} = {}) {
  const entitlementStore = {
    getEntitlementSet: async () => overrides.entitlement === undefined ? entitlementSet() : overrides.entitlement,
    listResourceScopes: async () => overrides.scopes ?? [scope('all')],
    getPolicies: async () => overrides.policies ?? [policy(true)],
  };
  const assignmentStore = {
    getAssignmentSet: async () => overrides.assignmentSet === undefined
      ? assignmentSet([{ assigneeType: 'everyone', effect: 'allow' }])
      : overrides.assignmentSet,
  };
  return new AccessEvaluator([
    new PlatformInvariantPolicy(),
    new EntitlementPolicy(entitlementStore),
    new PersonaPolicy(),
    new TenantPolicy(entitlementStore),
    new AssignmentPolicy(assignmentStore),
    new LongTermGrantPolicy(),
    new RuntimeApprovalPolicy(),
  ]);
}

function personalRunRequest(overrides: Partial<AccessEvaluationRequest> = {}): AccessEvaluationRequest {
  return {
    subject: subject(),
    action: 'personal_agent.run',
    resource: {
      type: 'personal_agent',
      id: 'user-1',
      tenantId: 'tenant-1',
      ownerUserId: 'user-1',
      enabled: true,
      tenantStatus: 'active',
    },
    context: {
      entitlement: { resourceType: 'tool', resourceId: 'personal_agent' },
      tenantPolicyKey: 'agent.personal.enabled',
    },
    ...overrides,
  };
}

function orgAgentRunRequest(overrides: Partial<AccessEvaluationRequest> = {}): AccessEvaluationRequest {
  return {
    subject: subject(),
    action: 'org_agent.run',
    resource: {
      type: 'org_agent',
      id: 'oa-1',
      tenantId: 'tenant-1',
      enabled: true,
      tenantStatus: 'active',
    },
    context: {
      assignment: { required: true, resourceType: 'org_agent', resourceId: 'oa-1' },
    },
    ...overrides,
  };
}

describe('AccessEvaluator 七层固定顺序', () => {
  it('provider 顺序错误时拒绝构造', () => {
    expect(() => new AccessEvaluator([
      new PersonaPolicy(),
      new PlatformInvariantPolicy(),
    ] as never)).toThrow(/order invalid/);
    const evaluator = buildEvaluator();
    expect(POLICY_LAYERS).toEqual([
      'platform_invariant',
      'entitlement',
      'persona',
      'tenant_policy',
      'assignment',
      'long_term_grant',
      'runtime_approval',
    ]);
    expect(evaluator).toBeDefined();
  });

  it('全层通过时 allow，链完整且 policySnapshot 聚合各层版本', async () => {
    const decision = await buildEvaluator().evaluate(personalRunRequest());
    expect(decision.verdict).toBe('allow');
    expect(decision.accessState).toBe('allowed');
    expect(decision.chain.map(step => step.layer)).toEqual([...POLICY_LAYERS]);
    expect(decision.chain.every(step => step.result === 'pass' || step.result === 'not_applicable')).toBe(true);
    expect(decision.policySnapshot).toMatchObject({
      membershipVersion: 3,
      entitlementVersion: 7,
      tenantPolicyVersion: 11,
    });
    expect(decision.nextActions).toEqual([]);
  });

  it('L1 Entitlement deny 优先于后续任何 allow，decisiveLayer=entitlement', async () => {
    const decision = await buildEvaluator({ entitlement: { ...entitlementSet(), status: 'suspended' } })
      .evaluate(personalRunRequest());
    expect(decision.verdict).toBe('deny');
    expect(decision.accessState).toBe('denied');
    expect(decision.reasonCode).toBe('ENTITLEMENT_NOT_ACTIVE');
    expect(decision.decisiveLayer).toBe('entitlement');
  });

  it('Entitlement selected scope 未命中资源时 deny RESOURCE_NOT_ENTITLED', async () => {
    const decision = await buildEvaluator({ scopes: [scope('selected', ['other_tool'])] })
      .evaluate(personalRunRequest());
    expect(decision.verdict).toBe('deny');
    expect(decision.reasonCode).toBe('RESOURCE_NOT_ENTITLED');
    expect(decision.policySnapshot.entitlementVersion).toBe(7);
  });

  it('Tenant Policy 关闭时 deny，即使 Entitlement 放行', async () => {
    const decision = await buildEvaluator({ policies: [policy(false)] })
      .evaluate(personalRunRequest());
    expect(decision.verdict).toBe('deny');
    expect(decision.reasonCode).toBe('TENANT_POLICY_DISABLED');
    expect(decision.decisiveLayer).toBe('tenant_policy');
    expect(decision.policySnapshot.tenantPolicyVersion).toBe(11);
  });

  it('L0 跨租户访问在任何 entitlement/persona 之前被拒', async () => {
    const decision = await buildEvaluator().evaluate(personalRunRequest({
      resource: {
        type: 'personal_agent',
        id: 'user-1',
        tenantId: 'tenant-2',
        ownerUserId: 'user-1',
        enabled: true,
        tenantStatus: 'active',
      },
    }));
    expect(decision.verdict).toBe('deny');
    expect(decision.decisiveLayer).toBe('platform_invariant');
    expect(decision.reasonCode).toBe('CROSS_TENANT_ACCESS_DENIED');
  });

  it('禁用成员的 Subject 在 L0 被拒，不产生 nextActions', async () => {
    const decision = await buildEvaluator().evaluate(personalRunRequest({
      subject: subject({ accountStatus: 'disabled' }),
    }));
    expect(decision.verdict).toBe('deny');
    expect(decision.reasonCode).toBe('SUBJECT_DISABLED');
  });
});

describe('AccessEvaluator persona 与 assignment 矩阵', () => {
  it('member 执行 tenant 管理动作被 L2 persona 拒绝', async () => {
    const decision = await buildEvaluator().evaluate({
      subject: subject(),
      action: 'tenant.policy.update',
      resource: { type: 'tenant', id: 'tenant-1', tenantId: 'tenant-1', tenantStatus: 'active' },
    });
    expect(decision.verdict).toBe('deny');
    expect(decision.decisiveLayer).toBe('persona');
    expect(decision.reasonCode).toBe('ORG_ADMIN_REQUIRED');
  });

  it('org_admin 管理动作放行；owner-only 动作仍要求 isOwner', async () => {
    const adminDecision = await buildEvaluator().evaluate({
      subject: subject({ persona: 'org_admin' }),
      action: 'tenant.policy.update',
      resource: { type: 'tenant', id: 'tenant-1', tenantId: 'tenant-1', tenantStatus: 'active' },
    });
    expect(adminDecision.verdict).toBe('allow');

    const ownerDecision = await buildEvaluator().evaluate({
      subject: subject({ persona: 'org_admin', isOwner: false }),
      action: 'membership.owner.grant',
      resource: { type: 'membership', id: 'user-2', tenantId: 'tenant-1', tenantStatus: 'active' },
    });
    expect(ownerDecision.verdict).toBe('deny');
    expect(ownerDecision.reasonCode).toBe('OWNER_REQUIRED');
  });

  it('平台动作只允许 platform_admin persona', async () => {
    const decision = await buildEvaluator().evaluate({
      subject: subject({ persona: 'org_admin', isOwner: true }),
      action: 'tenant.create',
      resource: { type: 'platform', id: 'tenants' },
    });
    expect(decision.verdict).toBe('deny');
    expect(decision.reasonCode).toBe('PLATFORM_ADMIN_REQUIRED');
  });

  it('组织管理员使用 Org Agent 仍需要 assignment，无豁免', async () => {
    const decision = await buildEvaluator({ assignmentSet: assignmentSet([]) })
      .evaluate(orgAgentRunRequest({
        subject: subject({ persona: 'org_admin' }),
      }));
    expect(decision.verdict).toBe('conditional');
    expect(decision.accessState).toBe('needs_assignment');
    expect(decision.decisiveLayer).toBe('assignment');
    expect(decision.nextActions).toEqual(['request_assignment']);
  });

  it('assignment 无集合时 needs_assignment；显式 deny 优先于 allow', async () => {
    const missing = await buildEvaluator({ assignmentSet: null }).evaluate(orgAgentRunRequest());
    expect(missing.verdict).toBe('conditional');
    expect(missing.accessState).toBe('needs_assignment');
    expect(missing.reasonCode).toBe('ASSIGNMENT_REQUIRED');

    const denied = await buildEvaluator({
      assignmentSet: assignmentSet([
        { assigneeType: 'everyone', effect: 'allow' },
        { assigneeType: 'user', assigneeId: 'user-1', effect: 'deny' },
      ]),
    }).evaluate(orgAgentRunRequest());
    expect(denied.verdict).toBe('deny');
    expect(denied.reasonCode).toBe('EXPLICIT_ASSIGNMENT_DENY');
    expect(denied.policySnapshot.assignmentVersion).toBe(13);
  });

  it('assignment 命中 user allow 时放行并记录版本', async () => {
    const decision = await buildEvaluator({
      assignmentSet: assignmentSet([{ assigneeType: 'user', assigneeId: 'user-1', effect: 'allow' }]),
    }).evaluate(orgAgentRunRequest());
    expect(decision.verdict).toBe('allow');
    expect(decision.reasonCode).toBe('RESOURCE_ASSIGNED');
    expect(decision.policySnapshot.assignmentVersion).toBe(13);
  });

  it('个人资源 non-owner 在 L0 owner 校验处被拒， persona 层无旁路', async () => {
    const decision = await buildEvaluator().evaluate(personalRunRequest({
      subject: subject({ subjectId: 'user-2', persona: 'org_admin' }),
    }));
    expect(decision.verdict).toBe('deny');
    expect(decision.decisiveLayer).toBe('platform_invariant');
    expect(decision.reasonCode).toBe('PERSONAL_RESOURCE_OWNER_MISMATCH');
  });
});

describe('AccessEvaluator 条件层', () => {
  it('长期授权未激活返回 needs_user_authorization', async () => {
    const decision = await buildEvaluator().evaluate(orgAgentRunRequest({
      context: {
        assignment: { required: true, resourceType: 'org_agent', resourceId: 'oa-1' },
        longTermGrant: { required: true, active: false },
      },
    }));
    expect(decision.verdict).toBe('conditional');
    expect(decision.accessState).toBe('needs_user_authorization');
    expect(decision.decisiveLayer).toBe('long_term_grant');
  });

  it('运行时审批未授予返回 needs_runtime_approval', async () => {
    const decision = await buildEvaluator().evaluate(orgAgentRunRequest({
      context: {
        assignment: { required: true, resourceType: 'org_agent', resourceId: 'oa-1' },
        runtimeApproval: { required: true, approved: false },
      },
    }));
    expect(decision.verdict).toBe('conditional');
    expect(decision.accessState).toBe('needs_runtime_approval');
  });

  it('deny 优先于 condition：assignment deny + runtime approval 未授予时整体 deny', async () => {
    const decision = await buildEvaluator({
      assignmentSet: assignmentSet([{ assigneeType: 'user', assigneeId: 'user-1', effect: 'deny' }]),
    }).evaluate(orgAgentRunRequest({
      context: {
        assignment: { required: true, resourceType: 'org_agent', resourceId: 'oa-1' },
        runtimeApproval: { required: true, approved: false },
      },
    }));
    expect(decision.verdict).toBe('deny');
    expect(decision.decisiveLayer).toBe('assignment');
  });

  it('service subject 必须声明允许的 purpose 动作且有 delegated user', async () => {
    const allowed = await buildEvaluator().evaluate(orgAgentRunRequest({
      subject: {
        subjectType: 'service',
        serviceId: 'runtime_worker',
        tenantId: 'tenant-1',
        delegatedUserId: 'user-1',
        purpose: 'run_org_agent',
      },
    }));
    expect(allowed.verdict).toBe('allow');

    const noDelegation = await buildEvaluator().evaluate(orgAgentRunRequest({
      subject: {
        subjectType: 'service',
        serviceId: 'runtime_worker',
        tenantId: 'tenant-1',
        purpose: 'run_org_agent',
      },
    }));
    expect(noDelegation.verdict).toBe('deny');
    expect(noDelegation.reasonCode).toBe('SERVICE_DELEGATED_USER_REQUIRED');

    const wrongPurpose = await buildEvaluator().evaluate({
      subject: {
        subjectType: 'service',
        serviceId: 'retention_worker',
        tenantId: 'tenant-1',
        delegatedUserId: 'user-1',
        purpose: 'retention',
      },
      action: 'org_agent.run',
      resource: { type: 'org_agent', id: 'oa-1', tenantId: 'tenant-1', enabled: true },
    });
    expect(wrongPurpose.verdict).toBe('deny');
    expect(wrongPurpose.reasonCode).toBe('SERVICE_ACTION_NOT_ALLOWED');
  });
});

describe('AccessDecision chain 不可变证据', () => {
  it('每个 chain 条目都带 layer/result/reasonCode，可用于审计回放', async () => {
    const decision = await buildEvaluator({ policies: [policy(false)] })
      .evaluate(personalRunRequest());
    for (const step of decision.chain as PolicyProviderResult[]) {
      expect(step.layer).toBeTruthy();
      expect(['pass', 'deny', 'condition', 'not_applicable']).toContain(step.result);
      expect(step.reasonCode).toBeTruthy();
    }
    expect(decision.evaluatedAt).toBeTruthy();
    expect(decision.id).toBeTruthy();
  });
});
