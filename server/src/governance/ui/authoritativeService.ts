import { randomUUID } from 'node:crypto';

import type { GovernanceAuditStore } from '../../data/governance-audit/types.js';
import type { GovernanceCredential } from '../../data/credentials/types.js';
import type { EnvironmentInstance, EnvironmentTemplate, EnvironmentTemplateVersion, ExecutionProvider } from '../../data/environments/types.js';
import type { GovernedSkillResource } from '../../data/skillGovernance/types.js';
import type { ConnectorDefinition } from '../../data/connectorCatalog/types.js';
import type { ManagedAgentResource } from '../../data/agentResources/types.js';
import type { AssignmentResourceType, ResourceAssignmentSet, UserResourcePreference } from '../../data/assignments/types.js';
import type { EntitlementResourceScope, TenantEntitlementSet, TenantPolicy } from '../../data/entitlements/types.js';
import type { TenantMembership, PlatformAdmin } from '../../data/memberships/types.js';
import type { UserRecord } from '../../data/users/types.js';
import { AccessEvaluator } from '../access/evaluator.js';
import {
  AssignmentPolicy,
  EntitlementPolicy,
  LongTermGrantPolicy,
  PersonaPolicy,
  PlatformInvariantPolicy,
  RuntimeApprovalPolicy,
  TenantPolicy as TenantAccessPolicy,
} from '../access/policies/index.js';
import type { AccessDecision, AccessEvaluationContext, AccessResourceRef, PolicyLayer } from '../access/types.js';
import { ReadinessEvaluator, type ExecutionReadiness } from '../readiness/evaluator.js';
import { SubjectResolver } from '../subject/resolver.js';
import { SubjectResolutionError, type HumanSubjectContext } from '../subject/types.js';

export const GOVERNANCE_UI_DOMAINS = [
  'agent', 'skill', 'connector', 'memory', 'file', 'automation', 'model_tool', 'environment',
] as const;
export type GovernanceUiDomain = typeof GOVERNANCE_UI_DOMAINS[number];
export type GovernancePersona = 'platform_admin' | 'org_admin' | 'member';

type ResourceInput = {
  type: string;
  id: string;
  domain: GovernanceUiDomain;
  tenantId?: string;
  displayName?: string;
};

export interface GovernanceEvaluationCommand {
  action: string;
  resource: ResourceInput;
  subjectUserId?: string;
}

export interface GovernanceResourceRef {
  type: string;
  id: string;
  tenantId?: string;
  displayName: string;
  domain: GovernanceUiDomain;
}

export interface GovernanceReadinessDto {
  ready: boolean;
  evaluatedAt: string;
  blockers: Array<{
    code: 'RESOURCE_DISABLED' | 'RESOURCE_RETIRED' | 'CREDENTIAL_MISSING' | 'CREDENTIAL_EXPIRED'
      | 'CREDENTIAL_UNHEALTHY' | 'QUOTA_EXHAUSTED' | 'RUN_LIMIT_REACHED'
      | 'ENVIRONMENT_UNAVAILABLE' | 'PROVIDER_DRAINING' | 'MODEL_UNAVAILABLE';
    message: string;
    retryable: boolean;
    nextAction?: { code: 'use' | 'authorize' | 'view_reason' | 'contact_admin' | 'retry'; label: string; href?: string };
  }>;
  resolved: {
    credentialId?: string;
    credentialGeneration?: number;
    environmentTemplateVersionId?: string;
    providerId?: string;
    modelRef?: string;
  };
}

