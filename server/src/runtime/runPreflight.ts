import { randomUUID } from 'crypto';
import type { OrgAgentRecord } from '../data/orgAgents/types.js';
import type { TenantRecord } from '../data/tenants/types.js';
import type { AccessDecision, AccessEvaluationRequest } from '../governance/access/types.js';
import { AccessEvaluator } from '../governance/access/evaluator.js';
import { ReadinessEvaluator, type ExecutionReadiness } from '../governance/readiness/evaluator.js';
import { SubjectResolver } from '../governance/subject/resolver.js';
import type { ServiceSubjectContext, SubjectContext } from '../governance/subject/types.js';
import type { RuntimeSessionRecord, SessionCatalog } from './sessionCatalog.js';
import type { RunResolutionSnapshotDraft } from './runResolutionSnapshotStore.js';

export type GovernanceEnforcementMode = 'shadow' | 'enforce';

interface OrgAgentReader {
  get(id: string): OrgAgentRecord | undefined;
}

interface TenantReader {
  findById(id: string): TenantRecord | undefined;
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
  skipBilling?: boolean;
}

export interface RunPreflightResult {
  proceed: boolean;
  enforcementMode: GovernanceEnforcementMode;
  accessDecision: AccessDecision;
  readiness: ExecutionReadiness;
  snapshot: RunResolutionSnapshotDraft;
  shadowWouldBlock: boolean;
}

export interface RunPreflightServiceOptions {
  enforcementMode: GovernanceEnforcementMode;
  subjectResolver: SubjectResolver;
  accessEvaluator: AccessEvaluator;
  readinessEvaluator: ReadinessEvaluator;
  sessionCatalog: Pick<SessionCatalog, 'get'>;
  orgAgentStore: OrgAgentReader;
  tenantStore: TenantReader;
  authorizeBilling?: (input: { tenantId: string; userId?: string; runId: string }) => Promise<{
    ok: boolean;
    code?: string;
    reason?: string;
  }>;
  isModelAvailable?: (modelRef: string, tenantId?: string) => boolean | Promise<boolean>;
  logger?: { warn(message: string): void };
}

export class RunPreflightService {
  constructor(private readonly options: RunPreflightServiceOptions) {}

  async preflight(input: RunPreflightInput): Promise<RunPreflightResult> {
    const evaluatedAt = new Date();
    const session = await this.options.sessionCatalog.get(input.sessionId);
    const resolved = this.resolveInput(input, session);
    let subject: SubjectContext;
    let decision: AccessDecision;
    try {
      subject = input.serviceSubject
        ? this.options.subjectResolver.resolveService(input.serviceSubject)
        : await this.options.subjectResolver.resolveHuman(resolved.userId);
      decision = await this.options.accessEvaluator.evaluate(this.buildAccessRequest(subject, resolved, evaluatedAt));
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
    const readiness = this.options.readinessEvaluator.evaluate({
      accessAllowed: decision.verdict === 'allow',
      resourceEnabled: resolved.orgAgent?.enabled ?? true,
      modelRef: resolved.modelRef,
      modelAvailable,
      billingDecision,
      evaluatedAt,
    });
    const wouldBlock = decision.verdict !== 'allow' || !readiness.ready;
    const proceed = this.options.enforcementMode === 'shadow' || !wouldBlock;
    return {
      proceed,
      enforcementMode: this.options.enforcementMode,
      accessDecision: decision,
      readiness,
      shadowWouldBlock: this.options.enforcementMode === 'shadow' && wouldBlock,
      snapshot: this.buildSnapshot(input, resolved, subject, decision, readiness, evaluatedAt),
    };
  }

  private resolveInput(input: RunPreflightInput, session: RuntimeSessionRecord | null): {
    userId: string;
    tenantId: string;
    orgAgent?: OrgAgentRecord;
    orgAgentId?: string;
    modelRef?: string;
  } {
    const userId = input.userId ?? session?.userId;
    const tenantId = input.tenantId ?? session?.tenantId;
    if (!userId && !input.serviceSubject?.delegatedUserId) throw new Error('RUN_PREFLIGHT_USER_REQUIRED');
    if (!tenantId && !input.serviceSubject?.tenantId) throw new Error('RUN_PREFLIGHT_TENANT_REQUIRED');
    const orgAgentId = input.orgAgentId ?? session?.orgAgentId;
    const orgAgent = orgAgentId ? this.options.orgAgentStore.get(orgAgentId) : undefined;
    return {
      userId: userId ?? input.serviceSubject!.delegatedUserId!,
      tenantId: tenantId ?? input.serviceSubject!.tenantId!,
      ...(orgAgentId ? { orgAgentId } : {}),
      ...(orgAgent ? { orgAgent } : {}),
      ...(input.modelRef ?? session?.modelRef ? { modelRef: input.modelRef ?? session!.modelRef } : {}),
    };
  }

  private buildAccessRequest(
    subject: SubjectContext,
    resolved: ReturnType<RunPreflightService['resolveInput']>,
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
          enabled: resolved.orgAgent?.enabled ?? false,
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
        id: resolved.userId,
        tenantId: resolved.tenantId,
        ownerUserId: resolved.userId,
        enabled: true,
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
    resolved: ReturnType<RunPreflightService['resolveInput']>,
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
    resolved: ReturnType<RunPreflightService['resolveInput']>,
    subject: SubjectContext,
    accessDecision: AccessDecision,
    readiness: ExecutionReadiness,
    evaluatedAt: Date,
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
    return {
      runId: input.runId,
      sessionId: input.sessionId,
      tenantId: resolved.tenantId,
      enforcementMode: this.options.enforcementMode,
      actor,
      accessDecision,
      readiness,
      agent: resolved.orgAgentId
        ? { type: 'org_agent', id: resolved.orgAgentId }
        : { type: 'personal_agent', id: resolved.userId },
      skills: (resolved.orgAgent?.allowedSkills ?? []).map(id => ({ id })),
      connectors: [],
      credentialBindings: [],
      memoryScopes: [{ id: `user:${resolved.userId}` }],
      ...(resolved.modelRef ? { model: { id: resolved.modelRef } } : {}),
      resolvedAt: evaluatedAt.toISOString(),
    };
  }
}
