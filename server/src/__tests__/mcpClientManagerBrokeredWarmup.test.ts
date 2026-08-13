import { describe, expect, it, vi } from 'vitest';

import { McpClientManager, type McpToolDescriptor } from '../mcp/clientManager.js';

const TOOL: McpToolDescriptor = {
  serverName: 'brokered',
  toolName: 'search',
  description: 'search',
  inputSchema: {},
};

function config(version: number) {
  return {
    mcpServers: {
      brokered: {
        type: 'http' as const,
        url: `https://example.com/mcp/v${version}`,
        headerSecretRefs: {
          Authorization: { ref: 'credential-ref', prefix: 'Bearer ' },
        },
      },
    },
  };
}

describe('McpClientManager brokered list-tools protection', () => {
  it('single-flights concurrent one-shot warmups for the same config and credential', async () => {
    const manager = new McpClientManager({
      agentCwd: '/tmp',
      configProvider: async () => config(1),
    });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const execute = vi.spyOn(manager as unknown as {
      executeBrokeredWarmup: (
        username: string,
        oneShot: McpClientManager,
      ) => Promise<McpToolDescriptor[]>;
    }, 'executeBrokeredWarmup')
      .mockImplementation(async () => {
        await gate;
        return [TOOL];
      });

    const first = manager.warmupBrokered(
      'alice',
      'brokered',
      { secretRef: 'credential-ref', secret: 'secret-v1' },
    );
    const second = manager.warmupBrokered(
      'alice',
      'brokered',
      { secretRef: 'credential-ref', secret: 'secret-v1' },
    );
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([[TOOL], [TOOL]]);
    expect(execute).toHaveBeenCalledTimes(1);
    await manager.shutdown();
  });

  it('backs off failures but immediately recovers after config or credential changes', async () => {
    let configVersion = 1;
    const manager = new McpClientManager({
      agentCwd: '/tmp',
      retryDelaysMs: [60_000],
      configProvider: async () => config(configVersion),
    });
    const execute = vi.spyOn(manager as unknown as {
      executeBrokeredWarmup: (
        username: string,
        oneShot: McpClientManager,
      ) => Promise<McpToolDescriptor[]>;
    }, 'executeBrokeredWarmup');
    const firstFailure = new Error('list-tools unavailable v1');
    execute.mockRejectedValueOnce(firstFailure);

    const credentialV1 = { secretRef: 'credential-ref', secret: 'secret-v1' };
    await expect(manager.warmupBrokered('alice', 'brokered', credentialV1))
      .rejects.toBe(firstFailure);
    await expect(manager.warmupBrokered('alice', 'brokered', credentialV1))
      .rejects.toBe(firstFailure);
    expect(execute).toHaveBeenCalledTimes(1);

    configVersion = 2;
    execute.mockResolvedValueOnce([TOOL]);
    await expect(manager.warmupBrokered('alice', 'brokered', credentialV1))
      .resolves.toEqual([TOOL]);
    expect(execute).toHaveBeenCalledTimes(2);

    const secondFailure = new Error('list-tools unavailable v2');
    execute.mockRejectedValueOnce(secondFailure);
    await expect(manager.warmupBrokered('alice', 'brokered', credentialV1))
      .rejects.toBe(secondFailure);
    await expect(manager.warmupBrokered('alice', 'brokered', credentialV1))
      .rejects.toBe(secondFailure);
    expect(execute).toHaveBeenCalledTimes(3);

    execute.mockResolvedValueOnce([TOOL]);
    await expect(manager.warmupBrokered(
      'alice',
      'brokered',
      { secretRef: 'credential-ref', secret: 'secret-v2' },
    )).resolves.toEqual([TOOL]);
    expect(execute).toHaveBeenCalledTimes(4);
    await manager.shutdown();
  });
});
