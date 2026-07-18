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

/**
 * 门禁事件判定值——支持 shadow 后缀（B4 · § 4.4.4 shadow 数据看板）。
 * 后端 fire-and-forget 写入 shadow 模式落库时会打 `_shadow` 后缀（如 `off_topic_shadow`），
 * 前端看板据此过滤"仅看 shadow / 仅看 enforce / 全部"。
 */
export type QaGuardrailVerdict =
  | 'off_topic'
  | 'pass_flagged'
  | 'off_topic_shadow'
  | 'pass_flagged_shadow';

export interface QaGuardrailEvent {
  id: string;
  tenantId: string;
  orgAgentId: string;
  userId?: string;
  username?: string;
  sessionId?: string;
  clientMsgId?: string;
  verdict: QaGuardrailVerdict;
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
  verdict?: QaGuardrailVerdict;
  from?: string;
  to?: string;
}

/**
 * shadow 数据看板过滤范围——`shadow` 仅看 `_shadow` 后缀事件（判定不生效期观察）；
 * `enforce` 仅看无后缀事件（生产判定）；`all` 全部。
 */
export type QaGuardrailMode = 'all' | 'shadow' | 'enforce';

/** 拒答 Top 聚合项（视图 1）——message_text 或专家维度桶 */
export interface QaGuardrailAggregateItem {
  bucket: string;
  count: number;
  /** 样例 message_text（截断到 120 字），用于管理员判断这类问题该不该放 */
  sampleTexts: string[];
  /** 该桶下判定分布 */
  offTopic: number;
  passFlagged: number;
}

/** 门禁模型分布（视图 2）——命中主档 / fallback 命中的比例 */
export interface QaGuardrailModelBreakdown {
  model: string;
  count: number;
  ratio: number;
}

/** 门禁延迟分位数（视图 3） */
export interface QaGuardrailLatencyStats {
  p50: number | null;
  p90: number | null;
  p99: number | null;
  samples: number;
}

/** 门禁看板汇总数据（视图 1-3 全部来自 events 派生，视图 4 走 appeals 端点） */
export interface QaGuardrailBoard {
  total: number;
  offTopicCount: number;
  passFlaggedCount: number;
  topRejections: QaGuardrailAggregateItem[];
  modelBreakdown: QaGuardrailModelBreakdown[];
  fallbackHitRate: number;
  latency: QaGuardrailLatencyStats;
  /** 逐日拒答数（视图 3 latency trend 附带的日拒答数）——最近 N 天 */
  dailyCounts: Array<{ date: string; count: number }>;
}

/**
 * 员工申诉记录（B4 · 新表 `runtime_guardrail_appeals`，本 MVP 新增）
 * MVP 后端端点：`GET /api/tenant/appeals` + `POST /api/tenant/appeals/:id/handle`；
 * 未装配 → 前端展示"申诉功能未部署"提示但不阻断其他视图。
 */
export interface QaAppealItem {
  id: string;
  tenantId: string;
  orgAgentId: string;
  guardrailEventId: string;
  userId: string;
  username?: string;
  /** 员工在拒答后填写的申诉理由 */
  reason: string;
  /** 门禁判定的原始 message_text（对照参照） */
  messageText: string;
  /** 门禁判定结果（off_topic / pass_flagged） */
  verdict: QaGuardrailVerdict;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: string;
  resolvedBy?: string;
  resolvedAt?: string;
}

export interface QaAppealsFilter {
  tenantId?: string;
  orgAgentId?: string;
  status?: 'pending' | 'accepted' | 'rejected';
}

export interface QaFeedbackFilter {
  tenantId?: string;
  orgAgentId?: string;
  userId?: string;
  from?: string;
  to?: string;
}
