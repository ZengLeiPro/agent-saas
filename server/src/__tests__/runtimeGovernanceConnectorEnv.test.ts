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
  vi.unstubAllEnvs();
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

  it('uses the Google Workspace governance catalog id when authorizing OAuth', async () => {
    const root = createRoot();
    const vault = new InMemorySecretVault();
    vi.stubEnv('GOOGLE_WORKSPACE_CONNECTOR_CLIENT_ID', 'google-client-id');
    vi.stubEnv('GOOGLE_WORKSPACE_CONNECTOR_CLIENT_SECRET', 'google-client-secret');
    const user = {
      id: 'user-1', username: 'alice', tenantId: 'tenant-a', role: 'user', disabled: false,
    };
    const listEffectiveResourceIds = vi.fn().mockResolvedValue([{
      resourceId: 'google_workspace',
      bindingId: 'binding-1',
      assignmentVersion: 1,
      finalEffect: 'allow',
      bindings: [],
    }]);
    const runtime = await initializeRuntimeGovernanceConnectors({
      processCwd: root,
      agentCwd: join(root, 'agents'),
      config: {} as AppConfig,
      secretVault: vault,
      userStore: { findById: vi.fn(() => user) } as never,
      membershipStore: { getMembership: vi.fn().mockResolvedValue({ status: 'active' }) } as never,
      governanceChangeJobStore: { findActiveForTarget: vi.fn().mockResolvedValue(null) } as never,
      assignmentStore: { listEffectiveResourceIds } as never,
      entitlementStore: {
        getEntitlementSet: vi.fn().mockResolvedValue({ status: 'active' }),
        listResourceScopes: vi.fn().mockResolvedValue([{
          resourceType: 'connector', mode: 'selected', resourceIds: ['google_workspace'],
        }]),
      } as never,
      resolveLegacySkillResourceId: (_user, skillId) => skillId,
    });

    try {
      await expect(runtime.googleWorkspaceOAuthService?.startAuthorization(
        user as never,
        'https://agent.example.test/api/connectors/oauth/callback',
      )).resolves.toMatchObject({ authorizationUrl: expect.stringContaining('accounts.google.com') });
      expect(listEffectiveResourceIds).toHaveBeenCalledWith('tenant-a', 'user-1', 'connector');
    } finally {
      await runtime.mcpClientShutdown();
    }
  });

  it('preserves a custom MCP x runtime env when native X is paused', async () => {
    const root = createRoot();
    const vault = new InMemorySecretVault();
    const runtime = await initializeRuntimeGovernanceConnectors({
      processCwd: root,
      agentCwd: join(root, 'agents'),
      config: {} as AppConfig,
      secretVault: vault,
      resolveLegacySkillResourceId: (_user, skillId) => skillId,
    });

    try {
      await runtime.mcpConfigStore.upsertServer({
        id: 'x',
        name: 'Personal X-compatible MCP',
        ownerUsername: 'alice',
        tenantId: 'tenant-a',
        config: { type: 'streamable-http', url: 'https://mcp.example.test/x' },
        secretRequirements: [
          { key: 'auth', label: 'Auth', target: 'env', name: 'AUTH_TOKEN', scope: 'user' },
          { key: 'ct0', label: 'CT0', target: 'env', name: 'CT0', scope: 'user' },
        ],
      });
      await runtime.mcpConfigStore.setUserEnabledServers('alice', ['x'], 'tenant-a');
      const mcpCaller = {
        actor: 'mcp_proxy' as const,
        userId: 'alice',
        tenantId: 'tenant-a',
        scopes: ['secret:mcp:write'],
      };
      const mcpAuth = await vault.putSecret('alice', 'mcp', 'mcp-auth', mcpCaller);
      const mcpCt0 = await vault.putSecret('alice', 'mcp', 'mcp-ct0', mcpCaller);
      await runtime.mcpConfigStore.setUserSecretRef('alice', 'x', 'auth', mcpAuth.id, 'tenant-a');
      await runtime.mcpConfigStore.setUserSecretRef('alice', 'x', 'ct0', mcpCt0.id, 'tenant-a');

      const xSecret = await vault.putSecret(
        'user-1',
        'connector',
        JSON.stringify({ authToken: 'native-auth', ct0: 'native-ct0' }),
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
        connectorId: 'x',
        credentialRefs: { cookies: xSecret.id },
        metadata: { credentialOwnerId: 'user-1' },
      });

      await expect(runtime.resolveRunScopedEnv({
        userId: 'user-1',
        username: 'alice',
        tenantId: 'tenant-a',
      })).resolves.toMatchObject({
        AUTH_TOKEN: 'native-auth',
        CT0: 'native-ct0',
      });

      await runtime.connectorConnectionStore.setRuntimeEnabled('alice', 'x', false);
      await expect(runtime.resolveRunScopedEnv({
        userId: 'user-1',
        username: 'alice',
        tenantId: 'tenant-a',
      })).resolves.toMatchObject({
        AUTH_TOKEN: 'mcp-auth',
        CT0: 'mcp-ct0',
      });
    } finally {
      await runtime.mcpClientShutdown();
    }
  });
});
