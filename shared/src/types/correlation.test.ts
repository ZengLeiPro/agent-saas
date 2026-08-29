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

  it('rejects non-string legacy identities without echoing untrusted keys or versions', () => {
    for (const invocationId of [123, null, { nested: true }]) {
      expect(parseCorrelationContext(undefined, { invocationId })).toMatchObject({ ok: false });
      expect(parseCorrelationContext({ version: 1 }, { invocationId })).toMatchObject({ ok: false });
    }

    const secret = 'secret-token\n[FORGED]';
    const unknownField = parseCorrelationContext({ version: 1, [secret]: 'value' });
    const unsupportedVersion = parseCorrelationContext({ version: secret });
    expect(unknownField).toEqual({ ok: false, error: 'context.correlation 包含不支持字段' });
    expect(unsupportedVersion).toEqual({ ok: false, error: 'context.correlation.version 不支持' });
    expect(JSON.stringify([unknownField, unsupportedVersion])).not.toContain(secret);
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
