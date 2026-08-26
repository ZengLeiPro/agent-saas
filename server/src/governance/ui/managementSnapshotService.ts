import { randomUUID } from 'node:crypto';

import {
  MANAGEMENT_ACTIONS_V1,
  managementSnapshotRequestV1Schema,
  managementSnapshotResponseV1Schema,
  type ManagementActionV1,
  type ManagementConstraintV1,
  type ManagementScopeV1,
  type ManagementSnapshotDecisionV1,
  type ManagementSnapshotRequestV1,
  type ManagementSnapshotResponseV1,
} from '../../../../shared/src/types/governance.js';
import type { GovernanceAuditMetadata, GovernanceAuditStore } from '../../data/governance-audit/types.js';
import type { PlatformAdmin, TenantMembership } from '../../data/memberships/types.js';
import type { TenantRecord } from '../../data/tenants/types.js';
import type { UserRecord } from '../../data/users/types.js';
import { getManagementActionDefinition } from '../access/actionCatalog.js';
import { SubjectResolver } from '../subject/resolver.js';
import { SubjectResolutionError, type HumanSubjectContext } from '../subject/types.js';

interface ManagementMembershipReader {
  getMembership(tenantId: string, userId: string): Promise<TenantMembership | null>;
  getPlatformAdmin(userId: string): Promise<PlatformAdmin | null>;
}

export interface ManagementSnapshotDeps {
  users: { findById(id: string): UserRecord | undefined };
  tenants: {
    findById(id: string): TenantRecord | undefined;
    findByIdStrict(id: string): TenantRecord | undefined;
  };
  memberships: ManagementMembershipReader;
  audit: GovernanceAuditStore;
  now?: () => Date;
}

export class ManagementSnapshotError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ManagementSnapshotError';
  }
}

type Reason = ManagementSnapshotDecisionV1['reason'];
const reason = (code: Reason['code'], label: string, layer: Reason['layer']): Reason => ({ code, label, layer });
const MANAGEMENT_SCOPE_KINDS = ['personal', 'tenant', 'platform'] as const;
const AUDIT_TENANT_ID_LIMIT = 6;
const AUDIT_TENANT_ID_LENGTH = 64;

export class ManagementSnapshotService {
  private readonly subjectResolver: SubjectResolver;

  constructor(private readonly deps: ManagementSnapshotDeps) {
    this.subjectResolver = new SubjectResolver(deps.users as never, deps.memberships);
    for (const action of MANAGEMENT_ACTIONS_V1) this.assertManagementAction(action);
  }

  async createSnapshot(actorUserId: string, input: ManagementSnapshotRequestV1): Promise<ManagementSnapshotResponseV1> {
    const parsed = managementSnapshotRequestV1Schema.safeParse(input);
    if (!parsed.success) {
      throw new ManagementSnapshotError(400, 'INVALID_MANAGEMENT_SNAPSHOT_REQUEST', '管理权限快照请求无效');
    }
    const initialSubject = await this.resolveAuthoritativeSubject(actorUserId);
    const intentMetadata = this.auditIntentMetadata(parsed.data);
    const base = {
      correlationId: `management-snapshot:${randomUUID()}`,
      actorType: 'user' as const,
      actorUserId,
      actorPersona: initialSubject.persona,
      actorTenantId: initialSubject.tenantId,
      action: 'settings.management.snapshot',
      targetType: 'management_snapshot',
      targetId: actorUserId,
      purpose: 'authoritative management capability and scope snapshot',
    };
    await this.appendAudit({ ...base, result: 'intent', metadata: intentMetadata });

    let response: ManagementSnapshotResponseV1;
    try {
      const subject = await this.resolveAuthoritativeSubject(actorUserId);
      if (!this.sameIdentity(initialSubject, subject)) {
        throw new ManagementSnapshotError(403, 'GOVERNANCE_SUBJECT_CHANGED', '治理身份在评估期间发生变化');
      }
      const evaluatedAt = (this.deps.now?.() ?? new Date()).toISOString();
      response = managementSnapshotResponseV1Schema.parse({
        contractVersion: 'v1',
        subject: {
          userId: subject.subjectId,
          tenantId: subject.tenantId,
          persona: subject.persona,
          isOwner: subject.isOwner,
        },
        decisions: parsed.data.decisions.map(decision => this.evaluateDecision(subject, decision.action, decision.scope)),
        policySnapshot: { membershipVersion: subject.membershipVersion },
        evaluatedAt,
      });
    } catch (error) {
      const failureCode = error instanceof ManagementSnapshotError
        ? error.code
        : 'GOVERNANCE_DEPENDENCY_UNAVAILABLE';
      await this.appendAudit({ ...base, result: 'failed', metadata: { ...intentMetadata, failureCode } });
      if (error instanceof ManagementSnapshotError) throw error;
      throw new ManagementSnapshotError(503, 'GOVERNANCE_DEPENDENCY_UNAVAILABLE', '管理权限权威依赖不可用');
    }

    const allowCount = response.decisions.filter(decision => decision.allowed).length;
    await this.appendAudit({
      ...base,
      result: 'succeeded',
      metadata: { ...intentMetadata, allowCount, denyCount: response.decisions.length - allowCount },
    });
    return response;
  }

