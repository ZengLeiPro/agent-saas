import type { UserStore } from '../data/users/store.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import type { McpConfigStore } from '../data/mcpConfig.js';
import type { SecretVault } from '../security/secretVault.js';
import type { ConnectorConnectionRecord, ConnectorConnectionStore } from './connectionStore.js';

export const GITHUB_CONNECTOR_ID = 'github';
export const GITHUB_TOKEN_CREDENTIAL_KEY = 'token';
export const GITHUB_MCP_CAPABILITY = 'mcp';

export interface GithubConnectionView {
  connectorId: 'github';
  status: 'connected' | 'disconnected';
  connectedAt?: string;
  updatedAt?: string;
  mcpEnabled: boolean;
}

export function toGithubConnectionView(record?: ConnectorConnectionRecord): GithubConnectionView {
  return {
    connectorId: GITHUB_CONNECTOR_ID,
    status: record?.status ?? 'disconnected',
    connectedAt: record?.connectedAt,
    updatedAt: record?.updatedAt,
    mcpEnabled: record?.status === 'connected' && record.capabilities[GITHUB_MCP_CAPABILITY] === true,
  };
}

/**
 * 把旧 McpConfigStore 中的 GitHub secret ref 原地迁移到 ConnectorStore。
 * 只迁 ref，不读取、不复制明文；随后清掉旧 pointer，避免 MCP 继续成为凭据权威源。
 */
export async function migrateLegacyGithubConnections(input: {
  connectionStore: ConnectorConnectionStore;
  mcpConfigStore: McpConfigStore;
  userStore?: UserStore;
}): Promise<number> {
  let migrated = 0;
  for (const username of input.mcpConfigStore.listUsernames()) {
    const legacyRef = input.mcpConfigStore.getUserSecretRef(
      username,
      GITHUB_CONNECTOR_ID,
      GITHUB_TOKEN_CREDENTIAL_KEY,
    );
    if (!legacyRef) continue;

    const current = input.connectionStore.get(username, GITHUB_CONNECTOR_ID);
    if (!current) {
      const user = input.userStore?.findByUsername(username);
      if (input.userStore && !user) continue;
      const mcpEnabled = input.mcpConfigStore.getUserConfig(username).enabledServers.includes(GITHUB_CONNECTOR_ID);
      await input.connectionStore.connect({
        username,
        tenantId: user?.tenantId ?? DEFAULT_TENANT_ID,
        connectorId: GITHUB_CONNECTOR_ID,
        credentialRefs: { [GITHUB_TOKEN_CREDENTIAL_KEY]: legacyRef },
        capabilities: { [GITHUB_MCP_CAPABILITY]: mcpEnabled },
      });
      migrated++;
    }
    await input.mcpConfigStore.clearUserSecretRef(
      username,
      GITHUB_CONNECTOR_ID,
      GITHUB_TOKEN_CREDENTIAL_KEY,
    );
  }
  return migrated;
}

export function githubMcpCredentialOverrides(
  connectionStore: ConnectorConnectionStore,
  username: string,
): Record<string, Record<string, string>> {
  const connection = connectionStore.get(username, GITHUB_CONNECTOR_ID);
  const tokenRef = connection?.status === 'connected'
    ? connection.credentialRefs[GITHUB_TOKEN_CREDENTIAL_KEY]
    : undefined;
  return tokenRef
    ? { [GITHUB_CONNECTOR_ID]: { [GITHUB_TOKEN_CREDENTIAL_KEY]: tokenRef } }
    : {};
}

export async function revokePendingGithubCredentials(input: {
  connectionStore: ConnectorConnectionStore;
  vault: SecretVault;
  username?: string;
  onError?: (error: Error, ref: string) => void;
}): Promise<number> {
  let revoked = 0;
  const records = input.connectionStore.listAll().filter(record =>
    record.connectorId === GITHUB_CONNECTOR_ID
    && (!input.username || record.username === input.username),
  );
  for (const record of records) {
    for (const ref of record.pendingRevokeRefs ?? []) {
      try {
        await input.vault.revokeSecret(ref, {
          actor: 'connector_proxy',
          userId: record.username,
          tenantId: record.tenantId,
          scopes: ['secret:connector:read', 'secret:mcp:read'],
        });
        await input.connectionStore.markCredentialRevoked(record.username, GITHUB_CONNECTOR_ID, ref);
        revoked++;
      } catch (error) {
        input.onError?.(error instanceof Error ? error : new Error(String(error)), ref);
      }
    }
  }
  return revoked;
}

export async function resolveGithubRuntimeEnv(
  deps: { connectionStore: ConnectorConnectionStore; vault: SecretVault; onError?: (error: Error) => void },
  context: { username: string; tenantId: string },
): Promise<Record<string, string>> {
  const connection = deps.connectionStore.get(context.username, GITHUB_CONNECTOR_ID);
  const tokenRef = connection?.status === 'connected'
    ? connection.credentialRefs[GITHUB_TOKEN_CREDENTIAL_KEY]
    : undefined;
  if (!tokenRef) return {};

  try {
    const token = await deps.vault.getSecret(tokenRef, {
      actor: 'connector_proxy',
      userId: context.username,
      tenantId: context.tenantId,
      scopes: ['secret:connector:read', 'secret:mcp:read'],
    });
    return token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {};
  } catch (error) {
    deps.onError?.(error instanceof Error ? error : new Error(String(error)));
    return {};
  }
}
