import type { UserPermissions } from "../../types/index.js";

export type UserRole = "admin" | "user";

/** 侧边栏分组排序偏好（跨设备同步） */
export interface GroupSortingPref {
  mode: "recent" | "custom";
  /** custom 模式下的 group id 顺序；recent 模式下保留作为快照可选 */
  order?: string[];
}

export type SidebarLayoutPref = "double" | "single";

export interface UserPreferences {
  sidebarLayout?: SidebarLayoutPref;
  authorizationModeEnabled?: boolean;
}

export interface UserRecord {
  id: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  realName?: string;
  /** 手机号（用户自维护）。zod 层强校验 11 位中国大陆号码格式，存储层不约束。 */
  phone?: string;
  avatar?: string; // 头像文件相对路径，如 'avatars/uuid.jpg'
  avatarVersion?: number; // 头像版本号（上传时 Date.now()），用于客户端缓存控制
  /** 调试模式：开启时前端显示思考、工具、Skill 等执行细节；默认关闭。 */
  debugMode?: boolean;
  dingtalkStaffId?: string;
  /**
   * Tenant 归属（多组织改造 PR 2 起必选）。
   * 旧记录（无 tenantId）由 UserStore.load() 自动按 admin/legacy split 回填并持久化。
   * 新建用户必须显式指定（POST /api/auth/users）。
   *
   * 业务语义：
   *   - role='admin' + tenantId='pantheon' = 平台 admin（跨组织）
   *   - role='admin' + tenantId !== 'pantheon' = 组织 admin（限本组织）
   *   - role='user' = 普通用户（限本组织）
   */
  tenantId: string;
  permissions?: UserPermissions;
  groupSorting?: GroupSortingPref;
  preferences?: UserPreferences;
  createdAt: string; // ISO 8601
  createdBy: string; // userId 或 'system'
  updatedAt: string;
  disabled?: boolean;
  disabledAt?: string;
  disabledBy?: string;
  appVersion?: string;
  appVersionUpdatedAt?: string;
}

// 对外暴露的用户信息（不含密码哈希）
export interface UserInfo {
  id: string;
  username: string;
  role: UserRole;
  realName?: string;
  /** 手机号（用户自维护，11 位中国大陆号码） */
  phone?: string;
  avatar?: string;
  avatarVersion?: number;
  /** 调试模式：开启时前端显示思考、工具、Skill 等执行细节；默认关闭。 */
  debugMode?: boolean;
  dingtalkStaffId?: string;
  /** Tenant 归属（PR 2 起必选） */
  tenantId: string;
  permissions?: UserPermissions;
  groupSorting?: GroupSortingPref;
  preferences?: UserPreferences;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  disabled?: boolean;
  disabledAt?: string;
  disabledBy?: string;
  appVersion?: string;
  appVersionUpdatedAt?: string;
}

export interface UsersFileData {
  version: 1;
  users: UserRecord[];
}
