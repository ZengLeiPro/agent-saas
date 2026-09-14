import { randomUUID } from 'node:crypto';

import { V2_CALLBACK_PATH, sha256Hex } from '@kaiyan/ky-app-contract';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { isPlatformAdmin, type JwtPayload } from '../../auth/types.js';
import {
  recordGovernanceIntent,
  recordGovernanceOutcome,
} from '../../data/governance-audit/recorder.js';
import type { GovernanceAuditStore } from '../../data/governance-audit/types.js';
import type { KyAppEnrollmentService } from '../enrollment/service.js';
import type { KyAppV2ActivationService } from '../enrollment/activation.js';
import { enrollmentReason } from '../enrollment/service.js';
import type { EnrollmentOperation } from '../enrollment/types.js';
import type { KyAppOutbound } from '../outbound.js';
import type { KyAppSatIssuer } from '../sat/issuer.js';
import type { PgKyAppSystemStore } from '../systems/store.js';
import type { KyAppInstallation } from '../systems/types.js';

const id = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/u);
const operationInput = z.object({ operationId: id }).strict();
const approveInput = z.object({ password: z.string().min(1).max(256) }).strict();
const challengeResponse = z
  .object({ enrollmentRequest: z.string().min(80).max(16_384), state: z.string().min(22).max(128) })
  .strict();
const tokenInput = z
  .object({
    grant_type: z.enum(['authorization_code', 'client_credentials']),
    code: z.string().min(22).max(256).optional(),
    code_verifier: z.string().min(43).max(128).optional(),
    client_assertion_type: z
      .literal('urn:ietf:params:oauth:client-assertion-type:jwt-bearer')
      .optional(),
    client_assertion: z.string().min(80).max(16_384),
    installation_id: id.optional(),
    scope: z.string().max(512).optional(),
  })
  .strict();
const activationInput = z
  .object({
    manifestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    appVersion: z.string().min(1).max(128),
    keyId: z.string().min(20).max(128),
    generation: z.number().int().positive(),
  })
  .strict();

export interface KyAppEnrollmentRoutesOptions {
  systems: PgKyAppSystemStore;
  enrollment: KyAppEnrollmentService;
  issuer: KyAppSatIssuer;
  outbound: KyAppOutbound;
  platformIssuer: string;
  reauthenticate: (user: JwtPayload, password: string) => Promise<boolean>;
  tenantName?: (tenantId: string) => string | undefined;
  audit?: GovernanceAuditStore;
}

function canAuthorize(user: JwtPayload | undefined, installation: KyAppInstallation): boolean {
  return Boolean(user && (isPlatformAdmin(user) || installation.techContactUserId === user.sub));
}

function publicOperation(
  operation: EnrollmentOperation,
  installation: KyAppInstallation,
  systemName: string,
  tenantName?: string,
) {
  return {
    operationId: operation.operationId,
    installationId: operation.installationId,
    status: operation.status,
    version: operation.version,
    organization: { id: installation.tenantId, name: tenantName ?? installation.tenantId },
    system: { id: installation.systemId, name: systemName },
    origin: installation.origin,
    deploymentId: operation.deploymentId,
    keyFingerprint: operation.keyId ? operation.keyId.slice(0, 8) : null,
    scopes: operation.grantedScopes,
    codeExpiresAt: operation.codeExpiresAt,
    updatedAt: operation.updatedAt,
    problem: operation.lastErrorCode
      ? { reason: operation.lastErrorCode, diagnosticId: operation.diagnosticId }
      : null,
  };
}

function statusFor(reason: string): number {
  if (reason === 'forbidden') return 403;
  if (reason === 'operation_not_found' || reason === 'installation_not_found') return 404;
  if (reason === 'feature_disabled' || reason === 'system_not_published') return 409;
  if (reason === 'reauthentication_required') return 401;
  if (reason === 'internal') return 500;
  if (reason.includes('replayed') || reason.includes('conflict') || reason === 'invalid_state') {
    return 409;
  }
  return 400;
}

function sendFailure(req: Request, res: Response, error: unknown) {
  const reason = enrollmentReason(error);
  res.status(statusFor(reason)).json({
    ok: false,
    error: {
      code: reason,
      retryable: reason === 'internal',
      message:
        reason === 'internal'
          ? '自动接入暂未完成，请按原进度查询'
          : error instanceof Error
            ? error.message
            : reason,
      requestId: req.header('x-ky-request-id') ?? randomUUID(),
    },
  });
}

