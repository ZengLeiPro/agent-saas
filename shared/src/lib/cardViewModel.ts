import type { MessageItem } from '../types/message';
import type { InteractionResponse, InteractionState } from './interactionProtocol';
import {
  canInteract,
  createInteractionRequestId,
  isInteractionSubmitting,
} from './interactionProtocol';
import type {
  RenderErrorDomain,
  RenderTimelineItem,
  RenderTimelineStatus,
} from './renderModel';

export const CARD_VIEW_MODEL_VERSION = 1 as const;

export type CardKind = 'tool' | 'permission' | 'ask_user' | 'approval' | 'unknown';
export type ToolCardStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type InteractionCardStatus =
  | 'pending'
  | 'submitting'
  | 'accepted'
  | 'resolved'
  | 'rejected'
  | 'failed'
  | 'cancelled'
  | 'expired';
export type CardStatus = ToolCardStatus | InteractionCardStatus;
export type CardActionKind = 'expand' | 'allow' | 'deny' | 'submit' | 'approve' | 'reject' | 'retry';
export type ApprovalSurface = 'workflow' | 'hand';

export interface CardTextDetail {
  /** Plain text only. Renderers must not interpret this value as HTML, JS, markdown, or a URL. */
  format: 'plain_text';
  text: string;
  truncated: boolean;
  sanitized: true;
}

export interface CardOutcomeViewModel {
  status: Extract<InteractionCardStatus, 'resolved' | 'rejected' | 'failed' | 'cancelled' | 'expired'> | 'succeeded';
  label: string;
  reason?: string;
  /** Reasons for resolved/rejected/expired are only exposed from an authoritative server outcome. */
  authoritative: boolean;
  live: 'polite' | 'assertive';
}

export interface CardActionViewModel {
  id: string;
  kind: CardActionKind;
  label: string;
  visible: boolean;
  disabled: boolean;
  busy: boolean;
  sessionId?: string;
  interactionId?: string;
  requestId?: string;
  response?: InteractionResponse;
  /** Automatic transport retries are forbidden for external workflow/hand side effects. */
  retryPolicy: 'none' | 'manual_same_request';
}

export interface CardQuestionOptionViewModel {
  id: string;
  label: string;
  description?: string;
  selected?: boolean;
  disabled: boolean;
}

export interface CardQuestionViewModel {
  id: string;
  label: string;
  header: string;
  multiSelect: boolean;
  options: readonly CardQuestionOptionViewModel[];
}

export interface CardAccessibilityViewModel {
  heading: string;
  expanded: boolean;
  busy: boolean;
  disabled: boolean;
  outcomeLiveAnnouncement?: string;
}

export interface CardViewModel {
  version: typeof CARD_VIEW_MODEL_VERSION;
  id: string;
  kind: CardKind;
  status: CardStatus;
  title: string;
  subtitle?: string;
  toolName?: string;
  displayName?: string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  inputSummary?: string;
  outputSummary?: string;
  error?: { domain: RenderErrorDomain; message?: string };
  defaultExpanded: boolean;
  detail?: CardTextDetail;
  questions?: readonly CardQuestionViewModel[];
  actions: readonly CardActionViewModel[];
  outcome?: CardOutcomeViewModel;
  accessibility: CardAccessibilityViewModel;
  /** Used by transport orchestration; renderers must never auto retry when true. */
  externalSideEffect: boolean;
}

export interface ToolCardPresenterInput {
  item: RenderTimelineItem;
  displayName?: string;
  startedAt?: number;
  endedAt?: number;
  expanded?: boolean;
  maxSummaryLength?: number;
  maxDetailLength?: number;
}

export interface InteractionQuestionInput {
  question: string;
  header: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
}

export interface InteractionCardPresenterInput {
  sessionId: string;
  interactionId: string;
  kind: Exclude<CardKind, 'tool'>;
  state?: InteractionState;
  toolName?: string;
  displayName?: string;
  input?: unknown;
  questions?: readonly InteractionQuestionInput[];
  answers?: Record<string, string | string[]>;
  approvalSurface?: ApprovalSurface;
  expanded?: boolean;
  /** Legacy/durable authority that an interaction is currently pending. */
  pending?: boolean;
}

const SENSITIVE_KEYS = new Set([
  'authorization', 'token', 'accesstoken', 'refreshtoken', 'idtoken', 'secret', 'clientsecret',
  'password', 'passwd', 'apikey', 'privatekey', 'path', 'filepath', 'relativepath', 'absolutepath',
]);

