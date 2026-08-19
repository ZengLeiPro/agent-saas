import type { SecretVault } from '../security/secretVault.js';
import type { ConnectorConnectionRecord, ConnectorConnectionStore } from './connectionStore.js';

export const X_CONNECTOR_ID = 'x';
export const X_COOKIE_CREDENTIAL_KEY = 'cookies';

export interface XConnectInput {
  authToken: string;
  ct0: string;
}

export interface XConnectionView {
  connectorId: typeof X_CONNECTOR_ID;
  status: 'connected' | 'disconnected';
  runtimeEnabled: boolean;
  connectedAt?: string;
  updatedAt?: string;
}

interface XCookieCredential {
  authToken: string;
  ct0: string;
}

function credentialOwnerId(record: ConnectorConnectionRecord): string {
  const ownerId = record.metadata?.credentialOwnerId;
  return typeof ownerId === 'string' && ownerId.length > 0
    ? ownerId
    : record.userId ?? record.username;
}

function vaultCaller(userId: string, tenantId: string, operation: 'read' | 'write' | 'revoke') {
  return {
    actor: 'connector_proxy' as const,
    userId,
    tenantId,
    scopes: [`secret:connector:${operation}`],
  };
}

function ownedRecord(
  connectionStore: ConnectorConnectionStore,
  context: { userId: string; username: string; tenantId: string },
): ConnectorConnectionRecord | undefined {
  const record = connectionStore.get(context.username, X_CONNECTOR_ID);
  return record?.userId === context.userId && record.tenantId === context.tenantId
    ? record
    : undefined;
}

function normalizeCookie(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} 不能为空`);
  if (normalized.length > 20_000 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} 格式无效`);
  }
  return normalized;
}

export function normalizeXConnectInput(input: XConnectInput): XConnectInput {
  return {
    authToken: normalizeCookie(input.authToken, 'auth_token'),
    ct0: normalizeCookie(input.ct0, 'ct0'),
  };
}

export function toXConnectionView(
  record?: ConnectorConnectionRecord,
  runtimeEnabled = true,
): XConnectionView {
  return {
    connectorId: X_CONNECTOR_ID,
    status: record?.status ?? 'disconnected',
    runtimeEnabled,
    connectedAt: record?.connectedAt,
    updatedAt: record?.updatedAt,
  };
}

function parseCookieCredential(value: string): XCookieCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('X 连接凭据格式无效');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('X 连接凭据不完整');
  const candidate = parsed as Partial<XCookieCredential>;
  if (typeof candidate.authToken !== 'string' || typeof candidate.ct0 !== 'string') {
    throw new Error('X 连接凭据不完整');
  }
  return normalizeXConnectInput({
    authToken: candidate.authToken,
    ct0: candidate.ct0,
  });
}

export function getXConnection(
  connectionStore: ConnectorConnectionStore,
  context: { userId: string; username: string; tenantId: string },
): XConnectionView {
  const record = ownedRecord(connectionStore, context);
  return toXConnectionView(
    record,
    connectionStore.isRuntimeEnabled(context.username, X_CONNECTOR_ID),
  );
}

export async function revokePendingXCredentials(input: {
  connectionStore: ConnectorConnectionStore;
  vault: SecretVault;
  username?: string;
  onError?: (error: Error, ref: string) => void;
}): Promise<number> {
  let revoked = 0;
  const records = input.connectionStore.listAll().filter(record =>
    record.connectorId === X_CONNECTOR_ID
    && (!input.username || record.username === input.username),
  );
  for (const record of records) {
    for (const ref of record.pendingRevokeRefs ?? []) {
      const pendingOwner = record.pendingRevokeRefOwners?.[ref];
      try {
        await input.vault.revokeSecret(ref, vaultCaller(
          pendingOwner?.userId ?? credentialOwnerId(record),
          pendingOwner?.tenantId ?? record.tenantId,
          'revoke',
        ));
        await input.connectionStore.markCredentialRevoked(record.username, X_CONNECTOR_ID, ref);
        revoked++;
      } catch (error) {
        input.onError?.(error instanceof Error ? error : new Error(String(error)), ref);
      }
    }
  }
  return revoked;
}

