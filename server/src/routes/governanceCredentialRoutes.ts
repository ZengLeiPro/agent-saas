import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Request, Response, Router } from 'express';
import { z } from 'zod';

import type { PgConnectorCatalogStore } from '../data/connectorCatalog/index.js';
import type { PgCredentialStore } from '../data/credentials/index.js';
import type { GovernanceCredential } from '../data/credentials/types.js';
import { governanceDigest } from '../data/governance-audit/index.js';
import type { PgGovernanceChangeJobStore } from '../data/changeJobs/index.js';
import type { PgMembershipStore } from '../data/memberships/index.js';
import { GLOBAL_OWNER_ID, tenantOwnerId, type SecretVault } from '../security/secretVault.js';
import {
  credentialCreatePreviewSchema, credentialCreateSchema, credentialHealthSchema,
  credentialRotatePreviewSchema, credentialStatusSchema, credentialTransferPreviewSchema,
} from './governanceResourceSchemas.js';

type Persona = 'platform_admin' | 'org_admin' | 'member';

const boundPreviewIdSchema = z.string().regex(
  /^cpv2\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.[a-f0-9]{64}$/,
);
const credentialCommitToken = {
  previewId: boundPreviewIdSchema,
  baselineDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().datetime({ offset: true }),
};
const boundCreateCommitSchema = credentialCreatePreviewSchema.extend(credentialCommitToken).strict();
const boundRotateCommitSchema = credentialRotatePreviewSchema.extend(credentialCommitToken).strict();
const boundTransferCommitSchema = credentialTransferPreviewSchema.extend(credentialCommitToken).strict();
const credentialRevokePreviewSchema = z.object({
  expectedVersion: z.number().int().positive(), reason: z.string().min(3).max(500),
}).strict();
const boundRevokeCommitSchema = credentialRevokePreviewSchema.extend(credentialCommitToken).strict();

function previewBinding(previewId: string): { idempotencyKey: string; nonce: string } {
  const [, idempotencyKey, nonce] = previewId.split('.');
  return { idempotencyKey, nonce };
}

const publicRecoveryBody = (
  code: string,
  diagnosticId: string,
  action: string,
  status = 'reconciliation_required',
) => ({
  error: 'Credential operation requires reconciliation', code, status,
  severity: 'critical', diagnosticId, action,
});

const compensationFailedBody = (operation: 'create' | 'rotate', diagnosticId: string) => ({
  ...publicRecoveryBody(
    `CREDENTIAL_${operation.toUpperCase()}_COMPENSATION_FAILED`, diagnosticId,
    'Contact an administrator and provide the diagnosticId. Do not retry with a new preview until reconciliation completes.',
    'compensation_failed',
  ),
  partial: true, changed: true,
});

function signedPreviewId(
  secret: string,
  payload: Record<string, unknown>,
  binding: { idempotencyKey: string; nonce: string },
): string {
  const signature = createHmac('sha256', secret).update(governanceDigest({ ...payload, ...binding })).digest('hex');
  return `cpv2.${binding.idempotencyKey}.${binding.nonce}.${signature}`;
}


