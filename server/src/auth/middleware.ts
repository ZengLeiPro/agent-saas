import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import type { JwtPayload } from "./types.js";
import { isPlatformAdmin } from "./types.js";
import type { UserStore } from "../data/users/store.js";
import type { TenantStore } from "../data/tenants/store.js";
import { checkTenantAccess } from "../data/tenants/access.js";
import { getEffectivePlatformCapabilities } from "./platformGovernance.js";

export { isPlatformAdmin } from "./types.js";

// 注意：中间件通过 app.use('/api', ...) 挂载，req.path 不含 /api 前缀
const PUBLIC_ROUTES: Array<{ method?: string; path: string | RegExp }> = [
  { method: "POST", path: "/auth/login" },
  { method: "POST", path: "/auth/sms/send-code" },
  { method: "POST", path: "/auth/sms/login" },
  // 自助注册试用（官网联动）：status/send-code/register 均免登录；
  // enabled 开关与频控在 routes/signup.ts 内收口
  { path: /^\/signup\// },
  { path: "/health" },
  { path: "/healthz" },
  { path: "/healthz/drain" },
  // 蓝绿部署探针（2026-07-15）：live=进程存活，ready=可接流量（部署门禁在
  // 新色端口上等它 200 再切流）。与 /healthz 同口径公开，只暴露 warmup 进度。
  { path: "/healthz/live" },
  { path: "/healthz/ready" },
  { path: "/config" },
  { method: "POST", path: "/internal/acs-alerts" },
  { method: "GET", path: "/app/version" },
  { path: /^\/dingtalk\/webhook\// },
  { method: "GET", path: /^\/auth\/avatar\// },
  { method: "GET", path: /^\/agents\/avatar\// },
  // 企业专家图片头像：<img> 加载不带鉴权头，与 agents/avatar 同口径公开（204 防枚举在路由内）
  { method: "GET", path: /^\/org-agents\/avatar\// },
  { method: "GET", path: "/mcp/oauth/callback" },
  { method: "GET", path: "/mcp/oauth/client-metadata" },
  { method: "GET", path: /^\/artifacts\/[^/]+\/content$/ },
  { method: "GET", path: /^\/share\/sessions\/[^/]+$/ },
  { path: /^\/share\/sessions\/[^/]+\/file$/ },
];

function isPublicRoute(req: Request): boolean {
  return PUBLIC_ROUTES.some(({ method, path }) => {
    if (method && req.method !== method) return false;
    if (typeof path === "string") return req.path === path;
    return path.test(req.path);
  });
}

/** Token 剩余有效期不足此阈值时自动续期（7 天） */
const RENEWAL_THRESHOLD_SECONDS = 7 * 24 * 60 * 60;

export function createAuthMiddleware(
  jwtSecret: string,
  userStore?: UserStore,
  tenantStore?: TenantStore,
  tokenExpiresIn?: string,
) {
  const expiresIn = tokenExpiresIn || "30d";

  return (req: Request, res: Response, next: NextFunction): void => {
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
                role: record.role,
                tenantId: payload.tenantId,
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
    } catch {
      res.status(401).json({ error: "Invalid or expired token" });
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
