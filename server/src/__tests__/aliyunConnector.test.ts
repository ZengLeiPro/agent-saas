import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import StsClientModule from '@alicloud/sts20150401';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AliyunConnectorService,
  createAliyunValidateCredentials,
  type AliyunValidateCredentials,
} from '../connectors/aliyun.js';
import { ConnectorConnectionStore } from '../connectors/connectionStore.js';
import { InMemorySecretVault } from '../security/secretVault.js';

const roots: string[] = [];

function createFixture(validateCredentials?: AliyunValidateCredentials) {
  const root = mkdtempSync(join(tmpdir(), 'aliyun-connector-'));
  roots.push(root);
  const connectionFile = join(root, 'connections.json');
  const connectionStore = new ConnectorConnectionStore(connectionFile);
  const vault = new InMemorySecretVault();
  const errors: Error[] = [];
  const service = new AliyunConnectorService({
    connectionStore,
    vault,
    validateCredentials,
    onError: error => errors.push(error),
  });
  return { connectionFile, connectionStore, vault, service, errors };
}

const alice = { userId: 'user-1', username: 'alice', tenantId: 'tenant-a' };
const input = {
  accessKeyId: 'LTAIexample',
  accessKeySecret: 'source-secret',
  regionId: 'cn-shenzhen',
};
const identity = {
  accountId: '1234567890123456',
  arn: 'acs:ram::1234567890123456:user/agent-saas',
  identityType: 'RAMUser',
};

