/** Skill 基本信息（pool 和自建共用） */
export interface SkillInfo {
  id: string;
  name: string;
  description: string;
}

export type PlatformSkillExposure = 'all' | 'allow_tenants' | 'deny_tenants';
export type TenantSkillMemberExposure = 'all' | 'allow_users' | 'deny_users';

export interface PlatformSkillSettings {
  enabled: boolean;
  exposure: PlatformSkillExposure;
  tenantIds: string[];
}

export interface TenantSkillSettings {
  enabled: boolean;
  exposure: TenantSkillMemberExposure;
  usernames: string[];
}

/** Pool skill + admin 设置的全局可见性 */
export interface PoolSkillInfo extends SkillInfo, PlatformSkillSettings {
  /** 兼容旧字段；等价于 enabled */
  visible: boolean;
}

/** 租户视角的平台 skill + 租户启用状态 */
export interface TenantSkillInfo extends SkillInfo, TenantSkillSettings {}

/** 用户视角的 skill（含选中状态和来源） */
export interface UserSkillInfo extends SkillInfo {
  selected: boolean;
  source: 'pool' | 'custom';
}

/** GET /api/skills/me 响应 */
export interface MySkillsResponse {
  poolSkills: UserSkillInfo[];
  customSkills: UserSkillInfo[];
}

/** GET /api/skills/pool 响应 */
export interface SkillPoolResponse {
  skills: PoolSkillInfo[];
}

/** GET /api/skills/tenants/:tenantId/pool 响应 */
export interface TenantSkillPoolResponse {
  tenantId: string;
  skills: TenantSkillInfo[];
}

/** GET /api/skills/custom 响应 */
export interface CustomSkillsResponse {
  users: Record<string, SkillInfo[]>;
}


/** POST /api/skills/me/import 响应 */
export interface SkillImportResponse {
  ok: true;
  skill: SkillInfo;
}


/** Skill 文档响应 */
export interface SkillDocumentResponse {
  skillId: string;
  source: 'pool' | 'custom';
  username?: string;
  content: string;
  fileName: string;
}
