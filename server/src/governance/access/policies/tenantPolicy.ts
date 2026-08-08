import type { TenantPolicy as TenantPolicyRecord } from '../../../data/entitlements/types.js';
import type { AccessEvaluationRequest, PolicyProvider, PolicyProviderResult } from '../types.js';

interface TenantPolicyReader {
  getPolicies(tenantId: string): Promise<TenantPolicyRecord[]>;
}

export class TenantPolicy implements PolicyProvider {
  readonly layer = 'tenant_policy' as const;

  constructor(private readonly store: TenantPolicyReader) {}

  async evaluate(request: AccessEvaluationRequest): Promise<PolicyProviderResult> {
    const policyKey = request.context?.tenantPolicyKey;
    if (!policyKey) return this.notApplicable();
    const tenantId = request.resource.tenantId;
    if (!tenantId) return this.deny('TENANT_POLICY_TENANT_REQUIRED');
    const policy = (await this.store.getPolicies(tenantId))
      .find(candidate => candidate.policyKey === policyKey);
    if (!policy) return this.deny('TENANT_POLICY_NOT_FOUND');
    if (policy.value !== true) return this.deny('TENANT_POLICY_DISABLED', policy.version);
    return {
      layer: this.layer,
      result: 'pass',
      reasonCode: 'TENANT_POLICY_ALLOWED',
      sourceVersion: policy.version,
      snapshot: { tenantPolicyVersion: policy.version },
    };
  }

  private notApplicable(): PolicyProviderResult {
    return { layer: this.layer, result: 'not_applicable', reasonCode: 'TENANT_POLICY_NOT_REQUIRED' };
  }

  private deny(reasonCode: string, version?: number): PolicyProviderResult {
    return {
      layer: this.layer,
      result: 'deny',
      reasonCode,
      ...(version !== undefined ? { sourceVersion: version, snapshot: { tenantPolicyVersion: version } } : {}),
    };
  }
}
