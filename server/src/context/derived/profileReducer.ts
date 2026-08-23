import type { DerivedItemCandidate, DerivedProfile, ProfileFacetEntry } from './types.js';

/** Deterministic reducer over already visibility-filtered, confirmed active items. */
export function reduceDerivedProfile(input: {
  tenantId: string;
  entityId: string;
  viewerId?: string;
  entityVisible: boolean;
  items: readonly DerivedItemCandidate[];
}): DerivedProfile {
  const profile: DerivedProfile = {
    tenantId: input.tenantId,
    entityId: input.entityId,
    ...(input.viewerId ? { viewerId: input.viewerId } : {}),
    status: input.entityVisible ? 'active' : 'revoked',
    facets: { role: [], tasks: [], workflow: [], artifacts: [], knowhow: [] },
  };
  if (!input.entityVisible) return profile;
  for (const item of input.items) {
    if (item.state !== 'confirmed' || item.evidence.length === 0) continue;
    const entry: ProfileFacetEntry = {
      itemId: item.itemId,
      semanticKey: item.semanticKey,
      value: item.value,
      authority: item.authority,
      evidence: item.evidence,
    };
    const facet = facetFor(item);
    if (facet) profile.facets[facet].push(entry);
  }
  for (const facet of Object.values(profile.facets)) {
    facet.sort((a, b) => authorityRank(b.authority) - authorityRank(a.authority)
      || a.semanticKey.localeCompare(b.semanticKey) || a.itemId.localeCompare(b.itemId));
  }
  return profile;
}

function facetFor(item: DerivedItemCandidate): keyof DerivedProfile['facets'] | undefined {
  const explicit = item.value && !Array.isArray(item.value) && typeof item.value === 'object'
    ? item.value.profileFacet
    : undefined;
  if (explicit === 'role' || explicit === 'tasks' || explicit === 'workflow'
    || explicit === 'artifacts' || explicit === 'knowhow') return explicit;
  if (item.semanticKey === 'role' || item.semanticKey.startsWith('role:')) return 'role';
  if (item.semanticKey.startsWith('artifact:')) return 'artifacts';
  if (item.semanticKey.startsWith('knowhow:')) return 'knowhow';
  if (item.itemType === 'Task') return 'tasks';
  if (item.itemType === 'Decision' || item.itemType === 'Commitment' || item.itemType === 'Status') return 'workflow';
  if (item.itemType === 'Risk') return 'knowhow';
  return undefined;
}

function authorityRank(value: 'source' | 'user' | 'steward'): number {
  return value === 'steward' ? 3 : value === 'user' ? 2 : 1;
}
