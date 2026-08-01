import StsClient, { AssumeRoleRequest } from '@alicloud/sts20150401';
import { Config as OpenApiConfig } from '@alicloud/openapi-client';

import type { SecretVault } from '../security/secretVault.js';
import type { ConnectorConnectionRecord, ConnectorConnectionStore } from './connectionStore.js';

export const ALIYUN_CONNECTOR_ID = 'aliyun';
export const ALIYUN_RAM_CREDENTIAL_KEY = 'ram_role';
const STS_DURATION_SECONDS = 3600;
const STS_REFRESH_WINDOW_MS = 5 * 60 * 1000;
const ROLE_ARN_PATTERN = /^acs:ram::(\d+):role\/([A-Za-z0-9+=,.@_-]{1,64})$/;
const REGION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
const EXTERNAL_ID_PATTERN = /^[\w+=,.@:/_-]{2,1224}$/;

interface AliyunRamRoleSecret {
  accessKeyId: string;
  accessKeySecret: string;
  externalId?: string;
}

export interface AliyunConnectionView {
  connectorId: 'aliyun';
  status: 'connected' | 'disconnected';
  accountId?: string;
  roleArn?: string;
  roleName?: string;
  regionId?: string;
  connectedAt?: string;
  updatedAt?: string;
}

export interface AliyunConnectInput {
  accessKeyId: string;
  accessKeySecret: string;
  roleArn: string;
  regionId: string;
  externalId?: string;
}

export interface AliyunTemporaryCredentials {
  accessKeyId: string;
  accessKeySecret: string;
  securityToken: string;
  expiration: string;
  assumedRoleArn?: string;
}

export type AliyunAssumeRole = (input: AliyunConnectInput & {
  roleSessionName: string;
  durationSeconds: number;
}) => Promise<AliyunTemporaryCredentials>;

export function createAliyunAssumeRole(): AliyunAssumeRole {
  return async input => {
    const client = new StsClient(new OpenApiConfig({
      accessKeyId: input.accessKeyId,
      accessKeySecret: input.accessKeySecret,
      regionId: input.regionId,
      endpoint: 'sts.aliyuncs.com',
    }));
    const response = await client.assumeRole(new AssumeRoleRequest({
      roleArn: input.roleArn,
      roleSessionName: input.roleSessionName,
      durationSeconds: input.durationSeconds,
      ...(input.externalId ? { externalId: input.externalId } : {}),
    }));
    const credentials = response.body?.credentials;
    if (!credentials?.accessKeyId || !credentials.accessKeySecret || !credentials.securityToken || !credentials.expiration) {
      throw new Error('阿里云 STS 未返回完整临时凭据');
    }
    return {
      accessKeyId: credentials.accessKeyId,
      accessKeySecret: credentials.accessKeySecret,
      securityToken: credentials.securityToken,
      expiration: credentials.expiration,
      assumedRoleArn: response.body?.assumedRoleUser?.arn,
    };
  };
}

export function toAliyunConnectionView(record?: ConnectorConnectionRecord): AliyunConnectionView {
  return {
    connectorId: ALIYUN_CONNECTOR_ID,
    status: record?.status ?? 'disconnected',
    accountId: record?.metadata?.accountId,
    roleArn: record?.metadata?.roleArn,
    roleName: record?.metadata?.roleName,
    regionId: record?.metadata?.regionId,
    connectedAt: record?.connectedAt,
    updatedAt: record?.updatedAt,
  };
}

function validateConnectInput(input: AliyunConnectInput): AliyunConnectInput {
  const accessKeyId = input.accessKeyId.trim();
  const accessKeySecret = input.accessKeySecret.trim();
  const roleArn = input.roleArn.trim();
  const regionId = input.regionId.trim();
  const externalId = input.externalId?.trim() || undefined;
  if (!accessKeyId || !accessKeySecret) throw new Error('AccessKey ID 和 AccessKey Secret 不能为空');
  if (!ROLE_ARN_PATTERN.test(roleArn)) throw new Error('RAM Role ARN 格式不正确');
  if (!REGION_ID_PATTERN.test(regionId)) throw new Error('地域 ID 格式不正确');
  if (externalId && !EXTERNAL_ID_PATTERN.test(externalId)) throw new Error('External ID 格式不正确');
  return { accessKeyId, accessKeySecret, roleArn, regionId, externalId };
}

function roleMetadata(roleArn: string, regionId: string): Record<string, string> {
  const match = ROLE_ARN_PATTERN.exec(roleArn);
  if (!match) throw new Error('RAM Role ARN 格式不正确');
  return { accountId: match[1]!, roleArn, roleName: match[2]!, regionId };
}