export interface EffectiveResourceViewDto {
  resource: GovernanceResourceRef;
  lifecycle: { state: string; blocksNewUse: boolean; effectiveAt?: string; reasonCode?: string };
  access: {
    decisionId: string;
    verdict: 'allow' | 'deny' | 'conditional';
    accessState: 'allowed' | 'denied' | 'needs_assignment' | 'needs_user_authorization' | 'runtime_approval_required';
    action: string;
    subject: { subjectId: string; tenantId: string; persona: GovernancePersona; isOwner: boolean };
    resource: GovernanceResourceRef;
    decisiveLayer: 'invariant' | 'entitlement' | 'persona' | 'tenant_policy' | 'assignment' | 'long_term_grant' | 'runtime_approval';
    reasonCode: string;
    reason: string;
    chain: Array<{
      layer: 'invariant' | 'entitlement' | 'persona' | 'tenant_policy' | 'assignment' | 'long_term_grant' | 'runtime_approval';
      result: 'pass' | 'deny' | 'condition' | 'not_applicable';
      code: string;
      label: string;
      sourceVersion?: string;
    }>;
    policySnapshot: {
      membershipVersion: number;
      entitlementVersion?: number;
      tenantPolicyVersion?: number;
      assignmentVersion?: number;
      grantGeneration?: number;
    };
    nextActions: Array<{ code: 'use' | 'authorize' | 'view_reason' | 'contact_admin' | 'retry'; label: string; href?: string }>;
    evaluatedAt: string;
  };
  readiness?: GovernanceReadinessDto;
  primaryResult: {
    code: 'unavailable' | 'blocked_lifecycle' | 'needs_assignment' | 'needs_authorization'
      | 'needs_runtime_approval' | 'not_ready' | 'available';
    label: string;
  };
  decisiveFactor: { code: string; label: string };
}

interface MembershipReader {
  getMembership(tenantId: string, userId: string): Promise<TenantMembership | null>;
  getPlatformAdmin(userId: string): Promise<PlatformAdmin | null>;
}
interface UserReader { findById(id: string): UserRecord | undefined }
interface TenantReader { findById(id: string): { id: string; disabled?: boolean } | undefined }
interface EntitlementReader {
  getEntitlementSet(tenantId: string): Promise<TenantEntitlementSet | null>;
  listResourceScopes(tenantId: string): Promise<EntitlementResourceScope[]>;
  getPolicies(tenantId: string): Promise<TenantPolicy[]>;
}
interface AssignmentReader {
  getAssignmentSet(tenantId: string, resourceType: AssignmentResourceType, resourceId: string): Promise<ResourceAssignmentSet | null>;
  listEffectiveResourceIds(tenantId: string, userId: string, resourceType: AssignmentResourceType, agentId?: string): Promise<Array<{ resourceId: string; bindingId: string; assignmentVersion: number }>>;
  listUserPreferences(userId: string): Promise<UserResourcePreference[]>;
}
interface AgentReader {
  get(id: string): Promise<ManagedAgentResource | null>;
  listPersonalByOwner(tenantId: string, ownerUserId: string): Promise<ManagedAgentResource[]>;
}
interface SkillReader {
  getResource(id: string): Promise<GovernedSkillResource | null>;
  listPersonalByOwner(tenantId: string, ownerUserId: string): Promise<GovernedSkillResource[]>;
}
interface ConnectorReader { get(id: string): Promise<ConnectorDefinition | null> }
interface CredentialReader {
  listForTenant(tenantId: string): Promise<GovernanceCredential[]>;
}
interface EnvironmentReader {
  getTemplate(id: string): Promise<EnvironmentTemplate | null>;
  getTemplateVersion(id: string): Promise<EnvironmentTemplateVersion | null>;
  listForTenant(tenantId: string): Promise<EnvironmentInstance[]>;
  getProvider(id: string): Promise<ExecutionProvider | null>;
}

export interface AuthoritativeGovernanceDeps {
  users: UserReader;
  tenants: TenantReader;
  memberships: MembershipReader;
  entitlements: EntitlementReader;
  assignments: AssignmentReader;
  agents: AgentReader;
  skills: SkillReader;
  connectors: ConnectorReader;
  credentials: CredentialReader;
  environments: EnvironmentReader;
  audit: GovernanceAuditStore;
  readinessEvaluator?: ReadinessEvaluator;
}

export class GovernanceUiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'GovernanceUiError';
  }
}

type ResolvedResource = {
  dto: GovernanceResourceRef;
  access: AccessResourceRef;
  lifecycle: EffectiveResourceViewDto['lifecycle'];
  context: AccessEvaluationContext;
  readinessKind: 'unavailable' | 'connector' | 'environment';
  connector?: ConnectorDefinition;
  environmentTemplate?: EnvironmentTemplate;
};

