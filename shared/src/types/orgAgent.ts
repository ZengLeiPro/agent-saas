/**
 * 公司级专职 Agent（Org Agent）前端类型（2026-07 唯恩批次）
 *
 * 与 server/src/data/orgAgents/types.ts 保持字段一致：
 * - OrgAgentSummary：普通用户可见的裁剪视图（GET /api/org-agents/mine）
 * - OrgAgentRecord：admin 全字段视图（组织管理端 CRUD）
 */

export interface OrgAgentAudience {
  exposure: 'all' | 'allow_users' | 'deny_users';
  usernames: string[];
  /** 治理目录组 id；兼容投影同时展开为 usernames 供旧通道判定。 */
  departmentIds?: string[];
  roles?: string[];
}

export type OrgAgentRuntimeContextModule =
  | 'company_info'
  | 'tenant_instructions'
  | 'runtime_memory'
  | 'personal_context';
export type OrgAgentRuntimeCapabilityPolicy = 'inherit' | 'disabled';
export type OrgAgentExecutionTarget = 'server-local' | 'server-container' | 'server-remote' | 'client';

export interface OrgAgentRuntimePolicy {
  schemaVersion: 1;
  context: { modules: OrgAgentRuntimeContextModule[] | null };
  model: { strategy: 'inherit' } | { strategy: 'fixed'; modelRef: string };
  memory: { scope: 'inherit' | 'full' | 'search_only' | 'none' };
  limits: { maxTurns: number | null };
  capabilities: {
    shell: OrgAgentRuntimeCapabilityPolicy;
    backgroundTasks: OrgAgentRuntimeCapabilityPolicy;
    interaction: OrgAgentRuntimeCapabilityPolicy;
    subagents: OrgAgentRuntimeCapabilityPolicy;
    scheduling: OrgAgentRuntimeCapabilityPolicy;
  };
  tools: { allowlist: string[] | null; denylist: string[] };
  mcp: {
    serverAllowlist: string[] | null;
    toolAllowlist: string[] | null;
    denyServers: string[];
    denyTools: string[];
  };
  execution: { allowedTargets: OrgAgentExecutionTarget[] | null };
}

export interface OrgAgentGuardrailConfig {
  mode?: 'off' | 'shadow' | 'enforce';
  enabled: boolean;
  /** 话题范围描述（喂门禁小模型），≤2000 字 */
  scopeDescription: string;
  /** 预设拒绝话术，1-500 字 */
  rejectionMessage: string;
  /** strict: 拿不准→拒；lenient: 拿不准→放行+打标 */
  strictness: 'strict' | 'lenient';
}

export interface OrgAgentRecord {
  id: string;
  tenantId: string;
  name: string;
  /** emoji 或 `org-agent-avatars/<id>.<ext>` 图片路径（路径值仅由上传接口写入） */
  avatar?: string;
  /** 图片头像的缓存版本号（上传时间戳） */
  avatarVersion?: number;
  /** 面向成员展示的职责说明，不包含内部提示语或门禁规则 */
  description: string;
  /** 面向成员展示的示例问题，点击后仅预填输入框 */
  starterPrompts: string[];
  instructions: string;
  /** 该 Agent 的固有 Skill 能力，不依赖成员个人勾选 */
  allowedSkills: string[];
  /** MVP 期间知识资源 id 同时作为 tenant-owned Skill id 注入运行时。 */
  allowedKnowledge?: string[];
  /** 每 Agent 独立运行策略；缺省时继承组织 org_agent Profile。 */
  runtime?: OrgAgentRuntimePolicy;
  /** null 表示旧数据或兼容数据中的 audience 合同无效；消费端必须 fail-closed。 */
  audience: OrgAgentAudience | null;
  guardrail: OrgAgentGuardrailConfig;
  enabled: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

/** 普通用户可见的安全公开视图（不含 instructions/guardrail/audience/Skill id） */
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
