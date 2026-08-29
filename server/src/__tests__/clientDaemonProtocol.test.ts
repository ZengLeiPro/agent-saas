import { describe, expect, it } from 'vitest';

import { deriveClientDaemonHandId, parseClientDaemonMessage, serializeClientDaemonMessage } from '../runtime/clientDaemonProtocol.js';

describe('client daemon wire protocol helpers', () => {
  it('round-trips daemon hello messages', () => {
    const encoded = serializeClientDaemonMessage({
      type: 'daemon_hello',
      protocolVersion: 1,
      daemonId: 'daemon-1',
      capabilities: [],
    });

    expect(parseClientDaemonMessage(encoded)).toEqual({
      type: 'daemon_hello',
      protocolVersion: 1,
      daemonId: 'daemon-1',
      capabilities: [],
    });
  });

  it('round-trips a versioned invocation correlation contract', () => {
    const encoded = serializeClientDaemonMessage({
      type: 'invoke_request',
      protocolVersion: 1,
      requestId: 'request-1',
      invocationId: 'run-1:call-1',
      request: {
        toolName: 'Read', input: { path: 'MEMORY.md' },
        context: {
          invocationId: 'run-1:call-1',
          correlation: { version: 1, invocationId: 'run-1:call-1', attemptId: 'attempt-1' },
          workspace: { root: '/tmp/workspace', executionTarget: 'client' },
        },
      },
    });
    expect(parseClientDaemonMessage(encoded)).toMatchObject({
      request: { context: { correlation: { version: 1, attemptId: 'attempt-1' } } },
    });
    expect(() => parseClientDaemonMessage(JSON.stringify({
      type: 'invoke_request', protocolVersion: 1, requestId: 'request-2', invocationId: 'legacy-a',
      request: {
        toolName: 'Read', input: {},
        context: {
          invocationId: 'legacy-a',
          correlation: { version: 1, invocationId: 'contract-b' },
          workspace: {},
        },
      },
    }))).toThrow(/correlation/);
    expect(() => parseClientDaemonMessage(JSON.stringify({
      type: 'invoke_request', protocolVersion: 1, requestId: 'request-3', invocationId: 'envelope-a',
      request: {
        toolName: 'Read', input: {},
        context: { correlation: { version: 1, invocationId: 'contract-b' }, workspace: {} },
      },
    }))).toThrow(/invocationId/);
  });

  it('rejects non-string legacy request identities instead of treating them as absent', () => {
    for (const [field, invalid] of [
      ['invocationId', 123],
      ['invocationId', null],
      ['handId', { nested: true }],
    ] as const) {
      expect(() => parseClientDaemonMessage(JSON.stringify({
        type: 'invoke_request', protocolVersion: 1, requestId: `request-${field}`, invocationId: 'envelope-1',
        request: {
          toolName: 'Read', input: {},
          context: { [field]: invalid, workspace: {} },
        },
      }))).toThrow(/correlation/);
    }
  });

  it('rejects unsafe protocol identities without echoing their values', () => {
    const secret = 'secret-token\n[FORGED]';
    for (const message of [
      { type: 'daemon_hello', protocolVersion: 1, daemonId: secret, capabilities: [] },
      { type: 'daemon_hello', protocolVersion: 1, daemonId: 'daemon-1', handId: secret, capabilities: [] },
      { type: 'daemon_hello', protocolVersion: 1, daemonId: 'daemon-1', capabilities: [], resumeInvocations: [{ invocationId: 123 }] },
      { type: 'invoke_completed', protocolVersion: 1, requestId: secret, invocationId: 'logical-1', response: {} },
      { type: 'daemon_error', protocolVersion: 1, requestId: secret, message: 'error' },
    ]) {
      let error: unknown;
      try {
        parseClientDaemonMessage(JSON.stringify(message));
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it('rejects malformed capabilities and cancel acknowledgements', () => {
    expect(() => parseClientDaemonMessage(JSON.stringify({
      type: 'daemon_hello', protocolVersion: 1, daemonId: 'daemon-1', capabilities: [{}],
    }))).toThrow('invalid client daemon protocol capabilities');
    expect(() => parseClientDaemonMessage(JSON.stringify({
      type: 'cancel_ack', protocolVersion: 1,
      requestId: 'cancel-1', invocationId: 'logical-1', accepted: 'false',
    }))).toThrow('invalid client daemon protocol boolean');
    expect(() => parseClientDaemonMessage(JSON.stringify({
      type: 'invoke_completed', protocolVersion: 1,
      requestId: 'invoke-1', invocationId: 'logical-1', response: {},
    }))).toThrow('invalid client daemon protocol invocation response');
    expect(() => parseClientDaemonMessage(JSON.stringify({
      type: 'invoke_chunk', protocolVersion: 1,
      requestId: 'invoke-1', invocationId: 'logical-1',
      chunk: { type: 'output', channel: 'invalid', content: 123 },
    }))).toThrow('invalid client daemon protocol invocation chunk');
  });

  it('derives a backward-compatible hand id without exceeding the wire limit', () => {
    expect(deriveClientDaemonHandId('daemon-1')).toBe('client-daemon-1');
    expect(deriveClientDaemonHandId('d'.repeat(249))).toHaveLength(256);
    for (const length of [250, 256]) {
      const handId = deriveClientDaemonHandId('d'.repeat(length));
      expect(handId).toMatch(/^client-[a-f0-9]{64}$/);
      expect(handId.length).toBeLessThanOrEqual(256);
      expect(() => parseClientDaemonMessage(JSON.stringify({
        type: 'daemon_registered', protocolVersion: 1, daemonId: 'daemon-1', handId,
      }))).not.toThrow();
    }
  });

  it('rejects unsupported protocol versions', () => {
    expect(() => parseClientDaemonMessage(JSON.stringify({ type: 'daemon_hello', protocolVersion: 999, daemonId: 'x', capabilities: [] }))).toThrow(/unsupported client daemon protocol version/);
  });

  it('rejects missing required fields for known message types', () => {
    expect(() => parseClientDaemonMessage(JSON.stringify({ type: 'invoke_request', protocolVersion: 1 }))).toThrow(/missing requestId/);
  });

  it('rejects unknown message types', () => {
    expect(() => parseClientDaemonMessage(JSON.stringify({ type: 'surprise', protocolVersion: 1 }))).toThrow(/unknown client daemon protocol message type/);
  });
});
