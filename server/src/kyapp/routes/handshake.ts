/**
 * WP2a 壳握手与 user SAT 续期路由（规范 §5.4、§3.1）。
 *
 * 三个端点都要求会话用户；nonce 绑定「壳会话 + 用户 + 安装实例」，
 * 校验与签发都在服务端完成，客户端只搬运不透明串。
 */
import { Router } from 'express';
import { z } from 'zod';

import type { KyAppHandshakeService, KyAppShellUser } from '../attest/handshake.js';
import type { UserStore } from '../../data/users/store.js';
import type { JwtPayload } from '../../auth/types.js';
import { isPlatformAdmin } from '../../auth/types.js';
import { sendKyAppError, sendKyAppFailure, shellSessionId } from './support.js';

const idSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const verifySchema = z.object({
  nonce: z
    .string()
    .min(22)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
  attestation: z.string().min(20).max(8192),
});

export interface KyAppHandshakeRoutesOptions {
  handshake: KyAppHandshakeService;
  userStore?: UserStore;
  /** 组织管理员判定：Membership 事实源优先，缺失时回落到会话 role。 */
  isTenantAdmin: (user: JwtPayload) => Promise<boolean>;
}

export function createKyAppHandshakeRouter(options: KyAppHandshakeRoutesOptions): Router {
  const router = Router();

  async function shellUser(user: JwtPayload): Promise<KyAppShellUser> {
    const record = options.userStore?.findById(user.sub);
    return {
      userId: user.sub,
      tenantId: user.tenantId,
      sessionId: shellSessionId(user),
      displayName: record?.realName ?? record?.username ?? user.username,
      isTenantAdmin: await options.isTenantAdmin(user),
      authBinding: { authEpoch: user.authEpoch, generation: user.generation },
    };
  }

  router.post('/installations/:iid/handshake/nonce', async (req, res) => {
    const iid = idSchema.safeParse(req.params.iid);
    if (!iid.success) return sendKyAppError(req, res, 'invalid_input', 'iid 非法');
    if (!req.user) return sendKyAppError(req, res, 'unauthorized', '需要登录');
    try {
      const issued = await options.handshake.issueNonce({
        installationId: iid.data,
        user: await shellUser(req.user),
      });
      res.setHeader('cache-control', 'no-store');
      res.json(issued);
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  router.post('/installations/:iid/handshake/verify', async (req, res) => {
    const iid = idSchema.safeParse(req.params.iid);
    const body = verifySchema.safeParse(req.body ?? {});
    if (!iid.success || !body.success) {
      return sendKyAppError(req, res, 'invalid_input', 'nonce 或 attestation 非法');
    }
    if (!req.user) return sendKyAppError(req, res, 'unauthorized', '需要登录');
    try {
      const result = await options.handshake.verifyHandshake({
        installationId: iid.data,
        nonce: body.data.nonce,
        attestation: body.data.attestation,
        user: await shellUser(req.user),
      });
      res.setHeader('cache-control', 'no-store');
      res.json(result);
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  router.post('/installations/:iid/token', async (req, res) => {
    const iid = idSchema.safeParse(req.params.iid);
    if (!iid.success) return sendKyAppError(req, res, 'invalid_input', 'iid 非法');
    if (!req.user) return sendKyAppError(req, res, 'unauthorized', '需要登录');
    try {
      const result = await options.handshake.refreshUserToken({
        installationId: iid.data,
        user: await shellUser(req.user),
      });
      res.setHeader('cache-control', 'no-store');
      res.json(result);
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  return router;
}

/** 默认的组织管理员判定：Membership persona 为准，缺失时回落到会话 role。 */
export function createTenantAdminResolver(memberships?: {
  getMembership(
    tenantId: string,
    userId: string,
  ): Promise<{ persona: 'member' | 'org_admin'; status: 'active' | 'disabled' } | null>;
}): (user: JwtPayload) => Promise<boolean> {
  return async (user: JwtPayload) => {
    if (isPlatformAdmin(user)) return true;
    if (!memberships) return user.role === 'admin';
    const membership = await memberships.getMembership(user.tenantId, user.sub);
    if (!membership) return user.role === 'admin';
    return membership.status === 'active' && membership.persona === 'org_admin';
  };
}
