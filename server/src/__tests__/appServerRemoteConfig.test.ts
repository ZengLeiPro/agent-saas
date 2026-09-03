import { describe, expect, it } from 'vitest';

import { parseAppConfig } from '../app/config.js';

const baseConfig = {
  agent: { cwd: '/tmp/agent' },
  server: { port: 3200 },
  runtimeEventStore: {
    backend: 'pg' as const,
    connectionString: 'postgresql://user:pass@localhost:5432/runtime',
  },
};

describe('serverRemote config with durable runtime storage', () => {
  it('accepts inline authToken', () => {
    const config = parseAppConfig({
      ...baseConfig,
      serverRemote: {
        baseUrl: 'http://127.0.0.1:3300',
        authToken: 'server-remote-token-xyz',
        invokeTimeoutMs: 90_000,
      },
    });

    expect(config.serverRemote).toMatchObject({
      baseUrl: 'http://127.0.0.1:3300',
      authToken: 'server-remote-token-xyz',
      invokeTimeoutMs: 90_000,
    });
  });

  it('accepts authTokenRef instead of inline authToken', () => {
    const config = parseAppConfig({
      ...baseConfig,
      serverRemote: {
        baseUrl: 'http://127.0.0.1:3300',
        authTokenRef: 'server-remote-prod',
      },
    });

    expect(config.serverRemote).toMatchObject({
      baseUrl: 'http://127.0.0.1:3300',
      authTokenRef: 'server-remote-prod',
    });
    expect(config.serverRemote?.authToken).toBeUndefined();
  });
});
