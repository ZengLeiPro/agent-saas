/**
 * 消息反馈（点「踩」）与门禁拒答申诉的跨端契约。
 *
 * 由 `web/src/contexts/MessageFeedbackContext.tsx` 与
 * `web/src/components/GuardrailAppealButton.tsx` 里的判定逻辑下沉而来，
 * 两端共用同一份端点、幂等语义与失败文案；组件只剩 UI 绑定。
 *
 * 服务端契约（server/src/routes/feedback.ts、routes/appeals.ts）：
 * - POST /api/feedback                    { sessionId, messageId, content, comment? }
 * - GET  /api/feedback/session/:sessionId  → { items: [{ contentHash }] }
 * - POST /api/appeals                     { guardrailEventId, appealReason? }
 * - 两个 store 未装配（file backend）→ 503，前端一律隐藏入口而不是报错；
 * - 申诉幂等：同一 guardrailEventId + user 唯一，重复提交 409 = 已申诉成功态。
 */

/** 评论 / 申诉理由的长度上限，与服务端 zod schema 一致 */
export const MESSAGE_FEEDBACK_COMMENT_MAX = 500;

export const MESSAGE_FEEDBACK_PATH = '/api/feedback';
export const GUARDRAIL_APPEAL_PATH = '/api/appeals';

/** 本人在某会话的已反馈列表（刷新后恢复「已反馈」态） */
export function messageFeedbackSessionPath(sessionId: string): string {
  return `${MESSAGE_FEEDBACK_PATH}/session/${encodeURIComponent(sessionId)}`;
}

export interface MessageFeedbackInput {
  sessionId: string;
  messageId: string;
  /** 消息全文；服务端会与 transcript 比对 sha256 后落 excerpt */
  content: string;
  comment?: string;
}

/** 构造 POST /api/feedback 的 body：空白评论不发送，超长按服务端上限截断 */
export function buildMessageFeedbackPayload(input: MessageFeedbackInput): {
  sessionId: string;
  messageId: string;
  content: string;
  comment?: string;
} {
  const comment = input.comment?.trim();
  return {
    sessionId: input.sessionId,
    messageId: input.messageId,
    content: input.content,
    ...(comment ? { comment: comment.slice(0, MESSAGE_FEEDBACK_COMMENT_MAX) } : {}),
  };
}

/** GET /api/feedback/session/:id 的响应 → 已提交的 contentHash 集合（脏数据静默丢弃） */
export function parseSubmittedFeedbackHashes(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const items = (payload as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const hashes: string[] = [];
  for (const item of items) {
    const hash =
      item && typeof item === 'object'
        ? (item as { contentHash?: unknown }).contentHash
        : undefined;
    if (typeof hash === 'string' && hash) hashes.push(hash);
  }
  return hashes;
}

/**
 * 反馈请求结果：
 * - 'ok'        提交/读取成功
 * - 'disabled'  503，数据面未装配 → 隐藏入口（兼容性红线：UI 零变化）
 * - 'failed'    其余失败，保持可重试
 */
export type MessageFeedbackOutcome = 'ok' | 'disabled' | 'failed';

export function messageFeedbackOutcome(status: number): MessageFeedbackOutcome {
  if (status === 503) return 'disabled';
  return status >= 200 && status < 300 ? 'ok' : 'failed';
}

/** POST /api/appeals 的 body：空白理由不发送 */
export function buildGuardrailAppealPayload(input: {
  guardrailEventId: string;
  appealReason?: string;
}): { guardrailEventId: string; appealReason?: string } {
  const reason = input.appealReason?.trim();
  return {
    guardrailEventId: input.guardrailEventId,
    ...(reason ? { appealReason: reason.slice(0, MESSAGE_FEEDBACK_COMMENT_MAX) } : {}),
  };
}

/**
 * 申诉请求结果：
 * - 'submitted'   2xx 或 409（幂等命中，同样落到「已申诉」态）
 * - 'unavailable' 503，申诉服务未装配
 * - 'failed'      其余失败
 */
export type GuardrailAppealOutcome = 'submitted' | 'unavailable' | 'failed';

export function guardrailAppealOutcome(status: number): GuardrailAppealOutcome {
  if (status === 409) return 'submitted';
  if (status === 503) return 'unavailable';
  return status >= 200 && status < 300 ? 'submitted' : 'failed';
}

/** 申诉失败提示文案（'submitted' 无文案） */
export function guardrailAppealFailureCopy(outcome: GuardrailAppealOutcome): string | null {
  if (outcome === 'unavailable') return '申诉服务暂不可用';
  if (outcome === 'failed') return '提交失败，请稍后重试';
  return null;
}
