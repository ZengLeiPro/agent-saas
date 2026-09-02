/** M40-05: the single cross-platform error taxonomy, safe presentation and recovery policy. */

export const CANONICAL_ERROR_KINDS = [
  'auth_expired',
  'auth_revoked',
  'network_offline',
  'network_timeout',
  'tls_untrusted',
  'server_unavailable',
  'rate_limited',
  'client_misconfigured',
  'sync_overflow',
  'stale_generation',
  'org_agent_unavailable',
  'capability_unavailable',
  'attachment_upload',
  'attachment_validation',
  'interaction_conflict',
  'storage_corrupt',
  'unknown',
] as const;

export type CanonicalErrorKind = (typeof CANONICAL_ERROR_KINDS)[number];
export type CanonicalErrorTone = 'warn' | 'danger';
export type CanonicalRecoveryActionKind =
  | 'retry'
  | 'reconnect'
  | 'relogin'
  | 'open-settings'
  | 'choose-agent'
  | 'reupload'
  | 'refresh'
  | 'full-sync'
  | 'contact-admin'
  | 'none';

export interface CanonicalRecoveryAction {
  kind: CanonicalRecoveryActionKind;
  label: string;
}

export interface CanonicalError {
  kind: CanonicalErrorKind;
  title: string;
  safeMessage: string;
  tone: CanonicalErrorTone;
  retryable: boolean;
  retryAfterMs?: number;
  correlationId?: string;
  recoveryAction: CanonicalRecoveryAction;
  /** The failed operation is terminal. Renderers must clear any spinner. */
  terminal: true;
}

export type CanonicalErrorSource =
  | 'http'
  | 'ws'
  | 'chat_rejected'
  | 'runtime'
  | 'expo'
  | 'network'
  | 'tls'
  | 'upload'
  | 'session';

export interface CanonicalErrorInput {
  source?: CanonicalErrorSource;
  status?: number;
  code?: unknown;
  reasonCode?: unknown;
  retryAfter?: unknown;
  retryAfterMs?: unknown;
  correlationId?: unknown;
  online?: boolean;
  timeout?: boolean;
  tls?: boolean;
  uploadPhase?: 'upload' | 'validation';
  /** N-1 only. It is allow-list classified and is never copied to output. */
  legacyMessage?: unknown;
  error?: unknown;
}

interface ErrorDefinition {
  title: string;
  safeMessage: string;
  tone: CanonicalErrorTone;
  retryable: boolean;
  action: CanonicalRecoveryActionKind;
  label: string;
}

const DEFINITIONS: Record<CanonicalErrorKind, ErrorDefinition> = {
  auth_expired: { title: '登录已过期', safeMessage: '请重新登录后继续。', tone: 'warn', retryable: false, action: 'relogin', label: '重新登录' },
  auth_revoked: { title: '登录已失效', safeMessage: '当前登录凭据已被撤销，请重新登录。', tone: 'danger', retryable: false, action: 'relogin', label: '重新登录' },
  network_offline: { title: '当前离线', safeMessage: '恢复网络连接后即可继续。', tone: 'warn', retryable: true, action: 'reconnect', label: '重新连接' },
  network_timeout: { title: '连接超时', safeMessage: '服务暂未响应，可以安全重试。', tone: 'warn', retryable: true, action: 'retry', label: '重试' },
  tls_untrusted: { title: '无法建立安全连接', safeMessage: '请检查设备时间、网络或受信任证书设置。', tone: 'danger', retryable: false, action: 'open-settings', label: '打开设置' },
  server_unavailable: { title: '服务暂不可用', safeMessage: '服务暂时不可用，请稍后重试。', tone: 'warn', retryable: true, action: 'retry', label: '重试' },
  rate_limited: { title: '操作过于频繁', safeMessage: '请等待片刻后重试。', tone: 'warn', retryable: true, action: 'retry', label: '稍后重试' },
  client_misconfigured: { title: '应用配置有误', safeMessage: '当前应用配置无法完成此操作，请联系管理员。', tone: 'danger', retryable: false, action: 'contact-admin', label: '联系管理员' },
  sync_overflow: { title: '需要完整同步', safeMessage: '本地进度与服务端差距过大，需要重新同步。', tone: 'warn', retryable: false, action: 'full-sync', label: '完整同步' },
  stale_generation: { title: '会话状态已更新', safeMessage: '当前会话状态已失效，请刷新后继续。', tone: 'warn', retryable: false, action: 'refresh', label: '刷新状态' },
  org_agent_unavailable: { title: 'Agent 当前不可用', safeMessage: '所选组织 Agent 不可用，请选择其他 Agent。', tone: 'warn', retryable: false, action: 'choose-agent', label: '选择 Agent' },
  capability_unavailable: { title: '能力当前不可用', safeMessage: '组织当前未提供此能力，请联系管理员。', tone: 'warn', retryable: false, action: 'contact-admin', label: '联系管理员' },
  attachment_upload: { title: '附件上传失败', safeMessage: '附件未上传成功，请保留草稿并重新上传。', tone: 'warn', retryable: false, action: 'reupload', label: '重新上传' },
  attachment_validation: { title: '附件无法使用', safeMessage: '附件格式、大小或状态不符合要求，请重新选择。', tone: 'warn', retryable: false, action: 'reupload', label: '重新选择' },
  interaction_conflict: { title: '此操作已发生变化', safeMessage: '该交互已被处理或更新，请刷新查看最新状态。', tone: 'warn', retryable: false, action: 'refresh', label: '刷新状态' },
  storage_corrupt: { title: '本地数据不可用', safeMessage: '本地数据无法安全读取，请联系管理员处理。', tone: 'danger', retryable: false, action: 'contact-admin', label: '联系管理员' },
  unknown: { title: '出现未知问题', safeMessage: '暂时无法完成此操作，请稍后再试或联系管理员。', tone: 'danger', retryable: false, action: 'none', label: '' },
};

