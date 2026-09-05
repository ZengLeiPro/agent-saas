/** §3.2 安装密钥派生、安装证明与 Local Token。 */
import { SignJWT, decodeJwt, decodeProtectedHeader } from 'jose';
import { describe, expect, it } from 'vitest';

import { ATTEST_TTL_SECONDS, JWT_TYP } from '@kaiyan/ky-app-contract';

import { KyAppError } from '../errors.js';
import { createAttestationIssuer, issueAttestation, verifyAttestation } from './attest.js';
import {
  KEY_ROTATION_WINDOW_MS,
  createLocalKeyRing,
  deriveInstallationKeys,
  selectVerificationKeys,
} from './keys.js';
import { issueLocalToken, localTokenPrefixes, verifyLocalToken } from './token.js';
import {
  BASE_NOW_MS,
  TEST_MANIFEST,
  TEST_MANIFEST_DIGEST,
  createClock,
  createTestConfig,
} from '../__tests__/helpers.js';

const config = createTestConfig();
const NONCE = 'n'.repeat(24);

describe('deriveInstallationKeys', () => {
  it('同一密钥同一 info 稳定，不同 info 不同', () => {
    const a = deriveInstallationKeys(config.installationKey, 'v1');
    const b = deriveInstallationKeys(config.installationKey, 'v1');
    expect(Buffer.from(a.attest).toString('hex')).toBe(Buffer.from(b.attest).toString('hex'));
    expect(Buffer.from(a.attest).toString('hex')).not.toBe(
      Buffer.from(a.localToken).toString('hex'),
    );
    expect(a.attest).toHaveLength(32);
  });

  it('拒绝长度不是 32 字节的 IKM 与空 keyVersion', () => {
    expect(() => deriveInstallationKeys(new Uint8Array(16), 'v1')).toThrow();
    expect(() => deriveInstallationKeys(config.installationKey, '')).toThrow();
  });
});

describe('selectVerificationKeys（24 小时轮换窗口）', () => {
  it('窗口内接受 previous，超窗即拒', () => {
    const withPrevious = createTestConfig({
      previousInstallationKey: config.installationKey,
      previousInstallationKeyVersion: 'v0',
    });
    const ring = createLocalKeyRing(withPrevious, { rotatedAt: BASE_NOW_MS });
    expect(selectVerificationKeys(ring, 'v1', BASE_NOW_MS)?.keyVersion).toBe('v1');
    expect(selectVerificationKeys(ring, 'v0', BASE_NOW_MS)?.keyVersion).toBe('v0');
    expect(selectVerificationKeys(ring, 'v0', BASE_NOW_MS + KEY_ROTATION_WINDOW_MS + 1)).toBeNull();
    expect(selectVerificationKeys(ring, 'v9', BASE_NOW_MS)).toBeNull();
  });
});

describe('issueAttestation / verifyAttestation', () => {
  const keys = createLocalKeyRing(config, { rotatedAt: BASE_NOW_MS });

  it('按 §3.2 生成 header 与 claims', async () => {
    const token = await issueAttestation({
      nonce: NONCE,
      dig: TEST_MANIFEST_DIGEST,
      origin: config.origin,
      iid: config.installationId,
      audience: config.issuer,
      keys: keys.current,
      nowMs: BASE_NOW_MS,
    });
    const header = decodeProtectedHeader(token);
    expect(header).toMatchObject({ alg: 'HS256', typ: JWT_TYP.attest, kid: 'v1' });
    const claims = decodeJwt(token);
    expect(claims.iss).toBe(`local:${config.installationId}`);
    expect(claims.aud).toBe(config.issuer);
    expect(claims.exp! - claims.iat!).toBe(ATTEST_TTL_SECONDS);
    await expect(
      verifyAttestation(token, { config, keys, nonce: NONCE, now: () => BASE_NOW_MS }),
    ).resolves.toMatchObject({ origin: config.origin });
  });

  it('nonce 不足 128 bit 拒绝', async () => {
    await expect(
      issueAttestation({
        nonce: 'short',
        dig: TEST_MANIFEST_DIGEST,
        origin: config.origin,
        iid: config.installationId,
        audience: config.issuer,
        keys: keys.current,
      }),
    ).rejects.toThrowError(KyAppError);
  });

  it('同一 nonce 在 60 s 内返回同一 JWT，过期后重签', async () => {
    const clock = createClock();
    const issuer = createAttestationIssuer({
      config,
      keys,
      manifestDigest: () => TEST_MANIFEST_DIGEST,
      now: clock.now,
    });
    const first = await issuer.issue(NONCE);
    expect(await issuer.issue(NONCE)).toBe(first);
    clock.advance(ATTEST_TTL_SECONDS * 1000 + 1);
    expect(await issuer.issue(NONCE)).not.toBe(first);
  });

  it('origin / iid / nonce 不符一律拒绝', async () => {
    const token = await issueAttestation({
      nonce: NONCE,
      dig: TEST_MANIFEST_DIGEST,
      origin: 'https://evil.example',
      iid: config.installationId,
      audience: config.issuer,
      keys: keys.current,
      nowMs: BASE_NOW_MS,
    });
    await expect(
      verifyAttestation(token, { config, keys, nonce: NONCE, now: () => BASE_NOW_MS }),
    ).rejects.toThrowError(KyAppError);
  });
});

