import * as ed25519 from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { toByteArray } from 'base64-js';
import {
  acceptMobilePolicyVersion,
  assertMobilePolicyBinding,
  mobileCompatibilityPayload,
  parseSignedMobileCompatibilityPolicy,
  MobileCompatibilityError,
  type MobileCompatibilityClientIdentity,
  type MobilePolicyReplayState,
  type SignedMobileCompatibilityPolicy,
} from '@agent/shared';

ed25519.etc.sha512Sync = (...messages: Uint8Array[]) => sha512(ed25519.etc.concatBytes(...messages));

export interface MobileCompatibilityTrust {
  keyId: string;
  publicKey: string;
  client: MobileCompatibilityClientIdentity;
  replay: MobilePolicyReplayState;
}

export function verifyMobileCompatibilityPolicy(
  value: unknown,
  trust: MobileCompatibilityTrust,
): { policy: SignedMobileCompatibilityPolicy; replay: MobilePolicyReplayState } {
  const policy = parseSignedMobileCompatibilityPolicy(value);
  assertMobilePolicyBinding(policy, trust.client);
  if (policy.keyId !== trust.keyId) throw new MobileCompatibilityError('POLICY_KEY_MISMATCH');
  const payload = mobileCompatibilityPayload(policy);
  if (bytesToHex(sha256(utf8ToBytes(payload))) !== policy.digest) throw new MobileCompatibilityError('POLICY_DIGEST_MISMATCH');
  let signature: Uint8Array; let publicKey: Uint8Array;
  try { signature = toByteArray(policy.signature); publicKey = toByteArray(trust.publicKey); }
  catch { throw new MobileCompatibilityError('POLICY_SIGNATURE_INVALID'); }
  if (signature.length !== 64 || publicKey.length !== 32 || !ed25519.verify(signature, utf8ToBytes(payload), publicKey)) {
    throw new MobileCompatibilityError('POLICY_SIGNATURE_INVALID');
  }
  return { policy, replay: acceptMobilePolicyVersion(policy, trust.replay) };
}
