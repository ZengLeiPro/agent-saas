import { describe, expect, it } from 'vitest';

import { parseClientDaemonMessage, serializeClientDaemonMessage } from '../runtime/clientDaemonProtocol.js';

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
