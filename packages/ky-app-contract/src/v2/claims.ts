import { V2_TTL_SECONDS } from '../types/constants.js';
import { v2Fail, type V2ContractErrorCode } from './errors.js';

export function asClaims<T>(value: Record<string, unknown>): T {
  return value as T;
}

export function assertExactClaims(
  claims: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((claim) => claims[claim] === undefined)) {
    return v2Fail('invalid_claims', 'claims', '缺少必填 claim');
  }
  if (Object.keys(claims).some((claim) => !allowed.has(claim))) {
    return v2Fail('invalid_claims', 'claims', '含未知 claim');
  }
}

export function assertStringClaim(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) return v2Fail('invalid_claims', 'claims');
}

export function assertIntegerClaim(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return v2Fail('invalid_claims', 'claims');
  }
}

export function assertTokenTime(
  claims: Record<string, unknown>,
  now: number,
  maxTtlSeconds: number,
): void {
  assertIntegerClaim(claims.iat);
  assertIntegerClaim(claims.exp);
  const iat = claims.iat;
  const exp = claims.exp;
  const tolerance = V2_TTL_SECONDS.clockTolerance;
  if (iat > now + tolerance || exp <= now - tolerance || exp <= iat || exp - iat > maxTtlSeconds) {
    return v2Fail('invalid_token_time', 'claims');
  }
  if (claims.nbf !== undefined) {
    assertIntegerClaim(claims.nbf);
    if (claims.nbf > now + tolerance) return v2Fail('invalid_token_time', 'claims');
  }
}

export function assertEqual(
  actual: unknown,
  expected: string | number,
  code: V2ContractErrorCode,
  stage = 'claims',
): void {
  if (actual !== expected) return v2Fail(code, stage);
}

export function assertDigest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    return v2Fail('manifest_digest_mismatch', 'claims');
  }
}

export function parseScope(value: unknown): string[] {
  const scopes =
    typeof value === 'string'
      ? value.split(' ').filter(Boolean)
      : Array.isArray(value) && value.every((item) => typeof item === 'string')
        ? value
        : null;
  if (!scopes || scopes.length === 0 || new Set(scopes).size !== scopes.length) {
    return v2Fail('invalid_claims', 'claims');
  }
  return scopes;
}