const REASON_LABELS: Record<string, string> = {
  RESOURCE_ASSIGNED: '组织已指派',
  ASSIGNMENT_REQUIRED: '需要组织指派',
  EXPLICIT_ASSIGNMENT_DENY: '组织指派明确拒绝',
  USER_AUTHORIZATION_REQUIRED: '需要用户授权',
  RUNTIME_APPROVAL_REQUIRED: '需要运行时审批',
  RUNTIME_APPROVAL_GRANTED: '运行时审批已通过',
  CROSS_TENANT_ACCESS_DENIED: '禁止跨组织访问',
  PERSONAL_RESOURCE_OWNER_MISMATCH: '仅资源所有者可用',
  RESOURCE_USE_PERSONA_ALLOWED: '身份允许使用资源',
  PLATFORM_INVARIANTS_SATISFIED: '平台安全约束已满足',
  ENTITLEMENT_ACTIVE: '组织权益有效',
  ENTITLEMENT_NOT_REQUIRED: '无需权益校验',
  TENANT_POLICY_NOT_REQUIRED: '无需组织策略校验',
  ASSIGNMENT_NOT_REQUIRED: '无需指派校验',
  LONG_TERM_GRANT_NOT_REQUIRED: '无需长期授权',
};
const PRIMARY_LABELS: Record<EffectiveResourceViewDto['primaryResult']['code'], string> = {
  unavailable: '不可用', blocked_lifecycle: '生命周期阻断', needs_assignment: '需要指派',
  needs_authorization: '需要授权', needs_runtime_approval: '需要审批', not_ready: '尚未就绪', available: '可用',
};

function label(code: string): string {
  return REASON_LABELS[code] ?? code.replaceAll('_', ' ').toLowerCase();
}
function layer(value: PolicyLayer): EffectiveResourceViewDto['access']['decisiveLayer'] {
  return value === 'platform_invariant' ? 'invariant' : value;
}
function tenantStatus(tenant: { disabled?: boolean } | undefined): 'active' | 'disabled' {
  return tenant?.disabled ? 'disabled' : 'active';
}
function actionFor(resource: ResolvedResource, requested: string): string {
  const expected = resource.dto.domain === 'agent'
    ? resource.access.type === 'personal_agent' ? 'personal_agent.run' : 'org_agent.run'
    : resource.dto.domain === 'skill' ? 'skill.use'
      : resource.dto.domain === 'connector' ? 'connector.use'
        : 'environment.use';
  const aliases = new Set([expected, 'use', ...(resource.dto.domain === 'agent' ? ['run'] : [])]);
  if (!aliases.has(requested)) throw new GovernanceUiError(400, 'ACTION_RESOURCE_MISMATCH', '操作与资源类型不匹配');
  return expected;
}
function nextAction(value: string): EffectiveResourceViewDto['access']['nextActions'][number] {
  if (value.includes('authorize')) return { code: 'authorize', label: '去授权' };
  if (value.includes('retry')) return { code: 'retry', label: '重试' };
  if (value.includes('assignment')) return { code: 'contact_admin', label: '联系管理员' };
  return { code: 'view_reason', label: '查看原因' };
}
function primary(view: Pick<EffectiveResourceViewDto, 'lifecycle' | 'access' | 'readiness'>): EffectiveResourceViewDto['primaryResult'] {
  let code: EffectiveResourceViewDto['primaryResult']['code'];
  if (view.access.accessState === 'denied') code = 'unavailable';
  else if (view.lifecycle.blocksNewUse) code = 'blocked_lifecycle';
  else if (view.access.accessState === 'needs_assignment') code = 'needs_assignment';
  else if (view.access.accessState === 'needs_user_authorization') code = 'needs_authorization';
  else if (view.access.accessState === 'runtime_approval_required') code = 'needs_runtime_approval';
  else if (view.readiness && !view.readiness.ready) code = 'not_ready';
  else code = 'available';
  return { code, label: PRIMARY_LABELS[code] };
}

export class AuthoritativeGovernanceService {
  private readonly subjectResolver: SubjectResolver;
  private readonly accessEvaluator: AccessEvaluator;
  private readonly readinessEvaluator: ReadinessEvaluator;

