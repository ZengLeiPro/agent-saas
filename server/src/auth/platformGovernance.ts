import type { Request, Response, NextFunction } from "express";
import type { JwtPayload } from "./types.js";
import { isPlatformAdmin } from "./types.js";
import { auditLog } from "../data/login-logs/index.js";

/**
 * 平台管理员分层治理（2026-07-18）。
 *
 * 背景：万神殿（pantheon）内所有员工账号此前拥有与 @admin 完全相同的平台权限。
 * 收敛为两层：
 *   - super admin（默认仅 @admin）：完整读写；
 *   - 只读平台 admin（其余万神殿账号）：平台管理界面全量可读，写操作被统一拦截，
 *     仅保留「创建租户」与少数只读性 POST；会话正文/工具 IO 明细等内容级读也归 super。
 *
 * 设计取舍：不引入新角色体系（账号即角色）；不逐端点改造（61 个写端点易漏），
 * 在 /api 层按管理路径前缀统一收口。组织 admin 与普通用户完全不受本策略影响
 * （他们不是平台 admin，第一行即放行；其自身的越权防御仍由各端点的租户 scope 承担）。
 *
 * 权威判定只在服务端；前端 isSuperAdmin 仅用于隐藏/禁用入口。
 */

const DEFAULT_SUPER_ADMIN_USERNAMES = ["admin"];

/** env SUPER_ADMIN_USERNAMES（逗号分隔）覆盖默认值；空/未设 = ["admin"]。 */
export function getSuperAdminUsernames(): string[] {
  const raw = process.env.SUPER_ADMIN_USERNAMES;
  if (!raw) return DEFAULT_SUPER_ADMIN_USERNAMES;
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : DEFAULT_SUPER_ADMIN_USERNAMES;
}

/**
 * super admin = 平台 admin 且 username 在名单内。
 * 安全性依赖「username 不可变」：PATCH /auth/users/:id 的字段集不含 username，
 * 且 POST /auth/users（可指定 username）本身已被本策略拦为 super 独占。
 */
export function isSuperAdmin(payload: JwtPayload | undefined): boolean {
  if (!isPlatformAdmin(payload)) return false;
  return getSuperAdminUsernames().includes(payload!.username);
}

/** 单端点级守门：清空审计日志等超敏感操作用。 */
export function requireSuperAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!isSuperAdmin(req.user)) {
    res.status(403).json({
      error: "此操作仅平台超级管理员（@admin）可执行",
      code: "SUPER_ADMIN_REQUIRED",
    });
    return;
  }
  next();
}

// ── 治理范围：管理路径（req.path 不含 /api 前缀，与 auth middleware 同口径） ──

const SKILLS_GOVERNED: RegExp[] = [
  /^\/skills\/pool(\/|$)/, // 全局技能池
  /^\/skills\/tenants\//, // 跨租户技能管理
  /^\/skills\/sync$/, // 全局同步
  /^\/skills\/users\//, // 跨用户启用集
  /^\/skills\/custom\/[^/]+\/[^/]+$/, // 跨用户自建技能（DELETE 四段）
  /^\/skills\/custom\/[^/]+\/[^/]+\/document$/, // 跨用户自建技能文档（PUT 五段）
  /^\/skills\/custom\/[^/]+\/promote$/, // 自建技能发布到全局池
];

function isGovernedPath(path: string): boolean {
  if (path === "/tenants" || path.startsWith("/tenants/")) return true;
  if (path.startsWith("/admin/")) return true;
  if (path === "/auth/users" || path.startsWith("/auth/users/")) return true;
  if (path === "/auth/login-logs") return true;
  if (path.startsWith("/mcp/admin")) return true;
  if (path === "/org-agents" || path.startsWith("/org-agents/")) return true;
  if (path.startsWith("/dingtalk/sessions")) return true;
  return SKILLS_GOVERNED.some((r) => r.test(path));
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** 只读平台 admin 仍放行的写方法：创建租户（业务拍板保留）+ 只读性 POST。 */
const WRITE_ALLOWLIST: Array<{ method: string; pattern: RegExp }> = [
  { method: "POST", pattern: /^\/tenants$/ },
  { method: "POST", pattern: /^\/admin\/tenant-remote-hands\/[^/]+\/health$/ },
  { method: "POST", pattern: /^\/admin\/runtime-operations\/acs\/network-policy\/probe$/ },
  { method: "POST", pattern: /^\/mcp\/admin\/users\/[^/]+\/diagnose$/ },
];

/**
 * 内容级读端点（会话正文 / 工具 IO 明细）归 super 独占。
 * 口径（2026-07-18 曾磊拍板）：只读平台 admin 的诊断视角=运行状态/错误/耗时/token
 * 聚合；不含成员会话正文。组织 admin 对本组织的质检台访问不受影响。
 */
const CONTENT_READ_SUPER_ONLY: RegExp[] = [
  /^\/admin\/qa\/sessions\/[^/]+\/messages$/,
  /^\/admin\/runtime\/trace\/runs\/[^/]+\/events$/,
];

/** 万神殿员工对自己账号的自助写：改自己头像 + 改自己基础资料（安全字段）。 */
const SELF_PATCH_SAFE_FIELDS = new Set([
  "password",
  "realName",
  "position",
  "debugMode",
  "dingtalkStaffId",
]);

function isSelfServiceWrite(req: Request): boolean {
  const sub = req.user?.sub;
  if (!sub) return false;
  const avatarMatch = req.path.match(/^\/auth\/users\/([^/]+)\/avatar$/);
  if (req.method === "POST" && avatarMatch && avatarMatch[1] === sub) {
    return true;
  }
  const patchMatch = req.path.match(/^\/auth\/users\/([^/]+)$/);
  if (req.method === "PATCH" && patchMatch && patchMatch[1] === sub) {
    const body: unknown = req.body;
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return Object.keys(body).every((k) => SELF_PATCH_SAFE_FIELDS.has(k));
    }
  }
  return false;
}

/**
 * /api 层统一挂载（auth middleware 之后）。对非 super 的平台 admin：
 * 管理路径读放行（内容级读除外）、写拦截（白名单与自助写除外）。
 */
export function enforcePlatformWritePolicy(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const user = req.user;
  if (!isPlatformAdmin(user)) {
    next();
    return;
  }
  if (isSuperAdmin(user)) {
    next();
    return;
  }
  if (!isGovernedPath(req.path)) {
    next();
    return;
  }

  if (READ_METHODS.has(req.method)) {
    if (CONTENT_READ_SUPER_ONLY.some((r) => r.test(req.path))) {
      auditLog(req, "platform_readonly_denied", `${req.method} ${req.path}`);
      res.status(403).json({
        error: "会话内容级数据仅平台超级管理员（@admin）可见",
        code: "PLATFORM_READ_ONLY",
      });
      return;
    }
    // 敏感读留痕：跨租户用户检索（手机号/姓名等）
    if (req.path === "/admin/users" && Object.keys(req.query).length > 0) {
      auditLog(
        req,
        "platform_user_search",
        JSON.stringify(req.query).slice(0, 500),
      );
    }
    next();
    return;
  }

  if (
    WRITE_ALLOWLIST.some(
      (w) => w.method === req.method && w.pattern.test(req.path),
    )
  ) {
    next();
    return;
  }
  if (isSelfServiceWrite(req)) {
    next();
    return;
  }

  auditLog(req, "platform_readonly_denied", `${req.method} ${req.path}`);
  res.status(403).json({
    error: "平台只读账号无权执行此操作，请联系 @admin",
    code: "PLATFORM_READ_ONLY",
  });
}
