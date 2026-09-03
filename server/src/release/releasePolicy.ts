import type { ReleaseAttestationLog } from './releaseAttestation.js';

export interface PromotionPolicyInput {
  attestations: ReleaseAttestationLog;
  manifestDigest: string;
  expectedManifestDigest: string;
  isMainAncestor: boolean;
  minimumPromotableShaSatisfied: boolean;
  productionStateIsResumable: boolean;
  expiresAt: string;
}

export interface PromotionPolicyTiming {
  now?: () => Date;
}

export interface PromotionEligibility {
  promotable: boolean;
  blockingReasons: string[];
}

/** Pure fail-closed policy gate; callers obtain Git ancestry and production facts separately. */
export function getPromotionEligibility(
  input: PromotionPolicyInput,
  timing: PromotionPolicyTiming = {},
): PromotionEligibility {
  const blockingReasons: string[] = [];
  if (
    input.manifestDigest !== input.expectedManifestDigest ||
    input.attestations.boundManifestDigest() !== input.expectedManifestDigest
  ) {
    blockingReasons.push('Manifest digest mismatch.');
  }
  if (!input.isMainAncestor) blockingReasons.push('Release SHA is not reachable from main.');
  if (!input.minimumPromotableShaSatisfied)
    blockingReasons.push('Release SHA is below the minimum promotable SHA.');
  if (!input.productionStateIsResumable)
    blockingReasons.push(
      'Current production component matrix is outside the resumable Manifest prefix.',
    );
  const expiresAt = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= (timing.now ?? (() => new Date()))().getTime()) {
    blockingReasons.push('Release promotion approval has expired.');
  }
  if (!input.attestations.isPromotable())
    blockingReasons.push('RC is not currently approved for promotion.');
  return { promotable: blockingReasons.length === 0, blockingReasons };
}
