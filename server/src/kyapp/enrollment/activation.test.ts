import { generateKeyPairSync } from 'node:crypto';

import { V2_JWT_TYP, p256JwkThumbprint, type P256PublicJwk } from '@kaiyan/ky-app-contract';
import { exportJWK, SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import { KyAppV2ActivationService } from './activation.js';

describe('KyAppV2ActivationService', () => {
  it('只有身份、版本、证明和 ready 全部一致后才启用', async () => {
    const now = 1_800_000_000_000;
    const digest = 'a'.repeat(64);
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const publicJwk = (await exportJWK(pair.publicKey)) as P256PublicJwk;
    const keyId = p256JwkThumbprint(publicJwk);
    const installation = {
      installationId: 'inst-1',
      tenantId: 'tenant-1',
      systemId: 'system-1',
      baseUrl: 'https://business.example.com',
      origin: 'https://business.example.com',
      techContactUserId: 'u1',
      status: 'pending',
      domainVerificationToken: null,
      domainVerifiedAt: new Date(now).toISOString(),
      registeredDigest: null,
      stateVersion: 1,
      authMode: 'v2_asymmetric',
      deploymentId: 'deployment-1',
      currentKeyId: keyId,
      identityGeneration: 1,
      createdAt: new Date(now).toISOString(),
      createdBy: 'u1',
      updatedAt: new Date(now).toISOString(),
      updatedBy: 'u1',
    } as const;
    const setRegisteredDigest = vi.fn(async () => ({ ...installation, registeredDigest: digest }));
    const setStatus = vi.fn(async () => ({
      ...installation,
      registeredDigest: digest,
      status: 'enabled' as const,
    }));
    const markReady = vi.fn();
    let calls = 0;
    const service = new KyAppV2ActivationService({
      config: {
        issuer: 'https://platform.example.com',
        jwksUrl: 'https://api.example.com/.well-known/jwks.json',
      },
      systems: {
        getDefinition: async () => ({ publishedDigest: digest }),
      },
      operations: { markReady },
      deploymentKeys: {
        current: async () => ({ keyId, publicJwk, deploymentId: 'deployment-1', generation: 1 }),
      },
      authenticator: { authenticateResource: async () => ({ installation, claims: {} }) },
      issuer: { issue: async () => ({ token: 'platform-sat' }) },
      outbound: {
        request: async (input: { path: string }) => {
          calls += 1;
          if (input.path.startsWith('/ky/v2/attest')) {
            const nonce = new URL(input.path, installation.baseUrl).searchParams.get('nonce')!;
            const seconds = Math.floor(now / 1000);
            const attestation = await new SignJWT({
              tid: installation.tenantId,
              iid: installation.installationId,
              sid: installation.systemId,
              deployment_id: installation.deploymentId,
              key_id: keyId,
              generation: 1,
              nonce,
              manifest_digest: digest,
              ready: true,
            })
              .setProtectedHeader({ alg: 'ES256', typ: V2_JWT_TYP.attest, kid: keyId })
              .setIssuer(installation.deploymentId)
              .setSubject(installation.installationId)
              .setAudience('https://platform.example.com')
              .setIssuedAt(seconds)
              .setExpirationTime(seconds + 60)
              .setJti('attest-jti-00000000000001')
              .sign(pair.privateKey);
            return { status: 200, json: { attestation } };
          }
          return { status: 200, json: { manifestDigest: digest } };
        },
      },
      runtimeStore: { recordReady: vi.fn() },
      installations: { setRegisteredDigest, setStatus },
      now: () => now,
    } as never);

    await expect(
      service.activate({
        installationId: installation.installationId,
        accessToken: 'workload-token',
        dpopProof: 'dpop-proof',
        manifestDigest: digest,
        appVersion: '1.0.0',
        keyId,
        generation: 1,
      }),
    ).resolves.toMatchObject({ status: 'enabled' });
    expect(calls).toBe(2);
    expect(setRegisteredDigest).toHaveBeenCalledOnce();
    expect(setStatus).toHaveBeenCalledOnce();
    expect(markReady).toHaveBeenCalledWith(
      installation.installationId,
      expect.objectContaining({ generation: 1 }),
    );
  });

  it('ready 版本不一致时不启用', async () => {
    const setStatus = vi.fn();
    const service = new KyAppV2ActivationService({
      config: { issuer: 'https://platform.example.com', jwksUrl: 'https://api.example.com/jwks' },
      systems: { getDefinition: async () => ({ publishedDigest: 'a'.repeat(64) }) },
      authenticator: {
        authenticateResource: async () => ({
          installation: {
            installationId: 'inst-1',
            tenantId: 'tenant-1',
            systemId: 'system-1',
            baseUrl: 'https://business.example.com',
            status: 'pending',
            authMode: 'v2_asymmetric',
            deploymentId: 'deployment-1',
            currentKeyId: 'key-12345678901234567890',
            identityGeneration: 1,
          },
        }),
      },
      deploymentKeys: { current: async () => null },
      installations: { setStatus },
    } as never);
    await expect(
      service.activate({
        installationId: 'inst-1',
        accessToken: 'token',
        dpopProof: 'proof',
        manifestDigest: 'b'.repeat(64),
        appVersion: '1',
        keyId: 'key-12345678901234567890',
        generation: 1,
      }),
    ).rejects.toMatchObject({ reason: 'manifest_digest_mismatch' });
    expect(setStatus).not.toHaveBeenCalled();
  });
});
