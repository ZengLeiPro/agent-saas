import type { ReleaseAttestationLog } from './releaseAttestation.js';

export interface PromotionPolicyInput {
  attestations: ReleaseAttestationLog;
  manifestDigest: string;
  expectedManifestDigest: string;
  isMainAncestor: boolean;
  productionBaselineIsAncestor: boolean;
  expiresAt?: string;
}

export interface PromotionEligibility {
  promotable: boolean;
  blockingReasons: string[];
}

/** Pure fail-closed policy gate; callers obtain Git ancestry and production facts separately. */
export function getPromotionEligibility(input: PromotionPolicyInput): PromotionEligibility {
  const blockingReasons: string[] = [];
  if (input.manifestDigest !== input.expectedManifestDigest) blockingReasons.push('Manifest digest mismatch.');
  if (!input.isMainAncestor) blockingReasons.push('Release SHA is not reachable from main.');
  if (!input.productionBaselineIsAncestor) blockingReasons.push('Production baseline is not an ancestor of release SHA.');
  if (input.expiresAt && (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now())) {
    blockingReasons.push('Release promotion approval has expired.');
  }
  if (!input.attestations.isPromotable()) blockingReasons.push('RC is not currently approved for promotion.');
  return { promotable: blockingReasons.length === 0, blockingReasons };
}
