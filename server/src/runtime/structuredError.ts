import { randomUUID } from 'node:crypto';
import {
  mapCanonicalError,
  type CanonicalError,
  type CanonicalErrorInput,
  type CanonicalErrorKind,
} from '@agent/shared';

/** Current wire error. message is safe display text; N-1 clients may still consume it. */
export interface StructuredErrorPayload {
  code: CanonicalErrorKind;
  message: string;
  /** N-1 safe string alias; current clients classify only by code. */
  error: string;
  correlationId: string;
  retryAfter?: number;
}

export interface StructuredErrorLogRecord {
  event: 'canonical_failure';
  kind: CanonicalErrorKind;
  correlationId: string;
  source: string;
  status?: number;
}

/** Server authority for HTTP and WS error metadata. It never serializes raw Error/body/credentials. */
export function buildStructuredError(input: CanonicalErrorInput): {
  failure: CanonicalError;
  payload: StructuredErrorPayload;
} {
  const classified = mapCanonicalError(input);
  const stableCorrelationId = classified.correlationId ?? randomUUID();
  const failure = classified.correlationId
    ? classified
    : mapCanonicalError({
        code: classified.kind,
        correlationId: stableCorrelationId,
        retryAfterMs: classified.retryAfterMs,
      });
  return {
    failure,
    payload: {
      code: failure.kind,
      message: failure.safeMessage,
      error: failure.safeMessage,
      correlationId: stableCorrelationId,
      ...(failure.retryAfterMs !== undefined
        ? { retryAfter: Math.max(0, Math.ceil(failure.retryAfterMs / 1000)) }
        : {}),
    },
  };
}

export function canonicalFailureLogRecord(input: {
  failure: CanonicalError;
  source: string;
  status?: number;
}): StructuredErrorLogRecord {
  return Object.freeze({
    event: 'canonical_failure' as const,
    kind: input.failure.kind,
    correlationId: input.failure.correlationId ?? 'correlation-unavailable',
    source: /^[a-z0-9_.:-]{1,80}$/i.test(input.source) ? input.source : 'unknown',
    ...(typeof input.status === 'number' ? { status: input.status } : {}),
  });
}

/** Header/body writer kept framework-neutral for route tests and Express adapters. */
export function sendStructuredHttpError(
  response: {
    status(code: number): unknown;
    setHeader?(name: string, value: string): unknown;
    set?(name: string, value: string): unknown;
    json(body: StructuredErrorPayload): unknown;
  },
  status: number,
  input: Omit<CanonicalErrorInput, 'status' | 'source'>,
): StructuredErrorPayload {
  const { payload } = buildStructuredError({ ...input, source: 'http', status });
  response.status(status);
  if (payload.retryAfter !== undefined) {
    if (response.setHeader) response.setHeader('Retry-After', String(payload.retryAfter));
    else response.set?.('Retry-After', String(payload.retryAfter));
  }
  response.json(payload);
  return payload;
}
