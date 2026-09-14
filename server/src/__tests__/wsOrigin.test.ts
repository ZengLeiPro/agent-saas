import { describe, expect, it } from 'vitest';

import { isWebSocketOriginAllowed } from '../channels/web/wsServer.js';

describe('WebSocket browser Origin gate', () => {
  const allowed = ['https://agent.kaiyan.net'];

  it('allows the configured Web origin', () => {
    expect(isWebSocketOriginAllowed('https://agent.kaiyan.net', allowed)).toBe(true);
  });

  it('rejects an untrusted browser origin', () => {
    expect(isWebSocketOriginAllowed('https://evil.example', allowed)).toBe(false);
  });

  it('keeps non-browser clients and deployment probes compatible', () => {
    expect(isWebSocketOriginAllowed(undefined, allowed)).toBe(true);
  });

  it('allows native clients whose Origin is the API host itself', () => {
    expect(isWebSocketOriginAllowed(
      'https://api.agent.kaiyan.net',
      allowed,
      'api.agent.kaiyan.net',
    )).toBe(true);
    expect(isWebSocketOriginAllowed(
      'https://api.agent.kaiyan.net',
      allowed,
      'api.agent.kaiyan.net:443',
    )).toBe(true);
  });

  it('still rejects random origins even when a request host is present', () => {
    expect(isWebSocketOriginAllowed('https://evil.example', allowed, 'api.agent.kaiyan.net')).toBe(false);
    expect(isWebSocketOriginAllowed('file://', allowed, 'api.agent.kaiyan.net')).toBe(false);
    expect(isWebSocketOriginAllowed('null', allowed, 'api.agent.kaiyan.net')).toBe(false);
  });
});