function normalizedKey(value: string): string {
  return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function redactStructured(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) return value.map((item) => redactStructured(item, seen));
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizedKey(key);
    const isPath = normalized === 'path' || normalized.endsWith('path');
    const isSecret = SENSITIVE_KEYS.has(normalized) || normalized.endsWith('token') || normalized.endsWith('secret');
    if (isPath || isSecret) {
      output[key] = isPath ? '[hidden]' : '[redacted]';
    } else {
      output[key] = redactStructured(item, seen);
    }
  }
  seen.delete(value as object);
  return output;
}

function parseStructured(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return value;
  try { return JSON.parse(trimmed) as unknown; } catch { return value; }
}

/**
 * Structural card sanitizer. Sensitive fields are selected by key, never by scanning arbitrary
 * string values. The output is plain text and strips controls used for bidi/UI spoofing.
 */
export function sanitizeCardDetail(value: unknown, maxLength = 16_384): CardTextDetail {
  const structured = redactStructured(parseStructured(value));
  const raw = typeof structured === 'string' ? structured : JSON.stringify(structured, null, 2) ?? '';
  const safe = raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '');
  const truncated = safe.length > maxLength;
  return { format: 'plain_text', text: truncated ? `${safe.slice(0, maxLength)}\n…` : safe, truncated, sanitized: true };
}

function summary(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const detail = sanitizeCardDetail(value, maxLength);
  return detail.text.replace(/\s+/g, ' ').trim();
}

function toolStatus(status: RenderTimelineStatus): ToolCardStatus {
  if (status === 'pending' || status === 'queued' || status === 'waiting') return 'pending';
  if (status === 'running') return 'running';
  if (status === 'failed' || status === 'timeout' || status === 'blocked') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  return 'succeeded';
}

function sourceTool(item: RenderTimelineItem): {
  toolName: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  durationMs?: number;
} | null {
  const segment = item.content.find((entry) => entry.type === 'tool');
  if (!segment || segment.type !== 'tool') return null;
  const message = item.source.type === 'message' || item.source.type === 'activity' ? item.source.message : undefined;
  const toolMessage = message?.type === 'tool_use' ? message : undefined;
  return {
    toolName: segment.toolName,
    input: segment.input,
    output: segment.result,
    ...(toolMessage?.error ? { error: toolMessage.error } : {}),
    ...(toolMessage?.durationMs !== undefined ? { durationMs: toolMessage.durationMs } : {}),
  };
}

export function selectToolCardViewModel(input: ToolCardPresenterInput): CardViewModel {
  const { item } = input;
  const source = sourceTool(item);
  if (!source || item.kind !== 'tool_activity') return selectUnknownCardViewModel(item, input.expanded);
  const status = toolStatus(item.status);
  const maxSummaryLength = input.maxSummaryLength ?? 240;
  const maxDetailLength = input.maxDetailLength ?? 16_384;
  const startedAt = input.startedAt ?? item.timestamp;
  const durationMs = source.durationMs ?? (
    startedAt !== undefined && input.endedAt !== undefined ? Math.max(0, input.endedAt - startedAt) : undefined
  );
  const endedAt = input.endedAt ?? (
    startedAt !== undefined && durationMs !== undefined && status !== 'running' && status !== 'pending'
      ? startedAt + durationMs : undefined
  );
  const displayName = input.displayName ?? source.toolName;
  const expanded = input.expanded ?? false;
  const inputDetail = sanitizeCardDetail(source.input, maxDetailLength);
  const outputDetail = sanitizeCardDetail(source.error ?? source.output, maxDetailLength);
  const detailText = [
    source.input !== undefined ? `Input\n${inputDetail.text}` : '',
    source.error !== undefined ? `Error\n${outputDetail.text}` : source.output !== undefined ? `Output\n${outputDetail.text}` : '',
  ].filter(Boolean).join('\n\n');
  const cardId = `card:${safeStableToken(item.id)}`;
  const outcome = status === 'succeeded'
    ? { status: 'succeeded' as const, label: '已完成', authoritative: true, live: 'polite' as const }
    : status === 'failed'
      ? { status: 'failed' as const, label: '执行失败', authoritative: true, live: 'assertive' as const }
      : status === 'cancelled'
        ? { status: 'cancelled' as const, label: '已取消', authoritative: true, live: 'polite' as const }
        : undefined;
  const action: CardActionViewModel = {
    id: `${cardId}:expand`, kind: 'expand', label: expanded ? '收起详情' : '展开详情',
    visible: true, disabled: false, busy: false, retryPolicy: 'none',
  };
  return {
    version: CARD_VIEW_MODEL_VERSION,
    id: cardId,
    kind: 'tool',
    status,
    title: displayName,
    subtitle: source.toolName === displayName ? undefined : source.toolName,
    toolName: source.toolName,
    displayName,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(summary(source.input, maxSummaryLength) ? { inputSummary: summary(source.input, maxSummaryLength) } : {}),
    ...(summary(source.error ?? source.output, maxSummaryLength) ? { outputSummary: summary(source.error ?? source.output, maxSummaryLength) } : {}),
    ...(status === 'failed' ? { error: { domain: item.error?.domain ?? 'tool', ...(source.error ? { message: summary(source.error, maxSummaryLength) } : {}) } } : {}),
    defaultExpanded: false,
    ...(detailText ? { detail: { format: 'plain_text', text: detailText, truncated: inputDetail.truncated || outputDetail.truncated, sanitized: true } } : {}),
    actions: [action],
    ...(outcome ? { outcome } : {}),
    accessibility: {
      heading: `工具：${displayName}`,
      expanded,
      busy: status === 'running' || status === 'pending',
      disabled: false,
      ...(outcome ? { outcomeLiveAnnouncement: `${displayName}${outcome.label}` } : {}),
    },
    externalSideEffect: false,
  };
}

