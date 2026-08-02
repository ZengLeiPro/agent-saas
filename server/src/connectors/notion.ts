import type { SecretVault } from '../security/secretVault.js';
import type { ConnectorConnectionRecord, ConnectorConnectionStore } from './connectionStore.js';

export const NOTION_CONNECTOR_ID = 'notion';
export const NOTION_VERSION = '2022-06-28';
const NOTION_ME_ENDPOINT = 'https://api.notion.com/v1/users/me';
const NOTION_VERIFY_TIMEOUT_MS = 5_000;
export const NOTION_LOCAL_DISCONNECT_NOTICE = '已仅在本平台移除 Notion 凭据；Notion 端授权/令牌未被远程撤销。如需彻底撤销，请在 Notion 中移除授权/令牌。';

type NotionConnectionStatus = 'connected' | 'invalid' | 'unavailable' | 'disconnected';
type NotionIdentityType = 'person' | 'bot';

export interface NotionConnectionView {
  connectorId: typeof NOTION_CONNECTOR_ID;
  status: NotionConnectionStatus;
  workspaceName?: string;
  identity?: {
    id: string;
    type: NotionIdentityType;
    name?: string;
    email?: string;
    botOwnerType?: string;
  };
  connectedAt?: string;
  verifiedAt?: string;
  updatedAt?: string;
  verificationMessage?: string;
  disconnectNotice: string;
}

export interface NotionConnectorDeps {
  connectionStore: ConnectorConnectionStore;
  vault: SecretVault;
}

interface VerifiedNotionIdentity {
  id: string;
  type: NotionIdentityType;
  name?: string;
  email?: string;
  botOwnerType?: string;
  workspaceName?: string;
}

export async function connectNotionCredential(input: NotionConnectorDeps & {
  userId: string;
  username: string;
  tenantId: string;
  token: string;
  fetchImpl: typeof fetch;
}): Promise<NotionConnectionView> {
  const token = input.token.trim();
  if (!token) throw new Error('Notion token 不能为空');

  // 先向 Notion 验证，再写入 Vault；错误信息不包含 Authorization 或 provider body。
  const identity = await verifyNotionToken(token, input.fetchImpl);
  const now = new Date().toISOString();
  const secret = await input.vault.putSecret(input.userId, 'notion_api_token', token, {
    connectorId: NOTION_CONNECTOR_ID,
    tenantId: input.tenantId,
    userId: input.userId,
  });
  let record: ConnectorConnectionRecord;
  try {
    record = await input.connectionStore.connect({
      username: input.username,
      userId: input.userId,
      tenantId: input.tenantId,
      connectorId: NOTION_CONNECTOR_ID,
      credentialRefs: { token: secret.id },
      capabilities: { native: true },
      metadata: {
        ...metadataFromIdentity(identity, now),
        connectedAt: now,
        notionVerificationStatus: 'connected',
        notionVerificationMessage: '',
      },
    });
  } catch (error) {
    await input.vault.revokeSecret(secret.id, vaultCaller(input.userId, input.tenantId)).catch(() => undefined);
    throw error;
  }
  await revokePendingRefs(input.vault, input.connectionStore, record, input.userId, input.tenantId);
  return viewFromRecord(record, 'connected');
}

export async function getLiveNotionConnection(input: NotionConnectorDeps & {
  userId: string;
  username: string;
  tenantId: string;
  fetchImpl: typeof fetch;
}): Promise<NotionConnectionView> {
  const record = ownedRecord(input.connectionStore, input.username, input.userId, input.tenantId);
  if (!record || record.status !== 'connected') return disconnectedView();
  const tokenRef = record.credentialRefs.token;
  if (!tokenRef) {
    const message = '本地 Notion 凭据不存在';
    await markNotionVerification(input.connectionStore, input.username, 'invalid', message);
    return viewFromRecord(record, 'invalid', message);
  }

  let token: string;
  try {
    token = await input.vault.getSecret(tokenRef, vaultCaller(input.userId, input.tenantId));
  } catch {
    const message = '本地凭据暂时无法读取，保留上次连接信息';
    await markNotionVerification(input.connectionStore, input.username, 'unavailable', message);
    return viewFromRecord(record, 'unavailable', message);
  }

  let identity: VerifiedNotionIdentity;
  try {
    identity = await verifyNotionToken(token, input.fetchImpl);
  } catch (error) {
    const status = error instanceof NotionVerificationError ? error.kind : 'unavailable';
    const message = status === 'invalid'
      ? 'Notion 已拒绝该授权，请重新连接'
      : '暂时无法向 Notion 验证，保留上次连接信息';
    await markNotionVerification(input.connectionStore, input.username, status, message);
    return viewFromRecord(record, status, message);
  }

  const verifiedAt = new Date().toISOString();
  const updated = await input.connectionStore.updateMetadata(input.username, NOTION_CONNECTOR_ID, {
    ...metadataFromIdentity(identity, verifiedAt),
    notionVerificationStatus: 'connected',
    notionVerificationMessage: '',
    notionVerificationCheckedAt: verifiedAt,
  });
  return updated ? viewFromRecord(updated, 'connected') : disconnectedView();
}

