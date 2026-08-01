import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AliyunConnectorService,
  type AliyunAssumeRole,
} from '../connectors/aliyun.js';
import { ConnectorConnectionStore } from '../connectors/connectionStore.js';
import { InMemorySecretVault } from '../security/secretVault.js';

const roots: string[] = [];

function createFixture(assumeRole?: AliyunAssumeRole) {
  const root = mkdtempSync(join(tmpdir(), 'aliyun-connector-'));
  roots.push(root);
  const connectionFile = join(root, 'connections.json');
  const connectionStore = new ConnectorConnectionStore(connectionFile);
  const vault = new InMemorySecretVault();
  const errors: Error[] = [];
  const service = new AliyunConnectorService({
    connectionStore,
    vault,
    assumeRole,
    onError: error => errors.push(error),
  });
  return { connectionFile, connectionStore, vault, service, errors };
}

const alice = { userId: 'user-1', username: 'alice', tenantId: 'tenant-a' };
const input = {
  accessKeyId: 'LTAIexample',
  accessKeySecret: 'source-secret',
  roleArn: 'acs:ram::1234567890123456:role/agent-saas',
  regionId: 'cn-shenzhen',
  externalId: 'agent-saas-tenant-a',
};

function temporaryCredentials() {
  return {
    accessKeyId: 'STS.access-key',
    accessKeySecret: 'sts-secret',
    securityToken: 'sts-token',
    expiration: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    assumedRoleArn: 'acs:ram::1234567890123456:role/agent-saas/agent-saas-user-1',
  };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Aliyun native connector', () => {
  it('stores source credentials only in Vault and injects cached run-scoped STS env', async () => {
    const assumeRole = vi.fn<AliyunAssumeRole>().mockResolvedValue(temporaryCredentials());
    const fixture = createFixture(assumeRole);

    const connection = await fixture.service.connect(alice, input);
    expect(connection).toMatchObject({
      connectorId: 'aliyun',
      status: 'connected',
      accountId: '1234567890123456',
      roleName: 'agent-saas',
      regionId: 'cn-shenzhen',
    });
    const persisted = readFileSync(fixture.connectionFile, 'utf8');
    expect(persisted).not.toContain(input.accessKeyId);
    expect(persisted).not.toContain(input.accessKeySecret);
    expect(persisted).not.toContain(input.externalId);

    const credentialRef = fixture.connectionStore.get(alice.username, 'aliyun')?.credentialRefs.ram_role;
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

    const [firstEnv, secondEnv] = await Promise.all([
      fixture.service.resolveRuntimeEnv(alice),
      fixture.service.resolveRuntimeEnv(alice),
    ]);
    expect(firstEnv).toEqual({
      ALIBABA_CLOUD_ACCESS_KEY_ID: 'STS.access-key',
      ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'sts-secret',
      ALIBABA_CLOUD_SECURITY_TOKEN: 'sts-token',
      ALIBABA_CLOUD_REGION_ID: 'cn-shenzhen',
    });
    expect(secondEnv).toEqual(firstEnv);
    expect(assumeRole).toHaveBeenCalledTimes(2); // connect 验证一次，首次运行换取一次；第二次命中缓存
    expect(assumeRole.mock.calls[1]?.[0]).toMatchObject({
      roleArn: input.roleArn,
      regionId: input.regionId,
      externalId: input.externalId,
    });
  });

  it('does not expose credentials across immutable user or tenant boundaries', async () => {
    const assumeRole = vi.fn<AliyunAssumeRole>().mockResolvedValue(temporaryCredentials());
    const fixture = createFixture(assumeRole);
    await fixture.service.connect(alice, input);

    await expect(fixture.service.resolveRuntimeEnv({ ...alice, userId: 'replacement-user' })).resolves.toEqual({});
    await expect(fixture.service.resolveRuntimeEnv({ ...alice, tenantId: 'tenant-b' })).resolves.toEqual({});
    expect(fixture.service.getConnection({ ...alice, userId: 'replacement-user' }).status).toBe('disconnected');
    expect(assumeRole).toHaveBeenCalledTimes(1);
  });

  it('revokes the Vault source credential and stops injection after disconnect', async () => {
    const assumeRole = vi.fn<AliyunAssumeRole>().mockResolvedValue(temporaryCredentials());
    const fixture = createFixture(assumeRole);
    await fixture.service.connect(alice, input);

    const disconnected = await fixture.service.disconnect(alice);
    expect(disconnected.status).toBe('disconnected');
    await expect(fixture.service.resolveRuntimeEnv(alice)).resolves.toEqual({});
    expect(fixture.connectionStore.get(alice.username, 'aliyun')?.pendingRevokeRefs).toBeUndefined();
  });

  it('revokes a newly stored source credential when the connection record cannot be saved', async () => {
    const assumeRole = vi.fn<AliyunAssumeRole>().mockResolvedValue(temporaryCredentials());
    const fixture = createFixture(assumeRole);
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
    const assumeRole = vi.fn<AliyunAssumeRole>().mockImplementation(async () => {
      await validationGate;
      return temporaryCredentials();
    });
    const fixture = createFixture(assumeRole);

    const connecting = fixture.service.connect(alice, input);
    await Promise.resolve();
    const disconnecting = fixture.service.disconnect(alice);
    releaseValidation();

    await connecting;
    await disconnecting;
    expect(fixture.service.getConnection(alice).status).toBe('disconnected');
  });

  it('does not persist a connection when AssumeRole validation fails', async () => {
    const fixture = createFixture(vi.fn<AliyunAssumeRole>().mockRejectedValue(new Error('Forbidden')));
    await expect(fixture.service.connect(alice, input)).rejects.toThrow('Forbidden');
    expect(fixture.service.getConnection(alice).status).toBe('disconnected');
    expect(existsSync(fixture.connectionFile) ? readFileSync(fixture.connectionFile, 'utf8') : '').not.toContain(input.accessKeyId);
  });

  it('fails closed when STS refresh fails', async () => {
    const assumeRole = vi.fn<AliyunAssumeRole>()
      .mockResolvedValueOnce(temporaryCredentials())
      .mockRejectedValueOnce(new Error('STS unavailable'));
    const fixture = createFixture(assumeRole);
    await fixture.service.connect(alice, input);

    await expect(fixture.service.resolveRuntimeEnv(alice)).resolves.toEqual({});
    expect(fixture.errors).toHaveLength(1);
    expect(fixture.errors[0]?.message).toBe('STS unavailable');
  });
});