  constructor(private readonly deps: AuthoritativeGovernanceDeps) {
    this.subjectResolver = new SubjectResolver(deps.users as never, deps.memberships);
    this.accessEvaluator = new AccessEvaluator([
      new PlatformInvariantPolicy(),
      new EntitlementPolicy(deps.entitlements),
      new PersonaPolicy(),
      new TenantAccessPolicy(deps.entitlements),
      new AssignmentPolicy(deps.assignments),
      new LongTermGrantPolicy(),
      new RuntimeApprovalPolicy(),
    ]);
    this.readinessEvaluator = deps.readinessEvaluator ?? new ReadinessEvaluator();
  }

  async evaluate(actorUserId: string, command: GovernanceEvaluationCommand): Promise<EffectiveResourceViewDto[]> {
    return this.audited(actorUserId, 'governance.ui.access.evaluate', command.resource.id, async actor => {
      const target = await this.resolveTarget(actor, command.subjectUserId, command.resource.tenantId);
      const resource = await this.resolveResource(command.resource, target);
      return [await this.view(target, resource, actionFor(resource, command.action))];
    });
  }

  async preflight(actorUserId: string, command: GovernanceEvaluationCommand): Promise<GovernanceReadinessDto> {
    return this.audited(actorUserId, 'governance.ui.execution.preflight', command.resource.id, async actor => {
      const target = await this.resolveTarget(actor, command.subjectUserId, command.resource.tenantId);
      const resource = await this.resolveResource(command.resource, target);
      const view = await this.view(target, resource, actionFor(resource, command.action));
      if (view.access.verdict !== 'allow') {
        throw new GovernanceUiError(403, 'ACCESS_DENIED', view.access.reason);
      }
      if (!view.readiness) throw new GovernanceUiError(503, 'READINESS_UNAVAILABLE', '资源就绪状态权威依赖不可用');
      return view.readiness;
    });
  }

  async effectiveResources(actorUserId: string, domains: GovernanceUiDomain[]): Promise<EffectiveResourceViewDto[]> {
    return this.audited(actorUserId, 'governance.ui.resources.list', actorUserId, async actor => {
      const requested = domains.length ? domains : ['agent', 'skill', 'connector', 'environment'] as GovernanceUiDomain[];
      const unsupported = requested.filter(domain => !['agent', 'skill', 'connector', 'environment'].includes(domain));
      if (unsupported.length) {
        throw new GovernanceUiError(503, 'EFFECTIVE_RESOURCES_PARTIAL', `缺少 ${unsupported.join(',')} 的权威治理资源索引`);
      }
      const inputs = await this.listEffectiveInputs(actor, requested);
      const views: EffectiveResourceViewDto[] = [];
      for (const input of inputs) {
        const resource = await this.resolveResource(input, actor);
        views.push(await this.view(actor, resource, actionFor(resource, 'use')));
      }
      return views;
    });
  }

  private async audited<T>(actorUserId: string, action: string, targetId: string, operation: (actor: HumanSubjectContext) => Promise<T>): Promise<T> {
    let actor: HumanSubjectContext;
    try {
      actor = await this.subjectResolver.resolveHuman(actorUserId);
    } catch (error) {
      if (error instanceof SubjectResolutionError) {
        throw new GovernanceUiError(403, 'GOVERNANCE_SUBJECT_UNAVAILABLE', '治理身份不可用');
      }
      throw new GovernanceUiError(503, 'GOVERNANCE_DEPENDENCY_UNAVAILABLE', '治理身份依赖不可用');
    }
    const correlationId = `governance-ui:${randomUUID()}`;
    const base = {
      correlationId, actorType: 'user' as const, actorUserId,
      actorPersona: actor.persona, actorTenantId: actor.tenantId,
      action, targetType: 'governance_ui_query', targetId,
      purpose: 'authoritative governance UI query', metadata: {},
    };
    try {
      await this.deps.audit.append({ ...base, result: 'intent' });
    } catch {
      throw new GovernanceUiError(503, 'GOVERNANCE_AUDIT_UNAVAILABLE', '治理审计不可用');
    }
    try {
      const result = await operation(actor);
      await this.deps.audit.append({ ...base, result: 'succeeded' });
      return result;
    } catch (error) {
      try {
        await this.deps.audit.append({ ...base, result: 'failed' });
      } catch {
        throw new GovernanceUiError(503, 'GOVERNANCE_AUDIT_UNAVAILABLE', '治理审计不可用');
      }
      throw error;
    }
  }

