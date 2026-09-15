import { generateKeyPairSync } from 'node:crypto';

import { V2_JWT_TYP, p256JwkThumbprint, type P256PublicJwk } from '@kaiyan/ky-app-contract';
import { exportJWK, SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import { InMemoryKyAppNonceStore } from './nonceStore.js';
import { KyAppHandshakeService, type KyAppShellUser } from './handshake.js';

const now = 1_800_000_000_000;
const digest = 'a'.repeat(64);
const installation = {
  installationId: 'installation-v2',
  tenantId: 'tenant-v2',
  systemId: 'system-v2',
  baseUrl: 'https://business.example.com',
  origin: 'https://business.example.com',
  techContactUserId: 'tech-v2',
  status: 'enabled',
  domainVerificationToken: null,
  domainVerifiedAt: new Date(now).toISOString(),
  registeredDigest: digest,
  stateVersion: 3,
  authMode: 'v2_asymmetric',
  deploymentId: 'deployment-v2',
  currentKeyId: 'set-by-test',
  identityGeneration: 1,
  createdAt: new Date(now).toISOString(),
  createdBy: 'admin',
  updatedAt: new Date(now).toISOString(),
  updatedBy: 'admin',
} as const;
const user: KyAppShellUser = {
  userId: 'member-v2',
  tenantId: installation.tenantId,
  sessionId: 'session-v2',
  displayName: 'V2 成员',
  isTenantAdmin: false,
  authBinding: { authEpoch: 1, generation: 1 },
};

async function setup(status: 'current' | 'previous' = 'current') {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const publicJwk = (await exportJWK(pair.publicKey)) as P256PublicJwk;
  const keyId = p256JwkThumbprint(publicJwk);
  const current = {
    ...installation,
    currentKeyId: status === 'current' ? keyId : 'current-key-after-rotation',
    identityGeneration: status === 'current' ? 1 : 2,
  };
  const credentials = { listAcceptableInstallationKeys: vi.fn() };
  const securityEvent = vi.fn();
  const service = new KyAppHandshakeService({
    config: { issuer: 'https://platform.example.com' },
    systems: {
      getInstallation: async () => current,
      getDefinition: async () => ({ status: 'published', publishedDigest: digest }),
      getVersion: async () => ({ manifest: { pathPrefixes: { user: ['/api/app/'], admin: [] } } }),
    },
    nonces: new InMemoryKyAppNonceStore(),
    credentials,
    deploymentKeys: {
      listAccepted: async () => [
        {
          installationId: current.installationId,
          keyId,
          deploymentId: current.deploymentId,
          publicJwk,
          status,
          notBefore: new Date(now - 1_000).toISOString(),
          acceptUntil: null,
          revokedAt: null,
          generation: 1,
        },
      ],
    },
    issuer: {
      issue: async () => ({ token: 'signed-user-sat', expiresAt: Math.floor(now / 1000) + 300 }),
    },
    canAccessInstallation: async () => true,
    onSecurityEvent: securityEvent,
    now: () => now,
  } as never);
  const { nonce } = await service.issueNonce({ installationId: current.installationId, user });
  return { pair, keyId, current, credentials, securityEvent, service, nonce };
}

async function v2Attestation(input: Awaited<ReturnType<typeof setup>>): Promise<string> {
  const seconds = Math.floor(now / 1000);
  return new SignJWT({
    tid: input.current.tenantId,
    iid: input.current.installationId,
    sid: input.current.systemId,
    deployment_id: input.current.deploymentId,
    key_id: input.keyId,
    generation: 1,
    nonce: input.nonce,
    manifest_digest: digest,
    ready: true,
  })
    .setProtectedHeader({ alg: 'ES256', typ: V2_JWT_TYP.attest, kid: input.keyId })
    .setIssuer(input.current.deploymentId)
    .setSubject(input.current.installationId)
    .setAudience('https://platform.example.com')
    .setIssuedAt(seconds)
    .setExpirationTime(seconds + 60)
    .setJti('attest-v2-jti-000000000001')
    .sign(input.pair.privateKey);
}

describe('KyAppHandshakeService V2 安装证明', () => {
  it('使用登记的部署公钥校验 ES256，并签发用户 SAT', async () => {
    const context = await setup();
    const result = await context.service.verifyHandshake({
      installationId: context.current.installationId,
      nonce: context.nonce,
      attestation: await v2Attestation(context),
      user,
    });
    expect(result).toMatchObject({
      token: 'signed-user-sat',
      installationId: context.current.installationId,
      user: { id: user.userId },
    });
    expect(context.credentials.listAcceptableInstallationKeys).not.toHaveBeenCalled();
    expect(context.securityEvent).not.toHaveBeenCalled();
  });

  it('轮换重叠窗口内仍接受 previous 部署公钥', async () => {
    const context = await setup('previous');
    await expect(
      context.service.verifyHandshake({
        installationId: context.current.installationId,
        nonce: context.nonce,
        attestation: await v2Attestation(context),
        user,
      }),
    ).resolves.toMatchObject({ token: 'signed-user-sat' });
  });

  it('V2 实例拒绝 HS256 降级证明并记录明确原因', async () => {
    const context = await setup();
    const token = await new SignJWT({ legacy: true })
      .setProtectedHeader({ alg: 'HS256', typ: 'ky-attest+jwt', kid: 'legacy-key' })
      .sign(new Uint8Array(32).fill(1));
    await expect(
      context.service.verifyHandshake({
        installationId: context.current.installationId,
        nonce: context.nonce,
        attestation: token,
        user,
      }),
    ).rejects.toMatchObject({ code: 'attestation_invalid' });
    expect(context.securityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'v2_downgrade_rejected' }),
    );
    expect(context.credentials.listAcceptableInstallationKeys).not.toHaveBeenCalled();
  });
});
