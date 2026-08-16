import type { IndustryType } from "./scenario";
import type { PlatformCapability, PlatformCapabilityLimits } from "./user";

export type SidebarLayoutPref = "double" | "single";
export type BusinessStepDisplayMode = "auto" | "collapsed" | "expanded";

export interface UserPreferences {
  sidebarLayout?: SidebarLayoutPref;
  /** 业务步骤默认展示方式：智能折叠、始终折叠或始终展开。 */
  businessStepDisplayMode?: BusinessStepDisplayMode;
  authorizationModeEnabled?: boolean;
  /** 会话列表是否显示头像；false（默认）时列表使用紧凑单行布局。 */
  showSessionListAvatar?: boolean;
  /** 当前用户新建会话时默认使用的模型引用（group/model）。 */
  defaultModel?: string;
  /** 当前激活岗位包，用于开箱包推荐与岗位切换器。 */
  activeRoleId?: string;
  /** 用户选择或系统推断的业态偏好，用于推荐排序。 */
  industryHint?: IndustryType;
}

export interface TenantFeatureFlags {
  filesEnabled: boolean;
  cronEnabled: boolean;
  mcpEnabled: boolean;
  customSkillsEnabled: boolean;
  /** 平台是否授权当前组织使用调试模式。 */
  debugModeAllowed: boolean;
  /** 当前组织是否向成员开放调试模式。 */
  debugModeEnabled?: boolean;
  /** 普通用户是否可使用个人 Agent；false 时只能进入可用的公司专职 Agent。 */
  personalAgentEnabled?: boolean;
  /** 租户共享知识库文件与引用预览能力。 */
  kbEnabled?: boolean;
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
  /** @deprecated 兼容旧客户端；平台管理员统一返回 true。 */
  isSuperAdmin?: boolean;
  /** @deprecated 兼容旧客户端；平台管理员实际始终拥有完整能力集。 */
  platformCapabilities?: PlatformCapability[];
  platformCapabilityLimits?: PlatformCapabilityLimits;
  realName?: string;
  /** 岗位（自由文本），空会话场景推荐按此优先排序 */
  position?: string;
  phone?: string;
  /** 手机号验证时间；存在时才允许验证码登录。 */
  phoneVerifiedAt?: string;
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

export interface SmsLoginCredentials {
  phone: string;
  code: string;
}
