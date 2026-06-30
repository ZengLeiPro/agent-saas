import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface CapabilityClaims {
  sessionId: string;
  userId: string;
  scopes: string[];
  expiresAt: string;
  toolName?: string;
  serverName?: string;
  nonce?: string;
}

export interface CapabilityToken extends CapabilityClaims {
  token: string;
}

export interface CapabilityTokenServiceOptions {
  signingKey?: string;
  defaultTtlMs?: number;
  now?: () => Date;
}

const DEFAULT_TTL_MS = 5 * 60_000;

export class CapabilityTokenService {
  private readonly signingKey: string;
  private readonly defaultTtlMs: number;
  private readonly now: () => Date;

  constructor(options: CapabilityTokenServiceOptions = {}) {
    this.signingKey = options.signingKey ?? randomBytes(32).toString('hex');
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? (() => new Date());
  }

  issue(input: Omit<CapabilityClaims, 'expiresAt' | 'nonce'> & { ttlMs?: number }): CapabilityToken {
    const expiresAt = new Date(this.now().getTime() + (input.ttlMs ?? this.defaultTtlMs)).toISOString();
    const claims: CapabilityClaims = {
      sessionId: input.sessionId,
      userId: input.userId,
      scopes: [...input.scopes].sort(),
      expiresAt,
      ...(input.toolName ? { toolName: input.toolName } : {}),
      ...(input.serverName ? { serverName: input.serverName } : {}),
      nonce: randomBytes(12).toString('hex'),
    };
    return { ...claims, token: sign(claims, this.signingKey) };
  }

  verify(token: string, requiredScopes: string[] = []): CapabilityClaims {
    const [payload, signature] = token.split('.');
    if (!payload || !signature) throw new Error('capability token malformed');
    const expected = hmac(payload, this.signingKey);
    if (!safeEqual(signature, expected)) throw new Error('capability token invalid signature');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as CapabilityClaims;
    if (new Date(claims.expiresAt).getTime() <= this.now().getTime()) throw new Error('capability token expired');
    const scopes = new Set(claims.scopes);
    for (const scope of requiredScopes) {
      if (!scopes.has(scope)) throw new Error(`capability token missing scope: ${scope}`);
    }
    return claims;
  }
}

function sign(claims: CapabilityClaims, key: string): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${hmac(payload, key)}`;
}

function hmac(payload: string, key: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
