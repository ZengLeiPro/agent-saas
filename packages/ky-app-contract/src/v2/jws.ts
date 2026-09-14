import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';

import type { P256PublicJwk } from '../types/enrollment.js';
import { validateP256PublicJwk } from './crypto.js';
import { v2Fail } from './errors.js';
import { parseJsonWithoutDuplicateKeys } from './json.js';

const SEGMENT = /^[A-Za-z0-9_-]+$/u;

export interface DecodedV2Jws {
  protectedHeader: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: Uint8Array;
  signature: Uint8Array;
}

function decodeObject(segment: string): Record<string, unknown> {
  let text: string;
  try {
    text = Buffer.from(segment, 'base64url').toString('utf8');
  } catch {
    return v2Fail('malformed_jose', 'compact');
  }
  const parsed = parseJsonWithoutDuplicateKeys(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return v2Fail('malformed_jose', 'json');
  }
  return parsed as Record<string, unknown>;
}

export function decodeV2Jws(compact: string): DecodedV2Jws {
  const parts = compact.split('.');
  if (parts.length !== 3 || parts.some((part) => !SEGMENT.test(part) || part.includes('='))) {
    return v2Fail('malformed_jose', 'compact');
  }
  return {
    protectedHeader: decodeObject(parts[0]!),
    payload: decodeObject(parts[1]!),
    signingInput: Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'),
    signature: Buffer.from(parts[2]!, 'base64url'),
  };
}

export function assertJoseHeader(
  header: Record<string, unknown>,
  expectedTyp: string,
  kind: 'kid' | 'jwk',
): void {
  if (header.alg !== 'ES256') return v2Fail('invalid_alg', 'jose_header');
  if (header.typ !== expectedTyp) return v2Fail('invalid_typ', 'jose_header');
  if (header.crit !== undefined) return v2Fail('malformed_jose', 'jose_header');
  const allowed = kind === 'kid' ? new Set(['alg', 'typ', 'kid']) : new Set(['alg', 'typ', 'jwk']);
  if (Object.keys(header).some((key) => !allowed.has(key))) {
    return v2Fail('malformed_jose', 'jose_header');
  }
  if (kind === 'kid' && typeof header.kid !== 'string') {
    return v2Fail('key_id_mismatch', 'jose_header');
  }
  if (kind === 'jwk') validateP256PublicJwk(header.jwk);
}

export function verifyV2Signature(decoded: DecodedV2Jws, key: P256PublicJwk): void {
  let valid = false;
  try {
    valid = verify(
      'sha256',
      decoded.signingInput,
      {
        key: createPublicKey({ key: key as JsonWebKey, format: 'jwk' }),
        dsaEncoding: 'ieee-p1363',
      },
      decoded.signature,
    );
  } catch {
    valid = false;
  }
  if (!valid) return v2Fail('invalid_signature', 'signature');
}
