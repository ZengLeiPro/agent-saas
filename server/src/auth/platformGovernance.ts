import type { Request, Response, NextFunction } from "express";
import type { PlatformCapability } from "../../../shared/src/types/user.js";
import type { JwtPayload } from "./types.js";
import { isPlatformAdmin } from "./types.js";
import { auditLog } from "../data/login-logs/index.js";
import { DEFAULT_TENANT_ID } from "../data/tenants/types.js";

/**
 * 平台管理员能力治理（2026-07-20）。
 *
 * @admin（以及 SUPER_ADMIN_USERNAMES 指定账号）保留完整权限；其他万神殿管理员
 * 不再被压成统一只读，而是按可审计的业务能力执行日常运营。Secret、平台全局
 * 模型/价格/工具配置、内容原文与硬删除仍然只允许超级管理员。
 */

const DEFAULT_SUPER_ADMIN_USERNAMES = ["admin"];

export const DEFAULT_PLATFORM_OPERATOR_CAPABILITIES: readonly PlatformCapability[] = [
  "tenant.manage",
  "user.manage",
  "customer_config.manage",
];

const PLATFORM_CAPABILITY_SET = new Set<PlatformCapability>([
  "tenant.manage",
  "user.manage",
  "customer_config.manage",
  "billing.adjust",
  "credential.reset",
  "runtime.operate",
  "finance.read",
]);

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

export function isSuperAdmin(payload: JwtPayload | undefined): boolean {
  if (!isPlatformAdmin(payload)) return false;
  return getSuperAdminUsernames().includes(payload!.username);
}

export function normalizePlatformCapabilities(value: unknown): PlatformCapability[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(
    (item): item is PlatformCapability =>
      typeof item === "string" && PLATFORM_CAPABILITY_SET.has(item as PlatformCapability),
  ))];
}

/** undefined 代表历史平台运营账号，自动获得安全默认包；显式 [] 代表不授予任何写能力。 */
export function getEffectivePlatformCapabilities(
  payload: JwtPayload | undefined,
): PlatformCapability[] {
  if (!isPlatformAdmin(payload) || isSuperAdmin(payload)) return [];
  if (payload!.platformCapabilities === undefined) {
    return [...DEFAULT_PLATFORM_OPERATOR_CAPABILITIES];
  }
  return normalizePlatformCapabilities(payload!.platformCapabilities);
}

export function hasPlatformCapability(
  payload: JwtPayload | undefined,
  capability: PlatformCapability,
): boolean {
  if (isSuperAdmin(payload)) return true;
  return getEffectivePlatformCapabilities(payload).includes(capability);
}

/** 单端点级守门：路由需要在业务数据解析后再判权限时使用。 */
export function requirePlatformCapability(capability: PlatformCapability) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isPlatformAdmin(req.user) || !hasPlatformCapability(req.user, capability)) {
      res.status(403).json({
        error: `当前平台管理员未获授权：${capability}`,
        code: "PLATFORM_CAPABILITY_REQUIRED",
        capability,
      });
      return;
    }
    next();
  };
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

const SKILLS_GOVERNED: RegExp[] = [
  /^\/skills\/pool(\/|$)/,
  /^\/skills\/tenants\//,
  /^\/skills\/sync$/,
  /^\/skills\/users\//,
  /^\/skills\/custom\/[^/]+\/[^/]+$/,
  /^\/skills\/custom\/[^/]+\/[^/]+\/document$/,
  /^\/skills\/custom\/[^/]+\/promote$/,
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

/** 无副作用诊断请求，不要求额外能力。 */
const SAFE_OPERATIONAL_POSTS: RegExp[] = [
  /^\/admin\/tenant-remote-hands\/[^/]+\/health$/,
  /^\/admin\/runtime-operations\/acs\/network-policy\/probe$/,
  /^\/mcp\/admin\/users\/[^/]+\/diagnose$/,
];

/** 会话正文仍归 super；run trace 对运营管理员改由路由层返回脱敏事件。 */
const CONTENT_READ_SUPER_ONLY: RegExp[] = [
  /^\/admin\/qa\/sessions\/[^/]+\/messages$/,
];

/** 平台内部财务口径，不因“可看运行事件”顺带放开。 */
const FINANCE_READ_ONLY: RegExp[] = [
  /^\/admin\/billing\/pricing-versions(\/|$)/,
  /^\/admin\/billing\/usage-events$/,
  /^\/admin\/billing\/audit$/,
  /^\/admin\/billing\/(sessions|runs)\/[^/]+\/summary$/,
];

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
  if (req.method === "POST" && avatarMatch && avatarMatch[1] === sub) return true;
  const patchMatch = req.path.match(/^\/auth\/users\/([^/]+)$/);
  if (req.method === "PATCH" && patchMatch && patchMatch[1] === sub) {
    const body: unknown = req.body;
    return !!body && typeof body === "object" && !Array.isArray(body)
      && Object.keys(body).every((key) => SELF_PATCH_SAFE_FIELDS.has(key));
  }
  return false;
}

