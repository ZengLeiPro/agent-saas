import { spawn } from 'node:child_process';

import type { SecretVault } from '../security/secretVault.js';
import type { GovernanceCredential } from '../data/credentials/types.js';
import type { GovernanceCredentialReader } from './governanceCredential.js';
import type { ConnectorConnectionRecord, ConnectorConnectionStore } from './connectionStore.js';

export const X_CONNECTOR_ID = 'x';
export const X_COOKIE_CREDENTIAL_KEY = 'cookies';

export interface XConnectInput {
  authToken: string;
  ct0: string;
}

export type XCredentialProbeKind = 'network' | 'authentication' | 'upstream';

export class XCredentialProbeError extends Error {
  constructor(readonly kind: XCredentialProbeKind) {
    super({
      network: 'X 网络或代理不可达，请检查出口代理后重试',
      authentication: 'X cookie 无效或已过期，请重新获取 auth_token 和 ct0',
      upstream: 'X 上游接口验证失败，请稍后重试',
    }[kind]);
    this.name = 'XCredentialProbeError';
  }
}

export type XValidateCredentials = (credentials: XConnectInput) => Promise<void>;

export interface XConnectionView {
  connectorId: typeof X_CONNECTOR_ID;
  status: 'connected' | 'disconnected';
  runtimeEnabled: boolean;
  credentialId?: string;
  credentialVersion?: number;
  connectedAt?: string;
  updatedAt?: string;
}

export type XGovernanceCredentialReader = GovernanceCredentialReader;

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

function classifyBirdProbeFailure(output: string): XCredentialProbeKind {
  if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid (?:auth|cookie|token)/i.test(output)) {
    return 'authentication';
  }
  if (/fetch failed|econnrefused|enotfound|ehostunreach|enetunreach|etimedout|timeout|proxy/i.test(output)) {
    return 'network';
  }
  return 'upstream';
}

/**
 * Bird 使用 Node 原生 fetch。探针只在服务端内部传入 cookie，且永不返回命令输出，
 * 避免把 cookie 或代理凭据写进 API 响应、日志与任务记录。
 */
export function createBirdWhoamiProbe(options: {
  spawnImpl?: typeof spawn;
  timeoutMs?: number;
} = {}): XValidateCredentials {
  const spawnImpl = options.spawnImpl ?? spawn;
  const timeoutMs = options.timeoutMs ?? 15_000;
  return async credentials => await new Promise<void>((resolve, reject) => {
    const child = spawnImpl('bird', ['whoami'], {
      env: {
        ...process.env,
        NODE_USE_ENV_PROXY: '1',
        AUTH_TOKEN: credentials.authToken,
        CT0: credentials.ct0,
        TWITTER_AUTH_TOKEN: credentials.authToken,
        TWITTER_CT0: credentials.ct0,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const capture = (chunk: Buffer) => { output = `${output}${chunk.toString('utf8')}`.slice(-8_192); };
    const cleanup = () => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    };
    const fail = (kind: XCredentialProbeKind) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new XCredentialProbeError(kind));
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => {
        child.kill('SIGKILL');
        fail('network');
      }, 2_000);
      forceKillTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.once('error', error => fail(classifyBirdProbeFailure(error.message)));
    child.once('close', code => {
      if (timedOut) return fail('network');
      if (code === 0) succeed();
      else fail(classifyBirdProbeFailure(output));
    });
  });
}