  private auditIntentMetadata(input: ManagementSnapshotRequestV1): GovernanceAuditMetadata {
    const actions = MANAGEMENT_ACTIONS_V1.filter(action => input.decisions.some(decision => decision.action === action));
    const scopeKinds = MANAGEMENT_SCOPE_KINDS.filter(kind => input.decisions.some(decision => decision.scope.kind === kind));
    const explicitTenantIds = [...new Set(input.decisions.flatMap(decision =>
      decision.scope.kind === 'tenant' ? [decision.scope.tenantId] : []))];
    const tenantIds = [...new Set(explicitTenantIds
      .map(tenantId => tenantId.slice(0, AUDIT_TENANT_ID_LENGTH)))]
      .slice(0, AUDIT_TENANT_ID_LIMIT);
    return {
      decisionCount: input.decisions.length,
      contractVersion: 'v1',
      actions: JSON.stringify(actions),
      scopeKinds: JSON.stringify(scopeKinds),
      requestedTenantIds: JSON.stringify(tenantIds),
      requestedTenantIdCount: explicitTenantIds.length,
      requestedTenantIdsTruncated: explicitTenantIds.length > tenantIds.length
        || explicitTenantIds.some(tenantId => tenantId.length > AUDIT_TENANT_ID_LENGTH),
    };
  }

  private async resolveAuthoritativeSubject(userId: string): Promise<HumanSubjectContext> {
    const subject = await this.resolveActiveSubject(userId);
    const tenant = this.findTenantAuthoritatively(subject.tenantId);
    if (!tenant) throw new ManagementSnapshotError(403, 'GOVERNANCE_TENANT_NOT_FOUND', '治理身份所属组织不存在');
    if (tenant.disabled) throw new ManagementSnapshotError(403, 'GOVERNANCE_TENANT_INACTIVE', '治理身份所属组织已停用');
    return subject;
  }

  private async resolveActiveSubject(userId: string): Promise<HumanSubjectContext> {
    let subject: HumanSubjectContext;
    try {
      subject = await this.subjectResolver.resolveHuman(userId);
    } catch (error) {
      if (error instanceof SubjectResolutionError) {
        throw new ManagementSnapshotError(403, 'GOVERNANCE_SUBJECT_UNAVAILABLE', '治理身份不可用');
      }
      throw new ManagementSnapshotError(503, 'GOVERNANCE_DEPENDENCY_UNAVAILABLE', '治理身份依赖不可用');
    }
    if (subject.accountStatus !== 'active') {
      throw new ManagementSnapshotError(403, 'GOVERNANCE_MEMBERSHIP_INACTIVE', '治理成员身份未启用');
    }
    return subject;
  }

  private sameIdentity(left: HumanSubjectContext, right: HumanSubjectContext): boolean {
    return left.subjectId === right.subjectId
      && left.tenantId === right.tenantId
      && left.persona === right.persona
      && left.isOwner === right.isOwner
      && left.membershipVersion === right.membershipVersion
      && left.accountStatus === right.accountStatus;
  }

  private assertManagementAction(action: ManagementActionV1): void {
    if (!getManagementActionDefinition(action)) {
      throw new ManagementSnapshotError(503, 'GOVERNANCE_ACTION_CATALOG_INVALID', '管理动作目录配置无效');
    }
  }

  private findTenantAuthoritatively(tenantId: string): TenantRecord | undefined {
    try {
      return this.deps.tenants.findByIdStrict(tenantId);
    } catch {
      throw new ManagementSnapshotError(503, 'GOVERNANCE_DEPENDENCY_UNAVAILABLE', '组织权威依赖不可用');
    }
  }

