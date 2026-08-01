import type { SecretVault } from '../security/secretVault.js';
import { ALIYUN_CONNECTOR_ID } from './aliyun.js';
import type { ConnectorConnectionStore } from './connectionStore.js';

export async function revokeAllUserConnectorCredentials(input: {
  connectionStore: ConnectorConnectionStore;
  vault: SecretVault;
  userId: string;
  username: string;
  tenantId: string;
  onError?: (error: Error, meta: { connectorId: string; ref: string }) => void;
}): Promise<number> {
  let revoked = 0;
  const records = input.connectionStore.listForUser(input.username)
    .filter(record => record.userId === input.userId && record.tenantId === input.tenantId);
  for (const record of records) {
    await input.connectionStore.disconnect(input.username, record.connectorId, input.tenantId);
    const disconnected = input.connectionStore.get(input.username, record.connectorId);
    for (const ref of disconnected?.pendingRevokeRefs ?? []) {
      try {
        await input.vault.revokeSecret(ref, {
          actor: 'connector_proxy',
          userId: record.connectorId === ALIYUN_CONNECTOR_ID ? input.userId : input.username,
          tenantId: input.tenantId,
          scopes: ['secret:connector:read', 'secret:mcp:read'],
        });
        await input.connectionStore.markCredentialRevoked(input.username, record.connectorId, ref);
        revoked++;
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        if (!input.onError) throw normalized;
        input.onError(normalized, { connectorId: record.connectorId, ref });
      }
    }
  }
  return revoked;
}
