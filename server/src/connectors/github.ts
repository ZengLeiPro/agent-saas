import type { SecretVault } from '../security/secretVault.js';
import type { ConnectorConnectionRecord, ConnectorConnectionStore } from './connectionStore.js';

export const GITHUB_CONNECTOR_ID = 'github';
export const GITHUB_TOKEN_CREDENTIAL_KEY = 'token';

export interface GithubConnectionView {
  connectorId: 'github';
  status: 'connected' | 'disconnected';
  runtimeEnabled: boolean;
  connectedAt?: string;
  updatedAt?: string;
}

function vaultOwnerId(record: ConnectorConnectionRecord): string {
  const ownerId = record.metadata?.credentialOwnerId;
  return typeof ownerId === 'string' && ownerId.length > 0 ? ownerId : record.username;
}

export function toGithubConnectionView(
  record?: ConnectorConnectionRecord,
  runtimeEnabled = true,
): GithubConnectionView {
  return {
    connectorId: GITHUB_CONNECTOR_ID,
    status: record?.status ?? 'disconnected',
    runtimeEnabled,
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
          userId: vaultOwnerId(record),
          tenantId: record.tenantId,
          scopes: ['secret:connector:revoke'],
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

export async function resolveGithubToken(
  deps: { connectionStore: ConnectorConnectionStore; vault: SecretVault; onError?: (error: Error) => void },
  context: { userId: string; username: string; tenantId: string },
): Promise<string | undefined> {
  const connection = deps.connectionStore.get(context.username, GITHUB_CONNECTOR_ID);
  if (
    !connection
    || connection.status !== 'connected'
    || !deps.connectionStore.isRuntimeEnabled(context.username, GITHUB_CONNECTOR_ID)
    || connection.userId !== context.userId
    || connection.tenantId !== context.tenantId
  ) return undefined;
  const tokenRef = connection.credentialRefs[GITHUB_TOKEN_CREDENTIAL_KEY];
  if (!tokenRef) return undefined;
  try {
    return await deps.vault.getSecret(tokenRef, {
      actor: 'connector_proxy',
      userId: vaultOwnerId(connection),
      tenantId: context.tenantId,
      scopes: ['secret:connector:read'],
    }) || undefined;
  } catch (error) {
    deps.onError?.(error instanceof Error ? error : new Error(String(error)));
    return undefined;
  }
}

export async function resolveGithubRuntimeEnv(
  deps: { connectionStore: ConnectorConnectionStore; vault: SecretVault; onError?: (error: Error) => void },
  context: { userId: string; username: string; tenantId: string },
): Promise<Record<string, string>> {
  const token = await resolveGithubToken(deps, context);
  return token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {};
}