export function createKyAppEnrollmentRouter(options: KyAppEnrollmentRoutesOptions): Router {
  const router = Router();
  const reauthFailures = new Map<string, { count: number; startedAt: number }>();

  router.post('/installations/:iid/enrollment-operations', async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    const body = operationInput.safeParse(req.body ?? {});
    const installationId = id.safeParse(req.params.iid);
    if (!body.success || !installationId.success) {
      return res.status(400).json({ ok: false, error: { code: 'invalid_input' } });
    }
    try {
      const installation = await options.systems.getInstallation(installationId.data);
      if (!installation || !canAuthorize(req.user, installation)) {
        return res.status(403).json({ ok: false, error: { code: 'forbidden' } });
      }
      const definition = await options.systems.getDefinition(installation.systemId);
      if (!definition?.publishedDigest) {
        return res.status(409).json({ ok: false, error: { code: 'system_not_published' } });
      }
      const created = await options.enrollment.create({
        operationId: body.data.operationId,
        installationId: installation.installationId,
        actorUserId: req.user!.sub,
      });
      let operation = created.operation;
      if (operation.status === 'created') {
        const nonce = sha256Hex(`ky-v2-enrollment:${operation.operationId}`);
        const sat = await options.issuer.issue({
          act: 'platform',
          tenantId: installation.tenantId,
          installationId: installation.installationId,
          systemId: installation.systemId,
          rid: operation.operationId,
          dig: definition.publishedDigest,
        });
        const challenge = await options.outbound.request({
          baseUrl: installation.baseUrl,
          path: '/ky/v2/enrollment/challenge',
          method: 'POST',
          requestId: operation.operationId,
          headers: { authorization: `Bearer ${sat.token}` },
          jsonBody: {
            operationId: operation.operationId,
            nonce,
            platformIssuer: options.platformIssuer,
            installationId: installation.installationId,
            tenantId: installation.tenantId,
            systemId: installation.systemId,
            origin: installation.origin,
            callbackUrl: `${installation.origin}${V2_CALLBACK_PATH}`,
          },
        });
        if (challenge.status !== 200) throw new Error(`challenge 返回 ${challenge.status}`);
        const parsed = challengeResponse.safeParse(challenge.json);
        if (!parsed.success) throw new Error('challenge 响应不符合 V2 契约');
        operation = await options.enrollment.acceptChallenge({
          operationId: operation.operationId,
          nonce,
          callbackState: parsed.data.state,
          enrollmentRequest: parsed.data.enrollmentRequest,
        });
      }
      res.status(created.created ? 201 : 200).json({
        operation: publicOperation(
          operation,
          installation,
          definition.name,
          options.tenantName?.(installation.tenantId),
        ),
      });
    } catch (error) {
      sendFailure(req, res, error);
    }
  });

  router.get('/enrollment-operations/:operationId', async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    const operationId = id.safeParse(req.params.operationId);
    if (!operationId.success || !req.user) {
      return res
        .status(operationId.success ? 401 : 400)
        .json({ ok: false, error: { code: 'invalid_input' } });
    }
    try {
      const operation = await options.enrollment.getOperation(operationId.data);
      if (operation.actorUserId !== req.user.sub) {
        return res.status(403).json({ ok: false, error: { code: 'forbidden' } });
      }
      const installation = await options.systems.getInstallation(operation.installationId);
      if (!installation) return res.status(404).json({ ok: false, error: { code: 'not_found' } });
      const definition = await options.systems.getDefinition(installation.systemId);
      res.json({
        operation: publicOperation(
          operation,
          installation,
          definition?.name ?? installation.systemId,
          options.tenantName?.(installation.tenantId),
        ),
      });
    } catch (error) {
      sendFailure(req, res, error);
    }
  });

  router.post('/enrollment-operations/:operationId/approve', async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('referrer-policy', 'no-referrer');
    const operationId = id.safeParse(req.params.operationId);
    const body = approveInput.safeParse(req.body ?? {});
    if (!operationId.success || !body.success || !req.user) {
      return res.status(req.user ? 400 : 401).json({ ok: false, error: { code: 'invalid_input' } });
    }
    try {
      const operation = await options.enrollment.getOperation(operationId.data);
      const installation = await options.systems.getInstallation(operation.installationId);
      if (
        !installation ||
        operation.actorUserId !== req.user.sub ||
        !canAuthorize(req.user, installation)
      ) {
        return res.status(403).json({ ok: false, error: { code: 'forbidden' } });
      }
      const rateKey = `${req.user.sub}:${req.ip ?? 'unknown'}`;
      const previous = reauthFailures.get(rateKey);
      const now = Date.now();
      const current = previous && now - previous.startedAt < 10 * 60_000 ? previous : undefined;
      if (current && current.count >= 5) {
        return res.status(429).json({ ok: false, error: { code: 'rate_limited' } });
      }
      const reauthenticated = await options.reauthenticate(req.user, body.data.password);
      if (reauthenticated) reauthFailures.delete(rateKey);
      else {
        reauthFailures.set(rateKey, {
          count: (current?.count ?? 0) + 1,
          startedAt: current?.startedAt ?? now,
        });
        if (reauthFailures.size > 10_000) {
          for (const [key, value] of reauthFailures) {
            if (now - value.startedAt >= 10 * 60_000) reauthFailures.delete(key);
          }
        }
      }
      const intent = await recordGovernanceIntent(options.audit, req.user, {
        action: 'ky_app.enrollment.approve',
        targetType: 'system_installation',
        targetId: operation.installationId,
        targetTenantId: installation.tenantId,
        purpose: 'asymmetric_installation_authorization',
        metadata: { operationId: operation.operationId },
      });
      let approved;
      try {
        approved = await options.enrollment.approve({
          operationId: operationId.data,
          actorUserId: req.user.sub,
          reauthenticated,
        });
        await recordGovernanceOutcome(options.audit!, intent, 'succeeded', {
          metadata: { operationId: operation.operationId },
        });
      } catch (error) {
        await recordGovernanceOutcome(options.audit!, intent, 'failed', {
          reason: enrollmentReason(error),
          metadata: { operationId: operation.operationId },
        }).catch(() => undefined);
        throw error;
      }
      const redirect = new URL(approved.callbackUrl);
      redirect.search = '';
      redirect.hash = '';
      redirect.searchParams.set('code', approved.code);
      redirect.searchParams.set('state', approved.state);
      res.json({ redirectUrl: redirect.toString(), operationId: approved.operation.operationId });
    } catch (error) {
      sendFailure(req, res, error);
    }
  });

  return router;
}

