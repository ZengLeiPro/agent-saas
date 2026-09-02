import type { InteractionReducerState, InteractionState } from './interactionProtocol';
import { selectInteraction } from './interactionProtocol';

export type CanonicalInteractionKind = 'permission' | 'ask_user' | 'approval';
export type CanonicalInteractionFinalStatus =
  | 'approved' | 'rejected' | 'answered' | 'failed' | 'cancelled' | 'expired';

export interface CanonicalInteractionReceipt {
  status: CanonicalInteractionFinalStatus;
  requestId?: string;
  reason?: string;
  respondedAt?: string;
}

export interface ActiveInteractionSummary {
  sessionId: string;
  interactionId: string;
  kind: CanonicalInteractionKind;
  /** Monotonic interaction revision, used to reject stale detail/ACK frames. */
  version: number;
  /** Server-assigned FIFO order. Never infer this from client timestamps. */
  order: number;
  createdAt?: number;
  receipt?: CanonicalInteractionReceipt;
  title?: string;
  toolId?: string;
  toolName?: string;
  displayName?: string;
  questions?: readonly ActiveInteractionQuestion[];
  input?: unknown;
  risk?: { level: 'low' | 'medium' | 'high'; summary: string };
}

export interface ActiveInteractionQuestion {
  id?: string;
  question: string;
  header: string;
  options: readonly { label: string; description?: string }[];
  multiSelect: boolean;
  required?: boolean;
  minSelections?: number;
  maxSelections?: number;
  allowText?: boolean;
  minLength?: number;
  maxLength?: number;
}

export interface CanonicalInteractionZoneItem extends ActiveInteractionSummary {
  state?: InteractionState;
  current: boolean;
  disabled: boolean;
  disabledReason?: 'revoked' | 'read_only' | 'not_selected' | 'terminal_session';
}

export interface CanonicalInteractionZoneState {
  sessionId: string | null;
  current: CanonicalInteractionZoneItem | null;
  queue: readonly CanonicalInteractionZoneItem[];
}

export interface SelectCanonicalInteractionZoneInput {
  selectedSessionId: string | null;
  interactions: readonly ActiveInteractionSummary[];
  lifecycle?: InteractionReducerState;
  revoked?: boolean;
  readOnly?: boolean;
  terminalSession?: boolean;
}

/**
 * The sole cross-platform fixed-zone selector. It keeps all session interactions out of history,
 * chooses exactly one current card, and preserves the remaining server FIFO order.
 */
export function selectCanonicalInteractionZone(input: SelectCanonicalInteractionZoneInput): CanonicalInteractionZoneState {
  const sessionId = input.selectedSessionId;
  if (!sessionId) return { sessionId: null, current: null, queue: [] };
  const seen = new Set<string>();
  const ordered = input.interactions
    .filter((item) => item.sessionId === sessionId && !item.receipt && !seen.has(item.interactionId) && seen.add(item.interactionId))
    .sort((left, right) => left.order - right.order || left.version - right.version || left.interactionId.localeCompare(right.interactionId));
  const disabledReason = input.revoked ? 'revoked' as const
    : input.readOnly ? 'read_only' as const
      : input.terminalSession ? 'terminal_session' as const
        : undefined;
  const items = ordered.map((item, index): CanonicalInteractionZoneItem => ({
    ...item,
    ...(item.kind === 'approval' && item.input !== undefined ? { input: redactInteractionCredentials(item.input) } : {}),
    current: index === 0,
    disabled: disabledReason !== undefined,
    ...(disabledReason ? { disabledReason } : {}),
    ...(input.lifecycle ? { state: selectInteraction(input.lifecycle, sessionId, item.interactionId) } : {}),
  }));
  return { sessionId, current: items[0] ?? null, queue: items.slice(1) };
}

export interface AskUserValidationResult { valid: boolean; errors: Readonly<Record<string, string>> }

export function validateAskUserAnswers(
  questions: readonly ActiveInteractionQuestion[],
  answers: Readonly<Record<string, string | string[]>>,
): AskUserValidationResult {
  const errors: Record<string, string> = {};
  questions.forEach((question, index) => {
    const key = question.id ?? question.question;
    const raw = answers[key] ?? answers[question.question];
    const values = (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []).map((value) => value.trim()).filter(Boolean);
    if ((question.required ?? true) && values.length === 0) errors[key] = '此问题为必填项';
    else if (!question.multiSelect && values.length > 1) errors[key] = '只能选择一个答案';
    else if (question.minSelections !== undefined && values.length < question.minSelections) errors[key] = `至少选择 ${question.minSelections} 项`;
    else if (question.maxSelections !== undefined && values.length > question.maxSelections) errors[key] = `最多选择 ${question.maxSelections} 项`;
    else if (question.minLength !== undefined && values.some((value) => value.length < question.minLength!)) errors[key] = `回答至少 ${question.minLength} 个字符`;
    else if (question.maxLength !== undefined && values.some((value) => value.length > question.maxLength!)) errors[key] = `回答最多 ${question.maxLength} 个字符`;
    void index;
  });
  return { valid: Object.keys(errors).length === 0, errors };
}

const SENSITIVE_KEY = /^(authorization|cookie|password|passwd|secret|token|api[_-]?key|credential|private[_-]?key)$/i;
export function redactInteractionCredentials(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactInteractionCredentials);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key, SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactInteractionCredentials(item),
  ]));
}

/** Only a canonical receipt/outcome may produce a final user-facing state. */
export function selectCanonicalInteractionFinalStatus(
  item: Pick<ActiveInteractionSummary, 'kind' | 'receipt'>,
  state?: InteractionState,
): CanonicalInteractionFinalStatus | null {
  if (item.receipt) return item.receipt.status;
  if (!state?.serverAuthoritative) return null;
  if (state.phase === 'cancelled' || state.phase === 'expired' || state.phase === 'failed') return state.phase;
  if (state.phase === 'rejected') return 'rejected';
  if (state.phase !== 'resolved') return null;
  if (item.kind === 'ask_user') return 'answered';
  return state.response?.allow === false ? 'rejected' : 'approved';
}

/** Pending interactions are projection state, never timeline rows or unread AI replies. */
export function isCanonicalPendingInteractionTimelineItem(value: { type?: string; status?: string }): boolean {
  return (value.type === 'permission_request' || value.type === 'ask_user' || value.type === 'approval')
    && value.status === 'pending';
}
