import { describe, expect, it } from 'vitest';

import { ContainerExecutionProvider } from 'server/agent/toolRuntime.js';
import { buildHealthResponse } from './handlers.js';
import type { HandServerConfig } from './config.js';

describe('buildHealthResponse', () => {
  it('reports desired and effective container network policy separately', () => {
    const config = {
      authToken: 'test-token',
      backend: 'container',
      networkPolicy: { mode: 'public-egress', denyPrivateNetworks: true },
      container: {},
    } as HandServerConfig;
    const provider = new ContainerExecutionProvider({
      networkPolicy: config.networkPolicy,
    });

    const health = buildHealthResponse({
      config,
      provider,
      workspaceResolver: {} as never,
      internalExecutionTarget: 'server-container',
      logger: { info() {}, warn() {}, error() {} },
    });

    expect(health.networkPolicy).toMatchObject({
      desiredPolicy: { mode: 'public-egress', denyPrivateNetworks: true },
      effectivePolicy: {
        mode: 'isolated',
        enforcement: 'not_enforced',
        publicEgressReachable: false,
        privateEgressBlocked: true,
        metadataBlocked: true,
      },
    });
    expect((health.container as Record<string, unknown>).network).toBe('none');
  });
});
