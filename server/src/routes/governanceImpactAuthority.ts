import type { OAuthGrant } from '../data/oauthGrants/types.js';
import type { EntitlementResourceType } from '../data/entitlements/types.js';

export interface GovernanceDependencyImpact {
  affectedResources: Array<{ type: string; id: string; version: number }>;
  blockers: string[];
  affectedAgents?: string[];
  affectedAutomations?: string[];
  brokenReferences?: string[];
}

export type GovernanceDependencyImpactResolver = (input: {
  tenantId: string;
  kind: 'oauth' | 'entitlement' | 'scope' | 'tenant';
  resourceType?: EntitlementResourceType;
  action?: 'suspend' | 'resume';
  grant?: OAuthGrant;
}) => Promise<GovernanceDependencyImpact>;

export function oauthDependencyImpact(resolver: GovernanceDependencyImpactResolver, grant: OAuthGrant) {
  return resolver({ tenantId: grant.tenantId, kind: 'oauth', grant }).then(impact => ({
    affectedAgents: impact.affectedAgents ?? [],
    affectedAutomations: impact.affectedAutomations ?? [],
    brokenReferences: impact.brokenReferences ?? [],
    blockers: impact.blockers,
  }));
}

export function tenantDependencyImpact(
  resolver: GovernanceDependencyImpactResolver, tenantId: string, action: 'suspend' | 'resume',
) {
  return resolver({ tenantId, kind: 'tenant', action }).then(({ affectedResources, blockers }) => ({ affectedResources, blockers }));
}

export function entitlementDependencyImpact(
  resolver: GovernanceDependencyImpactResolver,
  input: { tenantId: string; kind: 'entitlement' | 'scope'; resourceType?: EntitlementResourceType },
) {
  return resolver(input).then(({ affectedResources, blockers }) => ({ affectedResources, blockers }));
}
