import type { SecretVault } from '../security/secretVault.js';
import type { ConnectorConnectionStore } from './connectionStore.js';

export const NOTION_CONNECTOR_ID = 'notion';
export const NOTION_TOKEN_CREDENTIAL_KEY = 'token';

export async function connectNotionCredential(input: {
  connectionStore: ConnectorConnectionStore;
  vault: SecretVault;
  username: string;
  userId: string;
  tenantId: string;
  token: string;
}): Promise<void> {
  const ref = await input.vault.putSecret(
    input.username,
    'connector',
    input.token,
    {
      ownerId: input.username,
      tenantId: input.tenantId,
      connectorId: NOTION_CONNECTOR_ID,
    },
  );
  try {
    await input.connectionStore.connect({
      username: input.username,
      userId: input.userId,
      tenantId: input.tenantId,
      connectorId: NOTION_CONNECTOR_ID,
      credentialRefs: { [NOTION_TOKEN_CREDENTIAL_KEY]: ref.id },
    });
    await revokePendingNotionCredentials(input.connectionStore, input.vault, input.username);
  } catch (error) {
    await input.vault.revokeSecret(ref, vaultCaller(input.username, input.tenantId)).catch(() => undefined);
    throw error;
  }
}

export async function disconnectNotion(input: {
  connectionStore: ConnectorConnectionStore;
  vault: SecretVault;
  username: string;
  userId: string;
  tenantId: string;
}): Promise<void> {
  const record = input.connectionStore.get(input.username, NOTION_CONNECTOR_ID);
  if (!record || record.userId !== input.userId || record.tenantId !== input.tenantId) return;
  await input.connectionStore.disconnect(input.username, NOTION_CONNECTOR_ID, input.tenantId);
  await revokePendingNotionCredentials(input.connectionStore, input.vault, input.username);
}

export async function resolveNotionRuntimeEnv(
  deps: { connectionStore: ConnectorConnectionStore; vault: SecretVault; onError?: (error: Error) => void },
  context: { userId: string; username: string; tenantId: string },
): Promise<Record<string, string>> {
  const record = deps.connectionStore.get(context.username, NOTION_CONNECTOR_ID);
  const ref = record?.status === 'connected'
    && record.userId === context.userId
    && record.tenantId === context.tenantId
    ? record.credentialRefs[NOTION_TOKEN_CREDENTIAL_KEY]
    : undefined;
  if (!ref) return {};
  try {
    const token = await deps.vault.getSecret(ref, vaultCaller(context.username, context.tenantId));
    return token ? { NOTION_API_TOKEN: token } : {};
  } catch (error) {
    deps.onError?.(error instanceof Error ? error : new Error(String(error)));
    return {};
  }
}

async function revokePendingNotionCredentials(
  connectionStore: ConnectorConnectionStore,
  vault: SecretVault,
  username: string,
): Promise<void> {
  const record = connectionStore.get(username, NOTION_CONNECTOR_ID);
  if (!record) return;
  for (const ref of record.pendingRevokeRefs ?? []) {
    await vault.revokeSecret(ref, vaultCaller(record.username, record.tenantId));
    await connectionStore.markCredentialRevoked(record.username, NOTION_CONNECTOR_ID, ref);
  }
}

function vaultCaller(username: string, tenantId: string) {
  return {
    actor: 'connector_proxy' as const,
    userId: username,
    tenantId,
    scopes: ['secret:connector:read', 'secret:mcp:read'],
  };
}
