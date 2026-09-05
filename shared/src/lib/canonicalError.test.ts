import { describe, expect, it, vi } from 'vitest';
import { capabilityStatusToCanonicalError, evaluateCapability } from './authConnectionCapability';
import {
  CANONICAL_ERROR_KINDS,
  createOneTapRecovery,
  decideCanonicalRetry,
  executeCanonicalRecovery,
  mapCanonicalError,
  presentCanonicalError,
  restoreCanonicalSessionFailure,
  serializeCanonicalSessionFailure,
  type CanonicalErrorKind,
} from './canonicalError';

const CASES: Array<[CanonicalErrorKind, Parameters<typeof mapCanonicalError>[0]]> = [
  ['auth_expired', { source: 'http', status: 401 }],
  ['auth_revoked', { source: 'ws', code: 'token_revoked' }],
  ['network_offline', { source: 'expo', online: false }],
  ['network_timeout', { source: 'network', timeout: true }],
  ['tls_untrusted', { source: 'tls', tls: true }],
  ['server_unavailable', { source: 'http', status: 503 }],
  ['rate_limited', { source: 'http', status: 429 }],
  ['quota_exhausted', { source: 'runtime', reasonCode: 'usage_limit_reached' }],
  ['client_misconfigured', { source: 'ws', code: 'invalid_submission' }],
  ['sync_overflow', { source: 'ws', code: 'sync_overflow' }],
  ['stale_generation', { source: 'ws', code: 'generation_mismatch' }],
  ['org_agent_unavailable', { source: 'chat_rejected', reasonCode: 'org_agent_unavailable' }],
  ['capability_unavailable', { source: 'chat_rejected', reasonCode: 'model_not_allowed' }],
  ['attachment_upload', { source: 'upload', uploadPhase: 'upload' }],
  ['attachment_validation', { source: 'upload', uploadPhase: 'validation' }],
  ['interaction_conflict', { source: 'ws', code: 'session_locked' }],
  ['storage_corrupt', { source: 'runtime', code: 'storage_corrupted' }],
  ['unknown', { source: 'runtime', code: 'provider_future_secret' }],
];