  private evaluateDecision(
    subject: HumanSubjectContext,
    action: ManagementActionV1,
    scope: ManagementScopeV1,
  ): ManagementSnapshotDecisionV1 {
    this.assertManagementAction(action);
    const constraint = this.constraintFor(subject, action, scope);
    if (!this.scopeMatches(action, scope)) {
      return this.decision(action, scope, false,
        reason('ACTION_SCOPE_MISMATCH', '动作与管理范围不匹配', 'management_scope'), constraint);
    }
    if (action === 'settings.personal.view') {
      return this.decision(action, scope, true,
        reason('PERSONAL_SELF_ALLOWED', '允许查看本人的个人设置', 'management_scope'), constraint);
    }
    if (action === 'settings.platform.view') {
      const allowed = subject.persona === 'platform_admin';
      return this.decision(action, scope, allowed, allowed
        ? reason('PLATFORM_ADMIN_ALLOWED', '平台管理员可查看平台设置', 'management_authority')
        : reason('PLATFORM_ADMIN_REQUIRED', '仅平台管理员可查看平台设置', 'management_authority'), constraint);
    }
    if (scope.kind === 'platform') {
      const allowed = subject.persona === 'platform_admin';
      return this.decision(action, scope, allowed, allowed
        ? reason('PLATFORM_TENANT_MANAGEMENT_ALLOWED', '平台管理员可进入跨组织管理', 'management_authority')
        : reason('PLATFORM_ADMIN_REQUIRED', '仅平台管理员可进入跨组织管理', 'management_authority'), constraint);
    }
    if (scope.kind !== 'tenant') {
      throw new ManagementSnapshotError(503, 'GOVERNANCE_ACTION_CATALOG_INVALID', '管理动作范围配置无效');
    }
    return this.tenantDecision(subject, action, scope, constraint);
  }

  private tenantDecision(
    subject: HumanSubjectContext,
    action: ManagementActionV1,
    scope: Extract<ManagementScopeV1, { kind: 'tenant' }>,
    constraint: ManagementConstraintV1,
  ): ManagementSnapshotDecisionV1 {
    if (subject.persona === 'member') {
      return this.decision(action, scope, false,
        reason('ORG_ADMIN_REQUIRED', '仅组织管理员或平台管理员可查看组织设置', 'management_authority'), constraint);
    }
    if (subject.persona === 'org_admin' && scope.tenantId !== subject.tenantId) {
      return this.decision(action, scope, false,
        reason('TENANT_SCOPE_MISMATCH', '组织管理员只能查看本组织设置', 'management_scope'), constraint);
    }
    const tenant = this.findTenantAuthoritatively(scope.tenantId);
    if (!tenant || (tenant.disabled && subject.persona !== 'platform_admin')) {
      return this.decision(action, scope, false,
        reason('TENANT_NOT_FOUND', '明确指定的组织不存在或不可用', 'management_authority'), constraint);
    }
    return this.decision(action, scope, true, subject.persona === 'platform_admin'
      ? reason('PLATFORM_ADMIN_EXPLICIT_TENANT_ALLOWED', '平台管理员可查看明确指定的组织设置（含停用组织恢复入口）', 'management_authority')
      : reason('SAME_TENANT_ORG_ADMIN_ALLOWED', '组织管理员可查看本组织设置', 'management_authority'), constraint);
  }

  private scopeMatches(action: ManagementActionV1, scope: ManagementScopeV1): boolean {
    if (action === 'settings.personal.view') return scope.kind === 'personal';
    if (action === 'settings.tenant.view') return scope.kind === 'tenant' || scope.kind === 'platform';
    return scope.kind === 'platform';
  }

  private constraintFor(
    subject: HumanSubjectContext,
    action: ManagementActionV1,
    scope: ManagementScopeV1,
  ): ManagementConstraintV1 {
    if (action === 'settings.personal.view') return 'SELF_ONLY';
    if (action === 'settings.platform.view') return 'PLATFORM_ONLY';
    if (scope.kind === 'platform') return 'EXPLICIT_TENANT_SCOPE';
    return subject.persona === 'platform_admin' ? 'EXPLICIT_TENANT_SCOPE' : 'SAME_TENANT_ONLY';
  }

  private decision(
    action: ManagementActionV1,
    scope: ManagementScopeV1,
    allowed: boolean,
    decisionReason: Reason,
    constraint: ManagementConstraintV1,
  ): ManagementSnapshotDecisionV1 {
    return { action, scope, allowed, reason: decisionReason, constraints: [constraint] };
  }

  private async appendAudit(input: Parameters<GovernanceAuditStore['append']>[0]): Promise<void> {
    try {
      await this.deps.audit.append(input);
    } catch {
      throw new ManagementSnapshotError(503, 'GOVERNANCE_AUDIT_UNAVAILABLE', '治理审计不可用');
    }
  }
}
