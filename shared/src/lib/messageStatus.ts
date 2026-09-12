import { authFetch } from './authFetch';

export const MESSAGE_STATUS_BUDGET_MS = 12_000;
export const MESSAGE_STATUS_REQUEST_MS = 5_000;
export const MESSAGE_STATUS_RETRY_MS = 1_000;
export const MESSAGE_STATUS_MAX_REQUESTS = 2;

export type MessageExecutionStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
export interface AcceptedMessageStatus {
  clientMessageId: string;
  runId: string;
  sessionId: string;
  status: MessageExecutionStatus;
  deliveryMode: 'queue' | 'steer';
  queuePosition?: number;
}
export type MessageStatusUnknownReason =
  | 'cancelled' | 'deadline' | 'network' | 'unavailable' | 'invalid_response'
  | 'message_mismatch' | 'session_mismatch';
export type MessageStatusResult =
  | { kind: 'accepted'; value: AcceptedMessageStatus }
  | { kind: 'not_observed' }
  | { kind: 'unauthorized'; status: 401 | 403 }
  | { kind: 'unknown'; reason: MessageStatusUnknownReason };
export interface MessageStatusResponse { readonly status: number; json(): Promise<unknown> }
export type MessageStatusFetch = (input: string, init?: RequestInit) => Promise<MessageStatusResponse>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && value.trim() === value;
}

/** A 200 is evidence only after every correlation field has been checked. No raw errors escape. */
export function parseMessageStatus(
  body: unknown,
  clientMessageId: string,
  sessionId?: string,
): MessageStatusResult {
  if (!record(body)) return { kind: 'unknown', reason: 'invalid_response' };
  if (body.clientMessageId !== clientMessageId) return { kind: 'unknown', reason: 'message_mismatch' };
  if (!validId(body.runId) || !validId(body.sessionId)
    || (body.messageId !== undefined && body.messageId !== body.runId)
    || (body.conversationId !== undefined && body.conversationId !== body.sessionId)
    || typeof body.status !== 'string' || !['queued', 'running', 'completed', 'cancelled', 'failed'].includes(body.status)
    || (body.deliveryMode !== 'queue' && body.deliveryMode !== 'steer')
    || (body.queuePosition !== undefined
      && (!Number.isSafeInteger(body.queuePosition) || Number(body.queuePosition) < 1))) {
    return { kind: 'unknown', reason: 'invalid_response' };
  }
  if (sessionId && body.sessionId !== sessionId) return { kind: 'unknown', reason: 'session_mismatch' };
  return {
    kind: 'accepted',
    value: {
      clientMessageId,
      runId: body.runId,
      sessionId: body.sessionId,
      status: body.status as MessageExecutionStatus,
      deliveryMode: body.deliveryMode,
      ...(body.queuePosition === undefined ? {} : { queuePosition: Number(body.queuePosition) }),
    },
  };
}

export class ReadDeadlineError extends Error {
  constructor(readonly reason: 'cancelled' | 'deadline') { super(reason); }
}

/**
 * Includes credential reads AND response-body parsing, even when a platform Promise ignores abort.
 * Late resolutions/rejections are observed but never applied. Only the supplied read is cancelled.
 */
export function beforeReadDeadline<T>(
  read: (signal: AbortSignal) => Promise<T>,
  deadlineAt: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: { value: T } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      controller.abort();
      if ('value' in result) resolve(result.value); else reject(result.error);
    };
    const cancel = () => finish({ error: new ReadDeadlineError('cancelled') });
    if (signal?.aborted) { cancel(); return; }
    if (Date.now() >= deadlineAt) { finish({ error: new ReadDeadlineError('deadline') }); return; }
    signal?.addEventListener('abort', cancel);
    timer = setTimeout(() => finish({ error: new ReadDeadlineError('deadline') }), deadlineAt - Date.now());
    // Catch synchronous throws, too; the two handlers consume any late rejection.
    Promise.resolve().then(() => {
      if (settled) throw new ReadDeadlineError('cancelled');
      return read(controller.signal);
    }).then(value => finish({ value }), error => finish({ error }));
  });
}

function retryDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(new ReadDeadlineError('cancelled')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel);
  });
}

/** Existing GET only: this function has no business submission or session-creation capability. */
export async function readMessageStatus(
  clientMessageId: string,
  options: { sessionId?: string; signal?: AbortSignal; deadlineAt?: number; request?: MessageStatusFetch } = {},
): Promise<MessageStatusResult> {
  const deadlineAt = Math.min(options.deadlineAt ?? Infinity, Date.now() + MESSAGE_STATUS_BUDGET_MS);
  const request = options.request ?? authFetch;
  let result: MessageStatusResult = { kind: 'unknown', reason: 'unavailable' };
  if (!validId(clientMessageId)) return { kind: 'unknown', reason: 'invalid_response' };
  for (let attempt = 0; attempt < MESSAGE_STATUS_MAX_REQUESTS; attempt += 1) {
    if (options.signal?.aborted) return { kind: 'unknown', reason: 'cancelled' };
    if (Date.now() >= deadlineAt) return { kind: 'unknown', reason: 'deadline' };
    try {
      result = await beforeReadDeadline(async signal => {
        const response = await request(`/api/messages/${encodeURIComponent(clientMessageId)}/status`, {
          method: 'GET', cache: 'no-store', signal,
        });
        if (response.status === 401 || response.status === 403) {
          return { kind: 'unauthorized', status: response.status } as const;
        }
        if (response.status === 404) return { kind: 'not_observed' } as const;
        if (response.status !== 200) return { kind: 'unknown', reason: 'unavailable' } as const;
        try { return parseMessageStatus(await response.json(), clientMessageId, options.sessionId); }
        catch { return { kind: 'unknown', reason: 'invalid_response' } as const; }
      }, Math.min(deadlineAt, Date.now() + MESSAGE_STATUS_REQUEST_MS), options.signal);
    } catch (error) {
      result = { kind: 'unknown', reason: error instanceof ReadDeadlineError ? error.reason : 'network' };
    }
    if (result.kind === 'accepted' || result.kind === 'unauthorized'
      || (result.kind === 'unknown' && ['cancelled', 'message_mismatch', 'session_mismatch', 'invalid_response'].includes(result.reason))) return result;
    if (attempt + 1 === MESSAGE_STATUS_MAX_REQUESTS) return result;
    try {
      await beforeReadDeadline(signal => retryDelay(MESSAGE_STATUS_RETRY_MS, signal), deadlineAt, options.signal);
    } catch (error) {
      return { kind: 'unknown', reason: error instanceof ReadDeadlineError ? error.reason : 'network' };
    }
  }
  return result;
}