describe('M40-05 canonical taxonomy and transport parity', () => {
  it('covers every taxonomy kind exactly once', () => {
    expect(CASES.map(([kind]) => kind).sort()).toEqual([...CANONICAL_ERROR_KINDS].sort());
    for (const [kind, input] of CASES) expect(mapCanonicalError(input).kind).toBe(kind);
  });

  it('maps HTTP, WS, chat rejected, runtime, Expo, network, TLS and uploads by structured facts', () => {
    expect(mapCanonicalError({ source: 'http', status: 429 }).kind).toBe('rate_limited');
    expect(mapCanonicalError({ source: 'ws', code: 'sync_overflow' }).kind).toBe('sync_overflow');
    expect(mapCanonicalError({ source: 'chat_rejected', reasonCode: 'attachment_id_invalid' }).kind).toBe('attachment_validation');
    expect(mapCanonicalError({ source: 'runtime', code: 'server_error' }).kind).toBe('server_unavailable');
    expect(mapCanonicalError({ source: 'expo', code: 'Network Request Failed' }).kind).toBe('network_offline');
    expect(mapCanonicalError({ source: 'network', code: 'ETIMEDOUT' }).kind).toBe('network_timeout');
    expect(mapCanonicalError({ source: 'tls', code: 'CERT_UNTRUSTED' }).kind).toBe('tls_untrusted');
    expect(mapCanonicalError({ source: 'upload', code: 'upload_failed' }).kind).toBe('attachment_upload');
  });

  it('uses N-1 strings only as an allow-list mapper and never displays them', () => {
    const raw = 'Service unavailable token=SECRET path=/workspace/private body={password:x}';
    const failure = mapCanonicalError({ legacyMessage: raw, correlationId: 'corr-safe-123' });
    expect(failure.kind).toBe('server_unavailable');
    expect(JSON.stringify(failure)).not.toContain('SECRET');
    expect(JSON.stringify(presentCanonicalError(failure))).not.toContain('/workspace');
  });

  it('fails safe for unknown, malformed, cyclic and throwing objects', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.error = cyclic;
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, 'code', { get() { throw new Error('TOKEN_SECRET'); } });
    for (const value of [null, 'token=SECRET', cyclic, { error: cyclic }, hostile]) {
      expect(() => mapCanonicalError(value)).not.toThrow();
      expect(mapCanonicalError(value).kind).toBe('unknown');
      expect(JSON.stringify(mapCanonicalError(value))).not.toMatch(/SECRET|stack|workspace/i);
    }
  });

  it('parses Retry-After seconds/date and never applies it to non-retryable failures', () => {
    expect(mapCanonicalError({ status: 429, retryAfter: '12' }).retryAfterMs).toBe(12_000);
    expect(mapCanonicalError({ status: 503, retryAfter: 'Thu, 01 Jan 2026 00:00:05 GMT' }, Date.UTC(2026, 0, 1)).retryAfterMs).toBe(5_000);
    expect(mapCanonicalError({ code: 'auth_expired', retryAfterMs: 999 }).retryAfterMs).toBeUndefined();
  });

  it('projects only safe a11y and analytics fields and clears terminal spinners', () => {
    const failure = mapCanonicalError({ code: 'server_error', correlationId: 'corr-safe-123', legacyMessage: 'token=SECRET' });
    const surface = presentCanonicalError(failure);
    expect(surface).toMatchObject({ busy: false, terminal: true, analytics: { kind: 'server_unavailable', correlationId: 'corr-safe-123' } });
    expect(Object.keys(surface.analytics).sort()).toEqual(['correlationId', 'kind']);
    expect(surface.accessibilityLabel).not.toMatch(/SECRET|token|stack|workspace/i);
    expect(surface.primaryAction?.kind).toBe('retry');
  });

  it('reuses authConnectionCapability as authority instead of creating another status source', () => {
    const status = evaluateCapability({
      userId: 'u', tenantId: 't', provider: 'p', channel: 'mobile', correlationId: 'corr-auth-123',
      observedAt: 'now', providerConfigured: true, callbackDomainConfigured: true, ssoAvailable: true,
      credential: 'expired', network: 'online', server: 'healthy', tenantAllowed: true, operation: 'connection',
    });
    expect(capabilityStatusToCanonicalError(status)).toMatchObject({
      kind: 'auth_expired', correlationId: 'corr-auth-123', recoveryAction: { kind: 'relogin' },
    });
  });

  it('restores only canonical safe session failures', () => {
    const failure = mapCanonicalError({ code: 'sync_overflow', correlationId: 'corr-sync-123' });
    expect(restoreCanonicalSessionFailure(serializeCanonicalSessionFailure(failure))).toEqual(failure);
    expect(restoreCanonicalSessionFailure('{"kind":"future","token":"SECRET"}')).toBeUndefined();
    expect(restoreCanonicalSessionFailure('{broken')).toBeUndefined();
  });
});

describe('M40-05 retry and exactly one recovery action', () => {
  it('requires idempotency, foreground and online and respects capped exponential Retry-After', () => {
    const failure = mapCanonicalError({ status: 429, retryAfter: '20' });
    expect(decideCanonicalRetry({ failure, attempt: 3, idempotent: true, online: true, foreground: true, baseDelayMs: 1_000, maxDelayMs: 30_000 })).toEqual({ allowed: true, delayMs: 20_000 });
    expect(decideCanonicalRetry({ failure, attempt: 0, idempotent: false, online: true, foreground: true }).reason).toBe('not_idempotent');
    expect(decideCanonicalRetry({ failure, attempt: 0, idempotent: true, online: false, foreground: true }).reason).toBe('offline');
    expect(decideCanonicalRetry({ failure, attempt: 0, idempotent: true, online: true, foreground: false }).reason).toBe('background');
  });

  it.each(['auth_expired', 'auth_revoked', 'tls_untrusted', 'client_misconfigured'] as const)('%s never blind-retries', (code) => {
    const failure = mapCanonicalError({ code });
    expect(failure.retryable).toBe(false);
    expect(failure.recoveryAction.kind).not.toBe('retry');
  });

  it('offline reconnect waits for online transition', async () => {
    const reconnect = vi.fn();
    const failure = mapCanonicalError({ online: false });
    expect((await executeCanonicalRecovery(failure, { idempotent: true, online: false, foreground: true, reconnect })).blockedReason).toBe('offline');
    expect((await executeCanonicalRecovery(failure, { idempotent: true, online: true, foreground: true, reconnect })).executed).toBe(true);
    expect(reconnect).toHaveBeenCalledOnce();
  });

  it('full-sync fences send/replay before authority refresh', async () => {
    const order: string[] = [];
    const failure = mapCanonicalError({ code: 'sync_overflow' });
    await executeCanonicalRecovery(failure, {
      idempotent: true, online: true, foreground: true,
      fenceSendReplay: () => order.push('fence'),
      fullSync: () => { order.push('sync'); },
    });
    expect(order).toEqual(['fence', 'sync']);
  });

  it('reupload preserves draft and creates a fresh requestId', async () => {
    const seen: unknown[] = [];
    const draft = { text: 'keep me' };
    const failure = mapCanonicalError({ code: 'upload_failed' });
    const result = await executeCanonicalRecovery(failure, {
      idempotent: false, online: true, foreground: true, draft,
      createRequestId: () => 'request-new-123',
      reupload: (input) => { seen.push(input); },
    });
    expect(result.requestId).toBe('request-new-123');
    expect(seen).toEqual([{ requestId: 'request-new-123', draft }]);
  });

  it('duplicate tap dispatches one time', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const retry = vi.fn(() => pending);
    const tap = createOneTapRecovery(mapCanonicalError({ code: 'server_error' }), {
      idempotent: true, online: true, foreground: true, retry, sleep: () => undefined,
    });
    const first = tap();
    const second = tap();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(retry).toHaveBeenCalledOnce();
    release();
    await first;
    await tap();
    expect(retry).toHaveBeenCalledOnce();
  });
});