const CODE_KIND: Readonly<Record<string, CanonicalErrorKind>> = Object.freeze({
  auth_expired: 'auth_expired', token_expired: 'auth_expired', jwt_expired: 'auth_expired', credential_expired: 'auth_expired',
  auth_revoked: 'auth_revoked', token_revoked: 'auth_revoked', session_revoked: 'auth_revoked', access_denied: 'auth_revoked',
  network_offline: 'network_offline', offline: 'network_offline', network_request_failed: 'network_offline',
  network_timeout: 'network_timeout', timeout: 'network_timeout', request_timeout: 'network_timeout', etimedout: 'network_timeout', abort_error: 'network_timeout',
  tls_untrusted: 'tls_untrusted', cert_untrusted: 'tls_untrusted', certificate_unknown: 'tls_untrusted', ssl_error: 'tls_untrusted',
  server_unavailable: 'server_unavailable', server_draining: 'server_unavailable', service_unavailable: 'server_unavailable', server_error: 'server_unavailable',
  rate_limited: 'rate_limited', rate_limit: 'rate_limited', too_many_requests: 'rate_limited',
  client_misconfigured: 'client_misconfigured', invalid_configuration: 'client_misconfigured', provider_not_configured: 'client_misconfigured', callback_domain_missing: 'client_misconfigured', stt_not_configured: 'client_misconfigured',
  sync_overflow: 'sync_overflow', buffer_overflow: 'sync_overflow',
  stale_generation: 'stale_generation', stale_auth_epoch: 'stale_generation', generation_mismatch: 'stale_generation',
  org_agent_unavailable: 'org_agent_unavailable', personal_agent_disabled: 'org_agent_unavailable',
  capability_unavailable: 'capability_unavailable', sso_unavailable: 'capability_unavailable', model_not_allowed: 'capability_unavailable',
  attachment_upload: 'attachment_upload', attachment_state_failed: 'attachment_upload', upload_failed: 'attachment_upload',
  attachment_validation: 'attachment_validation', attachment_id_missing: 'attachment_validation', attachment_id_invalid: 'attachment_validation', attachment_not_found: 'attachment_validation', invalid_attachment: 'attachment_validation',
  interaction_conflict: 'interaction_conflict', duplicate_inflight: 'interaction_conflict', session_locked: 'interaction_conflict', interaction_expired: 'interaction_conflict', interaction_already_resolved: 'interaction_conflict',
  storage_corrupt: 'storage_corrupt', storage_corrupted: 'storage_corrupt', database_corrupt: 'storage_corrupt',
  invalid_submission: 'client_misconfigured', empty_message: 'client_misconfigured',
});

