/**
 * 公司级专职 Agent（Org Agent）数据类型
 *
 * 组织管理员定义的岗位型 Agent：限定提示语 + skill 白名单 + 指派给指定员工群体，
 * 员工能用不能改。配套 LLM 话题门禁（guardrail）配置。
 * 存储为文件 store（server/data/org-agents.json），tmpfile+rename 原子持久化。
 */

/** 指派范围（复用 TenantSkillRule 三态形态） */
export interface OrgAgentAudience {
  exposure: 'all' | 'allow_users' | 'deny_users';
  usernames: string[];
  /**
   * ★ 新增（2026-07-18 企业专家目录 MVP）：部门 id 白名单
   * 与 `usernames` 是 OR 关系：命中任一即被指派。MVP 阶段类型就位，
   * UI 侧暂不暴露；5 周灰度后按反馈决定是否加 UI（详见蓝图 v2 § 4.1.4）
   */
  departmentIds?: string[];
  /**
   * ★ 新增（2026-07-18 企业专家目录 MVP）：岗位/角色 slug 白名单
   * 同 departmentIds 语义
   */
  roles?: string[];
}

/**
 * 门禁运行档位（2026-07-18 蓝图 v2 § 4.3.1 引入，替代旧 `enabled: boolean`）
 *   - `off`     : 不跑门禁（新专家试运行 / 不需要门禁的通用专家）
 *   - `shadow`  : 跑门禁 + 落库审计，但**不拦截**主 Agent（新专家上线前 3-7 天观察期）
 *   - `enforce` : 跑门禁 + 落库审计 + off_topic 时用 rejectionMessage 拦截主 Agent（正式上线）
 *
 * 向后兼容：旧 `enabled: boolean` 字段仍支持读入（load / zod schema），
 *   `enabled=true → mode='enforce'`；`enabled=false → mode='off'`。
 * 写出时同时保留 `enabled` 派生值（`mode!=='off'`），避免早期只读 enabled 的旧代码
 * 路径静默降级。业务代码判定门禁行为**必须**读 `mode`，`enabled` 仅为兼容读取。
 */
export type OrgAgentGuardrailMode = 'off' | 'shadow' | 'enforce';

export interface OrgAgentGuardrailConfig {
  /**
   * 门禁运行档位（三档取代原 `enabled` 布尔；见 OrgAgentGuardrailMode 说明）。
   * optional：向后兼容旧记录/旧 API 输入，读取时用 `normalizeGuardrailConfig`
   * 从 `enabled` 派生（旧数据 store 直接读磁盘时 mode 会缺）。
   */
  mode?: OrgAgentGuardrailMode;
  /**
   * 旧 API/前端仍在写入的字段；`mode` 未显式设置时是唯一权威来源。
   * 归一化后满足 `enabled === (mode !== 'off')`——业务代码判定门禁行为**必须**
   * 走 `normalizeGuardrailConfig(record.guardrail).mode`，不要裸读 `enabled`。
   * @deprecated 使用 `mode`
   */
  enabled: boolean;
  /** 话题范围描述（喂门禁小模型），≤2000 字 */
  scopeDescription: string;
  /** 预设拒绝话术，1-500 字 */
  rejectionMessage: string;
  /** strict: 拿不准→拒；lenient: 拿不准→uncertain 放行+打标 */
  strictness: 'strict' | 'lenient';
}

/** `enabled: boolean` → `mode` 映射（兼容读取旧记录/旧 API 输入） */
export function guardrailModeFromLegacyEnabled(enabled: boolean | undefined): OrgAgentGuardrailMode {
  return enabled ? 'enforce' : 'off';
}

/** `mode` → 派生的 `enabled: boolean`（供旧代码路径读取） */
export function guardrailEnabledFromMode(mode: OrgAgentGuardrailMode): boolean {
  return mode !== 'off';
}

/** 归一化后的 guardrail 配置：`mode` 必有，`enabled` 与 `mode` 严格一致。 */
export type NormalizedOrgAgentGuardrailConfig =
  Omit<OrgAgentGuardrailConfig, 'mode'> & { mode: OrgAgentGuardrailMode };

/**
 * 归一化 guardrail 配置：读旧记录/旧 API 输入时把 `enabled` 补出 `mode`，
 * 反之亦然。**任何进入 channel 决策的 guardrail 都应先跑这一步**。
 */
export function normalizeGuardrailConfig(
  input: Partial<OrgAgentGuardrailConfig> & { enabled?: boolean; mode?: OrgAgentGuardrailMode },
): NormalizedOrgAgentGuardrailConfig {
  const mode: OrgAgentGuardrailMode = input.mode
    ?? guardrailModeFromLegacyEnabled(input.enabled);
  return {
    mode,
    enabled: guardrailEnabledFromMode(mode),
    scopeDescription: input.scopeDescription ?? '',
    rejectionMessage: input.rejectionMessage ?? '这个问题超出了我的职责范围，暂时无法回答。',
    strictness: input.strictness ?? 'strict',
  };
}

export interface OrgAgentRecord {
  /** `oa-${randomUUID()}` */
  id: string;
  tenantId: string;
  /** 1-30 字，注入 {{AGENT_NAME}} */
  name: string;
  /** emoji 或 `org-agent-avatars/<id>.<ext>` 图片路径（路径值仅由上传接口写入，PATCH 只收 emoji） */
  avatar?: string;
  /** 图片头像的缓存版本号（上传时间戳） */
  avatarVersion?: number;
  /** 面向成员展示的职责说明，不包含内部提示语或门禁规则 */
  description: string;
  /** 面向成员展示的示例问题，点击后仅预填输入框 */
  starterPrompts: string[];
  /** 限定提示语 ≤8000，注入 {{ORG_AGENT_INSTRUCTIONS}} */
  instructions: string;
  /** skill id 白名单；绑定项是该 Agent 的固有能力，不依赖成员个人 Skill 勾选 */
  allowedSkills: string[];
  /**
   * ★ 新增（2026-07-18 企业专家目录 MVP）：挂载的租户知识库 id 列表
   * MVP 阶段可映射到 tenant own skill id（wain-kb 即 tenant own skill）；
   * 未来独立 KB 表时字段语义不变（详见蓝图 v2 § 4.1.1）。
   */
  allowedKnowledge?: string[];
  audience: OrgAgentAudience;
  guardrail: OrgAgentGuardrailConfig;
  enabled: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

/** 普通用户可见的安全公开视图（不泄漏 instructions/guardrail/audience/Skill id） */
export interface OrgAgentSummary {
  id: string;
  name: string;
  avatar?: string;
  avatarVersion?: number;
  description: string;
  starterPrompts: string[];
  /** 只公开固有 Skill 数量，不泄漏内部 Skill id */
  skillCount: number;
}

export interface OrgAgentsFileData {
  version: 1;
  agents: OrgAgentRecord[];
}
