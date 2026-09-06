import type { AgentTargetCatalog } from '../lib/agentTarget';

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
  executionMode: 'direct' | 'dispatcher';
  workerModel: { strategy: 'inherit' } | { strategy: 'fixed'; modelRef: string };
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
  /**
   * 定制项目能力（`app__<systemId>__<capabilityId>`，WP3 / 规范 §6.1），与 `mcp` 平行。
   * 名单里写**规范化后**的 systemId / capabilityId（`-`/`.` 都变 `_`），
   * `capabilityAllowlist` / `denyCapabilities` 也接受完整工具名。
   *
   * 注意：`tools.allowlist` 非空时会**静默滤掉**任何未列名工具，包括全部 `app__*`。
   * 要给专职 Agent 开定制项目能力，要么让 `tools.allowlist` 为 null，
   * 要么把对应工具名一并写进 `tools.allowlist`。
   */
  apps: {
    systemAllowlist: string[] | null;
    capabilityAllowlist: string[] | null;
    denySystems: string[];
    denyCapabilities: string[];
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

/** GET /api/org-agents/mine：个人与被指派组织 Agent 的统一 target 目录。 */
export type OrgAgentMineResponse = AgentTargetCatalog<OrgAgentSummary>;
