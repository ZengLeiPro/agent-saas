import { describe, expect, it } from 'vitest';

import { generateKeyPair, decodeJwt, decodeProtectedHeader } from 'jose';

import { resolveKyAppConfig, type KyAppPlatformConfig } from '../config.js';
import type { KyAppInstallation } from '../systems/types.js';
import { KyAppSatDeniedError, KyAppSatIssuer, computePathPrefixes } from './issuer.js';
import { KyAppSuspensionRegistry } from './suspension.js';

const config = resolveKyAppConfig({ kyApp: { environment: 'prod' } }) as KyAppPlatformConfig;

const installation: KyAppInstallation = {
  installationId: 'tsi_01',
  tenantId: 't_demo',
  systemId: 'demo-erp',
  baseUrl: 'https://erp.example.com',
  origin: 'https://erp.example.com',
  techContactUserId: 'u_tech',
  status: 'enabled',
  domainVerificationToken: null,
  domainVerifiedAt: null,
  registeredDigest: 'a'.repeat(64),
  stateVersion: 2,
  createdAt: '2026-09-06T00:00:00.000Z',
  createdBy: 'admin',
  updatedAt: '2026-09-06T00:00:00.000Z',
  updatedBy: 'admin',
};

const pathPrefixes = { user: ['/api/app/'], admin: ['/api/admin/'] };

async function createIssuer(
  overrides: {
    suspensions?: KyAppSuspensionRegistry;
    user?: { disabled: boolean } | null;
    membership?: { status: string } | null;
    install?: KyAppInstallation | null;
    epochOk?: boolean;
  } = {},
) {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  return new KyAppSatIssuer({
    config,
    keys: { getActiveSigningKey: async () => ({ kid: 'k-test', privateKey }) },
    suspensions: overrides.suspensions ?? new KyAppSuspensionRegistry(),
    guard: {
      getUser: async () => (overrides.user === undefined ? { disabled: false } : overrides.user),
      getMembership: async () =>
        overrides.membership === undefined ? { status: 'active' } : overrides.membership,
      getInstallation: async () =>
        overrides.install === undefined ? installation : overrides.install,
      validatesAuthEpoch: () => overrides.epochOk !== false,
    },
  });
}

