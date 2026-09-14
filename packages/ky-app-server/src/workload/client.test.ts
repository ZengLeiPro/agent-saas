import { generateKeyPairSync, sign } from 'node:crypto';

import {
  V2_JWT_TYP,
  p256JwkThumbprint,
  type InstallationBinding,
  type P256PublicJwk,
} from '@kaiyan/ky-app-contract';
import { exportJWK, SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import type { DeploymentKeyStore } from '../identity/types.js';
import { KyAppWorkloadClient } from './client.js';

async function fixture() {
  const deploymentPair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const deploymentJwk = (await exportJWK(deploymentPair.publicKey)) as P256PublicJwk;
  const keyId = p256JwkThumbprint(deploymentJwk);
  const keys: DeploymentKeyStore = {
    current: async () => ({
      deploymentId: 'deployment-1',
      keyId,
      keyRef: 'kms:key-1',
      publicJwk: deploymentJwk,
    }),
    sign: async (_ref, payload) =>
      sign('sha256', payload, { key: deploymentPair.privateKey, dsaEncoding: 'ieee-p1363' }),
    prepareRotation: async () => ({
      deploymentId: 'deployment-1',
      keyId,
      keyRef: 'test:key',
      publicJwk: deploymentJwk,
    }),
    commitRotation: async () => undefined,
  };
  const platformPair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const platformJwk = (await exportJWK(platformPair.publicKey)) as P256PublicJwk;
  const platformKid = p256JwkThumbprint(platformJwk);
  const binding: InstallationBinding = {
    installationId: 'inst-1',
    tenantId: 'tenant-1',
    systemId: 'system-1',
    deploymentId: 'deployment-1',
    origin: 'https://business.example.com',
    platformIssuer: 'https://platform.example.com',
    platformApiBaseUrl: 'https://api.example.com',
    keyId,
    grantedScopes: ['directory.snapshot'],
    registeredDigest: 'a'.repeat(64),
    generation: 1,
    state: 'connected',
    updatedAt: new Date(0).toISOString(),
  };
  return { keys, platformPair, platformJwk, platformKid, binding };
}

describe('KyAppWorkloadClient', () => {
  it('读取请求遇到 invalid_dpop_proof 只重新取 token 一次', async () => {
    const f = await fixture();
    const now = 1_800_000_000_000;
    let tokenCalls = 0;
    let resourceCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/oauth/token')) {
        tokenCalls += 1;
        const seconds = Math.floor(now / 1000);
        const token = await new SignJWT({
          tid: 'tenant-1',
          iid: 'inst-1',
          sid: 'system-1',
          client_id: 'deployment-1',
          scope: 'directory.snapshot',
          cnf: { jkt: f.binding.keyId },
          generation: 1,
          nbf: seconds,
        })
          .setProtectedHeader({
            alg: 'ES256',
            typ: V2_JWT_TYP.workloadAccessToken,
            kid: f.platformKid,
          })
          .setIssuer('https://platform.example.com')
          .setSubject('inst-1')
          .setAudience('ky-app-platform-api')
          .setIssuedAt(seconds)
          .setExpirationTime(seconds + 300)
          .setJti(`workload-token-jti-${tokenCalls.toString().padStart(6, '0')}`)
          .sign(f.platformPair.privateKey);
        return new Response(JSON.stringify({ accessToken: token }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      resourceCalls += 1;
      if (resourceCalls === 1)
        return new Response('', { status: 401, headers: { 'dpop-error': 'invalid_dpop_proof' } });
      return new Response('{}', { status: 200 });
    });
    const client = new KyAppWorkloadClient({
      keys: f.keys,
      platformKeys: { resolve: async () => f.platformJwk },
      fetch: fetchMock as typeof fetch,
      now: () => now,
    });
    const response = await client.request(
      f.binding,
      'directory.snapshot',
      'https://api.example.com/directory',
    );
    expect(response.status).toBe(200);
    expect(tokenCalls).toBe(2);
    expect(resourceCalls).toBe(2);
  });

  it('写操作结果不确定时不自动重放', async () => {
    const f = await fixture();
    const now = 1_800_000_000_000;
    let resourceCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/oauth/token')) {
        const seconds = Math.floor(now / 1000);
        const token = await new SignJWT({
          tid: 'tenant-1',
          iid: 'inst-1',
          sid: 'system-1',
          client_id: 'deployment-1',
          scope: 'directory.snapshot',
          cnf: { jkt: f.binding.keyId },
          generation: 1,
          nbf: seconds,
        })
          .setProtectedHeader({
            alg: 'ES256',
            typ: V2_JWT_TYP.workloadAccessToken,
            kid: f.platformKid,
          })
          .setIssuer('https://platform.example.com')
          .setSubject('inst-1')
          .setAudience('ky-app-platform-api')
          .setIssuedAt(seconds)
          .setExpirationTime(seconds + 300)
          .setJti('workload-token-jti-mutation')
          .sign(f.platformPair.privateKey);
        return new Response(JSON.stringify({ accessToken: token }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      resourceCalls += 1;
      return new Response('', { status: 401, headers: { 'dpop-error': 'invalid_dpop_proof' } });
    });
    const client = new KyAppWorkloadClient({
      keys: f.keys,
      platformKeys: { resolve: async () => f.platformJwk },
      fetch: fetchMock as typeof fetch,
      now: () => now,
    });
    const response = await client.request(
      f.binding,
      'directory.snapshot',
      'https://api.example.com/mutation',
      { method: 'POST' },
      true,
    );
    expect(response.status).toBe(401);
    expect(resourceCalls).toBe(1);
  });
});