export function toXConnectionView(
  record?: ConnectorConnectionRecord,
  runtimeEnabled = true,
  credential?: GovernanceCredential,
): XConnectionView {
  return {
    connectorId: X_CONNECTOR_ID,
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

function isXGovernanceCredential(credential: GovernanceCredential, context: { userId: string; tenantId: string }): boolean {
  return credential.tenantId === context.tenantId
    && credential.ownerUserId === context.userId
    && credential.connectorId === X_CONNECTOR_ID
    && credential.kind === 'personal_grant';
}

function isUsableXGovernanceCredential(credential: GovernanceCredential): boolean {
  if (!['active', 'rotation_due'].includes(credential.status)) return false;
  if (!credential.expiresAt) return true;
  const expiresAt = Date.parse(credential.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

async function listXGovernanceCredentials(
  reader: XGovernanceCredentialReader,
  context: { userId: string; tenantId: string },
): Promise<GovernanceCredential[]> {
  return (await reader.listForOwner(context.tenantId, context.userId))
    .filter(credential => isXGovernanceCredential(credential, context))
    .sort((left, right) => {
      const updatedDelta = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      return updatedDelta || right.credentialId.localeCompare(left.credentialId);
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

export async function getXConnectionWithGovernance(input: {
  connectionStore: ConnectorConnectionStore;
  governanceCredentialStore?: XGovernanceCredentialReader;
  context: { userId: string; username: string; tenantId: string };
}): Promise<XConnectionView> {
  const runtimeEnabled = input.connectionStore.isRuntimeEnabled(input.context.username, X_CONNECTOR_ID);
  if (input.governanceCredentialStore) {
    const governanceCredentials = await listXGovernanceCredentials(input.governanceCredentialStore, input.context);
    const credential = governanceCredentials.find(isUsableXGovernanceCredential);
    if (credential) return toXConnectionView(undefined, runtimeEnabled, credential);
    if (governanceCredentials.length > 0) return toXConnectionView(undefined, runtimeEnabled);
  }
  return toXConnectionView(ownedRecord(input.connectionStore, input.context), runtimeEnabled);
}

export async function revokePendingXCredentials(input: {
  connectionStore: ConnectorConnectionStore;
  vault: SecretVault;
  username?: string;
  excludeRefs?: ReadonlySet<string>;
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
        if (!input.excludeRefs?.has(ref)) {
          await input.vault.revokeSecret(ref, vaultCaller(
            pendingOwner?.userId ?? credentialOwnerId(record),
            pendingOwner?.tenantId ?? record.tenantId,
            'revoke',
          ));
        }
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
  deps: {
    connectionStore: ConnectorConnectionStore;
    vault: SecretVault;
    governanceCredentialStore?: XGovernanceCredentialReader;
    onError?: (error: Error) => void;
  },
  context: { userId: string; username: string; tenantId: string },
): Promise<Record<string, string>> {
  if (!deps.connectionStore.isRuntimeEnabled(context.username, X_CONNECTOR_ID)) return {};

  let governanceCredential: GovernanceCredential | undefined;
  let hasGovernanceCredential = false;
  if (deps.governanceCredentialStore) {
    try {
      const governanceCredentials = await listXGovernanceCredentials(deps.governanceCredentialStore, context);
      hasGovernanceCredential = governanceCredentials.length > 0;
      governanceCredential = governanceCredentials.find(isUsableXGovernanceCredential);
    } catch (error) {
      deps.onError?.(error instanceof Error ? error : new Error(String(error)));
      return {};
    }
  }

  const connection = governanceCredential || hasGovernanceCredential ? undefined : ownedRecord(deps.connectionStore, context);
  if (!governanceCredential && (
    hasGovernanceCredential || !connection || connection.status !== 'connected'
  )) return {};

  const credentialRef = governanceCredential?.secretRef
    ?? connection?.credentialRefs[X_COOKIE_CREDENTIAL_KEY];
  if (!credentialRef) return {};
  const ownerId = governanceCredential?.ownerUserId ?? (connection ? credentialOwnerId(connection) : context.userId);
  try {
    const value = await deps.vault.getSecret(
      credentialRef,
      vaultCaller(ownerId, context.tenantId, 'read'),
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
  validateCredentials?: XValidateCredentials;
  onError?: (error: Error) => void;
}): Promise<XConnectionView> {
  const credentials = normalizeXConnectInput(input.credentials);
  await (input.validateCredentials ?? createBirdWhoamiProbe())(credentials);
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
