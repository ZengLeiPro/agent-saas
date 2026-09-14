import type {
  EnrollmentRequestClaims,
  InstallationGrantClaims,
  P256PublicJwk,
} from '../types/enrollment.js';
import { V2_JWT_TYP, V2_TTL_SECONDS } from '../types/constants.js';
import type { V2AttestClaims } from '../types/workload.js';
import {
  asClaims,
  assertDigest,
  assertEqual,
  assertExactClaims,
  assertStringClaim,
  assertTokenTime,
  parseScope,
} from './claims.js';
import { isPkceChallenge, p256JwkThumbprint, validateP256PublicJwk } from './crypto.js';
import { v2Fail } from './errors.js';
import { assertJoseHeader, decodeV2Jws, verifyV2Signature } from './jws.js';

const ENROLLMENT_CLAIMS = [
  'iss',
  'sub',
  'aud',
  'iat',
  'exp',
  'jti',
  'tid',
  'iid',
  'sid',
  'deployment_id',
  'origin',
  'callback_uri',
  'nonce',
  'code_challenge_method',
  'code_challenge',
  'key_id',
  'public_jwk',
  'scope',
] as const;

export interface EnrollmentVerificationOptions {
  platformIssuer: string;
  tenantId: string;
  installationId: string;
  systemId: string;
  deploymentId: string;
  origin: string;
  callbackUrl: string;
  nonce: string;
  now: number;
}

export function verifyEnrollmentRequest(
  compact: string,
  options: EnrollmentVerificationOptions,
): { claims: EnrollmentRequestClaims; keyId: string; replayKey: string } {
  const decoded = decodeV2Jws(compact);
  assertJoseHeader(decoded.protectedHeader, V2_JWT_TYP.enrollmentRequest, 'kid');
  if (
    decoded.payload.code_challenge_method === undefined ||
    decoded.payload.code_challenge === undefined
  ) {
    return v2Fail('invalid_pkce', 'claims');
  }
  assertExactClaims(decoded.payload, ENROLLMENT_CLAIMS);
  const claims = asClaims<EnrollmentRequestClaims>(decoded.payload);
  const publicJwk = validateP256PublicJwk(claims.public_jwk);
  const keyId = p256JwkThumbprint(publicJwk);
  if (decoded.protectedHeader.kid !== keyId || claims.key_id !== keyId) {
    return v2Fail('key_id_mismatch', 'public_key');
  }
  verifyV2Signature(decoded, publicJwk);
  assertTokenTime(decoded.payload, options.now, V2_TTL_SECONDS.enrollmentRequest);
  for (const value of [claims.iss, claims.sub, claims.aud, claims.jti, claims.nonce]) {
    assertStringClaim(value);
  }
  assertEqual(claims.iss, options.deploymentId, 'invalid_issuer');
  assertEqual(claims.sub, options.installationId, 'installation_binding_mismatch', 'binding');
  assertEqual(claims.aud, options.platformIssuer, 'invalid_audience');
  assertEqual(claims.tid, options.tenantId, 'installation_binding_mismatch', 'binding');
  assertEqual(claims.iid, options.installationId, 'installation_binding_mismatch', 'binding');
  assertEqual(claims.sid, options.systemId, 'installation_binding_mismatch', 'binding');
  assertEqual(claims.deployment_id, options.deploymentId, 'installation_binding_mismatch', 'binding');
  assertEqual(claims.origin, options.origin, 'invalid_origin', 'binding');
  assertEqual(claims.callback_uri, options.callbackUrl, 'callback_mismatch', 'binding');
  assertEqual(claims.nonce, options.nonce, 'nonce_mismatch');
  if (claims.code_challenge_method !== 'S256' || !isPkceChallenge(claims.code_challenge)) {
    return v2Fail('invalid_pkce', 'claims');
  }
  parseScope(claims.scope);
  return { claims, keyId, replayKey: `${keyId}:${claims.jti}` };
}

const GRANT_CLAIMS = [
  'iss',
  'sub',
  'aud',
  'iat',
  'exp',
  'jti',
  'tid',
  'iid',
  'sid',
  'client_id',
  'origin',
  'key_id',
  'scope',
  'registered_digest',
  'generation',
] as const;

export interface InstallationGrantVerificationOptions {
  platformPublicJwk: P256PublicJwk;
  platformKeyId: string;
  platformIssuer: string;
  deploymentId: string;
  tenantId: string;
  installationId: string;
  systemId: string;
  origin: string;
  keyId: string;
  now: number;
}

