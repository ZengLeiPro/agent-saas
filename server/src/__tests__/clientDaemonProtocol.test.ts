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
