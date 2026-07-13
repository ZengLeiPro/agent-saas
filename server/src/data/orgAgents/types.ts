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
}

export interface OrgAgentGuardrailConfig {
  enabled: boolean;
  /** 话题范围描述（喂门禁小模型），≤2000 字 */
  scopeDescription: string;
  /** 预设拒绝话术，1-500 字 */
  rejectionMessage: string;
  /** strict: 拿不准→拒；lenient: 拿不准→uncertain 放行+打标 */
  strictness: 'strict' | 'lenient';
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
