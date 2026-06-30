/** skills-config.json 的持久化格式 */
export interface SkillsConfigData {
  version: 1;
  /** 单调递增计数器，每次 mutation +1，驱动 workspace 同步 */
  configVersion: number;
  /** pool 中每个 skill 的全局可见性（true = 用户可见可选） */
  poolVisibility: Record<string, boolean>;
  /** 每个租户可用的 pool skill；未配置租户默认继承全部平台可见 skill */
  tenants: Record<string, TenantSkillConfig>;
  /** 每个用户的 skill 选择 */
  users: Record<string, UserSkillConfig>;
}

export interface TenantSkillConfig {
  /** 租户启用的 pool skill ID 列表 */
  enabledSkills: string[];
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
