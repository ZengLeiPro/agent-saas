import type { SecretVault } from '../security/secretVault.js';
import type { GovernanceCredential } from '../data/credentials/types.js';
import {
  isUsableGovernanceCredential,
  listPersonalGovernanceCredentials,
  type GovernanceCredentialReader,
} from './governanceCredential.js';
import type { ConnectorConnectionRecord, ConnectorConnectionStore } from './connectionStore.js';

export const GITHUB_CONNECTOR_ID = 'github';
export const GITHUB_TOKEN_CREDENTIAL_KEY = 'token';

export interface GithubConnectionView {
  connectorId: 'github';
  status: 'connected' | 'disconnected';
  runtimeEnabled: boolean;
  credentialId?: string;
  credentialVersion?: number;
  connectedAt?: string;
  updatedAt?: string;
}

function vaultOwnerId(record: ConnectorConnectionRecord): string {
  const ownerId = record.metadata?.credentialOwnerId;
  return typeof ownerId === 'string' && ownerId.length > 0 ? ownerId : record.username;
}

function ownedRecord(
  connectionStore: ConnectorConnectionStore,
  context: { userId: string; username: string; tenantId: string },
): ConnectorConnectionRecord | undefined {
  const record = connectionStore.get(context.username, GITHUB_CONNECTOR_ID);
  return record?.userId === context.userId && record.tenantId === context.tenantId
    ? record
    : undefined;
}

export function toGithubConnectionView(
  record?: ConnectorConnectionRecord,
  runtimeEnabled = true,
  credential?: GovernanceCredential,
): GithubConnectionView {
  return {
    connectorId: GITHUB_CONNECTOR_ID,
    status: credential ? 'connected' : (record?.status ?? 'disconnected'),
    runtimeEnabled,
    ...(credential ? {
      credentialId: credential.credentialId,
      credentialVersion: credential.version,
      connectedAt: credential.createdAt,
      updatedAt: credential.updatedAt,
    } : {
      connectedAt: record?.connectedAt,
      updatedAt: record?.updatedAt,
    }),
  };
}

export async function getGithubConnectionWithGovernance(input: {
  connectionStore: ConnectorConnectionStore;
  governanceCredentialStore?: GovernanceCredentialReader;
  context: { userId: string; username: string; tenantId: string };
}): Promise<GithubConnectionView> {
  const runtimeEnabled = input.connectionStore.isRuntimeEnabled(input.context.username, GITHUB_CONNECTOR_ID);
  if (input.governanceCredentialStore) {
    const credentials = await listPersonalGovernanceCredentials(
      input.governanceCredentialStore,
      input.context,
      GITHUB_CONNECTOR_ID,
    );
    const credential = credentials.find(isUsableGovernanceCredential);
    if (credential) return toGithubConnectionView(undefined, runtimeEnabled, credential);
    if (credentials.length > 0) return toGithubConnectionView(undefined, runtimeEnabled);
  }
  return toGithubConnectionView(ownedRecord(input.connectionStore, input.context), runtimeEnabled);
}

export async function revokePendingGithubCredentials(input: {
  connectionStore: ConnectorConnectionStore;
  vault: SecretVault;
  username?: string;
  excludeRefs?: ReadonlySet<string>;
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
        if (!input.excludeRefs?.has(ref)) {
          await input.vault.revokeSecret(ref, {
            actor: 'connector_proxy',
            userId: vaultOwnerId(record),
            tenantId: record.tenantId,
            scopes: ['secret:connector:revoke'],
          });
        }
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
  deps: {
    connectionStore: ConnectorConnectionStore;
    vault: SecretVault;
    governanceCredentialStore?: GovernanceCredentialReader;
    onError?: (error: Error) => void;
  },
  context: { userId: string; username: string; tenantId: string },
): Promise<string | undefined> {
  let governanceCredentials: GovernanceCredential[] = [];
  if (deps.governanceCredentialStore) {
    try {
      governanceCredentials = await listPersonalGovernanceCredentials(
        deps.governanceCredentialStore,
        context,
        GITHUB_CONNECTOR_ID,
      );
    } catch (error) {
      deps.onError?.(error instanceof Error ? error : new Error(String(error)));
      return undefined;
    }
  }
  const governanceCredential = governanceCredentials.find(isUsableGovernanceCredential);
  const connection = governanceCredential || governanceCredentials.length > 0
    ? undefined
    : ownedRecord(deps.connectionStore, context);
  if (!governanceCredential && (
    governanceCredentials.length > 0
    || !connection
    || connection.status !== 'connected'
    || !deps.connectionStore.isRuntimeEnabled(context.username, GITHUB_CONNECTOR_ID)
  )) return undefined;
  if (!deps.connectionStore.isRuntimeEnabled(context.username, GITHUB_CONNECTOR_ID)) return undefined;

  const tokenRef = governanceCredential?.secretRef
    ?? connection?.credentialRefs[GITHUB_TOKEN_CREDENTIAL_KEY];
  if (!tokenRef) return undefined;
  try {
    return await deps.vault.getSecret(tokenRef, {
      actor: 'connector_proxy',
      userId: governanceCredential?.ownerUserId ?? (connection ? vaultOwnerId(connection) : context.userId),
      tenantId: context.tenantId,
      scopes: ['secret:connector:read'],
    }) || undefined;
  } catch (error) {
    deps.onError?.(error instanceof Error ? error : new Error(String(error)));
    return undefined;
  }
}

export async function resolveGithubRuntimeEnv(
  deps: {
    connectionStore: ConnectorConnectionStore;
    vault: SecretVault;
    governanceCredentialStore?: GovernanceCredentialReader;
    onError?: (error: Error) => void;
  },
  context: { userId: string; username: string; tenantId: string },
): Promise<Record<string, string>> {
  const token = await resolveGithubToken(deps, context);
  return token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {};
}
