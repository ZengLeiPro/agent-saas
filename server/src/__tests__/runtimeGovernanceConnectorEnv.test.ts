import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  initializeRuntimeGovernanceConnectors,
  resolveBrokeredMcpServerIds,
} from '../app/runtimeGovernanceConnectors.js';
import type { FeishuTokenBroker } from '../feishu/tokenBroker.js';
import { InMemorySecretVault } from '../security/secretVault.js';
import type { AppConfig } from '../types/index.js';

const roots: string[] = [];

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'runtime-connector-env-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('runtime governance connector env', () => {
  it('limits brokered MCP warmup to enabled MCP servers and excludes native Aliyun', () => {
    const getEffectiveServers = vi.fn(() => [
      { id: 'mcp-salesforce' },
      { id: 'mcp-internal-search' },
    ]);

    const serverIds = resolveBrokeredMcpServerIds(
      { getEffectiveServers } as never,
      'alice',
      'tenant-a',
    );

    expect([...serverIds]).toEqual(['mcp-salesforce', 'mcp-internal-search']);
    expect(serverIds.has('aliyun')).toBe(false);
    expect(getEffectiveServers).toHaveBeenCalledWith('alice', 'tenant-a');
  });

  it('wires user-owned, brokered and tenant env into the run-scoped resolver', async () => {
    const root = createRoot();
    const vault = new InMemorySecretVault();
    const feishuBroker = {
      ensureFresh: async () => ({ appId: 'cli_app', accessToken: 'uat_runtime' }),
    } as unknown as FeishuTokenBroker;
    const runtime = await initializeRuntimeGovernanceConnectors({
      processCwd: root,
      agentCwd: join(root, 'agents'),
      config: {} as AppConfig,
      secretVault: vault,
      getFeishuTokenBroker: () => feishuBroker,
      tenantRunEnvByTenant: new Map([['tenant-a', { DASHSCOPE_API_KEY: 'tenant-stt-key' }]]),
      resolveLegacySkillResourceId: (_user, skillId) => skillId,
    });

    try {
      const secret = await vault.putSecret(
        'user-1',
        'connector',
        'github_pat_runtime_wiring',
        {
          actor: 'connector_proxy',
          userId: 'user-1',
          tenantId: 'tenant-a',
          scopes: ['secret:connector:write'],
        },
      );
      await runtime.connectorConnectionStore.connect({
        username: 'alice',
        userId: 'user-1',
        tenantId: 'tenant-a',
        connectorId: 'github',
        credentialRefs: { token: secret.id },
        metadata: { credentialOwnerId: 'user-1' },
      });

      await expect(runtime.resolveRunScopedEnv({
        userId: 'user-1',
        username: 'alice',
        tenantId: 'tenant-a',
      })).resolves.toMatchObject({
        GH_TOKEN: 'github_pat_runtime_wiring',
        GITHUB_TOKEN: 'github_pat_runtime_wiring',
        LARKSUITE_CLI_APP_ID: 'cli_app',
        LARKSUITE_CLI_USER_ACCESS_TOKEN: 'uat_runtime',
        DASHSCOPE_API_KEY: 'tenant-stt-key',
      });
    } finally {
      await runtime.mcpClientShutdown();
    }
  });
});
