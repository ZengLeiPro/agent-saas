import type { SecretVault } from '../security/secretVault.js';
import type { ConnectorConnectionRecord, ConnectorConnectionStore } from './connectionStore.js';

export const GITHUB_CONNECTOR_ID = 'github';
export const GITHUB_TOKEN_CREDENTIAL_KEY = 'token';

export interface GithubConnectionView {
  connectorId: 'github';
  status: 'connected' | 'disconnected';
  connectedAt?: string;
  updatedAt?: string;
}

export function toGithubConnectionView(record?: ConnectorConnectionRecord): GithubConnectionView {
  return {
    connectorId: GITHUB_CONNECTOR_ID,
    status: record?.status ?? 'disconnected',
    connectedAt: record?.connectedAt,
    updatedAt: record?.updatedAt,
  };
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
  context: { userId: string; username: string; tenantId: string },
): Promise<Record<string, string>> {
  const connection = deps.connectionStore.get(context.username, GITHUB_CONNECTOR_ID);
  const tokenRef = connection?.status === 'connected'
    && connection.userId === context.userId
    && connection.tenantId === context.tenantId
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
