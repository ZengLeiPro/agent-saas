import type { UserRole } from "../data/users/types.js";
import type {
  PlatformCapability,
  PlatformCapabilityLimits,
} from "../../../shared/src/types/user.js";
import { DEFAULT_TENANT_ID } from "../data/tenants/types.js";

export interface JwtPayload {
  sub: string; // userId
  username: string;
  role: UserRole;
  /**
   * 组织归属（必选）。多组织改造 PR 2：所有已签发的 JWT 强制带 tenantId。
   * 旧 token（无 tenantId）由 middleware 拦截视为非法。UserStore 启动期已迁移
   * 所有旧用户记录由迁移脚本补齐组织归属，新签发的 token 必带值。
   */
  tenantId: string;
  /** 由 auth middleware 每次按 UserStore 实时覆盖，不信任 JWT 存量声明。 */
  platformCapabilities?: PlatformCapability[];
  platformCapabilityLimits?: PlatformCapabilityLimits;
  iat?: number;
  exp?: number;
}

/**
 * 平台 admin（跨组织管理者）= role='admin' && tenantId === DEFAULT_TENANT_ID。
 * 平台 admin 可以：
 *   - 列出/管理所有 tenant
 *   - 跨 tenant 管理用户/审计（会话与文件访问不再跨用户授权）
 *
 * 组织 admin（同 tenant 内管理者）= role='admin' && tenantId !== DEFAULT_TENANT_ID。
 * 组织 admin 仅可以管理本组织内资源；会话与文件访问同样仅限自己。
 *
 * 平台根组织 = 'pantheon'（万神殿），只承载最高权限账号；
 * 开沿日常组织 = 'kaiyan'（开沿科技），其 admin 也是普通组织 admin。
 */
export function isPlatformAdmin(payload: JwtPayload | undefined): boolean {
  if (!payload) return false;
  if (payload.role !== "admin") return false;
  // PR 5 修 P1-1：从 DEFAULT_TENANT_ID 常量取值，避免字面值跨文件耦合
  return payload.tenantId === DEFAULT_TENANT_ID;
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}