  private async resolveTarget(actor: HumanSubjectContext, requestedUserId: string | undefined, tenantHint: string | undefined): Promise<HumanSubjectContext> {
    const targetId = requestedUserId ?? actor.subjectId;
    if (actor.persona === 'member' && targetId !== actor.subjectId) {
      throw new GovernanceUiError(403, 'SUBJECT_SCOPE_DENIED', '普通用户只能评估自己');
    }
    let target: HumanSubjectContext;
    try {
      target = targetId === actor.subjectId ? actor : await this.subjectResolver.resolveHuman(targetId);
    } catch (error) {
      if (error instanceof SubjectResolutionError) {
        throw new GovernanceUiError(403, 'SUBJECT_SCOPE_DENIED', '目标治理身份不可用');
      }
      throw new GovernanceUiError(503, 'GOVERNANCE_DEPENDENCY_UNAVAILABLE', '治理身份依赖不可用');
    }
    if (actor.persona === 'org_admin' && target.tenantId !== actor.tenantId) {
      throw new GovernanceUiError(403, 'TENANT_SCOPE_DENIED', '组织管理员只能评估本组织成员');
    }
    if (actor.persona !== 'platform_admin' && tenantHint && tenantHint !== actor.tenantId) {
      throw new GovernanceUiError(403, 'TENANT_SCOPE_DENIED', '禁止跨组织评估');
    }
    if (actor.persona === 'platform_admin' && tenantHint && target.tenantId !== tenantHint) {
      throw new GovernanceUiError(403, 'TENANT_SCOPE_DENIED', '平台管理员评估必须匹配 tenant scope');
    }
    return target;
  }

