import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Router } from 'express';
import { z } from 'zod';

import { governanceDigest } from '../data/governance-audit/index.js';
import type { PgOAuthGrantStore } from '../data/oauthGrants/index.js';
import type { OAuthGrant } from '../data/oauthGrants/types.js';

const previewSchema = z.object({ reason: z.string().min(3).max(500) }).strict();
const commitSchema = z.object({
  reason: z.string().min(3).max(500),
  previewId: z.string().regex(/^ogpv1\.[a-f0-9]{64}$/),
  baselineDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();

function sign(secret: string, payload: Record<string, unknown>): string {
  return createHmac('sha256', secret).update(governanceDigest(payload)).digest('hex');
}

function matches(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function baseline(grant: OAuthGrant): Record<string, unknown> {
  return {
    grantId: grant.grantId, tenantId: grant.tenantId, subjectUserId: grant.subjectUserId,
    provider: grant.provider, connectorId: grant.connectorId ?? null,
    status: grant.status, scopeSummary: grant.scopeSummary, version: grant.version,
  };
}

export function registerGovernanceOAuthGrantRoutes(options: {
  router: Router;
  grants: PgOAuthGrantStore;
  secret: string;
  previewTtlMs: number;
  now: () => Date;
  tenantFor: (req: Request) => string | null;
  revokeExternal?: (grant: OAuthGrant, user: NonNullable<Request['user']>) => Promise<void>;
  dependencyImpact?: (grant: OAuthGrant) => Promise<{
    affectedAgents: string[]; affectedAutomations: string[]; brokenReferences: string[]; blockers: string[];
  }>;
}): void {
  options.router.post('/oauth-grants/:grantId/revoke/preview', async (req, res) => {
    const parsed = previewSchema.safeParse(req.body);
    const tenantId = options.tenantFor(req);
    if (!parsed.success || !tenantId) return res.status(400).json({ error: 'Invalid request' });
    if (!options.revokeExternal) return res.status(503).json({ error: 'OAuth revocation authority unavailable' });
    const grant = await options.grants.getForSubject(tenantId, req.user!.sub, req.params.grantId);
    if (!grant) return res.status(404).json({ error: 'OAuth Grant not found' });
    if (grant.status !== 'active' && grant.status !== 'error') return res.status(409).json({ error: 'OAuth Grant is not revocable' });
    if (!options.dependencyImpact) {
      return res.status(503).json({
        error: 'OAuth dependency impact authority unavailable', code: 'DEPENDENCY_IMPACT_AUTHORITY_UNAVAILABLE',
      });
    }
    const impact = await options.dependencyImpact(grant).catch(() => null);
    if (!impact) return res.status(503).json({ error: 'OAuth dependency impact authority unavailable', code: 'DEPENDENCY_IMPACT_AUTHORITY_UNAVAILABLE' });
    const baselineDigest = governanceDigest(baseline(grant));
    const expiresAt = new Date(options.now().getTime() + options.previewTtlMs).toISOString();
    const signature = {
      version: 1, actorUserId: req.user!.sub, tenantId, grantId: grant.grantId,
      reason: parsed.data.reason, baselineDigest, expiresAt,
    };
    return res.json({
      previewId: `ogpv1.${sign(options.secret, signature)}`,
      baselineDigest, expiresAt,
      impact: {
        provider: grant.provider, connectorId: grant.connectorId ?? null, action: 'revoke',
        immediatelyUnavailable: true, newRuns: 'blocked', reversible: false, effectiveMode: 'immediate',
        affectedAgents: impact.affectedAgents, affectedAutomations: impact.affectedAutomations,
        brokenReferences: impact.brokenReferences, blockers: impact.blockers,
        warnings: [], currentVersion: grant.version,
        nextVersion: grant.version + 1,
      },
      changeId: res.locals.governanceChangeId,
    });
  });

  options.router.post('/oauth-grants/:grantId/revoke', async (req, res) => {
    const parsed = commitSchema.safeParse(req.body);
    const tenantId = options.tenantFor(req);
    if (!parsed.success || !tenantId) return res.status(400).json({ error: 'Invalid request' });
    if (!options.revokeExternal) return res.status(503).json({ error: 'OAuth revocation authority unavailable' });
    if (!options.dependencyImpact) return res.status(503).json({ error: 'OAuth dependency impact authority unavailable', code: 'DEPENDENCY_IMPACT_AUTHORITY_UNAVAILABLE' });
    if (Date.parse(parsed.data.expiresAt) <= options.now().getTime()) {
      return res.status(409).json({ error: 'OAuth revocation preview expired', code: 'OAUTH_GRANT_PREVIEW_EXPIRED' });
    }
    const expected = `ogpv1.${sign(options.secret, {
      version: 1, actorUserId: req.user!.sub, tenantId, grantId: req.params.grantId,
      reason: parsed.data.reason, baselineDigest: parsed.data.baselineDigest, expiresAt: parsed.data.expiresAt,
    })}`;
    if (!matches(parsed.data.previewId, expected)) {
      return res.status(409).json({ error: 'OAuth revocation preview invalid', code: 'OAUTH_GRANT_PREVIEW_INVALID' });
    }
    const grant = await options.grants.getForSubject(tenantId, req.user!.sub, req.params.grantId);
    if (!grant || governanceDigest(baseline(grant)) !== parsed.data.baselineDigest) {
      return res.status(409).json({ error: 'OAuth Grant baseline changed', code: 'OAUTH_GRANT_BASELINE_CONFLICT' });
    }
    try {
      if (grant.status === 'error' && grant.revocationStage === 'provider_revoked') {
        const revoked = await options.grants.recordRevocation({
          grantId: grant.grantId, tenantId, subjectUserId: req.user!.sub,
          purpose: parsed.data.reason, actorUserId: req.user!.sub,
        });
        return res.json({ grantId: revoked.grantId, status: revoked.status, version: revoked.version, changeId: res.locals.governanceChangeId });
      }
      if (grant.status === 'error' && grant.revocationStage === 'provider_revoking') {
        return res.status(202).json({
          grantId: grant.grantId, status: grant.status, revocationStage: grant.revocationStage,
          version: grant.version, changeId: res.locals.governanceChangeId, projectionStatus: 'provider_revoking',
        });
      }
      if (grant.status === 'active') {
        await options.grants.markRevocationPending({
          grantId: grant.grantId, tenantId, subjectUserId: req.user!.sub,
          purpose: parsed.data.reason, actorUserId: req.user!.sub,
        });
      }
      await options.grants.markProviderRevoking({ grantId: grant.grantId, tenantId, subjectUserId: req.user!.sub });
      try {
        await options.revokeExternal(grant, req.user!);
      } catch {
        const pending = await options.grants.markRevocationRetry({
          grantId: grant.grantId, tenantId, subjectUserId: req.user!.sub,
          errorCode: 'OAUTH_PROVIDER_REVOKE_FAILED',
        });
        return res.status(202).json({
          grantId: pending.grantId, status: pending.status, revocationStage: pending.revocationStage,
          retryAt: pending.revocationNextRetryAt, version: pending.version,
          changeId: res.locals.governanceChangeId, projectionStatus: 'retry_wait',
        });
      }
      const providerRevoked = await options.grants.markProviderRevoked({
        grantId: grant.grantId, tenantId, subjectUserId: req.user!.sub,
      });
      try {
        const revoked = await options.grants.recordRevocation({
          grantId: grant.grantId, tenantId, subjectUserId: req.user!.sub,
          purpose: parsed.data.reason, actorUserId: req.user!.sub,
        });
        return res.json({ grantId: revoked.grantId, status: revoked.status, version: revoked.version, changeId: res.locals.governanceChangeId });
      } catch {
        return res.status(202).json({
          grantId: providerRevoked.grantId, status: providerRevoked.status,
          revocationStage: providerRevoked.revocationStage, version: providerRevoked.version,
          changeId: res.locals.governanceChangeId, projectionStatus: 'provider_revoked_pending_finalize',
        });
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'OAUTH_REVOCATION_STAGE_CONFLICT') {
        const current = await options.grants.getForSubject(tenantId, req.user!.sub, req.params.grantId);
        if (current?.status === 'error') {
          return res.status(202).json({
            grantId: current.grantId, status: current.status, revocationStage: current.revocationStage,
            retryAt: current.revocationNextRetryAt, version: current.version,
            changeId: res.locals.governanceChangeId, projectionStatus: current.revocationStage ?? 'retry_wait',
          });
        }
      }
      return res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
