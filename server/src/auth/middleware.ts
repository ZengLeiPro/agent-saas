import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import type { JwtPayload } from "./types.js";
import { isPlatformAdmin } from "./types.js";
import type { UserStore } from "../data/users/store.js";
import type { TenantStore } from "../data/tenants/store.js";
import { checkTenantAccess } from "../data/tenants/access.js";
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { getEffectivePlatformCapabilities } from "./platformGovernance.js";
import { isActivePlatformAdminIdentity } from '../governance/subject/platformIdentity.js';
import type { AuthEpochAuthority } from './authEpochAuthority.js';
import { isPublicRoute } from './publicRoutes.js';

export { isPlatformAdmin } from "./types.js";

/** Token 剩余有效期不足此阈值时自动续期（7 天） */
const RENEWAL_THRESHOLD_SECONDS = 7 * 24 * 60 * 60;

export function createAuthMiddleware(
  jwtSecret: string,
  userStore?: UserStore,
  tenantStore?: TenantStore,
  tokenExpiresIn?: string,
  governanceIdentity?: {
    getMembership(tenantId: string, userId: string): Promise<{ persona: 'member' | 'org_admin'; status: 'active' | 'disabled' } | null>;
    getPlatformAdmin(userId: string): Promise<{ status: 'active' | 'disabled' } | null>;
  },
  authEpochAuthority?: AuthEpochAuthority,
) {
  const expiresIn = tokenExpiresIn || "30d";

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (isPublicRoute(req)) {
      next();
      return;
    }

    let token: string | undefined;
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      token = authHeader.slice(7);
    }
    // Fallback: query param token（仅限 <img src> 等无法附加 header 的特定路径）
    if (!token && typeof req.query.token === "string") {
      const QUERY_TOKEN_PATHS = [
        /^\/auth\/avatar\//,
        /^\/agents\/avatar\//,
        /^\/voice\/play$/,
        /^\/file\/download$/,
        /^\/kb\/file$/,
        /^\/taskboard\/tasks\/[^/]+\/attachments\/[^/]+$/,
      ];
      if (QUERY_TOKEN_PATHS.some((p) => p.test(req.path))) {
        token = req.query.token;
      }
    }

    if (!token) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    try {
      const payload = jwt.verify(token, jwtSecret) as JwtPayload;
      if (userStore) {
        const record = userStore.findById(payload.sub);
        if (!record || record.disabled) {
          res
            .status(403)
            .json({ error: "账号已被禁用", code: "USER_DISABLED" });
          return;
        }

        // M30-01: token/session authority is checked before any business authorization.
        if (authEpochAuthority) {
          if (payload.authEpoch === undefined || payload.generation === undefined) {
            const upgraded = authEpochAuthority.upgradeLegacy(record.id);
            if (!upgraded) {
              res.status(401).json({ error: 'Legacy token can no longer be upgraded', code: 'AUTH_EPOCH_REQUIRED' });
              return;
            }
            payload.authEpoch = upgraded.authEpoch;
            payload.generation = upgraded.generation;
            const upgradedToken = jwt.sign({
              sub: record.id,
              username: record.username,
              role: record.role,
              tenantId: record.tenantId,
              ...upgraded,
            }, jwtSecret, { expiresIn } as SignOptions);
            res.setHeader('X-Refresh-Token', upgradedToken);
            res.setHeader('X-Auth-Epoch', String(upgraded.authEpoch));
            res.setHeader('X-Auth-Generation', String(upgraded.generation));
          } else if (!authEpochAuthority.validates(record.id, payload)) {
            res.status(401).json({ error: 'Authentication generation revoked', code: 'AUTH_EPOCH_REVOKED' });
            return;
          }
        }

        // 使用数据库中的真实角色与 tenantId，而非 token 中可能过期的声明
        payload.role = record.role;
        // PR 5 修 P1-4：fail-closed — record.tenantId 缺失视为非法账号，强制重新建立
        // 归属（UserStore.load() 已在启动期回填，运行时此处不该缺失）
        if (!record.tenantId) {
          res
            .status(403)
            .json({ error: "账号缺失组织归属", code: "NO_TENANT" });
          return;
        }
        payload.tenantId = record.tenantId;
        if (governanceIdentity) {
          const platformAdmin = record.tenantId === DEFAULT_TENANT_ID
            ? await governanceIdentity.getPlatformAdmin(record.id)
            : null;
          if (isActivePlatformAdminIdentity(record.tenantId, platformAdmin)) {
            payload.role = 'admin';
          } else {
            const membership = await governanceIdentity.getMembership(record.tenantId, record.id);
            if (!membership || membership.status !== 'active') {
              res.status(403).json({
                error: '治理 Membership 已停用或不存在',
                code: 'GOVERNANCE_MEMBERSHIP_INACTIVE',
              });
              return;
            }
            payload.role = membership.persona === 'org_admin' && record.tenantId !== DEFAULT_TENANT_ID
              ? 'admin'
              : 'user';
          }
        }
        // 平台能力不信任 JWT 存量声明：每次请求都从用户记录实时覆盖，授权与撤权立即生效。
        payload.platformCapabilities = record.platformCapabilities;
        payload.platformCapabilityLimits = record.platformCapabilityLimits;
        if (isPlatformAdmin(payload)) {
          payload.platformCapabilities = getEffectivePlatformCapabilities(payload);
        }

        const tenantAccess = checkTenantAccess(tenantStore, payload.tenantId);
        if (!tenantAccess.ok) {
          res.status(403).json({ error: tenantAccess.message, code: tenantAccess.code });
          return;
        }

        // 滑动过期：token 剩余不足 7 天时自动续期
        if (payload.exp) {
          const remaining = payload.exp - Math.floor(Date.now() / 1000);
          if (remaining < RENEWAL_THRESHOLD_SECONDS) {
            const newToken = jwt.sign(
              {
                sub: record.id,
                username: record.username,
                role: payload.role,
                tenantId: payload.tenantId,
                ...(payload.authEpoch !== undefined ? { authEpoch: payload.authEpoch } : {}),
                ...(payload.generation !== undefined ? { generation: payload.generation } : {}),
              },
              jwtSecret,
              { expiresIn } as SignOptions,
            );
            res.setHeader("X-Refresh-Token", newToken);
          }
        }
      }
      req.user = payload;
      next();
    } catch (error) {
      if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
        res.status(401).json({ error: "Invalid or expired token" });
        return;
      }
      res.status(503).json({ error: '治理身份服务不可用', code: 'GOVERNANCE_IDENTITY_UNAVAILABLE' });
    }
  };
}

/**
 * 任意 admin（包含平台 admin 和组织 admin）。多数后台接口用此守门：
 * 进一步的「跨组织访问」限制留给业务层（结合 req.user.tenantId + isPlatformAdmin）。
 */
export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.user?.role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}

/**
 * 仅平台 admin（平台根 tenant 的 admin）。用于「跨组织管理」接口：
 *   - /api/tenants（创建/列表/禁用其他组织）
 *   - /api/auth/users 列出所有组织用户
 *   - 跨组织审计视图（不包括会话/文件内容）
 */
export function requirePlatformAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!isPlatformAdmin(req.user)) {
    res.status(403).json({ error: "Platform admin access required" });
    return;
  }
  next();
}
