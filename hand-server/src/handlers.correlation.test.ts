import { describe, expect, it } from 'vitest';

import { parseWireRequest } from './handlers.js';

const workspace = { id: 'workspace-1', sessionId: 'session-1' };

describe('hand correlation parser', () => {
  it('accepts a versioned context and preserves the execution attempt', () => {
    expect(parseWireRequest({
      toolName: 'Shell',
      input: { command: 'pwd' },
      context: {
        invocationId: 'run-1:call-1',
        correlation: {
          version: 1,
          sessionId: 'session-1',
          runId: 'run-1',
          toolCallId: 'call-1',
          invocationId: 'run-1:call-1',
          attemptId: 'attempt-1',
        },
        workspace,
      },
    })).toMatchObject({
      ok: true,
      value: {
        context: {
          invocationId: 'run-1:call-1',
          correlation: { version: 1, invocationId: 'run-1:call-1', attemptId: 'attempt-1' },
        },
      },
    });
  });

  it('rejects unsupported, sensitive, malformed and conflicting correlation data', () => {
    for (const correlation of [
      { version: 2 },
      { version: 1, tenantId: 'tenant-secret' },
      { version: 1, attemptId: '/private/path' },
      { version: 1, invocationId: 'different-invocation' },
    ]) {
      expect(parseWireRequest({
        toolName: 'Shell',
        input: {},
        context: { invocationId: 'run-1:call-1', correlation, workspace },
      })).toMatchObject({ ok: false });
    }
  });

  it('rejects non-string legacy invocation and hand identities at the wire boundary', () => {
    for (const invalid of [123, null, { nested: true }]) {
      expect(parseWireRequest({
        toolName: 'Write', input: {}, context: { invocationId: invalid, workspace },
      })).toMatchObject({ ok: false });
      expect(parseWireRequest({
        toolName: 'Write', input: {}, context: { handId: invalid, workspace },
      })).toMatchObject({ ok: false });
    }
  });

  it('uses a correlation-only invocation as the journal/cancel identity', () => {
    expect(parseWireRequest({
      toolName: 'Shell', input: {},
      context: {
        correlation: { version: 1, invocationId: 'correlation-only', attemptId: 'attempt-1' },
        workspace,
      },
    })).toMatchObject({
      ok: true,
      value: { context: { invocationId: 'correlation-only' } },
    });
  });

  it('keeps legacy requests backward compatible', () => {
    expect(parseWireRequest({
      toolName: 'Read',
      input: { path: 'MEMORY.md' },
      context: { invocationId: 'legacy-invocation', workspace },
    })).toMatchObject({
      ok: true,
      value: { context: { correlation: { version: 1, invocationId: 'legacy-invocation' } } },
    });
  });
});