function validCredentials() {
  return vi.fn<AliyunValidateCredentials>().mockResolvedValue(identity);
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Aliyun native connector', () => {
  it('constructs the CommonJS STS client under Node ESM', async () => {
    const StsClient = (
      StsClientModule as unknown as { default?: typeof StsClientModule }
    ).default ?? StsClientModule;
    const getCallerIdentity = vi.spyOn(StsClient.prototype, 'getCallerIdentity').mockResolvedValue({
      body: {
        accountId: identity.accountId,
        arn: identity.arn,
        identityType: identity.identityType,
      },
    } as never);

    await expect(createAliyunValidateCredentials()(input)).resolves.toEqual({
      accountId: identity.accountId,
      arn: identity.arn,
      identityType: identity.identityType,
    });
    expect(getCallerIdentity).toHaveBeenCalledOnce();
    getCallerIdentity.mockRestore();
  });

  it('stores AccessKey only in Vault and injects user-scoped runtime env', async () => {
    const validateCredentials = validCredentials();
    const fixture = createFixture(validateCredentials);

    const connection = await fixture.service.connect(alice, input);
    expect(connection).toMatchObject({
      connectorId: 'aliyun',
      status: 'connected',
      accountId: identity.accountId,
      identityArn: identity.arn,
      identityType: identity.identityType,
      regionId: 'cn-shenzhen',
    });
    const persisted = readFileSync(fixture.connectionFile, 'utf8');
    expect(persisted).not.toContain(input.accessKeyId);
    expect(persisted).not.toContain(input.accessKeySecret);

    const credentialRef = fixture.connectionStore.get(alice.username, 'aliyun')?.credentialRefs.access_key;
    expect(credentialRef).toBeTruthy();
    await expect(fixture.vault.getSecret(credentialRef!, {
      actor: 'connector_proxy',
      userId: alice.username,
      tenantId: alice.tenantId,
      scopes: ['secret:connector:read'],
    })).rejects.toThrow('vault access denied');
    await expect(fixture.vault.getSecret(credentialRef!, {
      actor: 'connector_proxy',
      userId: alice.userId,
      tenantId: alice.tenantId,
      scopes: ['secret:connector:read'],
    })).resolves.toContain(input.accessKeyId);

    await expect(fixture.service.resolveRuntimeEnv(alice)).resolves.toEqual({
      ALIBABA_CLOUD_ACCESS_KEY_ID: input.accessKeyId,
      ALIBABA_CLOUD_ACCESS_KEY_SECRET: input.accessKeySecret,
      ALIBABA_CLOUD_REGION_ID: input.regionId,
    });
    expect(validateCredentials).toHaveBeenCalledOnce();
    expect(validateCredentials).toHaveBeenCalledWith(input);
  });

  it('does not expose credentials across immutable user or tenant boundaries', async () => {
    const fixture = createFixture(validCredentials());
    await fixture.service.connect(alice, input);

    await expect(fixture.service.resolveRuntimeEnv({ ...alice, userId: 'replacement-user' })).resolves.toEqual({});
    await expect(fixture.service.resolveRuntimeEnv({ ...alice, tenantId: 'tenant-b' })).resolves.toEqual({});
    expect(fixture.service.getConnection({ ...alice, userId: 'replacement-user' }).status).toBe('disconnected');
  });

  it('revokes the Vault AccessKey and stops injection after disconnect', async () => {
    const fixture = createFixture(validCredentials());
    await fixture.service.connect(alice, input);

    const disconnected = await fixture.service.disconnect(alice);
    expect(disconnected.status).toBe('disconnected');
    await expect(fixture.service.resolveRuntimeEnv(alice)).resolves.toEqual({});
    expect(fixture.connectionStore.get(alice.username, 'aliyun')?.pendingRevokeRefs).toBeUndefined();
  });

  it('revokes a newly stored AccessKey when the connection record cannot be saved', async () => {
    const fixture = createFixture(validCredentials());
    const revoke = vi.spyOn(fixture.vault, 'revokeSecret');
    vi.spyOn(fixture.connectionStore, 'connect').mockRejectedValueOnce(new Error('disk unavailable'));

    await expect(fixture.service.connect(alice, input)).rejects.toThrow('disk unavailable');
    expect(revoke).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      actor: 'connector_proxy',
      userId: alice.userId,
      tenantId: alice.tenantId,
    }));
  });

  it('serializes connect and disconnect mutations for the same immutable user', async () => {
    let releaseValidation!: () => void;
    const validationGate = new Promise<void>(resolve => { releaseValidation = resolve; });
    const validateCredentials = vi.fn<AliyunValidateCredentials>().mockImplementation(async () => {
      await validationGate;
      return identity;
    });
    const fixture = createFixture(validateCredentials);

    const connecting = fixture.service.connect(alice, input);
    await Promise.resolve();
    const disconnecting = fixture.service.disconnect(alice);
    releaseValidation();

    await connecting;
    await disconnecting;
    expect(fixture.service.getConnection(alice).status).toBe('disconnected');
  });

  it('does not persist a connection when AccessKey validation fails', async () => {
    const fixture = createFixture(vi.fn<AliyunValidateCredentials>().mockRejectedValue(new Error('InvalidAccessKeyId')));
    await expect(fixture.service.connect(alice, input)).rejects.toThrow('InvalidAccessKeyId');
    expect(fixture.service.getConnection(alice).status).toBe('disconnected');
    expect(existsSync(fixture.connectionFile) ? readFileSync(fixture.connectionFile, 'utf8') : '').not.toContain(input.accessKeyId);
  });

  it('fails closed when Vault resolution fails', async () => {
    const fixture = createFixture(validCredentials());
    await fixture.service.connect(alice, input);
    const credentialRef = fixture.connectionStore.get(alice.username, 'aliyun')?.credentialRefs.access_key;
    await fixture.vault.revokeSecret(credentialRef!, {
      actor: 'connector_proxy',
      userId: alice.userId,
      tenantId: alice.tenantId,
      scopes: ['secret:connector:revoke'],
    });

    await expect(fixture.service.resolveRuntimeEnv(alice)).resolves.toEqual({});
    expect(fixture.errors).toHaveLength(1);
    expect(fixture.errors[0]?.message).toContain('secret revoked');
  });
});
