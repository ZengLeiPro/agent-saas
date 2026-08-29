import { describe, expect, it } from 'vitest';

import {
  CORRELATION_CONTEXT_VERSION,
  correlationLogFields,
  parseCorrelationContext,
} from './correlation';

describe('CorrelationContext', () => {
  it('parses the versioned allowlist and merges agreeing legacy identities', () => {
    expect(parseCorrelationContext({
      version: CORRELATION_CONTEXT_VERSION,
      runId: 'run-1',
      invocationId: 'run-1:call-1',
      attemptId: 'attempt-1',
    }, { invocationId: 'run-1:call-1' })).toEqual({
      ok: true,
      value: {
        version: 1,
        runId: 'run-1',
        invocationId: 'run-1:call-1',
        attemptId: 'attempt-1',
      },
    });
  });

  it('rejects unsupported versions, unknown/sensitive fields and identity conflicts', () => {
    expect(parseCorrelationContext({ version: 2 })).toMatchObject({ ok: false });
    expect(parseCorrelationContext({ version: 1, tenantId: 'tenant-secret' })).toMatchObject({ ok: false });
    expect(parseCorrelationContext({ version: 1, invocationId: '../secret/path' })).toMatchObject({ ok: false });
    expect(parseCorrelationContext({ version: 1, attemptId: 'attempt-1' }, { invocationId: '../secret/path' })).toMatchObject({ ok: false });
    expect(parseCorrelationContext({ version: 1, attemptId: 'attempt-1' }, { invocationId: '' })).toMatchObject({ ok: false });
    expect(parseCorrelationContext(
      { version: 1, invocationId: 'invocation-a' },
      { invocationId: 'invocation-b' },
    )).toMatchObject({ ok: false });
  });

  it('keeps logs limited to shortened correlation ids', () => {
    const fields = correlationLogFields({
      version: 1,
      invocationId: 'invocation-abcdefghijklmnopqrstuvwxyz-123456789',
      attemptId: 'attempt-1',
    });
    expect(fields).toEqual({
      invocationId: 'invocation-a…23456789',
      attemptId: 'attempt-1',
    });
    expect(JSON.stringify(fields)).not.toContain('token');
  });
});
