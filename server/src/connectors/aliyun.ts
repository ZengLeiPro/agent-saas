import StsClient from '@alicloud/sts20150401';
import { Config as OpenApiConfig } from '@alicloud/openapi-client';

import type { SecretVault } from '../security/secretVault.js';
import type { ConnectorConnectionRecord, ConnectorConnectionStore } from './connectionStore.js';

export const ALIYUN_CONNECTOR_ID = 'aliyun';
export const ALIYUN_ACCESS_KEY_CREDENTIAL_KEY = 'access_key';
const REGION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;

interface AliyunAccessKeySecret {
  accessKeyId: string;
  accessKeySecret: string;
}

export interface AliyunConnectionView {
  connectorId: 'aliyun';
  status: 'connected' | 'disconnected';
  accountId?: string;
  identityArn?: string;
  identityType?: string;
  regionId?: string;
  connectedAt?: string;
  updatedAt?: string;
}

export interface AliyunConnectInput {
  accessKeyId: string;
  accessKeySecret: string;
  regionId: string;
}

export interface AliyunIdentity {
  accountId: string;
  arn?: string;
  identityType?: string;
}

export type AliyunValidateCredentials = (input: AliyunConnectInput) => Promise<AliyunIdentity>;

export function createAliyunValidateCredentials(): AliyunValidateCredentials {
  return async input => {
    const client = new StsClient(new OpenApiConfig({
      accessKeyId: input.accessKeyId,
      accessKeySecret: input.accessKeySecret,
      regionId: input.regionId,
      endpoint: 'sts.aliyuncs.com',
    }));
    const response = await client.getCallerIdentity();
    const identity = response.body;
    if (!identity?.accountId) throw new Error('阿里云 STS 未返回账号信息');
    return {
      accountId: identity.accountId,
      ...(identity.arn ? { arn: identity.arn } : {}),
      ...(identity.identityType ? { identityType: identity.identityType } : {}),
    };
  };
}

export function toAliyunConnectionView(record?: ConnectorConnectionRecord): AliyunConnectionView {
  return {
    connectorId: ALIYUN_CONNECTOR_ID,
    status: record?.status ?? 'disconnected',
    accountId: record?.metadata?.accountId,
    identityArn: record?.metadata?.identityArn,
    identityType: record?.metadata?.identityType,
    regionId: record?.metadata?.regionId,
    connectedAt: record?.connectedAt,
    updatedAt: record?.updatedAt,
  };
}

function validateConnectInput(input: AliyunConnectInput): AliyunConnectInput {
  const accessKeyId = input.accessKeyId.trim();
  const accessKeySecret = input.accessKeySecret.trim();
  const regionId = input.regionId.trim();
  if (!accessKeyId || !accessKeySecret) throw new Error('AccessKey ID 和 AccessKey Secret 不能为空');
  if (!REGION_ID_PATTERN.test(regionId)) throw new Error('地域 ID 格式不正确');
  return { accessKeyId, accessKeySecret, regionId };
}

function identityMetadata(identity: AliyunIdentity, regionId: string): Record<string, string> {
  return {
    accountId: identity.accountId,
    ...(identity.arn ? { identityArn: identity.arn } : {}),
    ...(identity.identityType ? { identityType: identity.identityType } : {}),
    regionId,
  };
}

function parseAccessKeySecret(value: string): AliyunAccessKeySecret {
  const parsed = JSON.parse(value) as Partial<AliyunAccessKeySecret>;
  if (!parsed.accessKeyId || !parsed.accessKeySecret) throw new Error('阿里云连接凭据不完整');
  return {
    accessKeyId: parsed.accessKeyId,
    accessKeySecret: parsed.accessKeySecret,
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
  private readonly mutationTails = new Map<string, Promise<void>>();

  constructor(private readonly deps: {
    connectionStore: ConnectorConnectionStore;
    vault: SecretVault;
    validateCredentials?: AliyunValidateCredentials;
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
      const validateCredentials = this.deps.validateCredentials ?? createAliyunValidateCredentials();
      const identity = await validateCredentials(input);

      const secret = await this.deps.vault.putSecret(
        context.userId,
        'connector',
        JSON.stringify({
          accessKeyId: input.accessKeyId,
          accessKeySecret: input.accessKeySecret,
        } satisfies AliyunAccessKeySecret),
        { connectorId: ALIYUN_CONNECTOR_ID, regionId: input.regionId },
      );
      let record: ConnectorConnectionRecord;
      try {
        record = await this.deps.connectionStore.connect({
          username: context.username,
          userId: context.userId,
          tenantId: context.tenantId,
          connectorId: ALIYUN_CONNECTOR_ID,
          credentialRefs: { [ALIYUN_ACCESS_KEY_CREDENTIAL_KEY]: secret.id },
          metadata: identityMetadata(identity, input.regionId),
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
      ? record.credentialRefs[ALIYUN_ACCESS_KEY_CREDENTIAL_KEY]
      : undefined;
    const regionId = record?.metadata?.regionId;
    if (!credentialRef || !regionId) return {};

    try {
      const rawSecret = await this.deps.vault.getSecret(credentialRef, {
        actor: 'connector_proxy',
        userId: context.userId,
        tenantId: context.tenantId,
        scopes: ['secret:connector:read'],
      });
      const credentials = parseAccessKeySecret(rawSecret);
      return {
        ALIBABA_CLOUD_ACCESS_KEY_ID: credentials.accessKeyId,
        ALIBABA_CLOUD_ACCESS_KEY_SECRET: credentials.accessKeySecret,
        ALIBABA_CLOUD_REGION_ID: regionId,
      };
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
}
