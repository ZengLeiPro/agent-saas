/** mock 壳：JWKS、SAT 签发变体、令牌端点、§5.4-3 壳侧握手校验（含 nonce 绑定与缓存）。 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { JWT_TYP, EXAMPLE_MANIFEST, manifestDigest, type Manifest } from '@kaiyan/ky-app-contract';
import {
  decodeInstallationKey,
  deriveInstallationKeys,
  issueAttestation,
} from '@kaiyan/ky-app-server';

import { freePort } from '../harness/ports.js';
import { createMockShell, type MockShell } from './server.js';
import { userClaims, type AppIdentity } from './sat.js';

const MANIFEST = EXAMPLE_MANIFEST as unknown as Manifest;
const KEY_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const APP_ORIGIN = 'http://127.0.0.1:59999';

let shell: MockShell;
let app: AppIdentity;

beforeAll(async () => {
  app = {
    issuer: 'https://test.ky.invalid',
    systemId: MANIFEST.systemId,
    tenantId: 't_test',
    installationId: 'tsi_test',
    manifestDigest: manifestDigest(MANIFEST),
    pathPrefixes: MANIFEST.pathPrefixes,
  };
  shell = await createMockShell({
    port: await freePort(),
    appOrigin: APP_ORIGIN,
    systemName: MANIFEST.name,
    app,
    installationKeyHex: KEY_HEX,
    installationKeyVersion: 'v1',
    serviceCredential: 'svc_test',
    externalLinkHosts: ['docs.kaiyan.net'],
    user: { id: 'test-admin', displayName: '管理员', isTenantAdmin: true },
  });
});

afterAll(async () => {
  await shell.close();
});

/** 用与 mock 壳相同的安装密钥签一枚安装证明。 */
async function attest(
  nonce: string,
  overrides: { origin?: string; iid?: string } = {},
): Promise<string> {
  return issueAttestation({
    nonce,
    dig: app.manifestDigest,
    origin: overrides.origin ?? APP_ORIGIN,
    iid: overrides.iid ?? app.installationId,
    audience: app.issuer,
    keys: deriveInstallationKeys(decodeInstallationKey(KEY_HEX, 'KEY'), 'v1'),
  });
}