function previewMatches(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function credentialView<T extends { secretRef: string }>(credential: T): Omit<T, 'secretRef'> {
  const { secretRef: _secretRef, ...safe } = credential;
  return safe;
}

export function registerGovernanceCredentialRoutes(options: {
  router: Router;
  connectors: PgConnectorCatalogStore;
  credentials: PgCredentialStore;
  memberships: PgMembershipStore;
  changeJobs: PgGovernanceChangeJobStore;
  vault: SecretVault;
  previewSecret: string;
  now: () => Date;
  personaFor: (req: Request) => Persona | undefined;
  canManageOrganization: (req: Request) => boolean;
  resourceTenantFor: (req: Request, requested?: string) => string | null;
  credentialHealthCheck?: (connectorId: string, secret: string) => Promise<{ healthy: boolean; code: string; metadata?: Record<string, string> }>;
  onPersonalCredentialRevoked?: (input: { credential: GovernanceCredential; actorUserId: string }) => Promise<void>;
}): void {
  const { router } = options;
  const hasActiveOffboarding = async (tenantId: string, userId: string): Promise<boolean> => Boolean(
    await options.changeJobs.findActiveForTarget(tenantId, 'user_offboarding', 'user', userId),
  );
  const validatePersonalSecret = async (connectorId: string | null | undefined, secret: string) => {
    if ((connectorId !== 'aliyun' && connectorId !== 'x') || !options.credentialHealthCheck) return undefined;
    try {
      return await options.credentialHealthCheck(connectorId, secret);
    } catch {
      return { healthy: false, code: 'CONNECTOR_HEALTH_CHECK_FAILED' };
    }
  };

  type ActiveCommit = { leaseToken: string; recovery?: Record<string, unknown> };
  const claimSignedCommit = async (res: Response, input: {
    tenantId: string;
    operation: 'create' | 'rotate' | 'transfer';
    idempotencyKey: string;
    nonce: string;
    requestDigest: string;
    targetId: string;
    actorUserId: string;
    existingOnly?: boolean;
  }): Promise<ActiveCommit | 'missing' | null> => {
    let claim: Awaited<ReturnType<PgCredentialStore['claimCommit']>>;
    try {
      claim = await options.credentials.claimCommit({
        ...input, nonceDigest: governanceDigest(input.nonce),
      });
    } catch {
      res.status(503).json({ error: 'Credential commit authority unavailable', code: 'CREDENTIAL_COMMIT_AUTHORITY_UNAVAILABLE' });
      return null;
    }
    if (claim.state === 'missing') return 'missing';
    if (claim.state === 'acquired') return { leaseToken: claim.leaseToken };
    if (claim.state === 'reconcile') return { leaseToken: claim.leaseToken, recovery: claim.recovery };
    if (claim.state === 'conflict') {
      res.status(409).json({ error: 'Credential idempotency key or nonce was reused for another commit', code: 'CREDENTIAL_IDEMPOTENCY_REUSE_CONFLICT' });
      return null;
    }
    if (claim.state === 'in_progress') {
      res.status(409).json({
        error: 'Credential commit is already in progress', code: 'CREDENTIAL_COMMIT_IN_PROGRESS',
        action: 'Retry the same signed request after the current lease expires.', retryAfterMs: claim.retryAfterMs,
      });
      return null;
    }
    res.status(409).json({
      error: 'Signed credential preview was already consumed', code: 'GOVERNANCE_PREVIEW_REPLAYED',
      commitStatus: claim.state === 'terminal' ? claim.status : 'succeeded',
    });
    return null;
  };
  type SignedCommitInput = Parameters<typeof claimSignedCommit>[1];
  const claimNewSignedCommit = async (res: Response, input: SignedCommitInput): Promise<ActiveCommit | null> => {
    const claim = await claimSignedCommit(res, { ...input, existingOnly: false });
    if (claim !== 'missing') return claim;
    res.status(503).json({ error: 'Credential commit authority unavailable', code: 'CREDENTIAL_COMMIT_AUTHORITY_UNAVAILABLE' });
    return null;
  };

  const recordCommitProgress = (input: Parameters<PgCredentialStore['recordCommitProgress']>[0]) =>
    options.credentials.recordCommitProgress(input);
  const finishCommit = (input: Parameters<PgCredentialStore['finishCommit']>[0]) =>
    options.credentials.finishCommit(input);
  const finishOrCritical = async (
    res: Response,
    input: Parameters<PgCredentialStore['finishCommit']>[0],
    options_: { changed: boolean },
  ): Promise<boolean> => {
    try {
      await finishCommit(input);
      return true;
    } catch (error) {
      const diagnosticId = randomUUID();
      console.error('credential commit ledger finalization failed', {
        diagnosticId, tenantId: input.tenantId, operation: input.operation,
        idempotencyKey: input.idempotencyKey, intendedStatus: input.status,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(503).json({
        ...publicRecoveryBody(
          `CREDENTIAL_${input.operation.toUpperCase()}_LEDGER_WRITE_FAILED`, diagnosticId,
          'Contact an administrator and provide the diagnosticId. Retry only the same signed request after reconciliation.',
        ),
        ...(options_.changed ? { partial: true, changed: true } : {}),
      });
      return false;
    }
  };

  router.post('/credentials/preview', async (req, res) => {
    if (!options.canManageOrganization(req)) return res.status(403).json({ error: 'Organization admin required' });
    const parsed = credentialCreatePreviewSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = options.resourceTenantFor(req, parsed.data.tenantId);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const [connector, custodian] = await Promise.all([
      options.connectors.get(parsed.data.connectorId),
      options.memberships.getMembership(tenantId, parsed.data.custodianUserId ?? req.user!.sub),
    ]);
    if (!connector || connector.status !== 'published') return res.status(409).json({ error: 'Connector unavailable', code: 'CONNECTOR_NOT_PUBLISHED' });
    if (!custodian || custodian.status !== 'active') return res.status(409).json({ error: 'Active in-tenant Credential custodian required', code: 'CREDENTIAL_CUSTODIAN_MEMBERSHIP_REQUIRED' });
    if (await hasActiveOffboarding(tenantId, custodian.userId)) return res.status(409).json({ error: 'Credential custodian offboarding is active', code: 'CREDENTIAL_SUBJECT_OFFBOARDING_ACTIVE' });
    const expiresAt = new Date(options.now().getTime() + 5 * 60_000).toISOString();
    const baselineDigest = governanceDigest({
      connector: { connectorId: connector.connectorId, status: connector.status, version: connector.version },
      custodian: { userId: custodian.userId, status: custodian.status, version: custodian.version },
    });
    const mutation = parsed.data;
    const idempotencyKey = randomUUID();
    const nonce = randomUUID();
    const previewId = signedPreviewId(options.previewSecret, {
      version: 2, kind: 'credential_create', actorUserId: req.user!.sub, tenantId,
      baselineDigest, expiresAt, changeDigest: governanceDigest(mutation),
    }, { idempotencyKey, nonce });
    return res.json({
      previewId, baselineDigest, expiresAt,
      impact: { connectorId: connector.connectorId, connectorVersion: connector.version, custodianUserId: custodian.userId, secretStoredInVault: true },
      changeId: res.locals.governanceChangeId,
    });
  });

  router.post('/credentials', async (req, res) => {
    const commitParsed = boundCreateCommitSchema.safeParse(req.body);
    const baseBody = commitParsed.success
      ? (({
          previewId: _previewId, baselineDigest: _baselineDigest, expiresAt: _expiresAt,
          reason: _reason, ...value
        }) => value)(commitParsed.data)
      : req.body;
    const parsed = credentialCreateSchema.safeParse(baseBody);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = options.resourceTenantFor(req, parsed.data.tenantId);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    if (parsed.data.kind === 'org_shared' && !options.canManageOrganization(req)) return res.status(403).json({ error: 'Admin required' });
    if (parsed.data.kind === 'org_shared' && !commitParsed.success) return res.status(409).json({ error: 'Signed impact preview required', code: 'GOVERNANCE_PREVIEW_REQUIRED' });
    if (parsed.data.kind === 'infrastructure' && options.personaFor(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    const ownerUserId = parsed.data.kind === 'personal_grant' ? req.user!.sub : undefined;
    const custodianUserId = parsed.data.kind === 'org_shared' ? parsed.data.custodianUserId ?? req.user!.sub : undefined;
    const responsibleUserId = ownerUserId ?? custodianUserId;
    let activeCommit: ActiveCommit | undefined;
    let pendingClaim: SignedCommitInput | undefined;
    if (parsed.data.kind === 'org_shared' && commitParsed.success) {
      const { previewId, baselineDigest: signedBaseline, expiresAt, ...mutation } = commitParsed.data;
      const { idempotencyKey, nonce } = previewBinding(previewId);
      const expected = signedPreviewId(options.previewSecret, {
        version: 2, kind: 'credential_create', actorUserId: req.user!.sub, tenantId,
        baselineDigest: signedBaseline, expiresAt, changeDigest: governanceDigest(mutation),
      }, { idempotencyKey, nonce });
      if (!previewMatches(previewId, expected)) {
        return res.status(409).json({ error: 'Governance preview invalid or baseline changed', code: 'GOVERNANCE_PREVIEW_BASELINE_CONFLICT' });
      }
      const claimInput = {
        tenantId, operation: 'create' as const, idempotencyKey, nonce, actorUserId: req.user!.sub,
        targetId: `credential-create:${parsed.data.connectorId}:${custodianUserId}`,
        requestDigest: governanceDigest({ previewId, signedBaseline, expiresAt, changeDigest: governanceDigest(mutation) }),
      };
      const existingClaim = await claimSignedCommit(res, { ...claimInput, existingOnly: true });
      if (!existingClaim) return;
      if (existingClaim === 'missing') {
        if (Date.parse(expiresAt) <= options.now().getTime()) return res.status(409).json({ error: 'Governance preview expired', code: 'GOVERNANCE_PREVIEW_EXPIRED' });
        pendingClaim = claimInput;
      } else {
        activeCommit = existingClaim;
      }
    }
    const [connector, membership] = activeCommit?.recovery
      ? [null, null]
      : await Promise.all([
          options.connectors.get(parsed.data.connectorId),
          responsibleUserId ? options.memberships.getMembership(tenantId, responsibleUserId) : null,
        ]);
    if (!activeCommit?.recovery) {
      if (!connector || connector.status !== 'published') return res.status(409).json({ error: 'Connector unavailable', code: 'CONNECTOR_NOT_PUBLISHED' });
      if (responsibleUserId && (!membership || membership.status !== 'active')) return res.status(409).json({ error: 'Active in-tenant Credential owner/custodian required', code: 'CREDENTIAL_CUSTODIAN_MEMBERSHIP_REQUIRED' });
      if (responsibleUserId && await hasActiveOffboarding(tenantId, responsibleUserId)) return res.status(409).json({ error: 'Credential owner/custodian offboarding is active', code: 'CREDENTIAL_SUBJECT_OFFBOARDING_ACTIVE' });
    }
    if (pendingClaim && commitParsed.success) {
      const currentBaseline = governanceDigest({
        connector: { connectorId: connector!.connectorId, status: connector!.status, version: connector!.version },
        custodian: { userId: membership!.userId, status: membership!.status, version: membership!.version },
      });
      if (currentBaseline !== commitParsed.data.baselineDigest) {
        return res.status(409).json({ error: 'Governance preview invalid or baseline changed', code: 'GOVERNANCE_PREVIEW_BASELINE_CONFLICT' });
      }
      const claimed = await claimNewSignedCommit(res, pendingClaim);
      if (!claimed) return;
      activeCommit = claimed;
    }

    const vaultCaller = { actor: 'connector_proxy' as const, userId: ownerUserId ?? custodianUserId ?? req.user!.sub, tenantId, scopes: ['secret:connector:write'] };
    const vaultOwnerId = parsed.data.kind === 'org_shared' ? tenantOwnerId(tenantId) : parsed.data.kind === 'infrastructure' ? GLOBAL_OWNER_ID : vaultCaller.userId;
    const idempotencyKey = commitParsed.success
      ? previewBinding(commitParsed.data.previewId).idempotencyKey
      : String(res.locals.governanceChangeId ?? 'untracked-create');
    if (activeCommit?.recovery) {
      const recoverySecretRef = typeof activeCommit.recovery.secretRef === 'string'
        ? activeCommit.recovery.secretRef
        : undefined;
      const recoveryCredentialId = typeof activeCommit.recovery.credentialId === 'string'
        ? activeCommit.recovery.credentialId
        : undefined;
      const checkpointCredential = recoveryCredentialId
        ? await options.credentials.get(recoveryCredentialId).catch(() => null)
        : null;
      const existing = checkpointCredential ?? (recoverySecretRef
        ? await options.credentials.getBySecretRef(recoverySecretRef).catch(() => null)
        : null);
      if (existing?.tenantId === tenantId
        && (!recoverySecretRef || existing.secretRef === recoverySecretRef)) {
        if (!await finishOrCritical(res, {
          tenantId, operation: 'create', idempotencyKey, leaseToken: activeCommit.leaseToken,
          status: 'succeeded', credentialId: existing.credentialId,
        }, { changed: true })) return;
        return res.status(409).json({ error: 'Signed credential preview was already consumed', code: 'GOVERNANCE_PREVIEW_REPLAYED', commitStatus: 'succeeded' });
      }
      const canSafelyRetryCompensation = activeCommit.recovery.phase === 'create_failed_compensation_pending';
      let compensationFailed = true;
      if (recoverySecretRef && canSafelyRetryCompensation) {
        try {
          await options.vault.revokeSecret(recoverySecretRef, {
            actor: 'connector_proxy', userId: vaultCaller.userId, tenantId,
            scopes: ['secret:connector:revoke'],
          });
          compensationFailed = false;
        } catch {
          // Keep the durable reconciliation terminal below; never repeat the create side effect.
        }
      }
      const diagnosticId = randomUUID();
      const status = compensationFailed ? 'compensation_failed' : 'failed';
      if (!await finishOrCritical(res, {
        tenantId, operation: 'create', idempotencyKey, leaseToken: activeCommit.leaseToken,
        status,
        errorCode: compensationFailed ? 'CREDENTIAL_CREATE_COMPENSATION_FAILED' : 'CREDENTIAL_CREATE_FAILED',
        manualAction: compensationFailed
          ? { action: 'reconcile_orphaned_secret', secretRef: recoverySecretRef ?? 'unknown', diagnosticId }
          : { action: 'recovered_orphaned_secret', diagnosticId },
      }, { changed: compensationFailed })) return;
      return compensationFailed
        ? res.status(500).json(compensationFailedBody('create', diagnosticId))
        : res.status(409).json({ error: 'Credential creation was safely reconciled', code: 'CREDENTIAL_CREATE_FAILED', status: 'failed' });
    }
    let healthMetadata: Record<string, string> | undefined;
    if (parsed.data.kind === 'personal_grant') {
      const health = await validatePersonalSecret(parsed.data.connectorId, parsed.data.secret);
      if (health && !health.healthy) return res.status(422).json({ error: 'Credential validation failed', code: health.code });
      healthMetadata = health?.metadata;
    }
    let secretRef: string | undefined;
    try {
      const secret = await options.vault.putSecret(vaultOwnerId, 'connector', parsed.data.secret, vaultCaller, { connectorId: parsed.data.connectorId, tenantId, credentialOwnerId: vaultCaller.userId });
      secretRef = secret.id;
      if (activeCommit) await recordCommitProgress({
        tenantId, operation: 'create', idempotencyKey, leaseToken: activeCommit.leaseToken,
        progress: { phase: 'vault_written', secretRef },
      });
    } catch (error) {
      if (secretRef) {
        try {
          await options.vault.revokeSecret(secretRef, {
            actor: 'connector_proxy', userId: vaultCaller.userId, tenantId,
            scopes: ['secret:connector:revoke'],
          });
        } catch {
          const diagnosticId = randomUUID();
          if (activeCommit && !await finishOrCritical(res, {
            tenantId, operation: 'create', idempotencyKey, leaseToken: activeCommit.leaseToken,
            status: 'compensation_failed', errorCode: 'CREDENTIAL_CREATE_COMPENSATION_FAILED',
            manualAction: { action: 'revoke_orphaned_secret', secretRef, diagnosticId },
          }, { changed: true })) return;
          return res.status(500).json(compensationFailedBody('create', diagnosticId));
        }
      }
      if (activeCommit && !await finishOrCritical(res, {
        tenantId, operation: 'create', idempotencyKey, leaseToken: activeCommit.leaseToken,
        status: 'failed', errorCode: 'CREDENTIAL_VAULT_WRITE_FAILED',
      }, { changed: false })) return;
      console.error('credential vault write or progress checkpoint failed', {
        tenantId, operation: 'create', idempotencyKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return res.status(409).json({ error: 'Credential vault write failed', code: 'CREDENTIAL_VAULT_WRITE_FAILED' });
    }

    let credential: Awaited<ReturnType<PgCredentialStore['create']>>;
    try {
      credential = await options.credentials.create({
        tenantId, connectorId: parsed.data.connectorId, kind: parsed.data.kind,
        ...(ownerUserId ? { ownerUserId } : {}), ...(custodianUserId ? { custodianUserId } : {}),
        ...(parsed.data.alias ? { alias: parsed.data.alias } : {}), purpose: parsed.data.purpose,
        scopeSummary: { ...(parsed.data.scopeSummary ?? {}), ...(healthMetadata ?? {}) }, secretRef,
        ...(parsed.data.expiresAt ? { expiresAt: parsed.data.expiresAt } : {}), createdBy: req.user!.sub,
      });
    } catch {
      if (activeCommit) {
        try {
          await recordCommitProgress({
            tenantId, operation: 'create', idempotencyKey, leaseToken: activeCommit.leaseToken,
            progress: { phase: 'create_failed_compensation_pending', secretRef },
          });
        } catch (error) {
          console.error('credential compensation checkpoint failed', {
            tenantId, operation: 'create', idempotencyKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      try {
        await options.vault.revokeSecret(secretRef, { actor: 'connector_proxy', userId: vaultCaller.userId, tenantId, scopes: ['secret:connector:revoke'] });
      } catch {
        const diagnosticId = randomUUID();
        if (activeCommit && !await finishOrCritical(res, {
          tenantId, operation: 'create', idempotencyKey, leaseToken: activeCommit.leaseToken,
          status: 'compensation_failed', errorCode: 'CREDENTIAL_CREATE_COMPENSATION_FAILED',
          manualAction: { action: 'revoke_orphaned_secret', secretRef, connectorId: parsed.data.connectorId, diagnosticId },
        }, { changed: true })) return;
        return res.status(500).json(compensationFailedBody('create', diagnosticId));
      }
      if (activeCommit && !await finishOrCritical(res, {
        tenantId, operation: 'create', idempotencyKey, leaseToken: activeCommit.leaseToken,
        status: 'failed', errorCode: 'CREDENTIAL_CREATE_FAILED',
      }, { changed: false })) return;
      return res.status(409).json({ error: 'Credential creation failed and the vault write was revoked', code: 'CREDENTIAL_CREATE_FAILED', status: 'failed' });
    }

    if (activeCommit) {
      try {
        await recordCommitProgress({
          tenantId, operation: 'create', idempotencyKey, leaseToken: activeCommit.leaseToken,
          progress: { phase: 'credential_created', secretRef, credentialId: credential.credentialId },
        });
      } catch (error) {
        console.error('credential commit progress checkpoint failed after create', {
          tenantId, operation: 'create', idempotencyKey, credentialId: credential.credentialId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (!await finishOrCritical(res, {
        tenantId, operation: 'create', idempotencyKey, leaseToken: activeCommit.leaseToken,
        status: 'succeeded', credentialId: credential.credentialId,
      }, { changed: true })) return;
    }
    return res.status(201).json(credentialView(credential));
  });

  router.patch('/credentials/:credentialId/status', async (req, res) => {
    const parsed = credentialStatusSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = options.resourceTenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const current = await options.credentials.get(req.params.credentialId);
    if (!current || current.tenantId !== tenantId) return res.status(404).json({ error: 'Credential not found' });
    if (current.kind === 'personal_grant' && current.ownerUserId !== req.user!.sub) return res.status(404).json({ error: 'Credential not found' });
    if (current.kind === 'org_shared' && !options.canManageOrganization(req)) return res.status(403).json({ error: 'Organization admin required' });
    if (current.kind === 'infrastructure' && options.personaFor(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    if (parsed.data.status === 'suspended' || parsed.data.status === 'revoked') {
      return res.status(409).json({ error: 'Signed impact preview required', code: 'GOVERNANCE_PREVIEW_REQUIRED' });
    }
    try {
      const credential = await options.credentials.updateStatus(current.credentialId, {
        status: parsed.data.status, expectedVersion: parsed.data.expectedVersion,
        updatedBy: req.user!.sub, updateReason: parsed.data.reason,
      });
      res.json(credentialView(credential));
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  const credentialForOrganizationAdmin = async (req: Request, credentialId: string) => {
    const tenantId = options.resourceTenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId || !options.canManageOrganization(req)) return null;
    const credential = await options.credentials.get(credentialId);
    return credential?.tenantId === tenantId && credential.kind === 'org_shared' ? { tenantId, credential } : null;
  };

  const credentialForRotation = async (req: Request, credentialId: string) => {
    const tenantId = options.resourceTenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return null;
    const credential = await options.credentials.get(credentialId);
    if (!credential || credential.tenantId !== tenantId) return null;
    const isOrganizationCredential = credential.kind === 'org_shared' && options.canManageOrganization(req);
    const isPersonalCredential = credential.kind === 'personal_grant' && credential.ownerUserId === req.user!.sub;
    return isOrganizationCredential || isPersonalCredential ? { tenantId, credential } : null;
  };

  const credentialForPersonalOwner = async (req: Request, credentialId: string) => {
    const tenantId = options.resourceTenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return null;
    const credential = await options.credentials.get(credentialId);
    return credential?.tenantId === tenantId
      && credential.kind === 'personal_grant'
      && credential.ownerUserId === req.user!.sub
      ? { tenantId, credential }
      : null;
  };

  router.post('/credentials/:credentialId/revoke/preview', async (req, res) => {
    const target = await credentialForPersonalOwner(req, req.params.credentialId);
    if (!target) return res.status(404).json({ error: 'Credential not found' });
    const parsed = credentialRevokePreviewSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    if (target.credential.version !== parsed.data.expectedVersion) {
      return res.status(409).json({ error: 'Credential baseline changed', code: 'GOVERNANCE_PREVIEW_BASELINE_CONFLICT' });
    }
    const baselineDigest = governanceDigest(credentialView(target.credential));
    const expiresAt = new Date(options.now().getTime() + 5 * 60_000).toISOString();
    const idempotencyKey = randomUUID();
    const nonce = randomUUID();
    const previewId = signedPreviewId(options.previewSecret, {
      version: 2, kind: 'credential_revoke', actorUserId: req.user!.sub, tenantId: target.tenantId,
      credentialId: target.credential.credentialId,
      baselineDigest, expiresAt, changeDigest: governanceDigest(parsed.data),
    }, { idempotencyKey, nonce });
    return res.json({
      previewId, baselineDigest, expiresAt,
      impact: {
        connectorId: target.credential.connectorId ?? null,
        immediatelyUnavailable: true,
        secretWillBeRevoked: true,
        cleanupRetry: target.credential.status === 'revoked',
        currentVersion: target.credential.version,
        nextVersion: target.credential.status === 'revoked' ? target.credential.version : target.credential.version + 1,
      },
      changeId: res.locals.governanceChangeId,
    });
  });

  router.post('/credentials/:credentialId/revoke', async (req, res) => {
    const target = await credentialForPersonalOwner(req, req.params.credentialId);
    if (!target) return res.status(404).json({ error: 'Credential not found' });
    const parsed = boundRevokeCommitSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const { previewId, baselineDigest, expiresAt, ...mutation } = parsed.data;
    if (Date.parse(expiresAt) <= options.now().getTime()) {
      return res.status(409).json({ error: 'Governance preview expired', code: 'GOVERNANCE_PREVIEW_EXPIRED' });
    }
    const { idempotencyKey, nonce } = previewBinding(previewId);
    const expected = signedPreviewId(options.previewSecret, {
      version: 2, kind: 'credential_revoke', actorUserId: req.user!.sub, tenantId: target.tenantId,
      credentialId: target.credential.credentialId,
      baselineDigest, expiresAt, changeDigest: governanceDigest(mutation),
    }, { idempotencyKey, nonce });
    if (!previewMatches(previewId, expected)) {
      return res.status(409).json({ error: 'Governance preview invalid or baseline changed', code: 'GOVERNANCE_PREVIEW_BASELINE_CONFLICT' });
    }
    if (target.credential.version !== mutation.expectedVersion
      || governanceDigest(credentialView(target.credential)) !== baselineDigest) {
      return res.status(409).json({ error: 'Governance preview invalid or baseline changed', code: 'GOVERNANCE_PREVIEW_BASELINE_CONFLICT' });
    }

    const alreadyRevoked = target.credential.status === 'revoked';
    let vaultRevoked = false;
    try {
      await options.vault.revokeSecret(target.credential.secretRef, {
        actor: 'connector_proxy', userId: target.credential.ownerUserId ?? req.user!.sub,
        tenantId: target.tenantId, scopes: ['secret:connector:revoke'],
      });
      vaultRevoked = true;
    } catch (error) {
      console.error('credential vault revoke failed before governance status update', {
        credentialId: target.credential.credentialId,
        tenantId: target.tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return res.status(503).json({
        error: 'SecretVault 清理失败，Credential 状态保持可重试',
        code: 'CREDENTIAL_VAULT_REVOKE_FAILED', changed: false, retryable: true,
        credential: credentialView(target.credential),
      });
    }
    if (options.onPersonalCredentialRevoked) {
      try {
        await options.onPersonalCredentialRevoked({ credential: target.credential, actorUserId: req.user!.sub });
      } catch (error) {
        console.error('legacy personal credential cleanup failed before governance status update', {
          credentialId: target.credential.credentialId,
          tenantId: target.tenantId,
          error: error instanceof Error ? error.message : String(error),
        });
        return res.status(503).json({
          error: '旧连接器凭据清理失败，Credential 状态保持可重试',
          code: 'CREDENTIAL_LEGACY_CLEANUP_FAILED', changed: vaultRevoked, retryable: true,
          credential: credentialView(target.credential),
        });
      }
    }

    let credential: Awaited<ReturnType<PgCredentialStore['updateStatus']>> = target.credential;
    if (!alreadyRevoked) {
      try {
        credential = await options.credentials.updateStatus(target.credential.credentialId, {
          status: 'revoked', expectedVersion: mutation.expectedVersion,
          updatedBy: req.user!.sub, updateReason: mutation.reason,
        });
      } catch (error) {
        console.error('credential revoke status persistence failed after cleanup', {
          credentialId: target.credential.credentialId,
          tenantId: target.tenantId,
          error: error instanceof Error ? error.message : String(error),
        });
        return res.status(503).json({
          error: 'Credential 清理完成但状态写入失败，请稍后重试',
          code: 'CREDENTIAL_REVOKE_PERSIST_FAILED', changed: true, retryable: true,
          credential: credentialView(target.credential),
        });
      }
    }
    return res.json({ ...credentialView(credential), changeId: res.locals.governanceChangeId, effectiveAt: credential.updatedAt });
  });

  router.post('/credentials/:credentialId/rotate/preview', async (req, res) => {
    const target = await credentialForRotation(req, req.params.credentialId);
    if (!target) return res.status(404).json({ error: 'Credential not found' });
    const parsed = credentialRotatePreviewSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    if (target.credential.version !== parsed.data.expectedVersion || target.credential.status === 'revoked') return res.status(409).json({ error: 'Credential baseline changed', code: 'GOVERNANCE_PREVIEW_BASELINE_CONFLICT' });
    const baselineDigest = governanceDigest(credentialView(target.credential));
    const expiresAt = new Date(options.now().getTime() + 5 * 60_000).toISOString();
    const idempotencyKey = randomUUID();
    const nonce = randomUUID();
    const previewId = signedPreviewId(options.previewSecret, {
      version: 2, kind: 'credential_rotate', actorUserId: req.user!.sub, tenantId: target.tenantId,
      credentialId: target.credential.credentialId,
      baselineDigest, expiresAt, changeDigest: governanceDigest(parsed.data),
    }, { idempotencyKey, nonce });
    return res.json({
      previewId, baselineDigest, expiresAt,
      impact: { currentGeneration: target.credential.generation, nextGeneration: target.credential.generation + 1, secretWillNotBeReturned: true },
      changeId: res.locals.governanceChangeId,
    });
  });

  router.post('/credentials/:credentialId/rotate', async (req, res) => {
    const target = await credentialForRotation(req, req.params.credentialId);
    if (!target) return res.status(404).json({ error: 'Credential not found' });
    const parsed = boundRotateCommitSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const { previewId, baselineDigest, expiresAt, ...mutation } = parsed.data;
    const { idempotencyKey, nonce } = previewBinding(previewId);
    const expected = signedPreviewId(options.previewSecret, {
      version: 2, kind: 'credential_rotate', actorUserId: req.user!.sub, tenantId: target.tenantId,
      credentialId: target.credential.credentialId,
      baselineDigest, expiresAt, changeDigest: governanceDigest(mutation),
    }, { idempotencyKey, nonce });
    if (!previewMatches(previewId, expected)) {
      return res.status(409).json({ error: 'Governance preview invalid or baseline changed', code: 'GOVERNANCE_PREVIEW_BASELINE_CONFLICT' });
    }
    const claimInput = {
      tenantId: target.tenantId, operation: 'rotate' as const, idempotencyKey, nonce, actorUserId: req.user!.sub,
      targetId: target.credential.credentialId,
      requestDigest: governanceDigest({ previewId, baselineDigest, expiresAt, changeDigest: governanceDigest(mutation) }),
    };
    const existingClaim = await claimSignedCommit(res, { ...claimInput, existingOnly: true });
    if (!existingClaim) return;
    if (existingClaim === 'missing' && Date.parse(expiresAt) <= options.now().getTime()) {
      return res.status(409).json({ error: 'Governance preview expired', code: 'GOVERNANCE_PREVIEW_EXPIRED' });
    }
    const claimed = existingClaim === 'missing'
      ? await claimNewSignedCommit(res, claimInput)
      : existingClaim;
    if (!claimed) return;
    if (claimed.recovery) {
      const checkpointCompleted = claimed.recovery.phase === 'credential_rotated'
        && claimed.recovery.credentialId === target.credential.credentialId;
      const actualCompleted = claimed.recovery.credentialId === target.credential.credentialId
        && typeof claimed.recovery.expectedGeneration === 'number'
        && target.credential.generation > claimed.recovery.expectedGeneration;
      if (checkpointCompleted || actualCompleted) {
        if (!await finishOrCritical(res, {
          tenantId: target.tenantId, operation: 'rotate', idempotencyKey,
          leaseToken: claimed.leaseToken, status: 'succeeded', credentialId: target.credential.credentialId,
        }, { changed: true })) return;
        return res.status(409).json({ error: 'Signed credential preview was already consumed', code: 'GOVERNANCE_PREVIEW_REPLAYED', commitStatus: 'succeeded' });
      }
      const diagnosticId = randomUUID();
      if (!await finishOrCritical(res, {
        tenantId: target.tenantId, operation: 'rotate', idempotencyKey,
        leaseToken: claimed.leaseToken, status: 'compensation_failed',
        errorCode: 'CREDENTIAL_ROTATE_COMPENSATION_FAILED',
        manualAction: {
          action: 'reconcile_vault_and_generation', credentialId: target.credential.credentialId,
          secretRef: target.credential.secretRef, diagnosticId, recoveryPhase: claimed.recovery.phase ?? 'unknown',
        },
      }, { changed: true })) return;
      return res.status(500).json(compensationFailedBody('rotate', diagnosticId));
    }
    const currentBaseline = governanceDigest(credentialView(target.credential));
    if (baselineDigest !== currentBaseline || target.credential.version !== mutation.expectedVersion) {
      if (!await finishOrCritical(res, {
        tenantId: target.tenantId, operation: 'rotate', idempotencyKey,
        leaseToken: claimed.leaseToken, status: 'failed', errorCode: 'GOVERNANCE_PREVIEW_BASELINE_CONFLICT',
      }, { changed: false })) return;
      return res.status(409).json({ error: 'Governance preview invalid or baseline changed', code: 'GOVERNANCE_PREVIEW_BASELINE_CONFLICT' });
    }
    let rotationScopeSummary = mutation.scopeSummary
      ? { ...target.credential.scopeSummary, ...mutation.scopeSummary }
      : undefined;
    if (target.credential.kind === 'personal_grant') {
      const health = await validatePersonalSecret(target.credential.connectorId, mutation.secret);
      if (health && !health.healthy) {
        if (!await finishOrCritical(res, {
          tenantId: target.tenantId, operation: 'rotate', idempotencyKey,
          leaseToken: claimed.leaseToken, status: 'failed', errorCode: health.code,
        }, { changed: false })) return;
        return res.status(422).json({ error: 'Credential validation failed', code: health.code });
      }
      if (health?.metadata) {
        rotationScopeSummary = { ...target.credential.scopeSummary, ...(mutation.scopeSummary ?? {}), ...health.metadata };
        for (const key of ['regionId', 'accountId', 'identityArn', 'identityType'] as const) {
          if (!(key in health.metadata)) delete rotationScopeSummary[key];
        }
      }
    }

    const caller = {
      actor: 'connector_proxy' as const,
      userId: target.credential.ownerUserId ?? target.credential.custodianUserId ?? req.user!.sub,
      tenantId: target.tenantId,
      scopes: ['secret:connector:read', 'secret:connector:rotate'],
    };
    let previousSecret: string;
    let vaultRotated = false;
    try {
      previousSecret = await options.vault.getSecret(target.credential.secretRef, caller);
      await options.vault.rotateSecret(target.credential.secretRef, mutation.secret, caller);
      vaultRotated = true;
      await recordCommitProgress({
        tenantId: target.tenantId, operation: 'rotate', idempotencyKey,
        leaseToken: claimed.leaseToken,
        progress: {
          phase: 'vault_rotated', credentialId: target.credential.credentialId,
          secretRef: target.credential.secretRef, expectedVersion: mutation.expectedVersion,
          expectedGeneration: target.credential.generation,
        },
      });
    } catch (error) {
      if (vaultRotated) {
        try {
          await options.vault.rotateSecret(target.credential.secretRef, previousSecret!, caller);
        } catch {
          const diagnosticId = randomUUID();
          if (!await finishOrCritical(res, {
            tenantId: target.tenantId, operation: 'rotate', idempotencyKey,
            leaseToken: claimed.leaseToken, status: 'compensation_failed',
            errorCode: 'CREDENTIAL_ROTATE_COMPENSATION_FAILED',
            manualAction: {
              action: 'reconcile_vault_and_generation', credentialId: target.credential.credentialId,
              secretRef: target.credential.secretRef, diagnosticId,
            },
          }, { changed: true })) return;
          return res.status(500).json(compensationFailedBody('rotate', diagnosticId));
        }
      }
      if (!await finishOrCritical(res, {
        tenantId: target.tenantId, operation: 'rotate', idempotencyKey,
        leaseToken: claimed.leaseToken, status: 'failed', errorCode: 'CREDENTIAL_ROTATE_VAULT_FAILED',
      }, { changed: false })) return;
      console.error('credential vault rotation or progress checkpoint failed', {
        tenantId: target.tenantId, operation: 'rotate', idempotencyKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return res.status(409).json({ error: 'Credential vault rotation failed', code: 'CREDENTIAL_ROTATE_VAULT_FAILED', status: 'failed' });
    }

    let credential: Awaited<ReturnType<PgCredentialStore['completeRotation']>>;
    try {
      const shouldClearExpiredAt = Boolean(
        target.credential.expiresAt && Date.parse(target.credential.expiresAt) <= options.now().getTime(),
      );
      credential = rotationScopeSummary
        ? await options.credentials.completeRotation(
          target.tenantId, target.credential.credentialId, mutation.expectedVersion, req.user!.sub,
          shouldClearExpiredAt, rotationScopeSummary,
        )
        : await options.credentials.completeRotation(
          target.tenantId, target.credential.credentialId, mutation.expectedVersion, req.user!.sub, shouldClearExpiredAt,
        );
    } catch {
      try {
        await options.vault.rotateSecret(target.credential.secretRef, previousSecret, caller);
      } catch {
        const diagnosticId = randomUUID();
        if (!await finishOrCritical(res, {
          tenantId: target.tenantId, operation: 'rotate', idempotencyKey,
          leaseToken: claimed.leaseToken, status: 'compensation_failed',
          errorCode: 'CREDENTIAL_ROTATE_COMPENSATION_FAILED',
          manualAction: {
            action: 'reconcile_vault_and_generation', credentialId: target.credential.credentialId,
            secretRef: target.credential.secretRef, diagnosticId,
          },
        }, { changed: true })) return;
        return res.status(500).json(compensationFailedBody('rotate', diagnosticId));
      }
      if (!await finishOrCritical(res, {
        tenantId: target.tenantId, operation: 'rotate', idempotencyKey,
        leaseToken: claimed.leaseToken, status: 'failed', errorCode: 'CREDENTIAL_ROTATE_PERSIST_FAILED',
      }, { changed: false })) return;
      return res.status(409).json({ error: 'Credential rotation was compensated after persistence failed', code: 'CREDENTIAL_ROTATE_COMPENSATED', status: 'failed' });
    }

    try {
      await recordCommitProgress({
        tenantId: target.tenantId, operation: 'rotate', idempotencyKey,
        leaseToken: claimed.leaseToken,
        progress: {
          phase: 'credential_rotated', credentialId: credential.credentialId,
          secretRef: target.credential.secretRef, expectedVersion: mutation.expectedVersion,
          expectedGeneration: target.credential.generation,
          resultingVersion: credential.version, resultingGeneration: credential.generation,
        },
      });
    } catch (error) {
      console.error('credential commit progress checkpoint failed after rotate', {
        tenantId: target.tenantId, operation: 'rotate', idempotencyKey,
        credentialId: credential.credentialId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (!await finishOrCritical(res, {
      tenantId: target.tenantId, operation: 'rotate', idempotencyKey,
      leaseToken: claimed.leaseToken, status: 'succeeded', credentialId: credential.credentialId,
    }, { changed: true })) return;
    return res.json({ ...credentialView(credential), changeId: res.locals.governanceChangeId, effectiveAt: credential.updatedAt });
  });

  router.post('/credentials/:credentialId/transfer/preview', async (req, res) => {
    const target = await credentialForOrganizationAdmin(req, req.params.credentialId);
    if (!target) return res.status(404).json({ error: 'Credential not found' });
    const parsed = credentialTransferPreviewSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const custodian = await options.memberships.getMembership(target.tenantId, parsed.data.custodianUserId);
    if (!custodian || custodian.status !== 'active' || await hasActiveOffboarding(target.tenantId, custodian.userId)) return res.status(409).json({ error: 'Active in-tenant Credential custodian required', code: 'CREDENTIAL_CUSTODIAN_MEMBERSHIP_REQUIRED' });
    if (target.credential.version !== parsed.data.expectedVersion || target.credential.status === 'revoked') return res.status(409).json({ error: 'Credential baseline changed', code: 'GOVERNANCE_PREVIEW_BASELINE_CONFLICT' });
    const baselineDigest = governanceDigest({ credential: credentialView(target.credential), custodian: { userId: custodian.userId, version: custodian.version, status: custodian.status } });
    const expiresAt = new Date(options.now().getTime() + 5 * 60_000).toISOString();
    const idempotencyKey = randomUUID();
    const nonce = randomUUID();
    const previewId = signedPreviewId(options.previewSecret, {
      version: 2, kind: 'credential_transfer', actorUserId: req.user!.sub, tenantId: target.tenantId,
      credentialId: target.credential.credentialId,
      baselineDigest, expiresAt, changeDigest: governanceDigest(parsed.data),
    }, { idempotencyKey, nonce });
    return res.json({
      previewId, baselineDigest, expiresAt,
      impact: { fromCustodianUserId: target.credential.custodianUserId, toCustodianUserId: custodian.userId },
      changeId: res.locals.governanceChangeId,
    });
  });

  router.post('/credentials/:credentialId/transfer', async (req, res) => {
    const target = await credentialForOrganizationAdmin(req, req.params.credentialId);
    if (!target) return res.status(404).json({ error: 'Credential not found' });
    const parsed = boundTransferCommitSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const { previewId, baselineDigest, expiresAt, ...mutation } = parsed.data;
    const { idempotencyKey, nonce } = previewBinding(previewId);
    const expected = signedPreviewId(options.previewSecret, {
      version: 2, kind: 'credential_transfer', actorUserId: req.user!.sub, tenantId: target.tenantId,
      credentialId: target.credential.credentialId,
      baselineDigest, expiresAt, changeDigest: governanceDigest(mutation),
    }, { idempotencyKey, nonce });
    if (!previewMatches(previewId, expected)) return res.status(409).json({ error: 'Governance preview invalid or baseline changed', code: 'GOVERNANCE_PREVIEW_BASELINE_CONFLICT' });
    const claimInput = {
      tenantId: target.tenantId, operation: 'transfer' as const, idempotencyKey, nonce, actorUserId: req.user!.sub,
      targetId: target.credential.credentialId,
      requestDigest: governanceDigest({ previewId, baselineDigest, expiresAt, changeDigest: governanceDigest(mutation) }),
    };
    const existingClaim = await claimSignedCommit(res, { ...claimInput, existingOnly: true });
    if (!existingClaim) return;
    if (existingClaim === 'missing' && Date.parse(expiresAt) <= options.now().getTime()) {
      return res.status(409).json({ error: 'Governance preview expired', code: 'GOVERNANCE_PREVIEW_EXPIRED' });
    }
    const custodian = existingClaim === 'missing'
      ? await options.memberships.getMembership(target.tenantId, mutation.custodianUserId)
      : null;
    if (existingClaim === 'missing'
      && (!custodian || custodian.status !== 'active' || await hasActiveOffboarding(target.tenantId, custodian.userId))) {
      return res.status(409).json({ error: 'Active in-tenant Credential custodian required', code: 'CREDENTIAL_CUSTODIAN_MEMBERSHIP_REQUIRED' });
    }
    const currentBaseline = custodian && governanceDigest({ credential: credentialView(target.credential), custodian: { userId: custodian.userId, version: custodian.version, status: custodian.status } });
    if (existingClaim === 'missing'
      && (baselineDigest !== currentBaseline || target.credential.version !== mutation.expectedVersion)) {
      return res.status(409).json({ error: 'Governance preview invalid or baseline changed', code: 'GOVERNANCE_PREVIEW_BASELINE_CONFLICT' });
    }
    const claimed = existingClaim === 'missing'
      ? await claimNewSignedCommit(res, claimInput)
      : existingClaim;
    if (!claimed) return;
    if (claimed.recovery) {
      const checkpointCompleted = claimed.recovery.phase === 'credential_transferred'
        && claimed.recovery.credentialId === target.credential.credentialId
        && claimed.recovery.custodianUserId === mutation.custodianUserId;
      const actualCompleted = target.credential.custodianUserId === mutation.custodianUserId
        && target.credential.version > mutation.expectedVersion;
      if (checkpointCompleted || actualCompleted) {
        if (!await finishOrCritical(res, {
          tenantId: target.tenantId, operation: 'transfer', idempotencyKey,
          leaseToken: claimed.leaseToken, status: 'succeeded', credentialId: target.credential.credentialId,
        }, { changed: true })) return;
        return res.status(409).json({ error: 'Signed credential preview was already consumed', code: 'GOVERNANCE_PREVIEW_REPLAYED', commitStatus: 'succeeded' });
      }
      const diagnosticId = randomUUID();
      if (!await finishOrCritical(res, {
        tenantId: target.tenantId, operation: 'transfer', idempotencyKey,
        leaseToken: claimed.leaseToken, status: 'partial', errorCode: 'CREDENTIAL_TRANSFER_RECONCILIATION_REQUIRED',
        manualAction: { action: 'verify_credential_custodian', credentialId: target.credential.credentialId, diagnosticId },
      }, { changed: true })) return;
      return res.status(409).json(publicRecoveryBody(
        'CREDENTIAL_TRANSFER_RECONCILIATION_REQUIRED', diagnosticId,
        'Contact an administrator and provide the diagnosticId. The transfer will not be repeated automatically.',
      ));
    }
    let credential: Awaited<ReturnType<PgCredentialStore['transferCustodian']>>;
    try {
      credential = await options.credentials.transferCustodian(target.tenantId, target.credential.credentialId, mutation.expectedVersion, mutation.custodianUserId, req.user!.sub);
    } catch {
      if (!await finishOrCritical(res, {
        tenantId: target.tenantId, operation: 'transfer', idempotencyKey,
        leaseToken: claimed.leaseToken, status: 'failed', errorCode: 'CREDENTIAL_TRANSFER_FAILED',
      }, { changed: false })) return;
      return res.status(409).json({ error: 'Credential transfer failed', code: 'CREDENTIAL_TRANSFER_FAILED', status: 'failed' });
    }
    try {
      await recordCommitProgress({
        tenantId: target.tenantId, operation: 'transfer', idempotencyKey,
        leaseToken: claimed.leaseToken,
        progress: {
          phase: 'credential_transferred', credentialId: credential.credentialId,
          fromCustodianUserId: target.credential.custodianUserId,
          custodianUserId: mutation.custodianUserId,
          expectedVersion: mutation.expectedVersion, resultingVersion: credential.version,
        },
      });
    } catch (error) {
      console.error('credential commit progress checkpoint failed after transfer', {
        tenantId: target.tenantId, operation: 'transfer', idempotencyKey,
        credentialId: credential.credentialId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (!await finishOrCritical(res, {
      tenantId: target.tenantId, operation: 'transfer', idempotencyKey,
      leaseToken: claimed.leaseToken, status: 'succeeded', credentialId: credential.credentialId,
    }, { changed: true })) return;
    return res.json({ ...credentialView(credential), changeId: res.locals.governanceChangeId, effectiveAt: credential.updatedAt });
  });

  router.post('/credentials/:credentialId/health-test', async (req, res) => {
    const target = await credentialForOrganizationAdmin(req, req.params.credentialId);
    if (!target) return res.status(404).json({ error: 'Credential not found' });
    const parsed = credentialHealthSchema.safeParse(req.body);
    if (!parsed.success || target.credential.version !== parsed.data.expectedVersion) return res.status(409).json({ error: 'Credential baseline changed', code: 'CREDENTIAL_VERSION_CONFLICT' });
    if (!target.credential.connectorId || !options.credentialHealthCheck) return res.status(503).json({ error: 'Connector health authority unavailable', code: 'CONNECTOR_HEALTH_AUTHORITY_UNAVAILABLE' });
    const caller = { actor: 'connector_proxy' as const, userId: target.credential.custodianUserId ?? req.user!.sub, tenantId: target.tenantId, scopes: ['secret:connector:read'] };
    try {
      const secret = await options.vault.getSecret(target.credential.secretRef, caller);
      const health = await options.credentialHealthCheck(target.credential.connectorId, secret);
      const credential = await options.credentials.recordValidation(target.tenantId, target.credential.credentialId, parsed.data.expectedVersion, health.healthy, req.user!.sub);
      return res.status(health.healthy ? 200 : 422).json({ healthy: health.healthy, code: health.code, credential: credentialView(credential), changeId: res.locals.governanceChangeId, effectiveAt: credential.updatedAt });
    } catch (error) {
      return res.status(503).json({ error: error instanceof Error ? error.message : String(error), code: 'CONNECTOR_HEALTH_CHECK_FAILED' });
    }
  });
}
