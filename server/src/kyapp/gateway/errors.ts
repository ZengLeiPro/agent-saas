/**
 * WP3：§6.5 错误码 → **客户面文案**映射（规范 §6.5、§6.6）。
 *
 * 三条纪律，逐条对应规范原文：
 * 1. **KY Agent 只按 `code` 渲染自有文案，绝不展示定制项目的 `message`。**
 *    定制项目的 `message` 只进日志（`error.details` 直接丢弃，连日志都不进）。
 * 2. `retryable` 只是提示，**重试的唯一依据是 §6.2-5 的「HTTP 类别 × safeToRetry」**
 *    （实现在 `lcid.ts`），本文件不参与重试判定。
 * 3. 客户面文案不写技术归因（不出现「上游」「HTTP」「网关」这类词），
 *    术语用「系统」，不用「定制项目」「租户」。
 */
import {
  APP_ERROR_CODES,
  GATEWAY_ERROR_CODES,
  isAppErrorCode,
  type AppErrorCode,
  type ErrorCode,
  type GatewayErrorCode,
} from '@kaiyan/ky-app-contract';

/**
 * §6.5 表逐条对齐。`maintenance` 与 `upstream_unavailable` 同为 503 但**文案不同**
 * （「系统正在升级」/「暂时不可用」），不要合并。
 */
const MESSAGES: Readonly<Record<ErrorCode, string>> = {
  unauthorized: '系统连接已失效，请刷新页面。',
  token_replayed: '系统连接已失效，请刷新页面。',
  forbidden: '你没有权限执行这个操作。',
  approval_required: '这个操作需要你确认后才能执行。',
  installation_disabled: '该系统已停用。',
  directory_stale: '系统组织信息未同步，暂不能执行写操作。',
  not_found: '未找到对应记录。',
  invalid_input: '参数不完整，请补充后重试。',
  idempotency_mismatch: '记录正在处理，请稍后刷新。',
  in_progress: '记录正在处理，请稍后刷新。',
  digest_mismatch: '该系统正在更新，暂不可操作。',
  // §6.5 原文标注「平台内部，不面向客户」：不泄漏内部语义，按通用内部错误渲染。
  state_gap: '系统内部错误，已记录。',
  response_too_large: '结果太多，请缩小范围。',
  rate_limited: '系统繁忙，稍后重试。',
  maintenance: '系统正在升级。',
  upstream_unavailable: '系统暂时不可用。',
  internal: '系统内部错误，已记录。',
  outcome_unknown: '操作结果未确认，请在系统中核对。',
  approval_channel_unavailable: '该操作需要在网页端确认。',
  system_needs_reregistration: '该系统正在更新，暂不可操作。',
};

/** §6.5 表里注明「平台内部，不面向客户」的码：客户面按通用内部错误渲染。 */
const INTERNAL_ONLY_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['state_gap']);

/**
 * Gateway 自己的处置结果，**不在 §6.5 的码表里**，因此单列。
 * 都来自 §6.6 客户面失败场景表。
 */
export const GATEWAY_LOCAL_OUTCOMES = [
  /** §6.6「10 分钟无人确认」。措辞必须让客户确信没有副作用。 */
  'approval_timeout',
  /** 客户在确认卡片上点了拒绝。 */
  'approval_declined',
  /** 能力不在本会话快照里（能力已下线 / 系统停用 / 会话首个 run 未取到清单）。 */
  'capability_unavailable',
] as const;

export type GatewayLocalOutcome = (typeof GATEWAY_LOCAL_OUTCOMES)[number];

const LOCAL_MESSAGES: Readonly<Record<GatewayLocalOutcome, string>> = {
  approval_timeout: '操作已取消，未写入任何数据。',
  approval_declined: '操作已取消，未写入任何数据。',
  capability_unavailable: '该系统暂未开放此操作。',
};

/** Gateway 内部处置与 §6.5 码的并集，作为 `tool_audit.errorCode` 的取值域。 */
export type GatewayFailureCode = ErrorCode | GatewayLocalOutcome;

const LOCAL_CODE_SET: ReadonlySet<string> = new Set<string>(GATEWAY_LOCAL_OUTCOMES);

export function isGatewayLocalOutcome(value: unknown): value is GatewayLocalOutcome {
  return typeof value === 'string' && LOCAL_CODE_SET.has(value);
}

/** 全部可能出现在客户面的失败码（用于覆盖率测试与文案审校）。 */
export const ALL_GATEWAY_FAILURE_CODES: readonly GatewayFailureCode[] = [
  ...APP_ERROR_CODES,
  ...GATEWAY_ERROR_CODES,
  ...GATEWAY_LOCAL_OUTCOMES,
];

/**
 * 失败码 → 客户面文案。**这是客户唯一会看到的字符串**。
 * 未知码（定制项目发了码表外的值）一律按 `internal` 渲染，绝不回显原值。
 */
export function customerMessageFor(code: string | undefined | null): string {
  if (isGatewayLocalOutcome(code)) return LOCAL_MESSAGES[code];
  if (typeof code === 'string' && code in MESSAGES) return MESSAGES[code as ErrorCode];
  return MESSAGES.internal;
}

/** 该码在 §6.5 表里是否标注为「不面向客户」。 */
export function isInternalOnlyCode(code: string | undefined | null): boolean {
  return typeof code === 'string' && INTERNAL_ONLY_CODES.has(code as ErrorCode);
}

/**
 * 从定制项目的响应体里解析出**可信的**错误码（附录 D）。
 * 不认识的码 → `internal`；`details` 直接丢弃；`message` 由调用方只写日志。
 */
export function parseAppErrorCode(payload: unknown): AppErrorCode {
  if (typeof payload !== 'object' || payload === null) return 'internal';
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return 'internal';
  const code = (error as { code?: unknown }).code;
  return isAppErrorCode(code) ? code : 'internal';
}

/** 定制项目的 `message`：只进日志，截断到 200 字，永不进客户面与模型上下文。 */
export function parseAppErrorLogMessage(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.trim() ? message.trim().slice(0, 200) : undefined;
}

/** HTTP 状态 → §6.5 码的兜底映射（定制项目没给合法 body 时用）。 */
export function fallbackCodeForStatus(status: number): AppErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 400) return 'invalid_input';
  if (status === 409) return 'in_progress';
  if (status === 422) return 'response_too_large';
  if (status === 429) return 'rate_limited';
  if (status === 503) return 'upstream_unavailable';
  return 'internal';
}

export type { AppErrorCode, ErrorCode, GatewayErrorCode };
