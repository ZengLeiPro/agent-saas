import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Router } from 'express';
import { z } from 'zod';

import type { PgAssignmentStore } from '../data/assignments/index.js';
import type { PgEntitlementStore } from '../data/entitlements/index.js';
import { isOrganizationEditableTenantPolicyKey, TENANT_POLICY_KEYS, type TenantPolicyKey } from '../data/entitlements/types.js';
import { governanceDigest } from '../data/governance-audit/index.js';
import type { GovernanceProjectionReconciler, PgGovernanceProjectionOutboxStore } from '../data/governanceProjection/index.js';

const policyShape = {
  expectedVersion: z.number().int().positive(),
  value: z.boolean(),
  reason: z.string().min(3).max(500),
};
const policyPreviewSchema = z.object(policyShape).strict();
const policyCommitSchema = z.object({
  ...policyShape,
  previewId: z.string().regex(/^gpv1\.[a-f0-9]{64}$/),
  baselineDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();

type Persona = 'platform_admin' | 'org_admin' | 'member';

function sign(secret: string, input: Record<string, unknown>): string {
  return createHmac('sha256', secret).update(governanceDigest(input)).digest('hex');
}

function matches(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function registerGovernanceOrganizationAccessRoutes(options: {
  router: Router;
  assignments: PgAssignmentStore;
  entitlements: PgEntitlementStore;
  secret: string;
  previewTtlMs: number;
  now: () => Date;
  personaFor: (req: Request) => Persona | undefined;
  tenantFor: (req: Request, requested?: string) => string | null;
  projectionOutbox?: PgGovernanceProjectionOutboxStore;
  projectionReconciler?: GovernanceProjectionReconciler;
}): void {
  const { router } = options;

  router.post('/policies/:policyKey/preview', async (req, res) => {
    if (options.personaFor(req) !== 'org_admin') return res.status(403).json({ error: 'Organization admin required' });
    const parsed = policyPreviewSchema.safeParse(req.body);
    if (!parsed.success || !(TENANT_POLICY_KEYS as readonly string[]).includes(req.params.policyKey)) {
      return res.status(400).json({ error: 'Invalid request' });
    }
    if (!isOrganizationEditableTenantPolicyKey(req.params.policyKey)) {
      return res.status(403).json({ error: 'Policy is managed by the platform' });
    }
    const tenantId = options.tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const current = (await options.entitlements.getPolicies(tenantId))
      .find(policy => policy.policyKey === req.params.policyKey);
    if (!current || current.version !== parsed.data.expectedVersion) {
      return res.status(409).json({ error: 'Policy baseline changed', code: 'GOVERNANCE_PREVIEW_BASELINE_CONFLICT' });
    }
    const baselineDigest = governanceDigest(current);
    const expiresAt = new Date(options.now().getTime() + options.previewTtlMs).toISOString();
    const signature = {
      version: 1, kind: 'policy', actorUserId: req.user!.sub, tenantId,
      policyKey: req.params.policyKey, baselineDigest, expiresAt,
      changeDigest: governanceDigest(parsed.data),
    };
    return res.json({
      previewId: `gpv1.${sign(options.secret, signature)}`,
      baselineDigest, expiresAt,
      impact: {
        tenantId, policyKey: req.params.policyKey,
        currentVersion: current.version, nextVersion: current.version + 1,
        from: current.value === true ? 'allow' : current.value === false ? 'deny' : 'inherited',
        to: parsed.data.value ? 'allow' : 'deny',
        reversible: true,
        effectiveMode: options.projectionOutbox ? 'source_immediate_projection_pending' : 'source_immediate',
      },
      changeId: res.locals.governanceChangeId,
    });
  });

  router.put('/policies/:policyKey', async (req, res) => {
    if (options.personaFor(req) !== 'org_admin') return res.status(403).json({ error: 'Organization admin required' });
    const parsed = policyCommitSchema.safeParse(req.body);
    if (!parsed.success || !(TENANT_POLICY_KEYS as readonly string[]).includes(req.params.policyKey)) {
      return res.status(400).json({ error: 'Invalid request' });
    }
    if (!isOrganizationEditableTenantPolicyKey(req.params.policyKey)) {
      return res.status(403).json({ error: 'Policy is managed by the platform' });
    }
    const tenantId = options.tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const { previewId, baselineDigest, expiresAt, ...mutation } = parsed.data;
    if (Date.parse(expiresAt) <= options.now().getTime()) {
      return res.status(409).json({ error: 'Governance preview expired', code: 'GOVERNANCE_PREVIEW_EXPIRED' });
    }
    const expectedPreviewId = `gpv1.${sign(options.secret, {
      version: 1, kind: 'policy', actorUserId: req.user!.sub, tenantId,
      policyKey: req.params.policyKey, baselineDigest, expiresAt,
      changeDigest: governanceDigest(mutation),
    })}`;
    const current = (await options.entitlements.getPolicies(tenantId))
      .find(policy => policy.policyKey === req.params.policyKey);
    if (!matches(previewId, expectedPreviewId)) {
      return res.status(409).json({ error: 'Governance preview invalid', code: 'GOVERNANCE_PREVIEW_INVALID' });
    }
    if (!current || current.version !== mutation.expectedVersion || governanceDigest(current) !== baselineDigest) {
      return res.status(409).json({ error: 'Governance baseline changed', code: 'GOVERNANCE_PREVIEW_BASELINE_CONFLICT' });
    }
    try {
      const policy = await options.entitlements.updatePolicy(
        tenantId, req.params.policyKey as TenantPolicyKey,
        mutation.value, mutation.expectedVersion, req.user!.sub,
      );
      let projectionId: string | undefined;
      if (options.projectionOutbox) {
        try {
          const projection = await options.projectionOutbox.enqueue({
            tenantId, projector: 'tenant_settings',
            idempotencyKey: `policy:${policy.policyKey}:${policy.version}`,
            payload: { tenantId, source: 'policy', policyKey: policy.policyKey, version: policy.version },
          });
          projectionId = projection.outboxId;
          void options.projectionReconciler?.reconcileOne();
        } catch {
          return res.status(500).json({
            error: 'Policy 已更新，但兼容投影未能持久化',
            code: 'GOVERNANCE_PROJECTION_NOT_DURABLE', changed: true,
            changeId: res.locals.governanceChangeId,
          });
        }
      }
      return res.json({
        ...policy, changeId: res.locals.governanceChangeId, effectiveAt: policy.updatedAt,
        projectionStatus: options.projectionOutbox ? 'pending' : 'not_configured',
        compatibilityProjection: options.projectionOutbox ? 'applied_with_projection_pending' : 'not_configured',
        ...(projectionId ? { projectionId } : {}),
      });
    } catch (error) {
      return res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
