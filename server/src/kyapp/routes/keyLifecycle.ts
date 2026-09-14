import { Router } from 'express';
import { z } from 'zod';

import { isPlatformAdmin } from '../../auth/types.js';
import type { KyAppV2KeyLifecycleService } from '../enrollment/keyLifecycle.js';
import { enrollmentReason } from '../enrollment/service.js';
import { governanceActorOf } from './support.js';

const id = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/u);
const proof = z.string().min(80).max(16_384);
const publicJwk = z
  .object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: z.string().min(43).max(43),
    y: z.string().min(43).max(43),
    alg: z.literal('ES256').optional(),
    use: z.literal('sig').optional(),
  })
  .strict();
const prepare = z
  .object({
    nextPublicJwk: publicJwk,
    nextClientAssertion: proof,
    nextDpopProof: proof,
    generation: z.number().int().positive(),
  })
  .strict();
const observation = z
  .object({
    instanceId: id,
    keyId: z.string().min(43).max(43),
    generation: z.number().int().positive(),
  })
  .strict();
const commit = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('switch'),
      nextClientAssertion: proof,
      nextDpopProof: proof,
      expectedInstanceIds: z.array(id).min(1).max(1000),
      observations: z.array(observation).min(1).max(1000),
      generation: z.number().int().positive(),
    })
    .strict(),
  z.object({ mode: z.literal('finalize') }).strict(),
]);

function workload(req: { header(name: string): string | undefined }) {
  const authorization = req.header('authorization') ?? '';
  const dpopProof = req.header('dpop') ?? '';
  if (!authorization.startsWith('DPoP ') || !dpopProof) return null;
  return { accessToken: authorization.slice('DPoP '.length), dpopProof };
}

function reasonOf(error: unknown): string {
  return error instanceof Error && 'reason' in error
    ? String((error as { reason: unknown }).reason)
    : enrollmentReason(error);
}

export function createKyAppV2KeyLifecycleRouter(options: {
  lifecycle: KyAppV2KeyLifecycleService;
}): Router {
  const router = Router();
  router.post('/installations/:iid/keys/prepare', async (req, res) => {
    const installationId = id.safeParse(req.params.iid);
    const body = prepare.safeParse(req.body ?? {});
    const auth = workload(req);
    if (!installationId.success || !body.success || !auth)
      return res.status(400).json({ ok: false, error: { code: 'invalid_request' } });
    try {
      const next = await options.lifecycle.prepare({
        installationId: installationId.data,
        accessToken: auth.accessToken,
        currentDpopProof: auth.dpopProof,
        ...body.data,
      });
      return res.json({
        ok: true,
        keyId: next.keyId,
        generation: next.generation,
        status: next.status,
      });
    } catch (error) {
      return res.status(409).json({ ok: false, error: { code: reasonOf(error) } });
    }
  });
  router.post('/installations/:iid/keys/commit', async (req, res) => {
    const installationId = id.safeParse(req.params.iid);
    const body = commit.safeParse(req.body ?? {});
    const auth = workload(req);
    if (!installationId.success || !body.success || !auth)
      return res.status(400).json({ ok: false, error: { code: 'invalid_request' } });
    try {
      if (body.data.mode === 'finalize') {
        const revoked = await options.lifecycle.finalize({
          installationId: installationId.data,
          ...auth,
        });
        return res.json({ ok: true, finalized: true, revokedPrevious: revoked });
      }
      const current = await options.lifecycle.commit({
        installationId: installationId.data,
        accessToken: auth.accessToken,
        currentDpopProof: auth.dpopProof,
        ...body.data,
      });
      return res.json({
        ok: true,
        keyId: current.keyId,
        generation: current.generation,
        status: current.status,
      });
    } catch (error) {
      return res.status(409).json({ ok: false, error: { code: reasonOf(error) } });
    }
  });
  router.post('/installations/:iid/revoke-deployment', async (req, res) => {
    const installationId = id.safeParse(req.params.iid);
    if (!installationId.success)
      return res.status(400).json({ ok: false, error: { code: 'invalid_request' } });
    if (!req.user || !isPlatformAdmin(req.user))
      return res.status(403).json({ ok: false, error: { code: 'forbidden' } });
    try {
      const installation = await options.lifecycle.revoke(
        installationId.data,
        governanceActorOf(req.user),
      );
      return res.json({
        ok: true,
        installationId: installation.installationId,
        status: installation.status,
      });
    } catch (error) {
      return res.status(409).json({ ok: false, error: { code: reasonOf(error) } });
    }
  });
  return router;
}