const RETRYABLE_KINDS = new Set<CanonicalErrorKind>([
  'network_offline', 'network_timeout', 'server_unavailable', 'rate_limited',
]);

function safeOwn(input: unknown, key: string): unknown {
  if (!input || (typeof input !== 'object' && typeof input !== 'function')) return undefined;
  try {
    return Object.prototype.hasOwnProperty.call(input, key)
      ? (input as Record<string, unknown>)[key]
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizedCode(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 120) return undefined;
  const normalized = value.trim().toLowerCase().replace(/[.\s-]+/g, '_');
  return /^[a-z0-9_]+$/.test(normalized) ? normalized : undefined;
}

function safeCorrelationId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/.test(trimmed) ? trimmed : undefined;
}

/** Parses milliseconds, while mapCanonicalError first converts numeric Retry-After seconds. */
function retryAfterMs(value: unknown, nowMs: number): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.min(Math.round(value), 24 * 60 * 60 * 1000);
  }
  if (typeof value !== 'string' || value.length > 80) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.round(seconds * 1000), 24 * 60 * 60 * 1000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(Math.max(0, date - nowMs), 24 * 60 * 60 * 1000);
}

function legacyKind(message: unknown): CanonicalErrorKind | undefined {
  if (typeof message !== 'string' || message.length > 500) return undefined;
  // N-1 compatibility is intentionally a small allow-list. The message is never displayed.
  const lower = message.toLowerCase();
  if (/\b(offline|network request failed|internet connection)\b/.test(lower)) return 'network_offline';
  if (/\b(timed? ?out|timeout)\b/.test(lower)) return 'network_timeout';
  if (/\b(certificate|cert_|ssl|tls)\b/.test(lower)) return 'tls_untrusted';
  if (/\b(token|login|session)\b.{0,24}\b(expired|过期)\b/.test(lower)) return 'auth_expired';
  if (/\b(revoked|撤销)\b/.test(lower)) return 'auth_revoked';
  if (/\b(rate.?limit|too many requests|429)\b/.test(lower)) return 'rate_limited';
  if (/\b(service unavailable|server draining|503|bad gateway)\b/.test(lower)) return 'server_unavailable';
  if (/\b(sync overflow|buffer overflow)\b/.test(lower)) return 'sync_overflow';
  return undefined;
}

function statusKind(status: number | undefined): CanonicalErrorKind | undefined {
  if (status === 401) return 'auth_expired';
  if (status === 403) return 'auth_revoked';
  if (status === 408 || status === 504) return 'network_timeout';
  if (status === 409) return 'interaction_conflict';
  if (status === 429) return 'rate_limited';
  if (status === 502 || status === 503) return 'server_unavailable';
  return undefined;
}

function inferKind(input: CanonicalErrorInput): CanonicalErrorKind {
  const nestedError = safeOwn(input, 'error');
  const nested = safeOwn(nestedError, 'code') ?? safeOwn(nestedError, 'name');
  const code = normalizedCode(safeOwn(input, 'code')) ?? normalizedCode(safeOwn(input, 'reasonCode')) ?? normalizedCode(nested);
  if (code && CODE_KIND[code]) return CODE_KIND[code];
  if (safeOwn(input, 'online') === false) return 'network_offline';
  if (safeOwn(input, 'tls') === true) return 'tls_untrusted';
  if (safeOwn(input, 'timeout') === true) return 'network_timeout';
  if (safeOwn(input, 'uploadPhase') === 'validation') return 'attachment_validation';
  if (safeOwn(input, 'uploadPhase') === 'upload') return 'attachment_upload';
  const status = safeOwn(input, 'status');
  return statusKind(typeof status === 'number' ? status : undefined)
    ?? legacyKind(safeOwn(input, 'legacyMessage'))
    ?? legacyKind(safeOwn(nestedError, 'message'))
    ?? 'unknown';
}