  private async resolveResource(input: ResourceInput, subject: HumanSubjectContext): Promise<ResolvedResource> {
    const tenant = this.deps.tenants.findById(subject.tenantId);
    if (!tenant) throw new GovernanceUiError(503, 'TENANT_AUTHORITY_UNAVAILABLE', '组织权威数据不可用');
    const common = { tenantId: subject.tenantId, tenantStatus: tenantStatus(tenant) };
    if (input.domain === 'agent') {
      const record = await this.deps.agents.get(input.id);
      if (!record) throw new GovernanceUiError(404, 'RESOURCE_NOT_FOUND', 'Agent 不存在');
      if (record.tenantId !== subject.tenantId) throw new GovernanceUiError(403, 'TENANT_SCOPE_DENIED', '禁止跨组织资源评估');
      const personal = record.kind === 'personal_agent';
      return {
        dto: { type: record.kind, id: record.agentId, tenantId: record.tenantId, displayName: record.agentId, domain: 'agent' },
        access: { type: personal ? 'personal_agent' : 'org_agent', id: record.agentId, ...common, ...(personal ? { ownerUserId: record.ownerUserId } : {}), enabled: record.status === 'enabled' },
        lifecycle: { state: record.status, blocksNewUse: record.status !== 'enabled', ...(record.status === 'archived' ? { reasonCode: 'RESOURCE_RETIRED' } : {}) },
        context: personal ? {
          entitlement: { resourceType: 'tool', resourceId: 'personal_agent' }, tenantPolicyKey: 'agent.personal.enabled',
        } : { assignment: { required: true, resourceType: 'org_agent', resourceId: record.agentId } },
        readinessKind: 'unavailable',
      };
    }
    if (input.domain === 'skill') {
      const record = await this.deps.skills.getResource(input.id);
      if (!record) throw new GovernanceUiError(404, 'RESOURCE_NOT_FOUND', 'Skill 不存在');
      const platform = record.scope === 'platform';
      if (!platform && record.tenantId !== subject.tenantId) throw new GovernanceUiError(403, 'TENANT_SCOPE_DENIED', '禁止跨组织资源评估');
      const personal = record.scope === 'personal';
      return {
        dto: { type: 'skill', id: record.skillId, tenantId: subject.tenantId, displayName: record.skillId, domain: 'skill' },
        access: { type: 'skill', id: record.skillId, ...common, ...(personal ? { ownerUserId: record.ownerUserId } : {}), enabled: record.status === 'published' },
        lifecycle: { state: record.status, blocksNewUse: record.status !== 'published', ...(record.status === 'retired' ? { reasonCode: 'RESOURCE_RETIRED' } : {}) },
        context: {
          entitlement: { resourceType: 'skill', resourceId: record.skillId },
          ...(!personal ? { assignment: { required: true, resourceType: 'skill' as const, resourceId: record.skillId } } : {}),
        },
        readinessKind: 'unavailable',
      };
    }
    if (input.domain === 'connector') {
      const record = await this.deps.connectors.get(input.id);
      if (!record) throw new GovernanceUiError(404, 'RESOURCE_NOT_FOUND', 'Connector 不存在');
      const credentials = await this.connectorCredentials(subject, record.connectorId);
      const active = credentials.some(item => credentialHealthy(item));
      return {
        dto: { type: 'connector', id: record.connectorId, tenantId: subject.tenantId, displayName: record.name, domain: 'connector' },
        access: { type: 'credential', id: `connector:${record.connectorId}`, ...common, enabled: record.status === 'published' },
        lifecycle: { state: record.status, blocksNewUse: record.status !== 'published', ...(record.status === 'retired' ? { reasonCode: 'RESOURCE_RETIRED' } : {}) },
        context: {
          entitlement: { resourceType: 'connector', resourceId: record.connectorId },
          longTermGrant: { required: true, active, ...(credentials[0] ? { generation: credentials[0].generation } : {}) },
          ...(await this.runtimeApprovalContext(subject.tenantId)),
        },
        readinessKind: 'connector', connector: record,
      };
    }
    if (input.domain === 'environment' && ['environment', 'environment_template'].includes(input.type)) {
      const record = await this.deps.environments.getTemplate(input.id);
      if (!record) throw new GovernanceUiError(404, 'RESOURCE_NOT_FOUND', 'Environment template 不存在');
      return {
        dto: { type: 'environment_template', id: record.templateId, tenantId: subject.tenantId, displayName: record.name, domain: 'environment' },
        access: { type: 'environment_template', id: record.templateId, ...common, enabled: record.status === 'published' },
        lifecycle: { state: record.status, blocksNewUse: record.status !== 'published', ...(record.status === 'retired' ? { reasonCode: 'RESOURCE_RETIRED' } : {}) },
        context: {
          entitlement: { resourceType: 'environment_template', resourceId: record.templateId },
          assignment: { required: true, resourceType: 'environment_template', resourceId: record.templateId },
        },
        readinessKind: 'environment', environmentTemplate: record,
      };
    }
    throw new GovernanceUiError(503, 'RESOURCE_AUTHORITY_UNAVAILABLE', `${input.domain} 缺少权威治理适配器`);
  }

  private async runtimeApprovalContext(tenantId: string): Promise<Pick<AccessEvaluationContext, 'runtimeApproval'>> {
    const policy = (await this.deps.entitlements.getPolicies(tenantId))
      .find(item => item.policyKey === 'runtime.high_risk_tool.mode');
    const required = policy?.value === 'approval' || policy?.value === 'require_approval';
    return required ? { runtimeApproval: { required: true, approved: false } } : {};
  }

  private async view(subject: HumanSubjectContext, resource: ResolvedResource, action: string): Promise<EffectiveResourceViewDto> {
    let decision: AccessDecision;
    try {
      decision = await this.accessEvaluator.evaluate({ subject, action, resource: resource.access, context: resource.context });
    } catch {
      throw new GovernanceUiError(503, 'EVALUATOR_UNAVAILABLE', '访问评估依赖不可用');
    }
    const access = this.accessDto(subject, resource.dto, decision);
    const readiness = access.verdict === 'allow'
      ? await this.readiness(resource, subject)
      : undefined;
    const draft = { resource: resource.dto, lifecycle: resource.lifecycle, access, ...(readiness ? { readiness } : {}) };
    const primaryResult = primary(draft);
    return {
      ...draft,
      primaryResult,
      decisiveFactor: readiness && !readiness.ready
        ? { code: readiness.blockers[0]!.code, label: readiness.blockers[0]!.message }
        : { code: access.reasonCode, label: access.reason },
    };
  }

