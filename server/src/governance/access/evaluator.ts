import { randomUUID } from 'crypto';
import { POLICY_LAYERS, type AccessDecision, type AccessEvaluationRequest, type AccessState, type PolicyProvider, type PolicyProviderResult, type PolicySnapshotPatch } from './types.js';

function subjectId(request: AccessEvaluationRequest): string {
  return request.subject.subjectType === 'human'
    ? request.subject.subjectId
    : request.subject.serviceId;
}

function conditionalState(result: PolicyProviderResult): AccessState {
  if (result.layer === 'assignment') return 'needs_assignment';
  if (result.layer === 'long_term_grant') return 'needs_user_authorization';
  return 'needs_runtime_approval';
}

export class AccessEvaluator {
  constructor(private readonly providers: readonly PolicyProvider[]) {
    const actual = providers.map(provider => provider.layer);
    if (actual.length !== POLICY_LAYERS.length || actual.some((layer, index) => layer !== POLICY_LAYERS[index])) {
      throw new Error(`Access policy provider order invalid: ${actual.join(' -> ')}`);
    }
  }

  async evaluate(request: AccessEvaluationRequest): Promise<AccessDecision> {
    const chain: PolicyProviderResult[] = [];
    const policySnapshot: PolicySnapshotPatch = {};
    for (const provider of this.providers) {
      const result = await provider.evaluate(request);
      chain.push(result);
      Object.assign(policySnapshot, result.snapshot);
    }

    const denied = chain.find(result => result.result === 'deny');
    const conditional = denied ? undefined : chain.find(result => result.result === 'condition');
    const decisive = denied ?? conditional ?? [...chain].reverse().find(result => result.result === 'pass') ?? chain[0]!;
    const evaluatedAt = (request.evaluatedAt ?? new Date()).toISOString();
    const nextActions = chain.flatMap(result => result.nextAction ? [result.nextAction] : []);
    return {
      id: randomUUID(),
      verdict: denied ? 'deny' : conditional ? 'conditional' : 'allow',
      action: request.action,
      resourceType: request.resource.type,
      resourceId: request.resource.id,
      ...(request.resource.tenantId ? { tenantId: request.resource.tenantId } : {}),
      subjectType: request.subject.subjectType,
      subjectId: subjectId(request),
      accessState: denied ? 'denied' : conditional ? conditionalState(conditional) : 'allowed',
      reasonCode: decisive.reasonCode,
      decisiveLayer: decisive.layer,
      chain,
      policySnapshot,
      nextActions,
      evaluatedAt,
    };
  }
}
