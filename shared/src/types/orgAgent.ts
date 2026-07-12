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
}

export interface OrgAgentGuardrailConfig {
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
  /** emoji */
  avatar?: string;
  instructions: string;
  /** 该 Agent 的固有 Skill 能力，不依赖成员个人勾选 */
  allowedSkills: string[];
  audience: OrgAgentAudience;
  guardrail: OrgAgentGuardrailConfig;
  enabled: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

/** 普通用户可见的裁剪视图（不含 instructions/guardrail/audience） */
export interface OrgAgentSummary {
  id: string;
  name: string;
  avatar?: string;
}