function roleSessionName(userId: string): string {
  const suffix = userId.replace(/[^A-Za-z0-9.@_-]/g, '-').slice(0, 48) || 'user';
  return `agent-saas-${suffix}`.slice(0, 64);
}

function parseRamRoleSecret(value: string): AliyunRamRoleSecret {
  const parsed = JSON.parse(value) as Partial<AliyunRamRoleSecret>;
  if (!parsed.accessKeyId || !parsed.accessKeySecret) throw new Error('阿里云连接凭据不完整');
  return {
    accessKeyId: parsed.accessKeyId,
    accessKeySecret: parsed.accessKeySecret,
    ...(parsed.externalId ? { externalId: parsed.externalId } : {}),
  };
}

export async function revokePendingAliyunCredentials(input: {
  connectionStore: ConnectorConnectionStore;
  vault: SecretVault;
  username?: string;
  onError?: (error: Error, ref: string) => void;
}): Promise<number> {
  let revoked = 0;
  const records = input.connectionStore.listAll().filter(record =>
    record.connectorId === ALIYUN_CONNECTOR_ID
    && (!input.username || record.username === input.username),
  );
  for (const record of records) {
    for (const ref of record.pendingRevokeRefs ?? []) {
      try {
        await input.vault.revokeSecret(ref, {
          actor: 'connector_proxy',
          userId: record.userId,
          tenantId: record.tenantId,
          scopes: ['secret:connector:read'],
        });
        await input.connectionStore.markCredentialRevoked(record.username, ALIYUN_CONNECTOR_ID, ref);
        revoked++;
      } catch (error) {
        input.onError?.(error instanceof Error ? error : new Error(String(error)), ref);
      }
    }
  }
  return revoked;
}

export class AliyunConnectorService {
  private readonly cache = new Map<string, { credentials: AliyunTemporaryCredentials; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<AliyunTemporaryCredentials>>();
  private readonly mutationTails = new Map<string, Promise<void>>();

  constructor(private readonly deps: {
    connectionStore: ConnectorConnectionStore;
    vault: SecretVault;
    assumeRole?: AliyunAssumeRole;
    onError?: (error: Error) => void;
  }) {}

  getConnection(context: { userId: string; username: string; tenantId: string }): AliyunConnectionView {
    const record = this.deps.connectionStore.get(context.username, ALIYUN_CONNECTOR_ID);
    if (!record || record.userId !== context.userId || record.tenantId !== context.tenantId) {
      return toAliyunConnectionView(undefined);
    }
    return toAliyunConnectionView(record);
  }

  async connect(
    context: { userId: string; username: string; tenantId: string },
    rawInput: AliyunConnectInput,
  ): Promise<AliyunConnectionView> {
    const release = await this.acquireMutation(context.userId);
    try {
      const input = validateConnectInput(rawInput);
    const assumeRole = this.deps.assumeRole ?? createAliyunAssumeRole();
    await assumeRole({
      ...input,
      roleSessionName: roleSessionName(context.userId),
      durationSeconds: STS_DURATION_SECONDS,
    });

    const current = this.deps.connectionStore.get(context.username, ALIYUN_CONNECTOR_ID);
    const secret = await this.deps.vault.putSecret(
      context.userId,
      'connector',
      JSON.stringify({
        accessKeyId: input.accessKeyId,
        accessKeySecret: input.accessKeySecret,
        ...(input.externalId ? { externalId: input.externalId } : {}),
      } satisfies AliyunRamRoleSecret),
      { connectorId: ALIYUN_CONNECTOR_ID, roleArn: input.roleArn, regionId: input.regionId },
    );
    let record: ConnectorConnectionRecord;
    try {
      record = await this.deps.connectionStore.connect({
        username: context.username,
        userId: context.userId,
        tenantId: context.tenantId,
        connectorId: ALIYUN_CONNECTOR_ID,
        credentialRefs: { [ALIYUN_RAM_CREDENTIAL_KEY]: secret.id },
        metadata: roleMetadata(input.roleArn, input.regionId),
      });
    } catch (error) {
      await this.deps.vault.revokeSecret(secret.id, {
        actor: 'connector_proxy',
        userId: context.userId,
        tenantId: context.tenantId,
        scopes: ['secret:connector:read'],
      }).catch(revokeError => {
        this.deps.onError?.(revokeError instanceof Error ? revokeError : new Error(String(revokeError)));
      });
      throw error;
    }
    if (current) this.clearCache(current);
    await revokePendingAliyunCredentials({
      connectionStore: this.deps.connectionStore,
      vault: this.deps.vault,
      username: context.username,
      onError: (error, ref) => this.deps.onError?.(new Error(`阿里云旧凭据撤销失败 ${ref}: ${error.message}`)),
    });
      return toAliyunConnectionView(record);
    } finally {
      release();
    }
  }

  async disconnect(context: { userId: string; username: string; tenantId: string }): Promise<AliyunConnectionView> {
    const release = await this.acquireMutation(context.userId);
    try {
      const current = this.deps.connectionStore.get(context.username, ALIYUN_CONNECTOR_ID);
    if (!current || current.userId !== context.userId || current.tenantId !== context.tenantId) {
      return toAliyunConnectionView(undefined);
    }
    const record = await this.deps.connectionStore.disconnect(
      context.username,
      ALIYUN_CONNECTOR_ID,
      context.tenantId,
    );
    this.clearCache(current);
    await revokePendingAliyunCredentials({
      connectionStore: this.deps.connectionStore,
      vault: this.deps.vault,
      username: context.username,
      onError: (error, ref) => this.deps.onError?.(new Error(`阿里云凭据撤销失败 ${ref}: ${error.message}`)),
    });
      return toAliyunConnectionView(record);
    } finally {
      release();
    }
  }

  async resolveRuntimeEnv(context: { userId: string; username: string; tenantId: string }): Promise<Record<string, string>> {
    const record = this.deps.connectionStore.get(context.username, ALIYUN_CONNECTOR_ID);
    const credentialRef = record?.status === 'connected'
      && record.userId === context.userId
      && record.tenantId === context.tenantId
      ? record.credentialRefs[ALIYUN_RAM_CREDENTIAL_KEY]
      : undefined;
    const roleArn = record?.metadata?.roleArn;
    const regionId = record?.metadata?.regionId;
    if (!credentialRef || !roleArn || !regionId) return {};

    try {
      const cacheKey = `${credentialRef}:${roleArn}:${regionId}`;
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt - STS_REFRESH_WINDOW_MS > Date.now()) {
        return this.toRuntimeEnv(cached.credentials, regionId);
      }
      let refresh = this.inFlight.get(cacheKey);
      if (!refresh) {
        refresh = this.refreshTemporaryCredentials({ context, credentialRef, roleArn, regionId });
        this.inFlight.set(cacheKey, refresh);
      }
      let credentials: AliyunTemporaryCredentials;
      try {
        credentials = await refresh;
      } finally {
        if (this.inFlight.get(cacheKey) === refresh) this.inFlight.delete(cacheKey);
      }
      const expiresAt = Date.parse(credentials.expiration);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('阿里云 STS 返回了无效过期时间');
      this.cache.set(cacheKey, { credentials, expiresAt });
      return this.toRuntimeEnv(credentials, regionId);
    } catch (error) {
      this.deps.onError?.(error instanceof Error ? error : new Error(String(error)));
      return {};
    }
  }

