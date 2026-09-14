import { createHash, timingSafeEqual } from 'node:crypto';

import type { P256PublicJwk } from '../types/enrollment.js';
import { v2Fail } from './errors.js';

const PUBLIC_JWK_MEMBERS = new Set(['kty', 'crv', 'x', 'y', 'alg', 'use', 'kid', 'key_ops']);
const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/u;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/u;

export function validateP256PublicJwk(value: unknown): P256PublicJwk {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return v2Fail('private_jwk_rejected', 'public_key', 'JWK 必须是对象');
  }
  const jwk = value as Record<string, unknown>;
  for (const member of Object.keys(jwk)) {
    if (!PUBLIC_JWK_MEMBERS.has(member)) {
      return v2Fail('private_jwk_rejected', 'public_key', `JWK 含禁止字段 ${member}`);
    }
  }
  if (
    jwk.kty !== 'EC' ||
    jwk.crv !== 'P-256' ||
    typeof jwk.x !== 'string' ||
    typeof jwk.y !== 'string' ||
    !BASE64URL_43.test(jwk.x) ||
    !BASE64URL_43.test(jwk.y) ||
    (jwk.alg !== undefined && jwk.alg !== 'ES256') ||
    (jwk.use !== undefined && jwk.use !== 'sig')
  ) {
    return v2Fail('private_jwk_rejected', 'public_key', 'JWK 不是 P-256 公钥');
  }
  if (
    jwk.key_ops !== undefined &&
    (!Array.isArray(jwk.key_ops) || jwk.key_ops.some((item) => item !== 'verify'))
  ) {
    return v2Fail('private_jwk_rejected', 'public_key', 'JWK key_ops 只能包含 verify');
  }
  return jwk as unknown as P256PublicJwk;
}

export function p256JwkThumbprint(value: unknown): string {
  const jwk = validateP256PublicJwk(value);
  return createHash('sha256')
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
    .digest('base64url');
}

export function pkceS256(verifier: string): string {
  if (!PKCE_VERIFIER.test(verifier)) return v2Fail('invalid_pkce', 'claims');
  return createHash('sha256').update(Buffer.from(verifier, 'ascii')).digest('base64url');
}

export function verifyPkceS256(verifier: string, expectedChallenge: string): void {
  if (!constantTimeStringEqual(pkceS256(verifier), expectedChallenge)) {
    return v2Fail('invalid_pkce', 'token_exchange');
  }
}

export function isPkceChallenge(value: unknown): value is string {
  return typeof value === 'string' && BASE64URL_43.test(value);
}

export function accessTokenHash(accessToken: string): string {
  return createHash('sha256').update(Buffer.from(accessToken, 'ascii')).digest('base64url');
}

export function normalizeDpopHtu(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return v2Fail('invalid_dpop_proof', 'request_binding', 'htu 不是绝对 URL');
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
    return v2Fail('invalid_dpop_proof', 'request_binding', 'htu 必须使用 HTTPS');
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function constantTimeStringEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
