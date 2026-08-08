import type { EntitlementResourceScope, TenantEntitlementSet } from '../../../data/entitlements/types.js';
import type { AccessEvaluationRequest, PolicyProvider, PolicyProviderResult } from '../types.js';

interface EntitlementReader {
  getEntitlementSet(tenantId: string): Promise<TenantEntitlementSet | null>;
  listResourceScopes(tenantId: string): Promise<EntitlementResourceScope[]>;
}

export class EntitlementPolicy implements PolicyProvider {
  readonly layer = 'entitlement' as const;

  constructor(private readonly store: EntitlementReader) {}

  async evaluate(request: AccessEvaluationRequest): Promise<PolicyProviderResult> {
    const required = request.context?.entitlement;
    if (!required) return this.notApplicable();
    const tenantId = request.resource.tenantId;
    if (!tenantId) return this.deny('ENTITLEMENT_TENANT_REQUIRED');
    const entitlement = await this.store.getEntitlementSet(tenantId);
    if (!entitlement) return this.deny('ENTITLEMENT_NOT_FOUND');
    const now = request.evaluatedAt ?? new Date();
    if (!['active', 'trial'].includes(entitlement.status)) return this.deny('ENTITLEMENT_NOT_ACTIVE', entitlement.version);
    if (entitlement.effectiveFrom && Date.parse(entitlement.effectiveFrom) > now.getTime()) {
      return this.deny('ENTITLEMENT_NOT_EFFECTIVE', entitlement.version);
    }
    if (entitlement.effectiveTo && Date.parse(entitlement.effectiveTo) <= now.getTime()) {
      return this.deny('ENTITLEMENT_EXPIRED', entitlement.version);
    }
    const scope = (await this.store.listResourceScopes(tenantId))
      .find(candidate => candidate.resourceType === required.resourceType);
    if (!scope) return this.deny('ENTITLEMENT_SCOPE_NOT_FOUND', entitlement.version);
    if (scope.mode === 'selected' && (!required.resourceId || !scope.resourceIds.includes(required.resourceId))) {
      return this.deny('RESOURCE_NOT_ENTITLED', Math.max(entitlement.version, scope.version));
    }
    const version = Math.max(entitlement.version, scope.version);
    return {
      layer: this.layer,
      result: 'pass',
      reasonCode: 'ENTITLEMENT_ACTIVE',
      sourceVersion: version,
      snapshot: { entitlementVersion: version },
    };
  }

  private notApplicable(): PolicyProviderResult {
    return { layer: this.layer, result: 'not_applicable', reasonCode: 'ENTITLEMENT_NOT_REQUIRED' };
  }

  private deny(reasonCode: string, version?: number): PolicyProviderResult {
    return {
      layer: this.layer,
      result: 'deny',
      reasonCode,
      ...(version !== undefined ? { sourceVersion: version, snapshot: { entitlementVersion: version } } : {}),
    };
  }
}