function requiredWriteCapabilities(req: Request): PlatformCapability[] | null {
  const { method, path } = req;
  if (method === "POST" && path === "/tenants") return ["tenant.manage"];
  const tenantPatchMatch = path.match(/^\/tenants\/([^/]+)$/);
  if (method === "PATCH" && tenantPatchMatch) {
    return tenantPatchMatch[1] === DEFAULT_TENANT_ID ? null : ["tenant.manage"];
  }

  if (method === "POST" && path === "/auth/users") return ["user.manage"];
  if (method === "PATCH" && /^\/auth\/users\/[^/]+\/status$/.test(path)) return ["user.manage"];
  if (method === "POST" && /^\/auth\/users\/[^/]+\/avatar$/.test(path)) return ["user.manage"];
  if (method === "PATCH" && /^\/auth\/users\/[^/]+$/.test(path)) {
    const targetId = path.match(/^\/auth\/users\/([^/]+)$/)?.[1];
    if (targetId === req.user?.sub) return null;
    const needsCredentialReset = !!req.body && typeof req.body === "object" && "password" in req.body;
    return needsCredentialReset ? ["user.manage", "credential.reset"] : ["user.manage"];
  }

  const tenantCompanyMatch = path.match(/^\/tenants\/([^/]+)\/company-info$/);
  if (method === "PUT" && tenantCompanyMatch) {
    return tenantCompanyMatch[1] === DEFAULT_TENANT_ID ? null : ["customer_config.manage"];
  }
  const tenantSettingsMatch = path.match(/^\/tenants\/([^/]+)\/settings$/);
  if (method === "PATCH" && tenantSettingsMatch) {
    return tenantSettingsMatch[1] === DEFAULT_TENANT_ID ? null : ["customer_config.manage"];
  }
  if (
    (method === "POST" && (path === "/org-agents" || /^\/org-agents\/[^/]+\/avatar$/.test(path)))
    || (method === "PATCH" && /^\/org-agents\/[^/]+$/.test(path))
  ) {
    return ["customer_config.manage"];
  }
  const tenantSkillMatch = path.match(/^\/skills\/tenants\/([^/]+)/);
  if (
    (method === "POST" || method === "PUT" || method === "PATCH")
    && tenantSkillMatch
  ) {
    return tenantSkillMatch[1] === DEFAULT_TENANT_ID ? null : ["customer_config.manage"];
  }
  if (method === "PUT" && /^\/skills\/users\/[^/]+\/selections$/.test(path)) {
    return ["customer_config.manage"];
  }

  if (method === "POST" && /^\/admin\/billing\/accounts\/[^/]+\/adjust$/.test(path)) {
    return ["billing.adjust"];
  }
  if (method === "POST" && path === "/admin/billing/project-now") return ["runtime.operate"];
  if (method === "POST" && path === "/admin/usage/rebuild") return ["runtime.operate"];
  if (method === "POST" && path === "/admin/system/storage/scan") return ["runtime.operate"];
  if (
    method === "POST"
    && /^\/admin\/runtime-operations\/acs\/sandboxes\/[^/]+\/(pause|resume)$/.test(path)
  ) {
    return ["runtime.operate"];
  }
  return null;
}

function capabilityDenied(
  req: Request,
  res: Response,
  capability?: PlatformCapability,
): void {
  auditLog(req, "platform_capability_denied", JSON.stringify({
    method: req.method,
    path: req.path,
    ...(capability ? { capability } : {}),
  }));
  res.status(403).json({
    error: capability
      ? `当前平台管理员未获授权：${capability}`
      : "此操作仅平台超级管理员（@admin）可执行",
    code: capability ? "PLATFORM_CAPABILITY_REQUIRED" : "SUPER_ADMIN_REQUIRED",
    ...(capability ? { capability } : {}),
  });
}

/** /api 层统一挂载（auth middleware 之后）。 */
export function enforcePlatformWritePolicy(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const user = req.user;
  if (!isPlatformAdmin(user) || isSuperAdmin(user) || !isGovernedPath(req.path)) {
    next();
    return;
  }

  if (READ_METHODS.has(req.method)) {
    if (CONTENT_READ_SUPER_ONLY.some((pattern) => pattern.test(req.path))) {
      capabilityDenied(req, res);
      return;
    }
    if (
      FINANCE_READ_ONLY.some((pattern) => pattern.test(req.path))
      && !hasPlatformCapability(user, "finance.read")
    ) {
      capabilityDenied(req, res, "finance.read");
      return;
    }
    if (
      (req.path === "/admin/users" || req.path === "/auth/users")
      && Object.keys(req.query).length > 0
    ) {
      auditLog(req, "platform_user_search", JSON.stringify(req.query).slice(0, 500));
    }
    next();
    return;
  }

  if (SAFE_OPERATIONAL_POSTS.some((pattern) => req.method === "POST" && pattern.test(req.path))) {
    next();
    return;
  }
  if (isSelfServiceWrite(req)) {
    next();
    return;
  }

  const required = requiredWriteCapabilities(req);
  if (required === null) {
    capabilityDenied(req, res);
    return;
  }
  const missing = required.find((capability) => !hasPlatformCapability(user, capability));
  if (missing) {
    capabilityDenied(req, res, missing);
    return;
  }

  res.once("finish", () => {
    auditLog(req, "platform_privileged_action", JSON.stringify({
      method: req.method,
      path: req.path,
      capabilities: required,
      status: res.statusCode,
    }));
  });
  next();
}
