import { randomUUID } from 'crypto';
import type { OrgAgentRecord } from '../data/orgAgents/types.js';
import type { ManagedAgentResource, ManagedAgentVersion } from '../data/agentResources/types.js';
import type { TenantRecord } from '../data/tenants/types.js';
import type { AccessDecision, AccessEvaluationRequest } from '../governance/access/types.js';
import { AccessEvaluator } from '../governance/access/evaluator.js';
import { ReadinessEvaluator, type ExecutionReadiness } from '../governance/readiness/evaluator.js';
import { SubjectResolver } from '../governance/subject/resolver.js';
import type { ServiceSubjectContext, SubjectContext } from '../governance/subject/types.js';
import type { RuntimeSessionRecord, SessionCatalog } from './sessionCatalog.js';
import type { ResolvedResourceRef, RunResolutionSnapshotDraft } from './runResolutionSnapshotStore.js';

export type GovernanceEnforcementMode = 'shadow' | 'enforce';

interface OrgAgentReader {
  get(id: string): OrgAgentRecord | undefined;
}

interface TenantReader {
  findById(id: string): TenantRecord | undefined;
}

interface AgentResourceReader {
  getForTenant(tenantId: string, agentId: string): Promise<ManagedAgentResource | null>;
  findPersonalByOwner(tenantId: string, ownerUserId: string): Promise<ManagedAgentResource | null>;
  getVersion(versionId: string): Promise<ManagedAgentVersion | null>;
}

export interface RunPreflightInput {
  phase: 'enqueue' | 'wake';
  runId: string;
  sessionId: string;
  userId?: string;
  tenantId?: string;
  orgAgentId?: string;
  modelRef?: string;
  serviceSubject?: Omit<ServiceSubjectContext, 'subjectType'>;
  environment?: {
    providerId: string;
    templateVersionId?: string;
    instanceId?: string;
    recipeDigest?: string;
  };
  skipBilling?: boolean;
}

export interface RunPreflightResult {
  proceed: boolean;
  enforcementMode: GovernanceEnforcementMode;
  migrationControlRevision?: number;
  accessDecision: AccessDecision;
  readiness: ExecutionReadiness;
  snapshot: RunResolutionSnapshotDraft;
  shadowWouldBlock: boolean;
}

export interface RunPreflightServiceOptions {
  enforcementMode: GovernanceEnforcementMode;
  resolveEnforcementMode?: () => Promise<GovernanceEnforcementMode>;
  resolveEnforcementState?: () => Promise<{ mode: GovernanceEnforcementMode; revision: number }>;
  subjectResolver: SubjectResolver;
  accessEvaluator: AccessEvaluator;
  compareLegacyAccess?: (input: {
    request: AccessEvaluationRequest;
    governanceDecision: AccessDecision;
  }) => Promise<void>;
  readinessEvaluator: ReadinessEvaluator;
  sessionCatalog: Pick<SessionCatalog, 'get'>;
  orgAgentStore: OrgAgentReader;
  agentResourceStore?: AgentResourceReader;
  resolveTypedBindings?: (input: { tenantId: string; userId: string; agentId?: string }) => Promise<{
    skills: ResolvedResourceRef[];
    connectors: ResolvedResourceRef[];
    credentialBindings: ResolvedResourceRef[];
  }>;
  tenantStore: TenantReader;
  authorizeBilling?: (input: { tenantId: string; userId?: string; runId: string }) => Promise<{
    ok: boolean;
    code?: string;
    reason?: string;
  }>;
  isModelAvailable?: (modelRef: string, tenantId?: string) => boolean | Promise<boolean>;
  isEnvironmentAvailable?: (
    input: NonNullable<RunPreflightInput['environment']>,
    context: { tenantId: string; userId: string; agentId?: string },
  ) => Promise<boolean>;
  logger?: { warn(message: string): void };
}

