export type SidebarLayoutPref = "double" | "single";

export interface UserPreferences {
  sidebarLayout?: SidebarLayoutPref;
  authorizationModeEnabled?: boolean;
  /** 会话列表是否显示头像；false（默认）时列表使用紧凑单行布局。 */
  showSessionListAvatar?: boolean;
}

export interface TenantFeatureFlags {
  filesEnabled: boolean;
  cronEnabled: boolean;
  mcpEnabled: boolean;
  customSkillsEnabled: boolean;
  debugModeAllowed: boolean;
}

export interface AuthUser {
  id: string;
  username: string;
  role: "admin" | "user";
  /**
   * Tenant 归属（多组织改造 PR 2 起必选）。
   * 平台 admin = role==='admin' && tenantId===DEFAULT_TENANT_ID（pantheon）
   * 组织 admin = role==='admin' && tenantId !== DEFAULT_TENANT_ID
   */
  tenantId: string;
  realName?: string;
  phone?: string;
  avatar?: string;
  avatarVersion?: number;
  /** 调试模式：开启时前端显示思考、工具、Skill 等可展开执行细节。 */
  debugMode?: boolean;
  tenantFeatures?: TenantFeatureFlags;
  preferences?: UserPreferences;
}

export interface LoginCredentials {
  username: string;
  password: string;
}