export async function resolveXRuntimeEnv(
  deps: { connectionStore: ConnectorConnectionStore; vault: SecretVault; onError?: (error: Error) => void },
  context: { userId: string; username: string; tenantId: string },
): Promise<Record<string, string>> {
  const connection = ownedRecord(deps.connectionStore, context);
  if (
    !connection
    || connection.status !== 'connected'
    || !deps.connectionStore.isRuntimeEnabled(context.username, X_CONNECTOR_ID)
  ) return {};
  const credentialRef = connection.credentialRefs[X_COOKIE_CREDENTIAL_KEY];
  if (!credentialRef) return {};
  try {
    const value = await deps.vault.getSecret(
      credentialRef,
      vaultCaller(credentialOwnerId(connection), context.tenantId, 'read'),
    );
    const credential = parseCookieCredential(value);
    return {
      AUTH_TOKEN: credential.authToken,
      CT0: credential.ct0,
      TWITTER_AUTH_TOKEN: credential.authToken,
      TWITTER_CT0: credential.ct0,
    };
  } catch (error) {
    deps.onError?.(error instanceof Error ? error : new Error(String(error)));
    return {};
  }
}

export async function connectXCredential(input: {
  connectionStore: ConnectorConnectionStore;
  vault: SecretVault;
  userId: string;
  username: string;
  tenantId: string;
  credentials: XConnectInput;
  onError?: (error: Error) => void;
}): Promise<XConnectionView> {
  const credentials = normalizeXConnectInput(input.credentials);
  const secret = await input.vault.putSecret(
    input.userId,
    'connector',
    JSON.stringify(credentials),
    vaultCaller(input.userId, input.tenantId, 'write'),
    {
      connectorId: X_CONNECTOR_ID,
      credentialKey: X_COOKIE_CREDENTIAL_KEY,
      tenantId: input.tenantId,
      credentialOwnerId: input.userId,
    },
  );

  let record: ConnectorConnectionRecord;
  try {
    record = await input.connectionStore.connect({
      username: input.username,
      userId: input.userId,
      tenantId: input.tenantId,
      connectorId: X_CONNECTOR_ID,
      credentialRefs: { [X_COOKIE_CREDENTIAL_KEY]: secret.id },
      capabilities: { native: true },
      metadata: { credentialOwnerId: input.userId },
    });
  } catch (error) {
    await input.vault.revokeSecret(
      secret.id,
      vaultCaller(input.userId, input.tenantId, 'revoke'),
    ).catch(revokeError => {
      input.onError?.(revokeError instanceof Error ? revokeError : new Error(String(revokeError)));
    });
    throw error;
  }

  await revokePendingXCredentials({
    connectionStore: input.connectionStore,
    vault: input.vault,
    username: input.username,
    onError: input.onError
      ? (error, ref) => input.onError?.(new Error(`X 旧凭据撤销失败 ${ref}: ${error.message}`))
      : undefined,
  });
  await input.connectionStore.setRuntimeEnabled(input.username, X_CONNECTOR_ID, true);
  return toXConnectionView(record, true);
}

export async function disconnectXCredential(input: {
  connectionStore: ConnectorConnectionStore;
  vault: SecretVault;
  userId: string;
  username: string;
  tenantId: string;
  onError?: (error: Error) => void;
}): Promise<XConnectionView> {
  const current = ownedRecord(input.connectionStore, input);
  if (!current) return toXConnectionView(undefined);
  const connection = await input.connectionStore.disconnect(
    input.username,
    X_CONNECTOR_ID,
    input.tenantId,
  );
  await revokePendingXCredentials({
    connectionStore: input.connectionStore,
    vault: input.vault,
    username: input.username,
    onError: input.onError
      ? (error, ref) => input.onError?.(new Error(`X 凭据撤销失败 ${ref}: ${error.message}`))
      : undefined,
  });
  return toXConnectionView(connection, input.connectionStore.isRuntimeEnabled(input.username, X_CONNECTOR_ID));
}
