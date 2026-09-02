import { randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  evaluateCapability,
  type AuthConnectionCapabilityStatus,
  type CapabilityAction,
  type CapabilityChannel,
  type CapabilityObservation,
} from '../../../shared/src/lib/authConnectionCapability.js';
import { auditLog } from '../data/login-logs/index.js';

const querySchema = z.object({
  provider: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/),
  channel: z.enum(['web', 'mobile']),
  operation: z.enum(['auth', 'connection']),
  userId: z.string().max(200).optional(),
  tenantId: z.string().max(200).optional(),
});
const fallbackSchema = querySchema.omit({ userId: true, tenantId: true }).extend({
  action: z.enum(['use_system_browser_sso', 'reauthenticate', 'contact_admin', 'retry_later', 'open_readonly_local_shell']),
  cancelled: z.boolean().optional(),
  correlationId: z.string().min(8).max(200),
});

export interface AuthConnectionCapabilityRouterOptions {
  providerConfigured(provider: string, operation: 'auth' | 'connection'): boolean | Promise<boolean>;
  credentialState?(req: Request, provider: string): CapabilityObservation['credential'] | Promise<CapabilityObservation['credential']>;
  tenantAllowed(req: Request, provider: string, operation: 'auth' | 'connection'): boolean | Promise<boolean>;
  callbackDomainConfigured(channel: CapabilityChannel): boolean;
  ssoAvailable(provider: string): boolean | Promise<boolean>;
  serverDegraded(): boolean;
  now?: () => Date;
}

/** Explicit allowlist: credentials and arbitrary request bodies never enter audit details. */
function safeAuditDetail(status: AuthConnectionCapabilityStatus, event: 'status' | 'fallback', action?: CapabilityAction): string {
  return JSON.stringify({
    schemaVersion: status.schemaVersion, mode: status.mode, reasonCode: status.reasonCode,
    affectedCapabilities: status.affectedCapabilities, allowedActions: status.allowedActions,
    provider: status.subject.provider, channel: status.subject.channel,
    correlationId: status.correlationId, ...(action ? { action } : {}), event,
  });
}

export function createAuthConnectionCapabilityRouter(options: AuthConnectionCapabilityRouterOptions): Router {
  const router = Router();

  async function resolve(req: Request, input: z.infer<typeof querySchema>, correlationId: string = randomUUID()) {
    const observedAt = (options.now?.() ?? new Date()).toISOString();
    return evaluateCapability({
      userId: req.user!.sub, tenantId: req.user!.tenantId, provider: input.provider,
      channel: input.channel, operation: input.operation, observedAt, correlationId,
      providerConfigured: await options.providerConfigured(input.provider, input.operation),
      callbackDomainConfigured: options.callbackDomainConfigured(input.channel),
      ssoAvailable: await options.ssoAvailable(input.provider),
      credential: await options.credentialState?.(req, input.provider) ?? 'not_applicable',
      network: 'online', server: options.serverDegraded() ? 'degraded' : 'healthy',
      tenantAllowed: await options.tenantAllowed(req, input.provider, input.operation),
    });
  }

  router.get('/capabilities/status', async (req, res) => {
    if (!req.user?.sub || !req.user.tenantId) return res.status(401).json({ error: 'Authentication required' });
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid capability query' });
    if ((parsed.data.userId && parsed.data.userId !== req.user.sub)
      || (parsed.data.tenantId && parsed.data.tenantId !== req.user.tenantId)) {
      return res.status(403).json({ error: 'Capability subject boundary mismatch' });
    }
    const status = await resolve(req, parsed.data);
    auditLog(req, status.mode === 'normal' ? 'capability_normal_revalidated' : 'capability_degraded_entered', safeAuditDetail(status, 'status'));
    res.setHeader('Cache-Control', 'no-store');
    return res.json(status);
  });

  router.post('/capabilities/fallback', async (req, res) => {
    if (!req.user?.sub || !req.user.tenantId) return res.status(401).json({ error: 'Authentication required' });
    const parsed = fallbackSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid fallback selection' });
    const status = await resolve(req, parsed.data, parsed.data.correlationId);
    if (parsed.data.cancelled) {
      auditLog(req, 'capability_fallback_cancelled', safeAuditDetail(status, 'fallback'));
      return res.status(204).end();
    }
    if (!status.allowedActions.includes(parsed.data.action)) {
      return res.status(409).json({ error: 'Fallback is not allowed by authoritative capability', status });
    }
    auditLog(req, 'capability_fallback_selected', safeAuditDetail(status, 'fallback', parsed.data.action));
    return res.json({ accepted: true, action: parsed.data.action, status });
  });
  return router;
}
