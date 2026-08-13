import { describe, expect, it, vi } from 'vitest';

import { publicOperationalError } from '../utils/publicOperationalError.js';

describe('publicOperationalError', () => {
  it('忽略恶意对象伪造的 code 与 diagnosticId，只使用服务端白名单和新生成 ID', () => {
    const logger = { error: vi.fn() };
    const malicious = {
      code: 'ATTACKER_CODE',
      errorCode: 'RUNTIME_TRACE_QUERY_FAILED',
      diagnosticId: 'diag_attacker_controlled',
      message: '/workspace/releases/secret/server.js',
    };

    const result = publicOperationalError(
      malicious,
      'CRON_OPERATION_FAILED',
      undefined,
      logger,
      'GET /api/cron/jobs',
    );

    expect(result).toMatchObject({
      error: '服务暂不可用，请稍后重试',
      code: 'CRON_OPERATION_FAILED',
      diagnosticId: expect.stringMatching(/^diag_[a-f0-9]{32}$/),
    });
    expect(result.diagnosticId).not.toBe(malicious.diagnosticId);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(`[${result.diagnosticId}] CRON_OPERATION_FAILED`));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('/workspace/releases/secret/server.js'));
  });

  it('未知调用点 code 也不会直接透出', () => {
    const result = publicOperationalError(new Error('boom'), 'ATTACKER_FALLBACK');
    expect(result.code).toBe('INTERNAL_OPERATION_FAILED');
  });
});
