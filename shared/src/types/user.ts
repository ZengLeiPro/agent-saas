import type { UserPreferences } from "./auth";

export interface UserPermissions {
  maxTurns?: number;
  rateLimit?: { maxRequests?: number; windowMs?: number };
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
  preferences?: UserPreferences;
  disabled?: boolean;
  tenantId?: string;
}