  private async acquireMutation(userId: string): Promise<() => void> {
    const previous = this.mutationTails.get(userId) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>(resolve => { releaseCurrent = resolve; });
    const tail = previous.then(() => current);
    this.mutationTails.set(userId, tail);
    await previous;
    return () => {
      releaseCurrent();
      if (this.mutationTails.get(userId) === tail) this.mutationTails.delete(userId);
    };
  }

  private async refreshTemporaryCredentials(input: {
    context: { userId: string; username: string; tenantId: string };
    credentialRef: string;
    roleArn: string;
    regionId: string;
  }): Promise<AliyunTemporaryCredentials> {
    const rawSecret = await this.deps.vault.getSecret(input.credentialRef, {
      actor: 'connector_proxy',
      userId: input.context.userId,
      tenantId: input.context.tenantId,
      scopes: ['secret:connector:read'],
    });
    const secret = parseRamRoleSecret(rawSecret);
    return (this.deps.assumeRole ?? createAliyunAssumeRole())({
      ...secret,
      roleArn: input.roleArn,
      regionId: input.regionId,
      roleSessionName: roleSessionName(input.context.userId),
      durationSeconds: STS_DURATION_SECONDS,
    });
  }

  private toRuntimeEnv(credentials: AliyunTemporaryCredentials, regionId: string): Record<string, string> {
    return {
      ALIBABA_CLOUD_ACCESS_KEY_ID: credentials.accessKeyId,
      ALIBABA_CLOUD_ACCESS_KEY_SECRET: credentials.accessKeySecret,
      ALIBABA_CLOUD_SECURITY_TOKEN: credentials.securityToken,
      ALIBABA_CLOUD_REGION_ID: regionId,
    };
  }

  private clearCache(record: ConnectorConnectionRecord): void {
    const credentialRef = record.credentialRefs[ALIYUN_RAM_CREDENTIAL_KEY];
    if (!credentialRef) return;
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${credentialRef}:`)) this.cache.delete(key);
    }
    for (const key of this.inFlight.keys()) {
      if (key.startsWith(`${credentialRef}:`)) this.inFlight.delete(key);
    }
  }
}
