import { Router } from 'express';
import { z } from 'zod';

export interface NativeOAuthHandoffPersistence {
  beginNativeHandoff(input: {
    providerState: string; userId: string; tenantId: string; connectorId: string; deviceId: string;
  }): Promise<void>;
  completeNativeHandoff(input: {
    providerState: string; status: 'succeeded' | 'failed'; errorCode?: string;
  }): Promise<string | null>;
  consumeNativeHandoff(input: {
    code: string; userId: string; tenantId: string; deviceId: string;
  }): Promise<{ connectorId: string; status: 'succeeded' | 'failed'; errorCode?: string } | null>;
}

export class NativeOAuthHandoffStore {
  private readonly appLink: string;

  constructor(private readonly persistence: NativeOAuthHandoffPersistence, appLink: string) {
    const parsed = new URL(appLink);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('Native OAuth App Link must be a fixed HTTPS URL without credentials, query, or fragment');
    }
    this.appLink = parsed.toString();
  }

  async begin(input: {
    providerState: string; userId: string; tenantId: string; connectorId: string; deviceId: string;
  }): Promise<void> {
    if (!/^[A-Za-z0-9._:-]{8,200}$/.test(input.deviceId)) throw new Error('Invalid native OAuth deviceId');
    await this.persistence.beginNativeHandoff(input);
  }

  async complete(
    providerState: string,
    result: { status: 'succeeded' | 'failed'; errorCode?: string },
  ): Promise<string | null> {
    const code = await this.persistence.completeNativeHandoff({ providerState, ...result });
    if (!code) return null;
    const target = new URL(this.appLink);
    target.searchParams.set('code', code);
    return target.toString();
  }

  consume(input: { code: string; userId: string; tenantId: string; deviceId: string }) {
    return this.persistence.consumeNativeHandoff(input);
  }
}

const handoffConsumeSchema = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]{48}$/),
  deviceId: z.string().regex(/^[A-Za-z0-9._:-]{8,200}$/),
}).strict();

export function createNativeOAuthHandoffRouter(store: NativeOAuthHandoffStore): Router {
  const router = Router();
  router.post('/oauth/native/handoff', async (req, res) => {
    if (!req.user?.sub || !req.user.tenantId) return res.status(401).json({ error: 'Authentication required' });
    const parsed = handoffConsumeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid native OAuth handoff request' });
    const result = await store.consume({ ...parsed.data, userId: req.user.sub, tenantId: req.user.tenantId });
    if (!result) return res.status(404).json({ error: 'Native OAuth handoff code is invalid or expired' });
    return res.json(result);
  });
  return router;
}
