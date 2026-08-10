import type { AccessEvaluationRequest, PolicyProvider, PolicyProviderResult } from '../types.js';

export class PlatformInvariantPolicy implements PolicyProvider {
  readonly layer = 'platform_invariant' as const;

  async evaluate(request: AccessEvaluationRequest): Promise<PolicyProviderResult> {
    const { subject, resource } = request;
    if (subject.subjectType === 'human' && subject.accountStatus !== 'active') {
      return this.deny('SUBJECT_DISABLED');
    }
    if (resource.tenantStatus && resource.tenantStatus !== 'active') {
      return this.deny('TENANT_NOT_ACTIVE');
    }
    if (subject.subjectType === 'human' && resource.tenantId && subject.tenantId !== resource.tenantId) {
      return this.deny('CROSS_TENANT_ACCESS_DENIED');
    }
    if (subject.subjectType === 'service' && resource.tenantId && subject.tenantId !== resource.tenantId) {
      return this.deny('SERVICE_TENANT_SCOPE_MISMATCH');
    }
    if (resource.ownerUserId) {
      const subjectId = subject.subjectType === 'human' ? subject.subjectId : subject.delegatedUserId;
      if (subjectId !== resource.ownerUserId) return this.deny('PERSONAL_RESOURCE_OWNER_MISMATCH');
    }
    return {
      layer: this.layer,
      result: 'pass',
      reasonCode: 'PLATFORM_INVARIANTS_SATISFIED',
      ...(subject.subjectType === 'human' ? {
        sourceVersion: subject.membershipVersion,
        snapshot: { membershipVersion: subject.membershipVersion },
      } : {}),
    };
  }

  private deny(reasonCode: string): PolicyProviderResult {
    return { layer: this.layer, result: 'deny', reasonCode };
  }
}
