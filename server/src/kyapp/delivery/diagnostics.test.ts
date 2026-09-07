import { randomBytes } from 'node:crypto';

import { SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import { EXAMPLE_MANIFEST, JWT_TYP, type Manifest } from '@kaiyan/ky-app-contract';

import { deriveAttestKey } from '../attest/verify.js';
import { KyAppDiagnostics } from './diagnostics.js';

const NOW = Date.parse('2026-09-07T00:00:00.000Z');
const DIGEST = 'a'.repeat(64);
const INSTALLATION_KEY = randomBytes(32);

async function attestation(nonce: string): Promise<string> {
  const now = Math.floor(NOW / 1000);
  return new SignJWT({
    iss: 'local:iid-demo',
    aud: 'https://staging.kaiyan.net',
    iid: 'iid-demo',
    origin: 'https://demo.example.com',
    nonce,
    dig: DIGEST,
    iat: now,
    exp: now + 60,
    jti: 'AAAAAAAAAAAAAAAAAAAAAA',
  })
    .setProtectedHeader({ alg: 'HS256', typ: JWT_TYP.attest, kid: 'v1' })
    .sign(deriveAttestKey(INSTALLATION_KEY));
}

describe('KyAppDiagnostics', () => {
  it('六项诊断全部调用真实协作者并逐项返回通过', async () => {
    const manifest = EXAMPLE_MANIFEST as unknown as Manifest;
    const logicalCalls = {
      run: vi.fn().mockResolvedValue({
        attempts: 1,
        outcome: { kind: 'success', data: { items: [] } },
      }),
    };
    const outbound = {
      request: vi.fn(async (input: { path: string }) => {
        if (input.path === '/ky/v1/health/live') return response({ status: 'ok' });
        if (input.path === '/ky/v1/health/ready') {
          return response({ status: 'ok', manifestDigest: DIGEST });
        }
        if (input.path.startsWith('/ky/v1/attest?nonce=')) {
          const nonce = new URL(`https://demo.example.com${input.path}`).searchParams.get('nonce')!;
          return response({ attestation: await attestation(nonce) });
        }
        if (input.path === '/ky/v1/me') {
          return response({
            contractVersion: 1,
            user: { id: 'admin-1', displayName: '管理员', roles: ['admin'], isTenantAdmin: true },
            landing: '/orders',
            menus: [{ key: 'orders', label: '订单', path: '/orders' }],
            capabilities: manifest.capabilities.map((item) => ({ id: item.id, enabled: true })),
            permVersion: '1',
          });
        }
        throw new Error(`未预期路径 ${input.path}`);
      }),
    };
    const diagnostics = new KyAppDiagnostics({
      systems: { getVersion: async () => ({ manifest }) },
      installations: {
        require: async () => ({
          installationId: 'iid-demo',
          tenantId: 'tenant-1',
          systemId: manifest.systemId,
          baseUrl: 'https://demo.example.com',
          origin: 'https://demo.example.com',
          registeredDigest: DIGEST,
          domainVerificationToken: 'domain-token',
        }),
        probeDomainOwnership: async () => ({
          verified: true,
          method: 'dns_txt',
          hostname: 'demo.example.com',
          detail: 'ok',
        }),
      },
      credentials: {
        listAcceptableInstallationKeys: async () => [
          { keyVersion: 'v1', installationKey: INSTALLATION_KEY },
        ],
      },
      issuer: { issue: async () => ({ token: 'sat', expiresAt: 0, kid: 'kid', jti: 'jti' }) },
      outbound,
      logicalCalls,
      audience: 'https://staging.kaiyan.net',
      resolveAuthBinding: () => ({ authEpoch: 1, generation: 1 }),
      isTenantAdmin: async () => true,
      now: () => NOW,
    } as never);

    const report = await diagnostics.run('iid-demo', {
      adminUserId: 'admin-1',
      readOnlyCapabilityId: 'order.search',
      readOnlyInput: { keyword: 'SO-1' },
    });
    expect(report.passed).toBe(true);
    expect(report.checks).toHaveLength(6);
    expect(report.checks.map((item) => item.status)).toEqual(Array(6).fill('passed'));
    expect(logicalCalls.run).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'admin-1',
        input: { keyword: 'SO-1' },
        entry: expect.objectContaining({ capabilityId: 'order.search', registeredDigest: DIGEST }),
      }),
    );
  });
});

function response(json: unknown) {
  return { status: 200, json, text: JSON.stringify(json), retryAfterMs: null };
}
