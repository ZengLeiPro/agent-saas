import { randomBytes } from 'node:crypto';

import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import { KyAppAttestationError, deriveAttestKey, verifyKyAppAttestation } from './verify.js';

const installationKey = randomBytes(32);
const other = randomBytes(32);
const AUDIENCE = 'https://agent.kaiyan.net';

async function sign(
  claims: Record<string, unknown>,
  options: { kid?: string; key?: Uint8Array; typ?: string } = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({
      alg: 'HS256',
      typ: options.typ ?? 'ky-attest+jwt',
      kid: options.kid ?? 'v1',
    })
    .sign(deriveAttestKey(options.key ?? installationKey));
}

function baseClaims(nowSeconds: number, overrides: Record<string, unknown> = {}) {
  return {
    iss: 'local:tsi_01',
    aud: AUDIENCE,
    iid: 'tsi_01',
    origin: 'https://erp.example.com',
    nonce: 'nonce-0123456789abcdefghij',
    dig: 'a'.repeat(64),
    iat: nowSeconds,
    exp: nowSeconds + 60,
    jti: 'jti-0123456789abcdefghij',
    ...overrides,
  };
}

describe('平台侧安装证明校验（规范 §3.2、§5.4）', () => {
  const nowMs = Date.parse('2026-09-06T00:00:00Z');
  const nowSeconds = Math.floor(nowMs / 1000);
  const input = {
    installationId: 'tsi_01',
    expectedOrigin: 'https://erp.example.com',
    audience: AUDIENCE,
    nonce: 'nonce-0123456789abcdefghij',
    keys: [{ keyVersion: 'v1', installationKey }],
    nowMs,
  };

  it('HKDF 派生是确定性的，长度 32 字节，非 32 字节输入被拒', () => {
    expect(deriveAttestKey(installationKey)).toEqual(deriveAttestKey(installationKey));
    expect(deriveAttestKey(installationKey)).toHaveLength(32);
    expect(deriveAttestKey(installationKey)).not.toEqual(deriveAttestKey(other));
    expect(() => deriveAttestKey(randomBytes(16))).toThrow(KyAppAttestationError);
  });

  it('合法证明通过，dig 只记录不比对', async () => {
    const token = await sign(baseClaims(nowSeconds, { dig: 'f'.repeat(64) }));
    await expect(verifyKyAppAttestation({ ...input, token })).resolves.toMatchObject({
      iid: 'tsi_01',
      dig: 'f'.repeat(64),
    });
  });

  it('篡改 origin / iid / nonce / aud、错 kid、错密钥、过期、错 typ 全部被拒', async () => {
    const cases: Array<[Promise<string>, string]> = [
      [sign(baseClaims(nowSeconds, { origin: 'https://evil.example.com' })), 'origin_mismatch'],
      [sign(baseClaims(nowSeconds, { iid: 'tsi_99' })), 'iid_mismatch'],
      [sign(baseClaims(nowSeconds, { iss: 'local:tsi_99' })), 'iss_mismatch'],
      [sign(baseClaims(nowSeconds, { aud: 'https://staging.agent.kaiyan.net' })), 'aud_mismatch'],
      [sign(baseClaims(nowSeconds, { nonce: 'nonce-zzzzzzzzzzzzzzzzzzzz' })), 'nonce_mismatch'],
      [sign(baseClaims(nowSeconds), { kid: 'v9' }), 'unknown_kid'],
      [sign(baseClaims(nowSeconds), { key: other }), 'signature_invalid'],
      [sign(baseClaims(nowSeconds - 120)), 'signature_invalid'],
      [sign(baseClaims(nowSeconds), { typ: 'ky-sat+jwt' }), 'bad_typ'],
    ];
    for (const [tokenPromise, reason] of cases) {
      const token = await tokenPromise;
      await expect(verifyKyAppAttestation({ ...input, token })).rejects.toMatchObject({ reason });
    }
    await expect(verifyKyAppAttestation({ ...input, token: 'not-a-jwt' })).rejects.toMatchObject({
      reason: 'malformed',
    });
  });

  it('轮换窗口内 current 与 previous 都能验，窗口外的密钥不再提供即被拒', async () => {
    const token = await sign(baseClaims(nowSeconds), { key: other, kid: 'v0' });
    await expect(
      verifyKyAppAttestation({
        ...input,
        token,
        keys: [
          { keyVersion: 'v1', installationKey },
          { keyVersion: 'v0', installationKey: other },
        ],
      }),
    ).resolves.toMatchObject({ iid: 'tsi_01' });
    await expect(verifyKyAppAttestation({ ...input, token })).rejects.toMatchObject({
      reason: 'unknown_kid',
    });
  });
});
