export const CORRELATION_CONTEXT_VERSION = 1 as const;

export interface CorrelationContext {
  version: typeof CORRELATION_CONTEXT_VERSION;
  /** Brain-owned session identity. */
  sessionId?: string;
  /** Brain-owned durable run identity. */
  runId?: string;
  /** Model/provider tool call identity within a run. */
  toolCallId?: string;
  /** Stable logical invocation and idempotency identity. */
  invocationId?: string;
  /** Identity of one real provider execution attempt. */
  attemptId?: string;
  /** Trusted hand routing identity. */
  handId?: string;
  /** Trusted sandbox identity added by the sandbox orchestrator. */
  sandboxId?: string;
  /** Trusted release identity when one is available. */
  releaseId?: string;
}

export type CorrelationIdField = Exclude<keyof CorrelationContext, 'version'>;

export type CorrelationParseResult =
  | { ok: true; value?: CorrelationContext }
  | { ok: false; error: string };

const ID_FIELDS: readonly CorrelationIdField[] = [
  'sessionId',
  'runId',
  'toolCallId',
  'invocationId',
  'attemptId',
  'handId',
  'sandboxId',
  'releaseId',
];
const ALLOWED_FIELDS = new Set<string>(['version', ...ID_FIELDS]);
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;

/**
 * Parse untrusted correlation data. Unknown fields are rejected rather than
 * silently reaching logs. Legacy invocation/hand identities are merged only
 * when they agree with the versioned contract.
 */
export function parseCorrelationContext(
  raw: unknown,
  legacy: { invocationId?: unknown; handId?: unknown } = {},
): CorrelationParseResult {
  if (raw === undefined) return fromLegacy(legacy);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'context.correlation 必须是 object' };
  }
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (!ALLOWED_FIELDS.has(key)) return { ok: false, error: 'context.correlation 包含不支持字段' };
  }
  if (value.version !== CORRELATION_CONTEXT_VERSION) {
    return { ok: false, error: 'context.correlation.version 不支持' };
  }

  const parsed: CorrelationContext = { version: CORRELATION_CONTEXT_VERSION };
  for (const field of ID_FIELDS) {
    const candidate = value[field];
    if (candidate === undefined) continue;
    if (typeof candidate !== 'string' || !CORRELATION_ID_PATTERN.test(candidate)) {
      return { ok: false, error: `context.correlation.${field} 格式非法` };
    }
    parsed[field] = candidate;
  }
  for (const field of ['invocationId', 'handId'] as const) {
    const candidate = legacy[field];
    if (candidate === undefined) continue;
    if (typeof candidate !== 'string' || !CORRELATION_ID_PATTERN.test(candidate)) {
      return { ok: false, error: `context.${field} 格式非法` };
    }
    if (parsed[field] && candidate !== parsed[field]) {
      return { ok: false, error: `context.${field} 与 context.correlation.${field} 冲突` };
    }
    if (!parsed[field]) parsed[field] = candidate;
  }
  return { ok: true, value: parsed };
}

function fromLegacy(legacy: { invocationId?: unknown; handId?: unknown }): CorrelationParseResult {
  let value: CorrelationContext | undefined;
  for (const field of ['invocationId', 'handId'] as const) {
    const candidate = legacy[field];
    if (candidate === undefined) continue;
    if (typeof candidate !== 'string' || !CORRELATION_ID_PATTERN.test(candidate)) {
      return { ok: false, error: `context.${field} 格式非法` };
    }
    value ??= { version: CORRELATION_CONTEXT_VERSION };
    value[field] = candidate;
  }
  return { ok: true, ...(value ? { value } : {}) };
}

/** Build the only correlation fields allowed to be attached to logs. */
export function correlationLogFields(context: CorrelationContext | undefined): Record<string, string> {
  if (!context) return {};
  const fields: Record<string, string> = {};
  for (const field of ID_FIELDS) {
    const value = context[field];
    if (value) fields[field] = shortenCorrelationId(value);
  }
  return fields;
}

export function shortenCorrelationId(value: string): string {
  return value.length <= 24 ? value : `${value.slice(0, 12)}…${value.slice(-8)}`;
}
