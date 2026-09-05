import { describe, expect, it } from 'vitest';

import {
  defaultRetryable,
  httpStatusFor,
  isAppErrorCode,
  isGatewayErrorCode,
  makeErrorHttpResponse,
  makeErrorResponse,
} from './errors.js';
import { validateErrorResponse } from './schemas/index.js';
import { APP_ERROR_CODES, GATEWAY_ERROR_CODES } from './types/errors.js';

describe('§6.5 错误码集合', () => {
  it('定制项目可发出集合与 Gateway 内部码互斥', () => {
    for (const code of APP_ERROR_CODES) {
      expect(isAppErrorCode(code)).toBe(true);
      expect(isGatewayErrorCode(code)).toBe(false);
    }
    for (const code of GATEWAY_ERROR_CODES) {
      expect(isGatewayErrorCode(code)).toBe(true);
      expect(isAppErrorCode(code)).toBe(false);
    }
    expect(GATEWAY_ERROR_CODES).toEqual([
      'outcome_unknown',
      'approval_channel_unavailable',
      'system_needs_reregistration',
    ]);
  });

  it('httpStatusFor 逐行对上 §6.5 表', () => {
    const expected: Record<string, number> = {
      unauthorized: 401,
      token_replayed: 401,
      forbidden: 403,
      approval_required: 403,
      installation_disabled: 403,
      directory_stale: 403,
      not_found: 404,
      invalid_input: 400,
      idempotency_mismatch: 409,
      in_progress: 409,
      digest_mismatch: 409,
      state_gap: 409,
      response_too_large: 422,
      rate_limited: 429,
      maintenance: 503,
      upstream_unavailable: 503,
      internal: 500,
    };
    expect(Object.keys(expected).sort()).toEqual([...APP_ERROR_CODES].sort());
    for (const code of APP_ERROR_CODES) {
      expect(httpStatusFor(code), code).toBe(expected[code]);
    }
  });
});

describe('makeErrorResponse（附录 D）', () => {
  it('生成的响应通过附录 D schema', () => {
    for (const code of APP_ERROR_CODES) {
      const body = makeErrorResponse({ code, requestId: 'req_1', message: 'boom' });
      const result = validateErrorResponse(body);
      expect(result.errors, code).toEqual([]);
      expect(body.error.retryable).toBe(defaultRetryable(code));
    }
  });

  it('message 超过 200 字被截断', () => {
    const body = makeErrorResponse({
      code: 'internal',
      requestId: 'req_1',
      message: 'x'.repeat(500),
    });
    expect(body.error.message).toHaveLength(200);
    expect(validateErrorResponse(body).ok).toBe(true);
  });

  it('缺 message 时用 code 兜底，retryable 可显式覆盖', () => {
    const body = makeErrorResponse({ code: 'not_found', requestId: 'req_1', retryable: true });
    expect(body.error.message).toBe('not_found');
    expect(body.error.retryable).toBe(true);
  });

  it('Gateway 内部码不得作为定制项目响应', () => {
    for (const code of GATEWAY_ERROR_CODES) {
      expect(() => makeErrorResponse({ code: code as never, requestId: 'req_1' })).toThrow(
        /不是定制项目可发出的错误码/u,
      );
    }
  });

  it('makeErrorHttpResponse 同时给出状态与体', () => {
    expect(makeErrorHttpResponse({ code: 'digest_mismatch', requestId: 'r' })).toEqual({
      status: 409,
      body: {
        ok: false,
        error: {
          code: 'digest_mismatch',
          retryable: false,
          message: 'digest_mismatch',
          requestId: 'r',
        },
      },
    });
  });
});

describe('附录 D schema 负例', () => {
  it('拒绝 details、ok:true、未知 code 与缺字段', () => {
    const base = makeErrorResponse({ code: 'internal', requestId: 'r' });
    expect(validateErrorResponse({ ...base, error: { ...base.error, details: {} } }).ok).toBe(
      false,
    );
    expect(validateErrorResponse({ ...base, ok: true }).ok).toBe(false);
    expect(
      validateErrorResponse({ ...base, error: { ...base.error, code: 'outcome_unknown' } }).ok,
    ).toBe(false);
    expect(validateErrorResponse({ ok: false, error: { code: 'internal' } }).ok).toBe(false);
    expect(validateErrorResponse({ ok: false }).ok).toBe(false);
  });
});