  private accessDto(subject: HumanSubjectContext, resource: GovernanceResourceRef, decision: AccessDecision): EffectiveResourceViewDto['access'] {
    const accessState = decision.accessState === 'needs_runtime_approval'
      ? 'runtime_approval_required' as const
      : decision.accessState;
    const runtimeConditional = accessState === 'runtime_approval_required';
    const verdict = decision.verdict === 'conditional' && !runtimeConditional ? 'deny' : decision.verdict;
    const mappedActions = decision.nextActions.map(nextAction);
    if (!mappedActions.length) mappedActions.push(verdict === 'allow' ? { code: 'use', label: '使用' } : { code: 'view_reason', label: '查看原因' });
    return {
      decisionId: decision.id, verdict, accessState, action: decision.action,
      subject: { subjectId: subject.subjectId, tenantId: subject.tenantId, persona: subject.persona, isOwner: subject.isOwner },
      resource, decisiveLayer: layer(decision.decisiveLayer), reasonCode: decision.reasonCode, reason: label(decision.reasonCode),
      chain: decision.chain.map(step => ({
        layer: layer(step.layer), result: step.result, code: step.reasonCode, label: label(step.reasonCode),
        ...(step.sourceVersion !== undefined ? { sourceVersion: String(step.sourceVersion) } : {}),
      })),
      policySnapshot: { membershipVersion: subject.membershipVersion, ...decision.policySnapshot },
      nextActions: mappedActions, evaluatedAt: decision.evaluatedAt,
    };
  }

  private async readiness(resource: ResolvedResource, subject: HumanSubjectContext): Promise<GovernanceReadinessDto> {
    if (resource.readinessKind === 'unavailable') {
      throw new GovernanceUiError(503, 'READINESS_UNAVAILABLE', '该资源缺少完整运行依赖索引，不能推断 ready');
    }
    if (resource.readinessKind === 'connector') {
      const credentials = await this.connectorCredentials(subject, resource.connector!.connectorId);
      const selected = credentials.find(credentialHealthy) ?? credentials[0];
      const internal = this.readinessEvaluator.evaluate({
        accessAllowed: true,
        resourceEnabled: resource.access.enabled,
        resourceRetired: resource.lifecycle.reasonCode === 'RESOURCE_RETIRED',
        credentials: selected ? [{
          bindingId: selected.credentialId,
          bound: true,
          expired: credentialExpired(selected),
          unhealthy: !credentialExpired(selected) && !credentialHealthy(selected),
        }] : [{ bindingId: `connector:${resource.connector!.connectorId}`, bound: false }],
      });
      return this.readinessDto(internal, selected ? { credentialId: selected.credentialId, credentialGeneration: selected.generation } : {});
    }
    const template = resource.environmentTemplate!;
    const instances = (await this.deps.environments.listForTenant(subject.tenantId))
      .filter(item => item.templateId === template.templateId);
    const candidate = instances.find(item => item.status === 'ready' && Date.parse(item.leaseExpiresAt) > Date.now()) ?? instances[0];
    const provider = candidate ? await this.deps.environments.getProvider(candidate.providerId) : null;
    const internal = this.readinessEvaluator.evaluate({
      accessAllowed: true,
      resourceEnabled: resource.access.enabled,
      resourceRetired: resource.lifecycle.reasonCode === 'RESOURCE_RETIRED',
      environment: { required: true, available: Boolean(candidate && candidate.status === 'ready' && Date.parse(candidate.leaseExpiresAt) > Date.now()) },
      providerDraining: provider?.status === 'draining',
      providerHealthy: provider ? provider.status !== 'disabled' : undefined,
    });
    return this.readinessDto(internal, {
      ...(template.currentVersionId ? { environmentTemplateVersionId: template.currentVersionId } : {}),
      ...(provider ? { providerId: provider.providerId } : {}),
    });
  }