export function verifyInstallationGrant(
  compact: string,
  options: InstallationGrantVerificationOptions,
): InstallationGrantClaims {
  const decoded = decodeV2Jws(compact);
  assertJoseHeader(decoded.protectedHeader, V2_JWT_TYP.installationGrant, 'kid');
  if (decoded.protectedHeader.kid !== options.platformKeyId) {
    return v2Fail('invalid_key_source', 'signature');
  }
  verifyV2Signature(decoded, validateP256PublicJwk(options.platformPublicJwk));
  assertExactClaims(decoded.payload, GRANT_CLAIMS);
  assertTokenTime(decoded.payload, options.now, V2_TTL_SECONDS.clientAssertion);
  const claims = asClaims<InstallationGrantClaims>(decoded.payload);
  assertEqual(claims.iss, options.platformIssuer, 'invalid_issuer');
  assertEqual(claims.aud, options.deploymentId, 'invalid_audience');
  assertEqual(claims.tid, options.tenantId, 'installation_binding_mismatch', 'binding');
  assertEqual(claims.iid, options.installationId, 'installation_binding_mismatch', 'binding');
  assertEqual(claims.sub, options.installationId, 'installation_binding_mismatch', 'binding');
  assertEqual(claims.sid, options.systemId, 'installation_binding_mismatch', 'binding');
  assertEqual(claims.client_id, options.deploymentId, 'installation_binding_mismatch', 'binding');
  assertEqual(claims.origin, options.origin, 'invalid_origin', 'binding');
  assertEqual(claims.key_id, options.keyId, 'key_id_mismatch');
  assertDigest(claims.registered_digest);
  parseScope(claims.scope);
  if (!Number.isSafeInteger(claims.generation) || claims.generation < 1) {
    return v2Fail('key_generation_mismatch', 'binding');
  }
  return claims;
}

const ATTEST_CLAIMS = [
  'iss',
  'sub',
  'aud',
  'iat',
  'exp',
  'jti',
  'tid',
  'iid',
  'sid',
  'deployment_id',
  'key_id',
  'generation',
  'nonce',
  'manifest_digest',
  'ready',
] as const;

export interface AttestVerificationOptions {
  deploymentPublicJwk: P256PublicJwk;
  deploymentId: string;
  keyId: string;
  platformAudience: string;
  tenantId: string;
  installationId: string;
  systemId: string;
  generation: number;
  nonce: string;
  manifestDigest: string;
  now: number;
}

export function verifyV2Attestation(
  compact: string,
  options: AttestVerificationOptions,
): V2AttestClaims {
  const decoded = decodeV2Jws(compact);
  if (
    decoded.protectedHeader.typ === 'ky-attest+jwt' ||
    decoded.protectedHeader.alg === 'HS256'
  ) {
    return v2Fail('v2_downgrade_rejected', 'jose_header');
  }
  assertJoseHeader(decoded.protectedHeader, V2_JWT_TYP.attest, 'kid');
  if (decoded.protectedHeader.kid !== options.keyId) return v2Fail('key_id_mismatch', 'signature');
  verifyV2Signature(decoded, validateP256PublicJwk(options.deploymentPublicJwk));
  assertExactClaims(decoded.payload, ATTEST_CLAIMS);
  assertTokenTime(decoded.payload, options.now, V2_TTL_SECONDS.attest);
  const claims = asClaims<V2AttestClaims>(decoded.payload);
  assertEqual(claims.iss, options.deploymentId, 'invalid_issuer');
  assertEqual(claims.aud, options.platformAudience, 'invalid_audience');
  assertEqual(claims.tid, options.tenantId, 'installation_binding_mismatch', 'binding');
  assertEqual(claims.iid, options.installationId, 'installation_binding_mismatch', 'binding');
  assertEqual(claims.sub, options.installationId, 'installation_binding_mismatch', 'binding');
  assertEqual(claims.sid, options.systemId, 'installation_binding_mismatch', 'binding');
  assertEqual(claims.deployment_id, options.deploymentId, 'installation_binding_mismatch', 'binding');
  assertEqual(claims.key_id, options.keyId, 'key_id_mismatch');
  assertEqual(claims.generation, options.generation, 'key_generation_mismatch', 'binding');
  assertEqual(claims.nonce, options.nonce, 'nonce_mismatch');
  assertDigest(claims.manifest_digest);
  assertEqual(claims.manifest_digest, options.manifestDigest, 'manifest_digest_mismatch', 'readiness');
  if (claims.ready !== true) return v2Fail('installation_inactive', 'readiness');
  return claims;
}