describe('配额耗尽（quota_exhausted）与绝对重置时刻', () => {
  const NOW = Date.parse('2026-08-03T00:58:00.000Z');

  it('只按上游结构化错误码归类，自由文本一律留在 rate_limited 兜底', () => {
    // 火山 Ark / OpenAI / Codex 的明确码
    for (const code of [
      'QuotaExceeded', 'AccountQuotaExceeded', 'insufficient_quota',
      'usage_limit_reached', 'billing_hard_limit_reached',
    ]) {
      expect(mapCanonicalError({ source: 'runtime', status: 429, code }).kind).toBe('quota_exhausted');
    }
    // 只有自由文本时不猜（2026-08-23 红线）：仍是普通限流
    expect(mapCanonicalError({
      source: 'runtime', status: 429,
      legacyMessage: 'You have exceeded the 5-hour usage quota',
    }).kind).toBe('rate_limited');
  });

  it('配额耗尽不可重试、不给 retry 动作（重试撞同一堵墙）', () => {
    const failure = mapCanonicalError({ source: 'runtime', code: 'usage_limit_reached' });
    expect(failure.retryable).toBe(false);
    expect(failure.recoveryAction.kind).toBe('none');
  });

  it('resetAt 归一为 ISO；越界/无效值丢弃；只在配额/限流类别保留', () => {
    const at = new Date(NOW + 4 * 60 * 60 * 1000).toISOString();
    expect(mapCanonicalError({ code: 'usage_limit_reached', resetAt: at }, NOW).resetAt).toBe(at);
    expect(mapCanonicalError({ status: 429, resetAt: at }, NOW).resetAt).toBe(at);
    // 超过 24h 窗口 / 已过期 / 非时间串一律不填
    expect(mapCanonicalError({ code: 'usage_limit_reached', resetAt: new Date(NOW + 48 * 3600_000).toISOString() }, NOW).resetAt).toBeUndefined();
    expect(mapCanonicalError({ code: 'usage_limit_reached', resetAt: new Date(NOW - 3600_000).toISOString() }, NOW).resetAt).toBeUndefined();
    expect(mapCanonicalError({ code: 'usage_limit_reached', resetAt: 'not-a-time' }, NOW).resetAt).toBeUndefined();
    // 与配额无关的类别不携带 resetAt
    expect(mapCanonicalError({ code: 'server_error', resetAt: at }, NOW).resetAt).toBeUndefined();
  });

  it('会话恢复保留 resetAt（持久化的是已脱敏的 canonical 结构）', () => {
    // restoreCanonicalSessionFailure 内部按真实 now 重新校验窗口，这里用真实时间基准。
    const at = new Date(Date.now() + 3600_000).toISOString();
    const failure = mapCanonicalError({ code: 'usage_limit_reached', resetAt: at, correlationId: 'corr-quota-1' });
    const restored = restoreCanonicalSessionFailure(serializeCanonicalSessionFailure(failure));
    expect(restored?.kind).toBe('quota_exhausted');
    expect(restored?.resetAt).toBe(at);
  });
});