export function getNotionConnectionView(
  connectionStore: ConnectorConnectionStore,
  username: string,
  userId?: string,
  tenantId?: string,
): NotionConnectionView {
  const record = userId && tenantId
    ? ownedRecord(connectionStore, username, userId, tenantId)
    : connectionStore.get(username, NOTION_CONNECTOR_ID);
  return !record || record.status !== 'connected'
    ? disconnectedView()
    : viewFromRecord(record, verificationStatus(record));
}

export async function resolveNotionRuntimeEnv(
  deps: NotionConnectorDeps & { onError?: (error: Error) => void },
  identity: { userId: string; username: string; tenantId: string },
): Promise<Record<string, string>> {
  const connection = ownedRecord(deps.connectionStore, identity.username, identity.userId, identity.tenantId);
  if (!connection || connection.status !== 'connected') return {};
  if (connection.metadata?.notionVerificationStatus === 'invalid') return {};
  const tokenRef = connection.credentialRefs.token;
  if (!tokenRef) return {};
  try {
    const token = await deps.vault.getSecret(tokenRef, vaultCaller(identity.userId, identity.tenantId));
    return { NOTION_API_TOKEN: token };
  } catch (error) {
    deps.onError?.(error instanceof Error ? error : new Error(String(error)));
    return {};
  }
}

export async function disconnectNotion(input: NotionConnectorDeps & {
  userId: string;
  username: string;
  tenantId: string;
}): Promise<{ connection: NotionConnectionView; providerRevoked: false; notice: string }> {
  const raw = input.connectionStore.get(input.username, NOTION_CONNECTOR_ID);
  const current = ownedRecord(input.connectionStore, input.username, input.userId, input.tenantId);
  if (raw && !current) {
    return {
      connection: disconnectedView(),
      providerRevoked: false,
      notice: NOTION_LOCAL_DISCONNECT_NOTICE,
    };
  }
  const disconnected = await input.connectionStore.disconnect(
    input.username,
    NOTION_CONNECTOR_ID,
    input.tenantId,
  );
  for (const ref of disconnected.pendingRevokeRefs ?? []) {
    try {
      await input.vault.revokeSecret(ref, vaultCaller(input.userId, input.tenantId));
      await input.connectionStore.markCredentialRevoked(input.username, NOTION_CONNECTOR_ID, ref);
    } catch {
      // 本地连接已先断开；保留 pendingRevokeRefs，交由后续维护任务重试。
    }
  }
  return {
    connection: disconnectedView(),
    providerRevoked: false,
    notice: NOTION_LOCAL_DISCONNECT_NOTICE,
  };
}

async function verifyNotionToken(token: string, fetchImpl: typeof fetch): Promise<VerifiedNotionIdentity> {
  let response: Response;
  try {
    response = await fetchImpl(NOTION_ME_ENDPOINT, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
      },
      signal: AbortSignal.timeout(NOTION_VERIFY_TIMEOUT_MS),
    });
  } catch {
    throw new NotionVerificationError('unavailable');
  }
  if (response.status === 401 || response.status === 403) throw new NotionVerificationError('invalid');
  if (!response.ok) throw new NotionVerificationError('unavailable');

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new NotionVerificationError('unavailable');
  }
  return parseNotionUser(body);
}

function parseNotionUser(value: unknown): VerifiedNotionIdentity {
  if (!isRecord(value) || value.object !== 'user' || typeof value.id !== 'string') {
    throw new NotionVerificationError('unavailable');
  }
  const name = typeof value.name === 'string' && value.name ? value.name : undefined;
  if (value.type === 'person' && isRecord(value.person)) {
    const email = typeof value.person.email === 'string' && value.person.email ? value.person.email : undefined;
    return { id: value.id, type: 'person', ...(name ? { name } : {}), ...(email ? { email } : {}) };
  }
  if (value.type === 'bot' && isRecord(value.bot)) {
    const owner = isRecord(value.bot.owner) ? value.bot.owner : undefined;
    const botOwnerType = owner && typeof owner.type === 'string' ? owner.type : undefined;
    const workspaceName = typeof value.bot.workspace_name === 'string' && value.bot.workspace_name
      ? value.bot.workspace_name
      : undefined;
    return {
      id: value.id,
      type: 'bot',
      ...(name ? { name } : {}),
      ...(botOwnerType ? { botOwnerType } : {}),
      ...(workspaceName ? { workspaceName } : {}),
    };
  }
  throw new NotionVerificationError('unavailable');
}

