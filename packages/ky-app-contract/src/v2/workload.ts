import type { P256PublicJwk } from '../types/enrollment.js';
import { V2_JWT_TYP, V2_TTL_SECONDS, V2_WORKLOAD_AUDIENCE } from '../types/constants.js';
import type {
  ClientAssertionClaims,
  DpopProofClaims,
  WorkloadAccessTokenClaims,
} from '../types/workload.js';
import {
  asClaims,
  assertEqual,
  assertExactClaims,
  assertIntegerClaim,
  assertStringClaim,
  assertTokenTime,
  parseScope,
} from './claims.js';
import {
  accessTokenHash,
  constantTimeStringEqual,
  normalizeDpopHtu,
  p256JwkThumbprint,
  validateP256PublicJwk,
} from './crypto.js';
import { v2Fail } from './errors.js';
import { assertJoseHeader, decodeV2Jws, verifyV2Signature } from './jws.js';

const CLIENT_ASSERTION_CLAIMS = [
  'iss',
  'sub',
  'aud',
  'iat',
  'exp',
  'jti',
  'iid',
  'key_id',
] as const;

export interface ClientAssertionVerificationOptions {
  deploymentPublicJwk: P256PublicJwk;
  deploymentId: string;
  installationId: string;
  keyId: string;
  tokenEndpoint: string;
  now: number;
}

export function verifyClientAssertion(
  compact: string,
  options: ClientAssertionVerificationOptions,
): { claims: ClientAssertionClaims; replayKey: string } {
  const decoded = decodeV2Jws(compact);
  assertJoseHeader(decoded.protectedHeader, V2_JWT_TYP.clientAssertion, 'kid');
  if (decoded.protectedHeader.kid !== options.keyId) return v2Fail('key_id_mismatch', 'signature');
  verifyV2Signature(decoded, validateP256PublicJwk(options.deploymentPublicJwk));
  assertExactClaims(decoded.payload, CLIENT_ASSERTION_CLAIMS);
  assertTokenTime(decoded.payload, options.now, V2_TTL_SECONDS.clientAssertion);
  const claims = asClaims<ClientAssertionClaims>(decoded.payload);
  assertEqual(claims.iss, options.deploymentId, 'invalid_issuer');
  assertEqual(claims.sub, options.deploymentId, 'invalid_issuer');
  assertEqual(claims.aud, options.tokenEndpoint, 'invalid_audience');
  assertEqual(claims.iid, options.installationId, 'installation_binding_mismatch', 'binding');
  assertEqual(claims.key_id, options.keyId, 'key_id_mismatch');
  assertStringClaim(claims.jti);
  return { claims, replayKey: `${options.keyId}:${claims.jti}` };
}

const WORKLOAD_CLAIMS = [
  'iss',
  'sub',
  'aud',
  'iat',
  'nbf',
  'exp',
  'jti',
  'tid',
  'iid',
  'sid',
  'client_id',
  'scope',
  'cnf',
  'generation',
] as const;

export interface WorkloadTokenVerificationOptions {
  platformPublicJwk: P256PublicJwk;
  platformKeyId: string;
  platformIssuer: string;
  tenantId: string;
  installationId: string;
  systemId: string;
  deploymentId: string;
  keyId: string;
  generation: number;
  requiredScope?: string;
  installationStatus?: 'enabled' | 'disabled' | 'revoked';
  authorizationScheme?: string;
  now: number;
}