describe('Local Token', () => {
  const keys = createLocalKeyRing(config, { rotatedAt: BASE_NOW_MS });
  const prefixes = TEST_MANIFEST.pathPrefixes;

  function verifyOptions(overrides: Record<string, unknown> = {}) {
    return {
      config,
      keys,
      localMode: true,
      installationState: 'enabled' as const,
      request: { method: 'GET', pathname: '/ky/v1/me' },
      pathPrefixes: prefixes,
      now: () => BASE_NOW_MS,
      ...overrides,
    };
  }

  it('local_admin 的 pfx 是 user ∪ admin，local_user 只有 user', () => {
    expect(localTokenPrefixes('local_admin', prefixes)).toEqual(['/api/app/', '/api/admin/']);
    expect(localTokenPrefixes('local_user', prefixes)).toEqual(['/api/app/']);
  });

  it('签发并验证 local_admin', async () => {
    const token = await issueLocalToken({
      config,
      keys,
      sub: 'u_admin',
      act: 'local_admin',
      pathPrefixes: prefixes,
      nowMs: BASE_NOW_MS,
    });
    expect(decodeProtectedHeader(token)).toMatchObject({ typ: JWT_TYP.localToken, kid: 'v1' });
    const identity = await verifyLocalToken(token, verifyOptions());
    expect(identity).toMatchObject({ act: 'local_admin', sub: 'u_admin', tadm: true });
  });

  it('exp 上限 4 小时；超出上限的请求被夹到 4 小时', async () => {
    const token = await issueLocalToken({
      config,
      keys,
      sub: 'u_admin',
      act: 'local_admin',
      pathPrefixes: prefixes,
      ttlSeconds: 99_999,
      nowMs: BASE_NOW_MS,
    });
    const claims = decodeJwt(token);
    expect(claims.exp! - claims.iat!).toBe(4 * 60 * 60);
  });

  it('兜底模式关闭 → 一律拒绝（模式级撤销）', async () => {
    const token = await issueLocalToken({
      config,
      keys,
      sub: 'u_admin',
      act: 'local_admin',
      pathPrefixes: prefixes,
      nowMs: BASE_NOW_MS,
    });
    await expect(
      verifyLocalToken(token, verifyOptions({ localMode: false })),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('安装实例 disabled / deleted → installation_disabled', async () => {
    const token = await issueLocalToken({
      config,
      keys,
      sub: 'u_admin',
      act: 'local_admin',
      pathPrefixes: prefixes,
      nowMs: BASE_NOW_MS,
    });
    for (const state of ['disabled', 'deleted'] as const) {
      await expect(
        verifyLocalToken(token, verifyOptions({ installationState: state })),
      ).rejects.toMatchObject({ code: 'installation_disabled' });
    }
  });

  it('local_user 打 admin 前缀 → 403', async () => {
    const token = await issueLocalToken({
      config,
      keys,
      sub: 'u_member',
      act: 'local_user',
      pathPrefixes: prefixes,
      nowMs: BASE_NOW_MS,
    });
    await expect(
      verifyLocalToken(
        token,
        verifyOptions({ request: { method: 'GET', pathname: '/api/admin/roles' } }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      verifyLocalToken(
        token,
        verifyOptions({ request: { method: 'GET', pathname: '/api/app/orders' } }),
      ),
    ).resolves.toMatchObject({ act: 'local_user', tadm: false });
  });

  it('alg / typ / kid / aud / act 任一不符即拒', async () => {
    const payload = {
      iss: `local:${config.installationId}`,
      aud: config.systemId,
      tid: config.tenantId,
      iid: config.installationId,
      sub: 'u_1',
      act: 'local_admin',
      pfx: ['/api/app/'],
      iat: Math.floor(BASE_NOW_MS / 1000),
      exp: Math.floor(BASE_NOW_MS / 1000) + 600,
      jti: 'j'.repeat(22),
    };
    const bad = [
      { patch: {}, header: { typ: 'JWT' } },
      { patch: {}, header: { kid: 'v-unknown' } },
      { patch: { aud: 'other' }, header: {} },
      { patch: { act: 'user' }, header: {} },
      { patch: { exp: payload.iat + 5 * 60 * 60 }, header: {} },
      { patch: { jti: 'short' }, header: {} },
    ];
    for (const item of bad) {
      const token = await new SignJWT({ ...payload, ...item.patch })
        .setProtectedHeader({
          alg: 'HS256',
          typ: JWT_TYP.localToken,
          kid: 'v1',
          ...item.header,
        })
        .sign(keys.current.localToken);
      await expect(verifyLocalToken(token, verifyOptions())).rejects.toThrowError(KyAppError);
    }
  });
});
