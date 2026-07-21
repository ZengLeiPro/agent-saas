import type { UserPreferences } from "./auth";

export interface UserPermissions {
  maxTurns?: number;
  rateLimit?: { maxRequests?: number; windowMs?: number };
}

/**
 * 平台运营能力。仅对 role=admin + tenantId=pantheon 的平台管理员生效；
 * 平台超级管理员不受该列表限制。
 */
export const PLATFORM_CAPABILITIES = [
  "tenant.manage",
  "user.manage",
  "customer_config.manage",
  "billing.adjust",
  "credential.reset",
  "runtime.operate",
  "finance.read",
  "workflow_demo.review",
  "workflow_demo.publish",
] as const;

export type PlatformCapability = (typeof PLATFORM_CAPABILITIES)[number];

export interface PlatformCapabilityLimits {
  /** 单笔最多可增加的积分。仅 billing.adjust 委托账号使用。 */
  billingMaxCreditsPerTransaction?: number;
  /** 北京时间自然日内最多可增加的积分。仅 billing.adjust 委托账号使用。 */
  billingMaxCreditsPerDay?: number;
}


export interface UserInfo {
  id: string;
  username: string;
  role: "admin" | "user";
  /** Tenant 归属（多组织改造起必选） */
  tenantId: string;
  realName?: string;
  /** 岗位（自由文本，如「销售」），驱动场景库按岗位推荐 */
  position?: string;
  /** 手机号（全平台唯一；自助注册账号通常 username 与 phone 相同） */
  phone?: string;
  avatar?: string;
  avatarVersion?: number;
  /** 调试模式：开启时前端显示思考、工具、Skill 等可展开执行细节。 */
  debugMode?: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  dingtalkStaffId?: string;
  permissions?: UserPermissions;
  platformCapabilities?: PlatformCapability[];
  platformCapabilityLimits?: PlatformCapabilityLimits;
  preferences?: UserPreferences;
  disabled?: boolean;
  disabledAt?: string;
  disabledBy?: string;
  appVersion?: string;
  appVersionUpdatedAt?: string;
}

export interface CreateUserInput {
  username: string;
  password: string;
  role: "admin" | "user";
  realName?: string;
  position?: string;
  dingtalkStaffId?: string;
  debugMode?: boolean;
  permissions?: UserPermissions;
  platformCapabilities?: PlatformCapability[];
  platformCapabilityLimits?: PlatformCapabilityLimits;
  tenantId?: string;
}

export interface UpdateUserInput {
  password?: string;
  role?: "admin" | "user";
  realName?: string;
  position?: string;
  dingtalkStaffId?: string;
  debugMode?: boolean;
  permissions?: UserPermissions;
  platformCapabilities?: PlatformCapability[];
  platformCapabilityLimits?: PlatformCapabilityLimits;
  preferences?: UserPreferences;
  disabled?: boolean;
  tenantId?: string;
}
