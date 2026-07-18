/**
 * 员工申诉（runtime_guardrail_appeals）数据类型
 *
 * 员工被专职 Agent 门禁拒答后可提交申诉，管理员在 QaConsole 侧处理：accepted
 * 表示门禁 scopeDescription 有误伤、需要调整；rejected 表示拒答正确。申诉率是
 * 门禁 scope 准不准的唯一真理指标（B4 § 4.3.2）。
 *
 * PG 落库；file backend 时 route 路径 503 → 前端隐藏入口。
 */

export type GuardrailAppealStatus = 'pending' | 'accepted' | 'rejected';

export interface GuardrailAppealInsert {
  tenantId: string;
  guardrailEventId: string;
  userId: string;
  /** 被拒答的原始消息（server 冗余存一份，方便管理员在申诉队列里独立看） */
  userMessage: string;
  /** 涉及的企业专家 id（冗余存，用于 QaConsole 按 expertId 过滤 + 索引） */
  expertId: string;
  /** 员工填写的申诉理由，可选 */
  appealReason?: string;
}

export interface GuardrailAppealRecord {
  id: string;
  tenantId: string;
  guardrailEventId: string;
  userId: string;
  userMessage: string;
  expertId: string;
  appealReason?: string;
  status: GuardrailAppealStatus;
  handledBy?: string;
  handledAt?: string;
  /** 管理员处理时可选留言（内部备注） */
  handleNote?: string;
  createdAt: string;
}

export interface GuardrailAppealListFilter {
  tenantId: string;
  status?: GuardrailAppealStatus;
  expertId?: string;
  userId?: string;
  offset?: number;
  limit?: number;
}

export interface GuardrailAppealListResult {
  items: GuardrailAppealRecord[];
  total: number;
}

/** 从 guardrail_events 表按 id 取 owner 用于越权守卫的裁剪结果 */
export interface GuardrailEventOwnerLookup {
  tenantId: string;
  userId?: string;
  orgAgentId: string;
  messageText: string;
}

export interface AppealHandleInput {
  status: 'accepted' | 'rejected';
  handledBy: string;
  handleNote?: string;
}
