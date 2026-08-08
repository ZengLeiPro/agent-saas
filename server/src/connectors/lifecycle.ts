import type { SecretVault } from '../security/secretVault.js';
import { ALIYUN_CONNECTOR_ID } from './aliyun.js';
import type { ConnectorConnectionRecord, ConnectorConnectionStore } from './connectionStore.js';
import { NOTION_CONNECTOR_ID } from './notion.js';

function vaultOwnerId(record: ConnectorConnectionRecord): string {
  const explicitOwnerId = record.metadata?.credentialOwnerId;
  if (typeof explicitOwnerId === 'string' && explicitOwnerId.length > 0) return explicitOwnerId;
  if (record.connectorId === ALIYUN_CONNECTOR_ID || record.connectorId === NOTION_CONNECTOR_ID) {
    return record.userId ?? record.username;
  }
  return record.username;
}

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
          userId: vaultOwnerId(record),
          tenantId: input.tenantId,
          scopes: ['secret:connector:revoke'],
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