export function verifyWorkloadAccessToken(
  compact: string,
  options: WorkloadTokenVerificationOptions,
): WorkloadAccessTokenClaims {
  if ((options.authorizationScheme ?? 'DPoP') !== 'DPoP')
    return v2Fail('dpop_required', 'request_auth');
  const decoded = decodeV2Jws(compact);
  assertJoseHeader(decoded.protectedHeader, V2_JWT_TYP.workloadAccessToken, 'kid');
  if (decoded.protectedHeader.kid !== options.platformKeyId) {
    return v2Fail('invalid_key_source', 'signature');
  }
  verifyV2Signature(decoded, validateP256PublicJwk(options.platformPublicJwk));
  assertExactClaims(decoded.payload, WORKLOAD_CLAIMS);
  assertTokenTime(decoded.payload, options.now, V2_TTL_SECONDS.workloadAccessToken);
  const claims = asClaims<WorkloadAccessTokenClaims>(decoded.payload);
  assertEqual(claims.iss, options.platformIssuer, 'invalid_issuer');
  assertEqual(claims.aud, V2_WORKLOAD_AUDIENCE, 'invalid_audience');
  assertEqual(claims.tid, options.tenantId, 'installation_binding_mismatch', 'resource_binding');
  assertEqual(
    claims.iid,
    options.installationId,
    'installation_binding_mismatch',
    'resource_binding',
  );
  assertEqual(
    claims.sub,
    options.installationId,
    'installation_binding_mismatch',
    'resource_binding',
  );
  assertEqual(claims.sid, options.systemId, 'installation_binding_mismatch', 'resource_binding');
  assertEqual(
    claims.client_id,
    options.deploymentId,
    'installation_binding_mismatch',
    'resource_binding',
  );
  if (!claims.cnf || claims.cnf.jkt !== options.keyId)
    return v2Fail('dpop_key_mismatch', 'resource_binding');
  assertEqual(claims.generation, options.generation, 'key_generation_mismatch', 'resource_binding');
  if (options.installationStatus && options.installationStatus !== 'enabled') {
    return v2Fail('installation_inactive', 'resource_binding');
  }
  const scopes = parseScope(claims.scope);
  if (options.requiredScope && !scopes.includes(options.requiredScope)) {
    return v2Fail('insufficient_scope', 'resource_binding');
  }
  return claims;
}

const DPOP_CLAIMS = ['htm', 'htu', 'iat', 'jti'] as const;

export interface DpopVerificationOptions {
  method: string;
  requestUrl: string;
  now: number;
  accessToken?: string;
  expectedKeyId?: string;
  nonce?: string;
}

export function assertReplayReservation(
  reserved: boolean,
  kind: 'client_assertion' | 'dpop',
): void {
  if (!reserved) {
    return v2Fail(
      kind === 'client_assertion' ? 'assertion_replayed' : 'dpop_replayed',
      'replay_store',
    );
  }
}

export function verifyDpopProof(
  compact: string,
  options: DpopVerificationOptions,
): { claims: DpopProofClaims; keyId: string; replayKey: string } {
  const decoded = decodeV2Jws(compact);
  assertJoseHeader(decoded.protectedHeader, V2_JWT_TYP.dpop, 'jwk');
  const publicJwk = validateP256PublicJwk(decoded.protectedHeader.jwk);
  verifyV2Signature(decoded, publicJwk);
  assertExactClaims(decoded.payload, DPOP_CLAIMS, ['ath', 'nonce']);
  const claims = asClaims<DpopProofClaims>(decoded.payload);
  assertStringClaim(claims.jti);
  assertStringClaim(claims.htm);
  assertStringClaim(claims.htu);
  assertIntegerClaim(claims.iat);
  if (Math.abs(options.now - claims.iat) > V2_TTL_SECONDS.dpopProof) {
    return v2Fail('invalid_token_time', 'claims');
  }
  if (claims.htm !== options.method.toUpperCase())
    return v2Fail('invalid_dpop_proof', 'request_binding');
  if (claims.htu.includes('?') || claims.htu.includes('#')) {
    return v2Fail('invalid_dpop_proof', 'request_binding');
  }
  if (normalizeDpopHtu(claims.htu) !== normalizeDpopHtu(options.requestUrl)) {
    return v2Fail('invalid_dpop_proof', 'request_binding');
  }
  const keyId = p256JwkThumbprint(publicJwk);
  if (options.expectedKeyId && keyId !== options.expectedKeyId) {
    return v2Fail('dpop_key_mismatch', 'request_binding');
  }
  if (options.accessToken !== undefined) {
    if (!claims.ath || !constantTimeStringEqual(claims.ath, accessTokenHash(options.accessToken))) {
      return v2Fail('invalid_dpop_proof', 'request_binding');
    }
  } else if (claims.ath !== undefined) {
    return v2Fail('invalid_dpop_proof', 'request_binding');
  }
  if (options.nonce !== undefined && claims.nonce !== options.nonce) {
    return v2Fail('nonce_mismatch', 'request_binding');
  }
  return { claims, keyId, replayKey: `${keyId}:${claims.jti}` };
}
