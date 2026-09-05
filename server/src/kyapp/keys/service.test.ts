import { describe, expect, it } from 'vitest';

import { InMemorySecretVault } from '../../security/secretVault.js';
import { FakeSigningKeyStore } from '../__tests__/signingKeyStoreDouble.js';
import { KyAppSigningKeyService, KyAppSigningKeyError } from './service.js';

function createService(now = () => Date.parse('2026-09-06T00:00:00Z')) {
  const store = new FakeSigningKeyStore();
  const vault = new InMemorySecretVault();
  let counter = 0;
  const service = new KyAppSigningKeyService({
    store: store as never,
    vault,
    now,
    generateKid: () => `ky-test-${(counter += 1)}`,
  });
  return { store, vault, service };
}

describe('SAT 签名密钥生命周期（规范 §3.1、§8.4）', () => {
  it('首次 ensureActive 生成 ES256 密钥，私钥进 vault、公钥进库，JWKS 只出公钥', async () => {
    const { store, vault, service } = createService();
    const record = await service.ensureActive();
    expect(record.status).toBe('active');
    expect(record.publicJwk).toMatchObject({
      kty: 'EC',
      crv: 'P-256',
      use: 'sig',
      kid: record.kid,
    });
    expect(record.publicJwk.d).toBeUndefined();

    // 幂等：第二次不再生成。
    expect((await service.ensureActive()).kid).toBe(record.kid);
    expect(store.records.size).toBe(1);

    const secret = await vault.getSecret(record.secretRef, {
      actor: 'system',
      userId: '__system__',
      scopes: ['secret:ky_app_sat_signing_key:read'],
    });
    expect(secret).toContain('BEGIN PRIVATE KEY');
    const jwks = await service.jwks();
    expect(jwks.keys).toHaveLength(1);
    expect(JSON.stringify(jwks)).not.toContain('BEGIN PRIVATE KEY');
    expect(JSON.stringify(jwks)).not.toContain('"d"');
  });

  it('rotate 幂等产出 next；promote 必须带匹配的 verifiedKid，切换后旧键 retiring 24 小时', async () => {
    let now = Date.parse('2026-09-06T00:00:00Z');
    const { service } = createService(() => now);
    const active = await service.ensureActive();
    const rotated = await service.rotate();
    expect(rotated.created).toBe(true);
    expect((await service.rotate()).newKid).toBe(rotated.newKid);
    expect((await service.jwks()).keys).toHaveLength(2);

    await expect(service.promote(rotated.newKid, active.kid)).rejects.toBeInstanceOf(
      KyAppSigningKeyError,
    );
    const promoted = await service.promote(rotated.newKid, rotated.newKid);
    expect(promoted.status).toBe('active');
    expect((await service.getActiveSigningKey()).kid).toBe(rotated.newKid);
    // 旧键仍在 JWKS（retiring），24 小时后才下线。
    expect((await service.jwks()).keys).toHaveLength(2);
    expect(await service.retireExpired(new Date(now + 60_000))).toEqual([]);
    now += 24 * 60 * 60 * 1000 + 1;
    expect(await service.retireExpired(new Date(now))).toEqual([active.kid]);
    expect((await service.jwks()).keys).toHaveLength(1);
  });

  it('revoke 立即移出 JWKS 并撤销 vault 私钥', async () => {
    const { vault, service } = createService();
    const record = await service.ensureActive();
    await service.revoke(record.kid);
    expect((await service.jwks()).keys).toEqual([]);
    await expect(
      vault.getSecret(record.secretRef, {
        actor: 'system',
        userId: '__system__',
        scopes: ['secret:ky_app_sat_signing_key:read'],
      }),
    ).rejects.toThrow();
  });
});