describe('SAT 签发（规范 §3.1 矩阵与 TTL 表）', () => {
  it('pfx = user ∪（tadm ? admin : ∅），去重', () => {
    expect(computePathPrefixes(pathPrefixes, false)).toEqual(['/api/app/']);
    expect(computePathPrefixes(pathPrefixes, true)).toEqual(['/api/app/', '/api/admin/']);
    expect(computePathPrefixes({ user: ['/a/'], admin: ['/a/'] }, true)).toEqual(['/a/']);
  });

  it('user SAT：header typ/kid、必备 claims、5 分钟 TTL、nbf=iat、jti ≥128bit', async () => {
    const issuer = await createIssuer();
    const issued = await issuer.issue({
      act: 'user',
      tenantId: 't_demo',
      installationId: 'tsi_01',
      systemId: 'demo-erp',
      userId: 'u_8f3a',
      tadm: true,
      pathPrefixes,
      authBinding: { authEpoch: 1, generation: 1 },
      name: '张三',
    });
    expect(decodeProtectedHeader(issued.token)).toMatchObject({
      alg: 'ES256',
      typ: 'ky-sat+jwt',
      kid: 'k-test',
    });
    const claims = decodeJwt(issued.token) as Record<string, unknown>;
    expect(claims).toMatchObject({
      iss: 'https://agent.kaiyan.net',
      aud: 'demo-erp',
      tid: 't_demo',
      iid: 'tsi_01',
      sub: 'u_8f3a',
      act: 'user',
      tadm: true,
      pfx: ['/api/app/', '/api/admin/'],
      name: '张三',
    });
    expect(claims.cap).toBeUndefined();
    expect(claims.dig).toBeUndefined();
    expect(Number(claims.exp) - Number(claims.iat)).toBe(300);
    expect(claims.nbf).toBe(claims.iat);
    expect(String(claims.jti).length).toBeGreaterThanOrEqual(22);
    expect(issued.expiresAt).toBe(claims.exp);
  });

  it('agent SAT 带 cap/lcid/dig/sid/rid，apr 与 aph 必须成对；platform SAT 禁 sub/tadm', async () => {
    const issuer = await createIssuer();
    const agent = await issuer.issue({
      act: 'agent',
      tenantId: 't_demo',
      installationId: 'tsi_01',
      systemId: 'demo-erp',
      userId: 'u_8f3a',
      tadm: false,
      cap: 'order.create',
      lcid: 'lc_9c2',
      dig: 'a'.repeat(64),
      sid: 'sess_77',
      rid: 'req_x',
      apr: 'apv_12',
      aph: 'c'.repeat(64),
    });
    const agentClaims = decodeJwt(agent.token) as Record<string, unknown>;
    expect(agentClaims).toMatchObject({
      act: 'agent',
      cap: 'order.create',
      lcid: 'lc_9c2',
      sid: 'sess_77',
    });
    expect(agentClaims.pfx).toBeUndefined();
    expect(Number(agentClaims.exp) - Number(agentClaims.iat)).toBe(60);

    await expect(
      issuer.issue({
        act: 'agent',
        tenantId: 't_demo',
        installationId: 'tsi_01',
        systemId: 'demo-erp',
        userId: 'u_8f3a',
        tadm: false,
        cap: 'order.create',
        lcid: 'lc_9c2',
        dig: 'a'.repeat(64),
        sid: 'sess_77',
        rid: 'req_x',
        apr: 'apv_12',
      }),
    ).rejects.toBeInstanceOf(KyAppSatDeniedError);

    const platform = await issuer.issue({
      act: 'platform',
      tenantId: 't_demo',
      installationId: 'tsi_01',
      systemId: 'demo-erp',
      rid: 'req_y',
    });
    const platformClaims = decodeJwt(platform.token) as Record<string, unknown>;
    expect(platformClaims.act).toBe('platform');
    expect(platformClaims.sub).toBeUndefined();
    expect(platformClaims.tadm).toBeUndefined();
    expect(platformClaims.rid).toBe('req_y');
  });

  it('user SAT 四道前置与停签窗口逐条拒签', async () => {
    const input = {
      act: 'user' as const,
      tenantId: 't_demo',
      installationId: 'tsi_01',
      systemId: 'demo-erp',
      userId: 'u_8f3a',
      tadm: false,
      pathPrefixes,
      authBinding: { authEpoch: 1, generation: 1 },
    };
    const cases: Array<[Parameters<typeof createIssuer>[0], string]> = [
      [{ user: null }, 'user_not_found'],
      [{ user: { disabled: true } }, 'user_disabled'],
      [{ membership: null }, 'membership_missing'],
      [{ membership: { status: 'suspended' } }, 'membership_inactive'],
      [{ epochOk: false }, 'auth_epoch_invalid'],
      [{ install: null }, 'installation_not_found'],
      [{ install: { ...installation, status: 'disabled' } }, 'installation_disabled'],
      [{ install: { ...installation, tenantId: 'other' } }, 'installation_tenant_mismatch'],
    ];
    for (const [overrides, reason] of cases) {
      const issuer = await createIssuer(overrides);
      await expect(issuer.issue(input)).rejects.toMatchObject({ reason });
    }

    const suspensions = new KyAppSuspensionRegistry();
    suspensions.onAuthEpochAudit({ event: 'auth_epoch_fenced', userId: 'u_8f3a' });
    const suspended = await createIssuer({ suspensions });
    await expect(suspended.issue(input)).rejects.toMatchObject({ reason: 'suspended' });
    // agent / platform 不受用户前置约束（它们不代表用户会话）。
    await expect(
      suspended.issue({
        act: 'platform',
        tenantId: 't_demo',
        installationId: 'tsi_01',
        systemId: 'demo-erp',
        rid: 'req_z',
      }),
    ).resolves.toMatchObject({ kid: 'k-test' });
  });
});