function interactionStatus(state: InteractionState | undefined, pending: boolean): InteractionCardStatus {
  if (state) return state.phase;
  return pending ? 'pending' : 'failed';
}

function optionId(cardId: string, questionIndex: number, optionIndex: number): string {
  return `${cardId}:question:${questionIndex}:option:${optionIndex}`;
}

function interactionActions(
  cardId: string,
  input: InteractionCardPresenterInput,
  status: InteractionCardStatus,
): CardActionViewModel[] {
  const selectorAllows = canInteract(input.state) && (input.pending ?? true);
  const busy = isInteractionSubmitting(input.state);
  if (!selectorAllows) return [];
  const make = (kind: CardActionKind, label: string, response: InteractionResponse): CardActionViewModel => {
    const requestId = createInteractionRequestId(input.sessionId, input.interactionId, response);
    return {
      id: `${cardId}:action:${kind}`,
      kind,
      label,
      visible: selectorAllows,
      disabled: !selectorAllows || busy,
      busy,
      sessionId: input.sessionId,
      interactionId: input.interactionId,
      requestId,
      response,
      retryPolicy: 'manual_same_request',
    };
  };
  if (status !== 'pending' && status !== 'failed') return [];
  if (input.kind === 'permission') return [make('allow', '允许', { allow: true }), make('deny', '拒绝', { allow: false })];
  if (input.kind === 'approval') return [make('approve', '批准', { allow: true }), make('reject', '拒绝', { allow: false })];
  if (input.kind === 'ask_user') return [make('submit', '提交回答', { answers: input.answers ?? {} })];
  return [];
}

function interactionOutcome(state: InteractionState | undefined): CardOutcomeViewModel | undefined {
  if (!state) return undefined;
  if (state.phase !== 'resolved' && state.phase !== 'rejected' && state.phase !== 'failed' && state.phase !== 'cancelled' && state.phase !== 'expired') return undefined;
  const authoritative = state.serverAuthoritative;
  const labels = { resolved: '已处理', rejected: '已拒绝', failed: '处理失败', cancelled: '已取消', expired: '已过期' } as const;
  return {
    status: state.phase,
    label: labels[state.phase],
    ...(authoritative && state.reason ? { reason: sanitizeCardDetail(state.reason, 500).text } : {}),
    authoritative,
    live: state.phase === 'failed' ? 'assertive' : 'polite',
  };
}