export function createKyAppV2TokenRouter(
  options: Pick<KyAppEnrollmentRoutesOptions, 'enrollment'>,
): Router {
  const router = Router();
  router.post('/oauth/token', async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    const body = tokenInput.safeParse(req.body ?? {});
    const dpopProof = req.header('dpop') ?? '';
    if (!body.success || dpopProof === '') {
      return res.status(400).json({ error: 'invalid_request' });
    }
    try {
      if (body.data.grant_type === 'authorization_code') {
        if (!body.data.code || !body.data.code_verifier) {
          return res.status(400).json({ error: 'invalid_request' });
        }
        const result = await options.enrollment.exchangeAuthorizationCode({
          code: body.data.code,
          codeVerifier: body.data.code_verifier,
          clientAssertion: body.data.client_assertion,
          dpopProof,
        });
        return res.json({
          access_token: result.accessToken,
          token_type: result.tokenType,
          expires_in: result.expiresIn,
          installation_grant: result.installationGrant,
          installation_id: result.installationId,
        });
      }
      if (!body.data.installation_id) {
        return res.status(400).json({ error: 'invalid_request' });
      }
      const result = await options.enrollment.issueClientCredentials({
        installationId: body.data.installation_id,
        clientAssertion: body.data.client_assertion,
        dpopProof,
        scopes: (body.data.scope ?? '').split(/\s+/u).filter(Boolean),
      });
      return res.json({
        access_token: result.accessToken,
        token_type: result.tokenType,
        expires_in: result.expiresIn,
      });
    } catch (error) {
      const reason = enrollmentReason(error);
      return res.status(statusFor(reason)).json({ error: reason });
    }
  });
  return router;
}

export function createKyAppV2ActivationRouter(options: {
  activation: KyAppV2ActivationService;
}): Router {
  const router = Router();
  router.post('/installations/:iid/activate', async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    const installationId = id.safeParse(req.params.iid);
    const body = activationInput.safeParse(req.body ?? {});
    const authorization = req.header('authorization') ?? '';
    const dpopProof = req.header('dpop') ?? '';
    if (
      !installationId.success ||
      !body.success ||
      !authorization.startsWith('DPoP ') ||
      !dpopProof
    ) {
      return res.status(400).json({ ok: false, error: { code: 'invalid_request' } });
    }
    try {
      const installation = await options.activation.activate({
        installationId: installationId.data,
        accessToken: authorization.slice('DPoP '.length),
        dpopProof,
        ...body.data,
      });
      return res.json({
        ok: true,
        installationId: installation.installationId,
        status: installation.status,
      });
    } catch (error) {
      await options.activation.recordFailure(installationId.data, error).catch(() => undefined);
      const reason =
        error instanceof Error && 'reason' in error
          ? String((error as { reason: unknown }).reason)
          : enrollmentReason(error);
      return res.status(statusFor(reason)).json({ ok: false, error: { code: reason } });
    }
  });
  return router;
}
