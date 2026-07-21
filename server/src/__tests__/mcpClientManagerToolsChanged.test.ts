import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';

import { buildMcpToolKey, McpClientManager } from '../mcp/clientManager.js';

describe('McpClientManager 官方 SDK tools/list_changed', () => {
  let manager: McpClientManager | undefined;

  afterEach(async () => {
    await manager?.shutdown();
  });

  it('保留 catalog 能力说明并让通知只刷新后续目录', async () => {
    const fixture = join(
      dirname(fileURLToPath(import.meta.url)),
      'fixtures',
      'mcp-tools-changed-server.mjs',
    );
    manager = new McpClientManager({
      agentCwd: '/tmp',
      failOnError: true,
      configProvider: async () => ({
        mcpServers: {
          controlled: { command: process.execPath, args: [fixture] },
        },
        serverMetadata: {
          controlled: {
            name: '受控 MCP',
            description: '只用于 tools/list_changed 集成测试',
          },
        },
      }),
    });

    const initial = await manager.ensureUser('mcp-tools-changed-test');
    expect(initial.map((tool) => tool.toolName)).toEqual(['read_value', 'enable_extra_tool']);
    expect(initial[0]).toMatchObject({
      serverName: 'controlled',
      serverDisplayName: '受控 MCP',
      serverDescription: '只用于 tools/list_changed 集成测试',
      inputSchema: expect.objectContaining({ required: ['key'] }),
    });

    await manager.invoke(
      'mcp-tools-changed-test',
      buildMcpToolKey('controlled', 'enable_extra_tool'),
      {},
    );
    let refreshed = await manager.ensureUser('mcp-tools-changed-test');
    for (let attempt = 0; attempt < 20 && !refreshed.some((tool) => tool.toolName === 'read_extra'); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      refreshed = await manager.ensureUser('mcp-tools-changed-test');
    }
    expect(refreshed.map((tool) => tool.toolName)).toEqual([
      'read_value', 'enable_extra_tool', 'read_extra',
    ]);
    expect(manager.getUserConnectionStatuses('mcp-tools-changed-test')).toEqual([
      expect.objectContaining({ serverName: 'controlled', status: 'connected', toolCount: 3 }),
    ]);
  });
});
