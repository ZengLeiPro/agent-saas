/** 组织对话质检台（/api/admin/qa）响应类型 */

export interface QaSessionItem {
  sessionId: string;
  title: string | null;
  userId: string | null;
  username: string | null;
  orgAgentId: string | null;
  orgAgentName: string | null;
  orgAgentAvatar: string | null;
  createdAt: string | null;
  updatedAt: string;
  runtimeStatus: string | null;
  totalCostUsd: number | null;
}

export interface QaGuardrailEvent {
  id: string;
  tenantId: string;
  orgAgentId: string;
  userId?: string;
  username?: string;
  sessionId?: string;
  clientMsgId?: string;
  verdict: 'off_topic' | 'pass_flagged';
  messageText: string;
  model?: string;
  latencyMs?: number;
  createdAt: string;
}

export interface QaFeedbackItem {
  id: string;
  tenantId: string;
  sessionId: string;
  messageId: string;
  orgAgentId?: string;
  userId: string;
  username?: string;
  verdict: 'down';
  comment?: string;
  messageExcerpt: string;
  contentHash: string;
  createdAt: string;
}

/** 数据面可用性：503（file backend 未装配 PG）→ unavailable，视图整体隐藏换提示 */
export type QaAvailability = 'unknown' | 'available' | 'unavailable';

export interface QaSessionsFilter {
  tenantId?: string;
  orgAgentId?: string;
  userId?: string;
  from?: string;
  to?: string;
}

export interface QaEventsFilter {
  tenantId?: string;
  orgAgentId?: string;
  userId?: string;
  verdict?: 'off_topic' | 'pass_flagged';
  from?: string;
  to?: string;
}

export interface QaFeedbackFilter {
  tenantId?: string;
  orgAgentId?: string;
  userId?: string;
  from?: string;
  to?: string;
}
