import type { Request, Response, NextFunction } from "express";
import {
  PLATFORM_CAPABILITIES,
  type PlatformCapability,
} from "../../../shared/src/types/user.js";
import type { JwtPayload } from "./types.js";
import { isPlatformAdmin } from "./types.js";

/**
 * 平台管理员权限治理。
 *
 * 所有 role=admin + tenantId=pantheon 的平台管理员拥有相同的完整平台权限。
 * isSuperAdmin / requireSuperAdmin 保留为兼容别名，避免旧调用方和客户端协议同时破坏；
 * 它们不再区分用户名或账号层级。
 */

const PLATFORM_CAPABILITY_SET = new Set<PlatformCapability>(PLATFORM_CAPABILITIES);

/** @deprecated 平台管理员已不再区分超级管理员；等价于 isPlatformAdmin。 */
export function isSuperAdmin(payload: JwtPayload | undefined): boolean {
  return isPlatformAdmin(payload);
}

export function normalizePlatformCapabilities(value: unknown): PlatformCapability[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(
    (item): item is PlatformCapability =>
      typeof item === "string" && PLATFORM_CAPABILITY_SET.has(item as PlatformCapability),
  ))];
}

/** 平台管理员始终返回完整能力集；账号记录中的旧能力配置不再影响权限。 */
export function getEffectivePlatformCapabilities(
  payload: JwtPayload | undefined,
): PlatformCapability[] {
  return isPlatformAdmin(payload) ? [...PLATFORM_CAPABILITIES] : [];
}

export function hasPlatformCapability(
  payload: JwtPayload | undefined,
  _capability: PlatformCapability,
): boolean {
  return isPlatformAdmin(payload);
}

export function requirePlatformCapability(_capability: PlatformCapability) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isPlatformAdmin(req.user)) {
      res.status(403).json({
        error: "此操作仅平台管理员可执行",
        code: "PLATFORM_ADMIN_REQUIRED",
      });
      return;
    }
    next();
  };
}

/** @deprecated 兼容旧路由命名；现在允许所有平台管理员。 */
export function requireSuperAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!isPlatformAdmin(req.user)) {
    res.status(403).json({
      error: "此操作仅平台管理员可执行",
      code: "PLATFORM_ADMIN_REQUIRED",
    });
    return;
  }
  next();
}

/**
 * 兼容原有全局挂载点。平台管理员不再按账号能力分层，具体路由继续负责
 * requirePlatformAdmin / requireAdmin 与租户作用域校验。
 */
export function enforcePlatformWritePolicy(
  _req: Request,
  _res: Response,
  next: NextFunction,
): void {
  next();
}