/** Maps all transports and runtimes into a renderer-safe canonical failure. Raw values are never copied. */
export function mapCanonicalError(input: CanonicalErrorInput | unknown, nowMs = Date.now()): CanonicalError {
  const safeInput = input && typeof input === 'object' ? input as CanonicalErrorInput : {};
  const kind = inferKind(safeInput);
  const definition = DEFINITIONS[kind];
  const explicitMs = retryAfterMs(safeOwn(safeInput, 'retryAfterMs'), nowMs);
  const rawRetryAfter = safeOwn(safeInput, 'retryAfter');
  const headerMs = retryAfterMs(
    typeof rawRetryAfter === 'number' ? rawRetryAfter * 1000 : rawRetryAfter,
    nowMs,
  );
  const correlationId = safeCorrelationId(safeOwn(safeInput, 'correlationId'))
    ?? safeCorrelationId(safeOwn(safeOwn(safeInput, 'error'), 'correlationId'));
  const delay = kind === 'rate_limited' || RETRYABLE_KINDS.has(kind) ? explicitMs ?? headerMs : undefined;
  return Object.freeze({
    kind,
    title: definition.title,
    safeMessage: definition.safeMessage,
    tone: definition.tone,
    retryable: definition.retryable,
    ...(delay !== undefined ? { retryAfterMs: delay } : {}),
    ...(correlationId ? { correlationId } : {}),
    recoveryAction: Object.freeze({ kind: definition.action, label: definition.label }),
    terminal: true as const,
  });
}

export const canonicalErrorMapper = mapCanonicalError;

export interface RetryPolicyInput {
  failure: CanonicalError;
  attempt: number;
  idempotent: boolean;
  online: boolean;
  foreground: boolean;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: number;
}

export interface RetryDecision {
  allowed: boolean;
  delayMs: number;
  reason?: 'not_retryable' | 'not_idempotent' | 'offline' | 'background';
}

/** Pure retry policy: idempotency + foreground/online gates, Retry-After, capped exponential backoff. */
export function decideCanonicalRetry(input: RetryPolicyInput): RetryDecision {
  if (!input.failure.retryable || input.failure.recoveryAction.kind !== 'retry') return { allowed: false, delayMs: 0, reason: 'not_retryable' };
  if (!input.idempotent) return { allowed: false, delayMs: 0, reason: 'not_idempotent' };
  if (!input.online) return { allowed: false, delayMs: 0, reason: 'offline' };
  if (!input.foreground) return { allowed: false, delayMs: 0, reason: 'background' };
  const base = Math.max(1, input.baseDelayMs ?? 500);
  const cap = Math.max(base, input.maxDelayMs ?? 30_000);
  const exponent = Math.min(Math.max(0, Math.floor(input.attempt)), 20);
  const backoff = Math.min(cap, base * (2 ** exponent));
  const jitter = Math.min(1, Math.max(0, input.jitter ?? 0));
  const jittered = Math.round(backoff * (1 + jitter));
  return { allowed: true, delayMs: Math.max(input.failure.retryAfterMs ?? 0, Math.min(cap, jittered)) };
}

export interface CanonicalRecoveryContext {
  idempotent: boolean;
  online: boolean;
  foreground: boolean;
  attempt?: number;
  retry?(): void | Promise<void>;
  reconnect?(): void | Promise<void>;
  relogin?(): void | Promise<void>;
  openSettings?(): void | Promise<void>;
  chooseAgent?(): void | Promise<void>;
  refresh?(): void | Promise<void>;
  contactAdmin?(): void | Promise<void>;
  /** Must synchronously fence send and replay before fullSync starts. */
  fenceSendReplay?(): void;
  fullSync?(): void | Promise<void>;
  draft?: unknown;
  createRequestId?(): string;
  reupload?(input: { requestId: string; draft: unknown }): void | Promise<void>;
  sleep?(ms: number): void | Promise<void>;
}

export interface CanonicalRecoveryResult {
  executed: boolean;
  action: CanonicalRecoveryActionKind;
  requestId?: string;
  blockedReason?: RetryDecision['reason'] | 'missing_handler';
}

async function invoke(handler: (() => void | Promise<void>) | undefined, action: CanonicalRecoveryActionKind): Promise<CanonicalRecoveryResult> {
  if (!handler) return { executed: false, action, blockedReason: 'missing_handler' };
  await handler();
  return { executed: true, action };
}