class NotionVerificationError extends Error {
  constructor(readonly kind: 'invalid' | 'unavailable') {
    super(`Notion verification ${kind}`);
  }
}

function metadataFromIdentity(identity: VerifiedNotionIdentity, verifiedAt: string): Record<string, string> {
  return {
    notionUserId: identity.id,
    identityType: identity.type,
    verifiedAt,
    ...(identity.name ? { identityName: identity.name } : {}),
    ...(identity.email ? { identityEmail: identity.email } : {}),
    ...(identity.botOwnerType ? { botOwnerType: identity.botOwnerType } : {}),
    ...(identity.workspaceName ? { workspaceName: identity.workspaceName } : {}),
  };
}

function viewFromRecord(
  record: ConnectorConnectionRecord,
  status: Exclude<NotionConnectionStatus, 'disconnected'>,
  verificationMessage?: string,
): NotionConnectionView {
  const metadata = record.metadata ?? {};
  const identityId = stringValue(metadata.notionUserId);
  const identityType = stringValue(metadata.identityType);
  const identityName = stringValue(metadata.identityName);
  const identityEmail = stringValue(metadata.identityEmail);
  const botOwnerType = stringValue(metadata.botOwnerType);
  const identity: NotionConnectionView['identity'] = identityId && (identityType === 'person' || identityType === 'bot')
    ? {
        type: identityType,
        id: identityId,
        ...(identityName ? { name: identityName } : {}),
        ...(identityEmail ? { email: identityEmail } : {}),
        ...(botOwnerType ? { botOwnerType } : {}),
      }
    : undefined;
  const workspaceName = stringValue(metadata.workspaceName);
  const connectedAt = stringValue(metadata.connectedAt) ?? record.connectedAt;
  const verifiedAt = stringValue(metadata.verifiedAt);
  return {
    connectorId: NOTION_CONNECTOR_ID,
    status,
    disconnectNotice: NOTION_LOCAL_DISCONNECT_NOTICE,
    ...(workspaceName ? { workspaceName } : {}),
    ...(identity ? { identity } : {}),
    ...(connectedAt ? { connectedAt } : {}),
    ...(verifiedAt ? { verifiedAt } : {}),
    ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
    ...(verificationMessage ? { verificationMessage } : {}),
  };
}

function disconnectedView(): NotionConnectionView {
  return {
    connectorId: NOTION_CONNECTOR_ID,
    status: 'disconnected',
    disconnectNotice: NOTION_LOCAL_DISCONNECT_NOTICE,
  };
}

function verificationStatus(record: ConnectorConnectionRecord): Exclude<NotionConnectionStatus, 'disconnected'> {
  const status = record.metadata?.notionVerificationStatus;
  return status === 'invalid' || status === 'unavailable' ? status : 'connected';
}

function ownedRecord(
  connectionStore: ConnectorConnectionStore,
  username: string,
  userId?: string,
  tenantId?: string,
): ConnectorConnectionRecord | undefined {
  const record = connectionStore.get(username, NOTION_CONNECTOR_ID);
  if (!record) return undefined;
  if (userId && record.userId !== userId) return undefined;
  if (tenantId && record.tenantId !== tenantId) return undefined;
  return record;
}

async function markNotionVerification(
  connectionStore: ConnectorConnectionStore,
  username: string,
  status: Exclude<NotionConnectionStatus, 'disconnected'>,
  message: string,
): Promise<void> {
  await connectionStore.updateMetadata(username, NOTION_CONNECTOR_ID, {
    notionVerificationStatus: status,
    notionVerificationMessage: message,
    notionVerificationCheckedAt: new Date().toISOString(),
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function vaultCaller(userId: string, tenantId: string) {
  return {
    actor: 'connector_proxy' as const,
    userId,
    tenantId,
    scopes: [
      'secret:notion_api_token:read',
      'secret:notion_api_token:write',
      'secret:notion_api_token:revoke',
    ],
  };
}

async function revokePendingRefs(
  vault: SecretVault,
  connectionStore: ConnectorConnectionStore,
  record: ConnectorConnectionRecord,
  userId: string,
  tenantId: string,
): Promise<void> {
  for (const ref of record.pendingRevokeRefs ?? []) {
    try {
      await vault.revokeSecret(ref, vaultCaller(userId, tenantId));
      await connectionStore.markCredentialRevoked(record.username, record.connectorId, ref);
    } catch {
      // 新连接已经生效；保留 pendingRevokeRefs 供维护任务重试。
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
