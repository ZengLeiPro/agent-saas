import { describe, expect, it, vi } from 'vitest';
import {
  buildStructuredError,
  canonicalFailureLogRecord,
  sendStructuredHttpError,
} from '../runtime/structuredError.js';

describe('M40-05 server structured and secret-safe errors', () => {
  it('emits safe code/correlationId/retryAfter and an N-1 safe string alias', () => {
    const result = buildStructuredError({
      source: 'http', status: 429, retryAfter: '7', correlationId: 'corr-rate-123',
      legacyMessage: 'token=SERVER_SECRET /workspace/private raw-body',
    });
    expect(result.payload).toEqual({
      code: 'rate_limited',
      message: '请等待片刻后重试。',
      error: '请等待片刻后重试。',
      correlationId: 'corr-rate-123',
      retryAfter: 7,
    });
    expect(JSON.stringify(result)).not.toMatch(/SERVER_SECRET|workspace|raw-body/);
  });

  it('replaces malformed correlation and source values instead of leaking them', () => {
    const { failure, payload } = buildStructuredError({
      code: 'unknown',
      correlationId: 'token=CORRELATION_SECRET',
    });
    const record = canonicalFailureLogRecord({ failure, source: 'ws token=SOURCE_SECRET' });
    expect(payload.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(record.source).toBe('unknown');
    expect(JSON.stringify({ payload, record })).not.toMatch(/CORRELATION_SECRET|SOURCE_SECRET/);
  });

  it('writes HTTP status/header/body without making message the logic authority', () => {
    const response = { status: vi.fn(), setHeader: vi.fn(), json: vi.fn() };
    const payload = sendStructuredHttpError(response, 503, {
      code: 'server_unavailable', correlationId: 'corr-http-123', retryAfterMs: 2_100,
    });
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '3');
    expect(response.json).toHaveBeenCalledWith(payload);
    expect(payload).toMatchObject({ code: 'server_unavailable', correlationId: 'corr-http-123', retryAfter: 3 });
  });

  it('audit metadata contains correlation/source/status but no body or credential', () => {
    const { failure } = buildStructuredError({ code: 'tls_untrusted', correlationId: 'corr-tls-123' });
    const record = canonicalFailureLogRecord({ failure, source: 'ws', status: 495 });
    expect(record).toEqual({ event: 'canonical_failure', kind: 'tls_untrusted', correlationId: 'corr-tls-123', source: 'ws', status: 495 });
    expect(Object.keys(record).sort()).toEqual(['correlationId', 'event', 'kind', 'source', 'status']);
    expect(JSON.stringify(record)).not.toMatch(/body|credential|token|secret/i);
  });
});
