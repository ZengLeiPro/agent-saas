/**
 * WP2a SAT 签名密钥路由与 JWKS 文档（规范 §3.1、§8.4）。
 *
 * `rotate` 只生成 next 并广播 `jwks.rotated` + `jwks.probe`，**不切换**；
 * 切换要等所有 enabled 实例回报 `verifiedKid`（`promote`）。
 * `revoke` 是紧急通道：立即移出 JWKS 并广播 `jwks.revoke`。
 * JWKS 文档挂在 `/api` 之外，公开、`max-age=600`、≤16 KB。
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { requirePlatformAdmin } from '../../auth/middleware.js';
import {
  governanceDigest,
  recordGovernanceIntent,
  recordGovernanceOutcome,
} from '../../data/governance-audit/recorder.js';
import type { GovernanceAuditStore } from '../../data/governance-audit/types.js';
import type { KyAppEventDispatcher } from '../events/dispatcher.js';
import type { KyAppSigningKeyService } from '../keys/service.js';
import { governanceActorOf, sendKyAppError, sendKyAppFailure } from './support.js';

/** §3.1：JWKS 响应上限 16 KB。 */
export const KY_APP_JWKS_MAX_BYTES = 16 * 1024;
/** §3.1：`max-age=600`。 */
export const KY_APP_JWKS_MAX_AGE_SECONDS = 600;

const kidSchema = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_.-]+$/);

export interface KyAppKeyRoutesOptions {
  keys: KyAppSigningKeyService;
  dispatcher: KyAppEventDispatcher;
  audit?: GovernanceAuditStore;
}

/** 公开 JWKS 处理器；挂在 app 级（`/api` 之外，天然公开）。 */
export function createKyAppJwksHandler(keys: KyAppSigningKeyService) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const document = await keys.jwks();
      const body = JSON.stringify(document);
      if (Buffer.byteLength(body, 'utf8') > KY_APP_JWKS_MAX_BYTES) {
        sendKyAppError(req, res, 'internal', 'JWKS 文档超过 16 KB 上限');
        return;
      }
      res.setHeader('cache-control', `public, max-age=${KY_APP_JWKS_MAX_AGE_SECONDS}`);
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.status(200).send(body);
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  };
}

export function createKyAppKeysRouter(options: KyAppKeyRoutesOptions): Router {
  const router = Router();

  router.post('/keys/rotate', requirePlatformAdmin, async (req, res) => {
    try {
      const actor = governanceActorOf(req.user!);
      const intent = await recordGovernanceIntent(options.audit, actor, {
        action: 'ky_app.signing_key.rotate',
        targetType: 'ky_app_signing_key',
        targetId: 'active',
        purpose: 'key_rotation',
        metadata: {},
      });
      const result = await options.dispatcher.rotateAndProbe();
      await recordGovernanceOutcome(options.audit!, intent, 'succeeded', {
        afterDigest: governanceDigest({ newKid: result.newKid }),
        metadata: { newKid: result.newKid, probedInstallations: result.probed },
      });
      res.json({ ...result, promoted: false });
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  router.post('/keys/promote', requirePlatformAdmin, async (req, res) => {
    const kid = kidSchema.safeParse((req.body ?? {}).kid);
    if (!kid.success) return sendKyAppError(req, res, 'invalid_input', 'kid 非法');
    try {
      const actor = governanceActorOf(req.user!);
      const intent = await recordGovernanceIntent(options.audit, actor, {
        action: 'ky_app.signing_key.promote',
        targetType: 'ky_app_signing_key',
        targetId: kid.data,
        purpose: 'key_rotation',
        metadata: { newKid: kid.data },
      });
      const result = await options.dispatcher.promoteWhenAllVerified(kid.data);
      await recordGovernanceOutcome(
        options.audit!,
        intent,
        result.promoted ? 'succeeded' : 'failed',
        {
          metadata: { promoted: result.promoted, pendingInstallations: result.pending.length },
        },
      );
      if (!result.promoted) {
        return sendKyAppError(
          req,
          res,
          'conflict',
          `仍有 ${result.pending.length} 个安装实例未回报 verifiedKid，不能切换签发密钥`,
        );
      }
      res.json(result);
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  router.post('/keys/revoke', requirePlatformAdmin, async (req, res) => {
    const kid = kidSchema.safeParse((req.body ?? {}).kid);
    if (!kid.success) return sendKyAppError(req, res, 'invalid_input', 'kid 非法');
    try {
      const actor = governanceActorOf(req.user!);
      const intent = await recordGovernanceIntent(options.audit, actor, {
        action: 'ky_app.signing_key.revoke',
        targetType: 'ky_app_signing_key',
        targetId: kid.data,
        purpose: 'key_emergency_revocation',
        metadata: { revokedKid: kid.data },
      });
      const record = await options.keys.revoke(kid.data);
      const broadcast = await options.dispatcher.broadcastRevoke(kid.data);
      await recordGovernanceOutcome(options.audit!, intent, 'succeeded', {
        afterDigest: governanceDigest({ kid: record.kid, status: record.status }),
        metadata: { notifiedInstallations: broadcast },
      });
      res.json({ kid: record.kid, status: record.status, notifiedInstallations: broadcast });
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  return router;
}