/** Executes exactly the one action selected by the canonical mapper. */
export async function executeCanonicalRecovery(failure: CanonicalError, context: CanonicalRecoveryContext): Promise<CanonicalRecoveryResult> {
  const action = failure.recoveryAction.kind;
  if (action === 'none') return { executed: false, action };
  if (action === 'retry') {
    const decision = decideCanonicalRetry({ failure, attempt: context.attempt ?? 0, idempotent: context.idempotent, online: context.online, foreground: context.foreground });
    if (!decision.allowed) return { executed: false, action, blockedReason: decision.reason };
    if (decision.delayMs > 0) await (context.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(decision.delayMs);
    return invoke(context.retry, action);
  }
  if (action === 'reconnect') {
    if (!context.online) return { executed: false, action, blockedReason: 'offline' };
    if (!context.foreground) return { executed: false, action, blockedReason: 'background' };
    return invoke(context.reconnect, action);
  }
  if (action === 'full-sync') {
    if (!context.online) return { executed: false, action, blockedReason: 'offline' };
    if (!context.foreground) return { executed: false, action, blockedReason: 'background' };
    if (!context.fenceSendReplay || !context.fullSync) return { executed: false, action, blockedReason: 'missing_handler' };
    context.fenceSendReplay();
    await context.fullSync();
    return { executed: true, action };
  }
  if (action === 'reupload') {
    if (!context.online) return { executed: false, action, blockedReason: 'offline' };
    if (!context.foreground) return { executed: false, action, blockedReason: 'background' };
    if (!context.createRequestId || !context.reupload) return { executed: false, action, blockedReason: 'missing_handler' };
    const requestId = context.createRequestId();
    await context.reupload({ requestId, draft: context.draft });
    return { executed: true, action, requestId };
  }
  const handlers: Record<Exclude<CanonicalRecoveryActionKind, 'none' | 'retry' | 'reconnect' | 'full-sync' | 'reupload'>, (() => void | Promise<void>) | undefined> = {
    relogin: context.relogin,
    'open-settings': context.openSettings,
    'choose-agent': context.chooseAgent,
    refresh: context.refresh,
    'contact-admin': context.contactAdmin,
  };
  return invoke(handlers[action], action);
}

/** A UI one-tap guard. Repeated taps share one promise and never dispatch twice. */
export function createOneTapRecovery(failure: CanonicalError, context: CanonicalRecoveryContext): () => Promise<CanonicalRecoveryResult> {
  let dispatched: Promise<CanonicalRecoveryResult> | undefined;
  return () => dispatched ??= executeCanonicalRecovery(failure, context);
}

/** Persist only the already-sanitized canonical failure for session/cold-start restoration. */
export function serializeCanonicalSessionFailure(failure: CanonicalError): string {
  return JSON.stringify(failure);
}

export function restoreCanonicalSessionFailure(value: unknown): CanonicalError | undefined {
  let candidate: unknown = value;
  if (typeof value === 'string') {
    try { candidate = JSON.parse(value) as unknown; } catch { return undefined; }
  }
  if (!candidate || typeof candidate !== 'object') return undefined;
  const kind = safeOwn(candidate, 'kind');
  if (typeof kind !== 'string' || !CANONICAL_ERROR_KINDS.includes(kind as CanonicalErrorKind)) return undefined;
  const restored = mapCanonicalError({
    source: 'session',
    code: kind,
    retryAfterMs: safeOwn(candidate, 'retryAfterMs'),
    correlationId: safeOwn(candidate, 'correlationId'),
  });
  return restored.kind === kind ? restored : undefined;
}

export interface CanonicalErrorPresentation {
  title: string;
  message: string;
  tone: CanonicalErrorTone;
  busy: false;
  terminal: true;
  primaryAction?: CanonicalRecoveryAction;
  accessibilityLabel: string;
  analytics: { kind: CanonicalErrorKind; correlationId?: string };
}

/** Shared ErrorCard/Toast/chat projection. It contains no raw transport/provider fields. */
export function presentCanonicalError(failure: CanonicalError): CanonicalErrorPresentation {
  const primaryAction = failure.recoveryAction.kind === 'none' ? undefined : failure.recoveryAction;
  return Object.freeze({
    title: failure.title,
    message: failure.safeMessage,
    tone: failure.tone,
    busy: false as const,
    terminal: true as const,
    ...(primaryAction ? { primaryAction } : {}),
    accessibilityLabel: [failure.title, failure.safeMessage, primaryAction?.label].filter(Boolean).join('，'),
    analytics: Object.freeze({ kind: failure.kind, ...(failure.correlationId ? { correlationId: failure.correlationId } : {}) }),
  });
}