  private readinessDto(internal: ExecutionReadiness, resolved: GovernanceReadinessDto['resolved']): GovernanceReadinessDto {
    const code = (value: ExecutionReadiness['blockers'][number]['code']): GovernanceReadinessDto['blockers'][number]['code'] => {
      if (value === 'CREDENTIAL_NOT_BOUND') return 'CREDENTIAL_MISSING';
      if (value === 'PROVIDER_UNHEALTHY') return 'ENVIRONMENT_UNAVAILABLE';
      return value;
    };
    return {
      ready: internal.ready,
      evaluatedAt: internal.evaluatedAt,
      blockers: internal.blockers.map(blocker => ({
        code: code(blocker.code), message: blocker.reason, retryable: blocker.retryable,
        ...(blocker.nextAction ? { nextAction: nextAction(blocker.nextAction) } : {}),
      })),
      resolved,
    };
  }

  private async connectorCredentials(subject: HumanSubjectContext, connectorId: string): Promise<GovernanceCredential[]> {
    const [all, bindings] = await Promise.all([
      this.deps.credentials.listForTenant(subject.tenantId),
      this.deps.assignments.listEffectiveResourceIds(subject.tenantId, subject.subjectId, 'credential'),
    ]);
    const ids = new Set(bindings.map(item => item.resourceId));
    return all.filter(item => item.connectorId === connectorId && ids.has(item.credentialId));
  }

  private async listEffectiveInputs(subject: HumanSubjectContext, domains: GovernanceUiDomain[]): Promise<ResourceInput[]> {
    const values: ResourceInput[] = [];
    if (domains.includes('agent')) {
      const [assigned, personal] = await Promise.all([
        this.deps.assignments.listEffectiveResourceIds(subject.tenantId, subject.subjectId, 'org_agent'),
        this.deps.agents.listPersonalByOwner(subject.tenantId, subject.subjectId),
      ]);
      values.push(...assigned.map(item => ({ type: 'org_agent', id: item.resourceId, domain: 'agent' as const })));
      values.push(...personal.map(item => ({ type: 'personal_agent', id: item.agentId, domain: 'agent' as const })));
    }
    if (domains.includes('skill')) {
      const [assigned, personal, preferences] = await Promise.all([
        this.deps.assignments.listEffectiveResourceIds(subject.tenantId, subject.subjectId, 'skill'),
        this.deps.skills.listPersonalByOwner(subject.tenantId, subject.subjectId),
        this.deps.assignments.listUserPreferences(subject.subjectId),
      ]);
      values.push(...assigned.map(item => ({ type: 'skill', id: item.resourceId, domain: 'skill' as const })));
      const enabled = new Set(preferences.filter(item => item.resourceType === 'skill' && item.enabled).map(item => item.resourceId));
      values.push(...personal.filter(item => enabled.has(item.skillId)).map(item => ({ type: 'skill', id: item.skillId, domain: 'skill' as const })));
    }
    if (domains.includes('connector')) {
      const credentials = await this.deps.credentials.listForTenant(subject.tenantId);
      const bindings = await this.deps.assignments.listEffectiveResourceIds(subject.tenantId, subject.subjectId, 'credential');
      const ids = new Set(bindings.map(item => item.resourceId));
      const connectorIds = new Set(credentials.filter(item => ids.has(item.credentialId) && item.connectorId).map(item => item.connectorId!));
      values.push(...[...connectorIds].map(id => ({ type: 'connector', id, domain: 'connector' as const })));
    }
    if (domains.includes('environment')) {
      const assigned = await this.deps.assignments.listEffectiveResourceIds(subject.tenantId, subject.subjectId, 'environment_template');
      values.push(...assigned.map(item => ({ type: 'environment_template', id: item.resourceId, domain: 'environment' as const })));
    }
    const seen = new Set<string>();
    return values.filter(item => {
      const key = `${item.domain}:${item.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

function credentialExpired(value: GovernanceCredential): boolean {
  return value.status === 'expired' || Boolean(value.expiresAt && Date.parse(value.expiresAt) <= Date.now());
}
function credentialHealthy(value: GovernanceCredential): boolean {
  return ['active', 'rotation_due'].includes(value.status) && !credentialExpired(value);
}
