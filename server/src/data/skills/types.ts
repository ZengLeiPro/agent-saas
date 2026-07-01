/** skills-config.json 的持久化格式 */
export interface SkillsConfigData {
  version: 1;
  /** 单调递增计数器，每次 mutation +1，驱动 workspace 同步 */
  configVersion: number;
  /** 旧字段：pool 中每个 skill 的全局启用状态。新配置使用 platform；保留用于兼容旧数据。 */
  poolVisibility: Record<string, boolean>;
  /** 平台级 skill 配置：平台是否启用，以及开放给哪些租户 */
  platform?: Record<string, PlatformSkillConfig>;
  /** 每个租户可用的 pool skill；未配置租户默认继承全部平台可见 skill */
  tenants: Record<string, TenantSkillConfig>;
  /** 每个用户的 skill 选择 */
  users: Record<string, UserSkillConfig>;
}

export type PlatformSkillExposure = 'all' | 'allow_tenants' | 'deny_tenants';

export interface PlatformSkillConfig {
  /** 平台是否启用该 skill；关闭后所有租户和用户都不可用 */
  enabled: boolean;
  /** all=全平台开放；allow_tenants=仅指定租户开放；deny_tenants=指定租户禁用 */
  exposure: PlatformSkillExposure;
  /** allow_tenants / deny_tenants 模式下使用的租户 ID 列表 */
  tenantIds: string[];
}

export type TenantSkillMemberExposure = 'all' | 'allow_users' | 'deny_users';

export interface TenantSkillRule {
  /** 租户是否启用该 skill */
  enabled: boolean;
  /** all=全员开放；allow_users=指定成员开放；deny_users=指定成员禁用 */
  exposure: TenantSkillMemberExposure;
  /** allow_users / deny_users 模式下使用的 username 列表 */
  usernames: string[];
}

export interface TenantSkillConfig {
  /** 旧字段：租户启用的 pool skill ID 列表；保留用于兼容旧数据 */
  enabledSkills?: string[];
  /** 新字段：租户对每个 skill 的启用与成员范围规则 */
  skills?: Record<string, TenantSkillRule>;
}

export interface UserSkillConfig {
  /** 用户选中开启的 pool skill ID 列表 */
  selectedSkills: string[];
}

/** 扫描 SKILL.md 解析出的元数据 */
export interface PoolSkillMeta {
  /** 目录名 */
  id: string;
  /** frontmatter name */
  name: string;
  /** frontmatter description */
  description: string;
}