export function selectInteractionCardViewModel(input: InteractionCardPresenterInput): CardViewModel {
  if (input.kind === 'unknown') return selectUnknownInteractionCardViewModel(input);
  const cardId = `card:interaction:${safeStableToken(input.sessionId)}:${safeStableToken(input.interactionId)}`;
  const status = interactionStatus(input.state, input.pending ?? true);
  const displayName = input.displayName ?? input.toolName;
  const title = input.kind === 'permission'
    ? `权限请求${displayName ? `：${displayName}` : ''}`
    : input.kind === 'ask_user' ? '需要你的回答'
      : `${input.approvalSurface === 'hand' ? '外部操作' : '工作流'}审批${displayName ? `：${displayName}` : ''}`;
  const externalSideEffect = input.kind === 'approval'
    && (input.approvalSurface === 'workflow' || input.approvalSurface === 'hand');
  const expanded = input.expanded ?? input.kind === 'ask_user';
  const actions = interactionActions(cardId, input, status);
  const outcome = interactionOutcome(input.state);
  const disabled = actions.length === 0 || actions.every((action) => action.disabled);
  const busy = isInteractionSubmitting(input.state);
  const questions = input.questions?.map((question, questionIndex): CardQuestionViewModel => ({
    id: `${cardId}:question:${questionIndex}`,
    label: question.question,
    header: question.header,
    multiSelect: question.multiSelect,
    options: question.options.map((option, optionIndex) => ({
      id: optionId(cardId, questionIndex, optionIndex),
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
      disabled: !canInteract(input.state) || !(input.pending ?? true),
    })),
  }));
  return {
    version: CARD_VIEW_MODEL_VERSION,
    id: cardId,
    kind: input.kind,
    status,
    title,
    ...(input.toolName ? { toolName: input.toolName } : {}),
    ...(displayName ? { displayName } : {}),
    ...(summary(input.input, 240) ? { inputSummary: summary(input.input, 240) } : {}),
    defaultExpanded: input.kind === 'ask_user',
    ...(input.input !== undefined ? { detail: sanitizeCardDetail(input.input) } : {}),
    ...(questions ? { questions } : {}),
    actions,
    ...(outcome ? { outcome } : {}),
    accessibility: {
      heading: title,
      expanded,
      busy,
      disabled,
      ...(outcome ? { outcomeLiveAnnouncement: `${title}${outcome.label}${outcome.reason ? `：${outcome.reason}` : ''}` } : {}),
    },
    externalSideEffect,
  };
}

export function selectCardViewModelFromRenderItem(
  item: RenderTimelineItem,
  options: { sessionId?: string; interactionState?: InteractionState; expanded?: boolean } = {},
): CardViewModel {
  const message: MessageItem | undefined = item.source.type === 'message' || item.source.type === 'activity'
    ? item.source.message : undefined;
  if (item.kind === 'tool_activity' && message?.type === 'permission_request') {
    return selectInteractionCardViewModel({
      sessionId: options.sessionId ?? 'unknown-session', interactionId: message.interactionId,
      kind: 'permission', state: options.interactionState, toolName: message.toolName,
      displayName: message.toolName, input: message.toolInput, pending: message.status === 'pending',
      expanded: options.expanded,
    });
  }
  if (message?.type === 'ask_user') {
    return selectInteractionCardViewModel({
      sessionId: options.sessionId ?? 'unknown-session', interactionId: message.interactionId,
      kind: 'ask_user', state: options.interactionState, questions: message.questions,
      answers: message.answers, pending: message.status === 'pending', expanded: options.expanded,
    });
  }
  if (item.kind === 'tool_activity') return selectToolCardViewModel({ item, expanded: options.expanded });
  return selectUnknownCardViewModel(item, options.expanded);
}

function selectUnknownInteractionCardViewModel(input: InteractionCardPresenterInput): CardViewModel {
  const id = `card:interaction:${safeStableToken(input.sessionId)}:${safeStableToken(input.interactionId)}`;
  return {
    version: CARD_VIEW_MODEL_VERSION, id, kind: 'unknown', status: 'failed',
    title: '不支持的交互', defaultExpanded: false, actions: [],
    outcome: { status: 'failed', label: '无法显示此交互', authoritative: false, live: 'polite' },
    accessibility: { heading: '不支持的交互', expanded: false, busy: false, disabled: true, outcomeLiveAnnouncement: '无法显示此交互' },
    externalSideEffect: false,
  };
}

function stableOpaqueId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function safeStableToken(value: string): string {
  return /^[A-Za-z0-9:._-]+$/.test(value) ? value : `opaque-${stableOpaqueId(value)}`;
}

export function selectUnknownCardViewModel(item: Pick<RenderTimelineItem, 'id'>, expanded = false): CardViewModel {
  return {
    version: CARD_VIEW_MODEL_VERSION,
    id: `card:unknown:${stableOpaqueId(item.id)}`,
    kind: 'unknown',
    status: 'failed',
    title: '不支持的卡片',
    defaultExpanded: false,
    actions: [],
    outcome: { status: 'failed', label: '内容不可用', authoritative: false, live: 'polite' },
    accessibility: { heading: '不支持的卡片', expanded, busy: false, disabled: true, outcomeLiveAnnouncement: '不支持的卡片，内容不可用' },
    externalSideEffect: false,
  };
}

/** Cross-platform semantic contract used by Web/Mobile parity tests. */
export function cardSemanticSignature(card: CardViewModel): string {
  return [
    card.id, card.kind, card.status, card.accessibility.heading,
    card.accessibility.expanded, card.accessibility.busy, card.accessibility.disabled,
    card.actions.map((action) => `${action.id}:${action.disabled}`).join(','),
    card.questions?.flatMap((question) => question.options.map((option) => `${option.id}:${option.label}`)).join(',') ?? '',
  ].join('|');
}