interface ResolvedRunInput {
  userId: string;
  tenantId: string;
  orgAgent?: OrgAgentRecord;
  orgAgentId?: string;
  managedAgent?: ManagedAgentResource;
  managedAgentVersion?: ManagedAgentVersion;
  modelRef?: string;
  typedBindings?: {
    skills: ResolvedResourceRef[];
    connectors: ResolvedResourceRef[];
    credentialBindings: ResolvedResourceRef[];
  };
}

export class RunPreflightService {
  constructor(private readonly options: RunPreflightServiceOptions) {}

  async enforcementMode(): Promise<GovernanceEnforcementMode> {
    return (await this.enforcementState()).mode;
  }

  async preflight(input: RunPreflightInput): Promise<RunPreflightResult> {
    return this.preflightStable(input, 0);
  }

  private async preflightStable(input: RunPreflightInput, retry: number): Promise<RunPreflightResult> {
    const initialState = await this.enforcementState();
    const enforcementMode = initialState.mode;
    const evaluatedAt = new Date();
    const session = await this.options.sessionCatalog.get(input.sessionId);
    const resolved = await this.resolveInput(input, session);
    let subject: SubjectContext;
    let decision: AccessDecision;
    try {
      subject = input.serviceSubject
        ? this.options.subjectResolver.resolveService(input.serviceSubject)
        : await this.options.subjectResolver.resolveHuman(resolved.userId);
      const accessRequest = this.buildAccessRequest(subject, resolved, evaluatedAt);
      decision = await this.options.accessEvaluator.evaluate(accessRequest);
      await this.options.compareLegacyAccess?.({ request: accessRequest, governanceDecision: decision }).catch(error => {
        this.options.logger?.warn(
          `Run preflight legacy comparison unavailable: run=${input.runId} error=${error instanceof Error ? error.message : String(error)}`,
        );
      });
    } catch (error) {
      this.options.logger?.warn(
        `Run preflight access evaluation unavailable: run=${input.runId} error=${error instanceof Error ? error.message : String(error)}`,
      );
      subject = input.serviceSubject
        ? { subjectType: 'service', ...input.serviceSubject }
        : {
            subjectType: 'human',
            subjectId: resolved.userId,
            tenantId: resolved.tenantId,
            persona: 'member',
            isOwner: false,
            accountStatus: 'disabled',
            membershipVersion: 0,
          };
      decision = this.unavailableDecision(subject, resolved, evaluatedAt);
    }

    const billingDecision = !input.skipBilling && this.options.authorizeBilling && resolved.tenantId
      ? await this.options.authorizeBilling({
          tenantId: resolved.tenantId,
          ...(resolved.userId ? { userId: resolved.userId } : {}),
          runId: input.runId,
        })
      : undefined;
    const modelAvailable = resolved.modelRef && this.options.isModelAvailable
      ? await this.options.isModelAvailable(resolved.modelRef, resolved.tenantId)
      : undefined;
    const requiredCredentialIds = Array.isArray(resolved.managedAgentVersion?.definition.credentials)
      ? resolved.managedAgentVersion.definition.credentials.flatMap(value => {
          if (typeof value === 'string') return [value];
          if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).id === 'string') {
            return [String((value as Record<string, unknown>).id)];
          }
          return [];
        })
      : [];
    const readinessCredentials = requiredCredentialIds.length > 0
      ? requiredCredentialIds.map(id => {
          const binding = resolved.typedBindings?.credentialBindings.find(item => item.id === id);
          return { bindingId: binding?.bindingId ?? `required:${id}`, bound: Boolean(binding) };
        })
      : (resolved.typedBindings?.credentialBindings ?? []).map(item => ({
          bindingId: item.bindingId ?? item.id, bound: true,
        }));
    const environmentAvailable = input.environment && this.options.isEnvironmentAvailable
      ? await this.options.isEnvironmentAvailable(input.environment, {
          tenantId: resolved.tenantId,
          userId: resolved.userId,
          ...(resolved.managedAgent?.agentId || resolved.orgAgentId
            ? { agentId: resolved.managedAgent?.agentId ?? resolved.orgAgentId }
            : {}),
        })
      : input.environment
        ? Boolean(input.environment.instanceId || input.environment.templateVersionId)
        : undefined;
    const readiness = this.options.readinessEvaluator.evaluate({
      accessAllowed: decision.verdict === 'allow',
      resourceEnabled: resolved.managedAgent
        ? resolved.managedAgent.status === 'enabled'
        : resolved.orgAgent?.enabled ?? true,
      modelRef: resolved.modelRef,
      modelAvailable,
      billingDecision,
      credentials: readinessCredentials,
      ...(input.environment?.instanceId || input.environment?.templateVersionId ? {
        environment: {
          required: true,
          available: environmentAvailable ?? false,
          ref: input.environment.instanceId ?? input.environment.templateVersionId ?? input.environment.providerId,
        },
      } : {}),
      evaluatedAt,
    });
    const wouldBlock = decision.verdict !== 'allow' || !readiness.ready;
    const finalState = await this.enforcementState();
    const controlChanged = finalState.mode !== initialState.mode
      || (finalState.revision !== undefined && finalState.revision !== initialState.revision);
    if (controlChanged) {
      if (retry >= 1) throw new Error('MIGRATION_CONTROL_CHANGED_DURING_PREFLIGHT');
      return this.preflightStable(input, retry + 1);
    }
    const proceed = enforcementMode === 'shadow' || !wouldBlock;
    return {
      proceed,
      enforcementMode,
      ...(initialState.revision !== undefined ? { migrationControlRevision: initialState.revision } : {}),
      accessDecision: decision,
      readiness,
      shadowWouldBlock: enforcementMode === 'shadow' && wouldBlock,
      snapshot: this.buildSnapshot(
        input, resolved, subject, decision, readiness, evaluatedAt, enforcementMode, initialState.revision,
      ),
    };
  }

  private async enforcementState(): Promise<{ mode: GovernanceEnforcementMode; revision?: number }> {
    if (this.options.resolveEnforcementState) return this.options.resolveEnforcementState();
    if (this.options.resolveEnforcementMode) return { mode: await this.options.resolveEnforcementMode() };
    return { mode: this.options.enforcementMode };
  }

  private async resolveInput(input: RunPreflightInput, session: RuntimeSessionRecord | null): Promise<ResolvedRunInput> {
    const userId = input.userId ?? session?.userId;
    const tenantId = input.tenantId ?? session?.tenantId;
    if (!userId && !input.serviceSubject?.delegatedUserId) throw new Error('RUN_PREFLIGHT_USER_REQUIRED');
    if (!tenantId && !input.serviceSubject?.tenantId) throw new Error('RUN_PREFLIGHT_TENANT_REQUIRED');
    const resolvedUserId = userId ?? input.serviceSubject!.delegatedUserId!;
    const resolvedTenantId = tenantId ?? input.serviceSubject!.tenantId!;
    const orgAgentId = input.orgAgentId ?? session?.orgAgentId;
    const orgAgent = orgAgentId ? this.options.orgAgentStore.get(orgAgentId) : undefined;
    const managedAgent = this.options.agentResourceStore
      ? orgAgentId
        ? await this.options.agentResourceStore.getForTenant(resolvedTenantId, orgAgentId)
        : await this.options.agentResourceStore.findPersonalByOwner(resolvedTenantId, resolvedUserId)
      : null;
    const managedAgentVersion = managedAgent?.currentVersionId && this.options.agentResourceStore
      ? await this.options.agentResourceStore.getVersion(managedAgent.currentVersionId)
      : null;
    const typedBindings = this.options.resolveTypedBindings
      ? await this.options.resolveTypedBindings({
          tenantId: resolvedTenantId,
          userId: resolvedUserId,
          ...(managedAgent?.agentId || orgAgentId
            ? { agentId: managedAgent?.agentId ?? orgAgentId }
            : {}),
        })
      : undefined;
    return {
      userId: resolvedUserId,
      tenantId: resolvedTenantId,
      ...(orgAgentId ? { orgAgentId } : {}),
      ...(orgAgent ? { orgAgent } : {}),
      ...(managedAgent ? { managedAgent } : {}),
      ...(managedAgentVersion ? { managedAgentVersion } : {}),
      ...(typedBindings ? { typedBindings } : {}),
      ...(input.modelRef ?? session?.modelRef ? { modelRef: input.modelRef ?? session!.modelRef } : {}),
    };
  }

  private buildAccessRequest(
    subject: SubjectContext,
    resolved: ResolvedRunInput,
    evaluatedAt: Date,
  ): AccessEvaluationRequest {
    if (resolved.orgAgentId) {
      return {
        subject,
        action: 'org_agent.run',
        resource: {
          type: 'org_agent',
          id: resolved.orgAgentId,
          tenantId: resolved.orgAgent?.tenantId ?? resolved.tenantId,
          enabled: resolved.managedAgent
            ? resolved.managedAgent.status === 'enabled'
            : resolved.orgAgent?.enabled ?? false,
          tenantStatus: this.tenantStatus(resolved.orgAgent?.tenantId ?? resolved.tenantId),
        },
        context: {
          assignment: {
            required: true,
            resourceType: 'org_agent',
            resourceId: resolved.orgAgentId,
          },
        },
        evaluatedAt,
      };
    }
    return {
      subject,
      action: 'personal_agent.run',
      resource: {
        type: 'personal_agent',
        id: resolved.managedAgent?.agentId ?? resolved.userId,
        tenantId: resolved.tenantId,
        ownerUserId: resolved.managedAgent?.ownerUserId ?? resolved.userId,
        enabled: resolved.managedAgent ? resolved.managedAgent.status === 'enabled' : true,
        tenantStatus: this.tenantStatus(resolved.tenantId),
      },
      context: {
        entitlement: { resourceType: 'tool', resourceId: 'personal_agent' },
        tenantPolicyKey: 'agent.personal.enabled',
      },
      evaluatedAt,
    };
  }

  private tenantStatus(tenantId: string): 'active' | 'disabled' {
    return this.options.tenantStore.findById(tenantId)?.disabled === true ? 'disabled' : 'active';
  }

  private unavailableDecision(
    subject: SubjectContext,
    resolved: ResolvedRunInput,
    evaluatedAt: Date,
  ): AccessDecision {
    const orgAgentId = resolved.orgAgentId;
    return {
      id: randomUUID(),
      verdict: 'deny',
      action: orgAgentId ? 'org_agent.run' : 'personal_agent.run',
      resourceType: orgAgentId ? 'org_agent' : 'personal_agent',
      resourceId: orgAgentId ?? resolved.userId,
      tenantId: resolved.tenantId,
      subjectType: subject.subjectType,
      subjectId: subject.subjectType === 'human' ? subject.subjectId : subject.serviceId,
      accessState: 'denied',
      reasonCode: 'ACCESS_EVALUATION_UNAVAILABLE',
      decisiveLayer: 'platform_invariant',
      chain: [{
        layer: 'platform_invariant',
        result: 'deny',
        reasonCode: 'ACCESS_EVALUATION_UNAVAILABLE',
      }],
      policySnapshot: {},
      nextActions: ['retry_later'],
      evaluatedAt: evaluatedAt.toISOString(),
    };
  }

  private buildSnapshot(
    input: RunPreflightInput,
    resolved: ResolvedRunInput,
    subject: SubjectContext,
    accessDecision: AccessDecision,
    readiness: ExecutionReadiness,
    evaluatedAt: Date,
    enforcementMode: GovernanceEnforcementMode,
    migrationControlRevision?: number,
  ): RunResolutionSnapshotDraft {
    const actor = subject.subjectType === 'human'
      ? {
          subjectType: 'human' as const,
          subjectId: subject.subjectId,
          tenantId: subject.tenantId,
          persona: subject.persona,
        }
      : {
          subjectType: 'service' as const,
          subjectId: subject.serviceId,
          ...(subject.tenantId ? { tenantId: subject.tenantId } : {}),
          ...(subject.delegatedUserId ? { delegatedUserId: subject.delegatedUserId } : {}),
        };
    const templateVersionId = typeof resolved.managedAgentVersion?.definition.templateVersionId === 'string'
      ? resolved.managedAgentVersion.definition.templateVersionId
      : undefined;
    const versionedSkills = Array.isArray(resolved.managedAgentVersion?.definition.skills)
      ? resolved.managedAgentVersion.definition.skills.flatMap(value => {
          if (!value || typeof value !== 'object') return [];
          const record = value as Record<string, unknown>;
          if (typeof record.id !== 'string') return [];
          return [{
            id: record.id,
            ...(typeof record.versionId === 'string' ? { versionId: record.versionId } : {}),
            ...(typeof record.revision === 'number' ? { revision: record.revision } : {}),
          }];
        })
      : undefined;
    return {
      runId: input.runId,
      sessionId: input.sessionId,
      tenantId: resolved.tenantId,
      enforcementMode,
      ...(migrationControlRevision !== undefined ? { migrationControlRevision } : {}),
      actor,
      accessDecision,
      readiness,
      agent: resolved.orgAgentId
        ? {
            type: 'org_agent', id: resolved.orgAgentId,
            ...(resolved.managedAgent ? {
              revision: resolved.managedAgent.revision,
              ...(resolved.managedAgent.templateId ? { templateId: resolved.managedAgent.templateId } : {}),
            } : {}),
            ...(templateVersionId ? { templateVersionId } : {}),
            ...(resolved.managedAgentVersion ? {
              versionId: resolved.managedAgentVersion.versionId,
              version: resolved.managedAgentVersion.versionNumber,
            } : {}),
          }
        : {
            type: 'personal_agent', id: resolved.managedAgent?.agentId ?? resolved.userId,
            ...(resolved.managedAgent ? {
              revision: resolved.managedAgent.revision,
              ...(resolved.managedAgent.templateId ? { templateId: resolved.managedAgent.templateId } : {}),
            } : {}),
            ...(templateVersionId ? { templateVersionId } : {}),
            ...(resolved.managedAgentVersion ? {
              versionId: resolved.managedAgentVersion.versionId,
              version: resolved.managedAgentVersion.versionNumber,
            } : {}),
          },
      skills: resolved.typedBindings?.skills.length
        ? resolved.typedBindings.skills
        : versionedSkills ?? (resolved.orgAgent?.allowedSkills ?? []).map(id => ({ id })),
      connectors: resolved.typedBindings?.connectors ?? [],
      credentialBindings: resolved.typedBindings?.credentialBindings ?? [],
      ...(input.environment ? {
        environment: {
          id: input.environment.instanceId ?? input.environment.templateVersionId ?? input.environment.providerId,
          providerId: input.environment.providerId,
          ...(input.environment.templateVersionId ? { templateVersionId: input.environment.templateVersionId } : {}),
          ...(input.environment.instanceId ? { instanceId: input.environment.instanceId } : {}),
          ...(input.environment.recipeDigest ? { recipeDigest: input.environment.recipeDigest } : {}),
        },
      } : {}),
      memoryScopes: [{ id: `user:${resolved.userId}` }],
      ...(resolved.modelRef ? { model: { id: resolved.modelRef } } : {}),
      resolvedAt: evaluatedAt.toISOString(),
    };
  }
}
