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
});