describe('mock 壳的 HTTP 面', () => {
  it('JWKS 端点给出 ES256 公钥', async () => {
    const response = await fetch(shell.jwksUrl);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { keys: Array<Record<string, string>> };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', use: 'sig', alg: 'ES256' });
  });

  it('壳页面与伪造子帧都能取到', async () => {
    const page = await fetch(shell.shellUrl());
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(
      'sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals"',
    );
    expect(html).toContain('referrerpolicy="strict-origin"');
    expect(html).toContain('allow="clipboard-write"');
    const forger = await fetch(`${shell.origin}/shell/forger.html`);
    expect(forger.status).toBe(200);
  });

  it('/shell/api/config 给出壳侧配置', async () => {
    const body = (await (await fetch(`${shell.origin}/shell/api/config`)).json()) as {
      appOrigin: string;
      externalLinkHosts: string[];
    };
    expect(body.appOrigin).toBe(APP_ORIGIN);
    expect(body.externalLinkHosts).toEqual(['docs.kaiyan.net']);
  });

  it('令牌端点签 user SAT；skew 参数签出「已过期但谎报 exp」的令牌', async () => {
    const normal = (await (
      await fetch(`${shell.origin}/shell/api/token?sub=u1&tadm=1&ttl=300`)
    ).json()) as { token: string; tokenExp: number };
    const claims = JSON.parse(
      Buffer.from(normal.token.split('.')[1], 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(claims.act).toBe('user');
    expect(claims.sub).toBe('u1');
    expect(claims.tadm).toBe(true);
    expect(normal.tokenExp).toBe(claims.exp);

    const skewed = (await (
      await fetch(`${shell.origin}/shell/api/token?sub=u1&skew=120`)
    ).json()) as { token: string; tokenExp: number };
    const skewedClaims = JSON.parse(
      Buffer.from(skewed.token.split('.')[1], 'base64url').toString('utf8'),
    ) as { exp: number };
    expect(skewedClaims.exp).toBeLessThan(Math.floor(Date.now() / 1000));
    expect(skewed.tokenExp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});

describe('§5.4-3 壳侧握手校验', () => {
  it('nonce ≥ 128 bit 且绑定壳会话 + 用户 + iid', async () => {
    const record = shell.allocateNonce({ sub: 'test-admin', iid: app.installationId });
    expect(record.nonce.length).toBeGreaterThanOrEqual(22);
    const verdict = await shell.verify({
      nonce: record.nonce,
      attestation: await attest(record.nonce),
      installationId: app.installationId,
    });
    expect(verdict.ok).toBe(true);
  });

  it('未登记的 nonce 一律拒绝', async () => {
    const verdict = await shell.verify({
      nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
      attestation: await attest('AAAAAAAAAAAAAAAAAAAAAA'),
      installationId: app.installationId,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('nonce 未登记');
  });

  it('ready.installationId 与 nonce 绑定的 iid 不符 → 拒绝', async () => {
    const record = shell.allocateNonce({ sub: 'test-admin', iid: app.installationId });
    const verdict = await shell.verify({
      nonce: record.nonce,
      attestation: await attest(record.nonce),
      installationId: 'tsi_other',
    });
    expect(verdict.ok).toBe(false);
  });

  it('同一 nonce 的同一 attestation 重复提交返回缓存结果', async () => {
    const record = shell.allocateNonce({ sub: 'test-admin', iid: app.installationId });
    const token = await attest(record.nonce);
    const first = await shell.verify({
      nonce: record.nonce,
      attestation: token,
      installationId: app.installationId,
    });
    const second = await shell.verify({
      nonce: record.nonce,
      attestation: token,
      installationId: app.installationId,
    });
    expect(first.ok).toBe(true);
    expect(first.cached).toBeUndefined();
    expect(second.ok).toBe(true);
    expect(second.cached).toBe(true);
  });

  it('同一 nonce 换了另一份 attestation → 拒绝', async () => {
    const record = shell.allocateNonce({ sub: 'test-admin', iid: app.installationId });
    await shell.verify({
      nonce: record.nonce,
      attestation: await attest(record.nonce),
      installationId: app.installationId,
    });
    const verdict = await shell.verify({
      nonce: record.nonce,
      attestation: await attest(record.nonce),
      installationId: app.installationId,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('不同的 attestation');
  });

  it('origin 与登记不符 → 拒绝', async () => {
    const record = shell.allocateNonce({ sub: 'test-admin', iid: app.installationId });
    const verdict = await shell.verify({
      nonce: record.nonce,
      attestation: await attest(record.nonce, { origin: 'http://127.0.0.1:1' }),
      installationId: app.installationId,
    });
    expect(verdict.ok).toBe(false);
  });

  it('HTTP 端点与 Node 侧 verify 行为一致', async () => {
    const nonceResponse = await fetch(`${shell.origin}/shell/api/nonce`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sub: 'test-admin', iid: app.installationId }),
    });
    const { nonce } = (await nonceResponse.json()) as { nonce: string };
    const verdict = (await (
      await fetch(`${shell.origin}/shell/api/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nonce,
          attestation: await attest(nonce),
          installationId: app.installationId,
        }),
      })
    ).json()) as { ok: boolean };
    expect(verdict.ok).toBe(true);
  });
});

describe('SAT 签发变体', () => {
  it('正常签发带 typ=ky-sat+jwt 与 kid', async () => {
    const token = await shell.signer.sign(userClaims(app, { sub: 'u1' }));
    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')) as {
      alg: string;
      typ: string;
      kid: string;
    };
    expect(header).toEqual({ alg: 'ES256', typ: JWT_TYP.sat, kid: shell.signer.kid });
  });

  it('alg=none 变体没有签名段', () => {
    const token = shell.signer.signNone(userClaims(app));
    expect(token.endsWith('.')).toBe(true);
    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')) as {
      alg: string;
    };
    expect(header.alg).toBe('none');
  });

  it('HS256 与未知 kid 变体的公钥都不在 JWKS 里', async () => {
    const hs = await shell.signer.signHs256(userClaims(app));
    expect(
      (JSON.parse(Buffer.from(hs.split('.')[0], 'base64url').toString('utf8')) as { alg: string })
        .alg,
    ).toBe('HS256');
    const orphan = await shell.signer.signUnknownKid(userClaims(app));
    const kid = (
      JSON.parse(Buffer.from(orphan.split('.')[0], 'base64url').toString('utf8')) as { kid: string }
    ).kid;
    expect(shell.signer.jwks().keys.some((key) => key.kid === kid)).toBe(false);
  });

  it('addKey / signWith / removeKey 支撑轮换与撤销场景', async () => {
    await shell.signer.addKey('k-rotate');
    expect(shell.signer.jwks().keys.map((key) => key.kid)).toContain('k-rotate');
    const token = await shell.signer.signWith('k-rotate', userClaims(app), { kid: 'k-rotate' });
    expect(
      (
        JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')) as {
          kid: string;
        }
      ).kid,
    ).toBe('k-rotate');
    shell.signer.removeKey('k-rotate');
    expect(shell.signer.jwks().keys.map((key) => key.kid)).not.toContain('k-rotate');
  });

  it('overrides 里写 undefined 表示删除该 claim', () => {
    const claims = userClaims(app, {}, { jti: undefined, tadm: undefined });
    expect('jti' in claims).toBe(false);
    expect('tadm' in claims).toBe(false);
  });

  it('user 的 pfx 随 tadm 变化', () => {
    expect(userClaims(app, { tadm: false }).pfx).toEqual(app.pathPrefixes.user);
    expect(userClaims(app, { tadm: true }).pfx).toEqual([
      ...app.pathPrefixes.user,
      ...app.pathPrefixes.admin,
    ]);
  });
});
