import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

import {
  V2_CALLBACK_PATH,
  V2_JWT_TYP,
  V2_TTL_SECONDS,
  p256JwkThumbprint,
  verifyEnrollmentRequest,
  type P256PublicJwk,
} from '@kaiyan/ky-app-contract';
import { exportJWK, SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import { MemoryInstallationBindingProvider } from '../identity/memory.js';
import { InstallationRuntimeManager } from '../identity/runtimeManager.js';
import type { DeploymentKeyStore } from '../identity/types.js';
import { MemoryEnrollmentAttemptStore, MemoryEphemeralSecretStore } from './memory.js';
import { V2EnrollmentService } from './service.js';

class TestKeys implements DeploymentKeyStore {
  readonly pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  readonly deploymentId = 'deployment-test-1';
  publicJwk!: P256PublicJwk;
  keyId = '';

  async initialize() {
    this.publicJwk = (await exportJWK(this.pair.publicKey)) as P256PublicJwk;
    this.keyId = p256JwkThumbprint(this.publicJwk);
    return this;
  }

  async current() {
    return {
      deploymentId: this.deploymentId,
      keyId: this.keyId,
      keyRef: 'test:key',
      publicJwk: this.publicJwk,
    };
  }

  async sign(_keyRef: string, payload: Uint8Array): Promise<Uint8Array> {
    return sign('sha256', payload, { key: this.pair.privateKey, dsaEncoding: 'ieee-p1363' });
  }

  async prepareRotation() {
    return { keyId: this.keyId, publicJwk: this.publicJwk };
  }
  async commitRotation(): Promise<void> {}
}

async function platformPair(): Promise<{
  privateKey: KeyObject;
  publicJwk: P256PublicJwk;
  keyId: string;
}> {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const publicJwk = (await exportJWK(pair.publicKey)) as P256PublicJwk;
  return { privateKey: pair.privateKey, publicJwk, keyId: p256JwkThumbprint(publicJwk) };
}

describe('V2EnrollmentService', () => {
  it('challenge 只返回公钥证明，并在 token 响应丢失时复用完全相同的 proof', async () => {
    const now = 1_800_000_000_000;
    const keys = await new TestKeys().initialize();
    const platform = await platformPair();
    const bindings = new MemoryInstallationBindingProvider();
    const start = vi.fn();
    const runtimes = new InstallationRuntimeManager(bindings, async () => ({
      validate: async () => undefined,
      start,
      drain: async () => undefined,
    }));
    const requests: Array<{ body: Record<string, string>; dpop: string }> = [];
    let calls = 0;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      requests.push({ body, dpop: new Headers(init?.headers).get('dpop') ?? '' });
      calls += 1;
      if (calls === 1) throw new TypeError('response_lost');
      const seconds = Math.floor(now / 1000);
      const grant = await new SignJWT({
        tid: 'tenant-1',
        iid: 'inst-1',
        sid: 'system-1',
        client_id: keys.deploymentId,
        origin: 'https://business.example.com',
        key_id: keys.keyId,
        scope: ['installation.activate', 'directory.snapshot'],
        registered_digest: 'a'.repeat(64),
        generation: 1,
      })
        .setProtectedHeader({
          alg: 'ES256',
          typ: V2_JWT_TYP.installationGrant,
          kid: platform.keyId,
        })
        .setIssuer('https://platform.example.com')
        .setSubject('inst-1')
        .setAudience(keys.deploymentId)
        .setIssuedAt(seconds)
        .setExpirationTime(seconds + V2_TTL_SECONDS.clientAssertion)
        .setJti('platform-grant-jti-000001')
        .sign(platform.privateKey);
      return new Response(JSON.stringify({ installationGrant: grant }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const service = new V2EnrollmentService({
      enabled: true,
      systemId: 'system-1',
      origin: 'https://business.example.com',
      platformIssuer: 'https://platform.example.com',
      platformApiBaseUrl: 'https://api.example.com',
      keys,
      attempts: new MemoryEnrollmentAttemptStore(),
      secrets: new MemoryEphemeralSecretStore(() => now),
      verifier: { verify: async () => undefined },
      platformKeys: { resolve: async () => platform.publicJwk },
      runtimes,
      fetch: fetchMock as typeof fetch,
      now: () => now,
    });
    const challengeInput = {
      operationId: 'operation-0000000000000001',
      nonce: 'nonce-00000000000000000001',
      platformIssuer: 'https://platform.example.com',
      installationId: 'inst-1',
      tenantId: 'tenant-1',
      systemId: 'system-1',
      origin: 'https://business.example.com',
      callbackUrl: `https://business.example.com${V2_CALLBACK_PATH}`,
    };
    const challenge = await service.challenge(challengeInput, 'platform-sat');
    const verified = verifyEnrollmentRequest(challenge.enrollmentRequest, {
      platformIssuer: challengeInput.platformIssuer,
      tenantId: challengeInput.tenantId,
      installationId: challengeInput.installationId,
      systemId: challengeInput.systemId,
      deploymentId: keys.deploymentId,
      origin: challengeInput.origin,
      callbackUrl: challengeInput.callbackUrl,
      nonce: challengeInput.nonce,
      now: Math.floor(now / 1000),
    });
    expect(verified.claims.public_jwk).not.toHaveProperty('d');

    await expect(service.callback('authorization-code-00000001', challenge.state)).rejects.toThrow(
      'response_lost',
    );
    await expect(
      service.callback('authorization-code-00000001', challenge.state),
    ).resolves.toMatchObject({ state: 'connected' });
    expect(requests[1].body.client_assertion).toBe(requests[0].body.client_assertion);
    expect(requests[1].dpop).toBe(requests[0].dpop);
    expect(start).toHaveBeenCalledOnce();
  });

  it('关闭 adapter 时业务进程仍可运行，但 enrollment fail closed', async () => {
    const keys = await new TestKeys().initialize();
    const service = new V2EnrollmentService({
      enabled: false,
      systemId: 'system-1',
      origin: 'https://business.example.com',
      platformIssuer: 'https://platform.example.com',
      platformApiBaseUrl: 'https://api.example.com',
      keys,
      attempts: new MemoryEnrollmentAttemptStore(),
      secrets: new MemoryEphemeralSecretStore(),
      verifier: { verify: async () => undefined },
      platformKeys: { resolve: async () => keys.publicJwk },
      runtimes: new InstallationRuntimeManager(
        new MemoryInstallationBindingProvider(),
        async () => ({
          validate: async () => undefined,
          start: async () => undefined,
          drain: async () => undefined,
        }),
      ),
    });
    await expect(
      service.challenge(
        {
          operationId: 'operation-0000000000000001',
          nonce: 'nonce-00000000000000000001',
          platformIssuer: 'https://platform.example.com',
          installationId: 'inst-1',
          tenantId: 'tenant-1',
          systemId: 'system-1',
          origin: 'https://business.example.com',
          callbackUrl: `https://business.example.com${V2_CALLBACK_PATH}`,
        },
        'sat',
      ),
    ).rejects.toThrow('enrollment_disabled');
  });
});
