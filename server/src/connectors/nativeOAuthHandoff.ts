import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';

export interface NativeOAuthBinding {
  clientState: string; pkceChallenge: string; provider: string; redirectUri: string;
  identityGeneration: number; createdAt: number;
}
export interface NativeOAuthHandoffPersistence {
  beginNativeHandoff(input: NativeOAuthBinding & {
    providerState: string; userId: string; tenantId: string; connectorId: string; deviceId: string;
  }): Promise<void>;
  completeNativeHandoff(input: {
    providerState: string; status: 'succeeded' | 'failed'; errorCode?: string;
  }): Promise<({ code: string } & Pick<NativeOAuthBinding, 'clientState' | 'provider' | 'redirectUri' | 'identityGeneration'>) | null>;
  consumeNativeHandoff(input: NativeOAuthBinding & {
    code: string; userId: string; tenantId: string; deviceId: string; pkceVerifier: string;
  }): Promise<{ connectorId: string; status: 'succeeded' | 'failed'; errorCode?: string } | null>;
}

function base64urlSha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

export class NativeOAuthHandoffStore {
  private readonly appLink: string;

  constructor(private readonly persistence: NativeOAuthHandoffPersistence, appLink: string, options: { allowCustomScheme?: boolean } = {}) {
    const parsed = new URL(appLink);
    const https = parsed.protocol === 'https:' && !!parsed.hostname && parsed.pathname === '/oauth/callback';
    const custom = options.allowCustomScheme === true && parsed.protocol !== 'http:' && parsed.protocol !== 'https:'
      && parsed.hostname === 'oauth' && parsed.pathname === '/callback';
    if ((!https && !custom) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('Native OAuth callback must be a fixed allowlisted HTTPS App Link (or explicitly enabled non-production custom scheme)');
    }
    this.appLink = parsed.toString();
  }

  async begin(input: NativeOAuthBinding & {
    providerState: string; userId: string; tenantId: string; connectorId: string; deviceId: string;
  }): Promise<void> {
    if (!/^[A-Za-z0-9._:-]{8,200}$/.test(input.deviceId)) throw new Error('Invalid native OAuth deviceId');
    if (input.redirectUri !== this.appLink || input.provider !== input.connectorId) throw new Error('Invalid native OAuth provider or redirect binding');
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(input.clientState)
      || !/^[A-Za-z0-9_-]{43}$/.test(input.pkceChallenge)
      || !Number.isSafeInteger(input.identityGeneration) || input.identityGeneration < 0
      || Math.abs(Date.now() - input.createdAt) > 60_000) throw new Error('Invalid native OAuth transaction binding');
    await this.persistence.beginNativeHandoff(input);
  }

  async complete(providerState: string, result: { status: 'succeeded' | 'failed'; errorCode?: string }): Promise<string | null> {
    const completed = await this.persistence.completeNativeHandoff({ providerState, ...result });
    if (!completed) return null;
    const target = new URL(this.appLink);
    target.searchParams.set('state', completed.clientState);
    target.searchParams.set('provider', completed.provider);
    target.searchParams.set('redirect', completed.redirectUri);
    target.searchParams.set('generation', String(completed.identityGeneration));
    if (result.status === 'succeeded') target.searchParams.set('code', completed.code);
    else target.searchParams.set('error', result.errorCode ?? 'OAUTH_AUTHORIZATION_FAILED');
    return target.toString();
  }

  consume(input: NativeOAuthBinding & { code: string; userId: string; tenantId: string; deviceId: string; pkceVerifier: string }) {
    if (base64urlSha256(input.pkceVerifier) !== input.pkceChallenge) return Promise.resolve(null);
    return this.persistence.consumeNativeHandoff(input);
  }
}


export const nativeOAuthStartBindingSchema = z.object({
  nativeDeviceId: z.string().regex(/^[A-Za-z0-9._:-]{8,200}$/),
  nativeState: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  nativePkceChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  nativeProvider: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/),
  nativeRedirectUri: z.string().url().max(2048),
  nativeIdentityGeneration: z.number().int().nonnegative(),
  nativeCreatedAt: z.number().int().nonnegative(),
}).strict();

const handoffConsumeSchema = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]{48}$/),
  deviceId: z.string().regex(/^[A-Za-z0-9._:-]{8,200}$/),
  state: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  pkceVerifier: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  provider: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/),
  redirectUri: z.string().url().max(2048),
  identityGeneration: z.number().int().nonnegative(),
}).strict();

export function createNativeOAuthHandoffRouter(store: NativeOAuthHandoffStore): Router {
  const router = Router();
  router.post('/oauth/native/handoff', async (req, res) => {
    if (!req.user?.sub || !req.user.tenantId) return res.status(401).json({ error: 'Authentication required' });
    const parsed = handoffConsumeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid native OAuth handoff request' });
    const result = await store.consume({
      ...parsed.data, clientState: parsed.data.state, pkceChallenge: base64urlSha256(parsed.data.pkceVerifier),
      createdAt: 0, userId: req.user.sub, tenantId: req.user.tenantId,
    });
    if (!result) return res.status(404).json({ error: 'Native OAuth handoff code is invalid, expired, replayed, or belongs to another account' });
    return res.json(result);
  });
  return router;
}
