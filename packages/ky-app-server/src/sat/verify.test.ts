/** §3.1 SAT 验签：§9.3-2 负向全表、容忍表边界、绑定与 dig 比对。 */
import { SignJWT } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';

import { createJwksClient, type JwksClient } from '../jwks/client.js';
import { KyAppError } from '../errors.js';
import { MemoryJtiStore } from './jtiStore.js';
import { readBearerToken, verifySat, type VerifySatOptions } from './verify.js';
import {
  BASE_NOW_MS,
  BASE_NOW_SECONDS,
  TEST_MANIFEST,
  TEST_MANIFEST_DIGEST,
  agentClaims,
  createClock,
  createFakeJwksServer,
  createSatSigner,
  createTestConfig,
  platformClaims,
  userClaims,
  type SatSigner,
} from '../__tests__/helpers.js';

const config = createTestConfig();

let signer: SatSigner;
let jwks: JwksClient;
let clock: ReturnType<typeof createClock>;
let jtiStore: MemoryJtiStore;

beforeEach(async () => {
  signer = await createSatSigner();
  const server = createFakeJwksServer([signer.jwk]);
  clock = createClock();
  jwks = createJwksClient({ url: config.jwksUrl, fetch: server.fetch, now: clock.now });
  jtiStore = new MemoryJtiStore(clock.now);
});

function options(overrides: Partial<VerifySatOptions> = {}): VerifySatOptions {
  return {
    config,
    jwks,
    jtiStore,
    request: { method: 'GET', pathname: '/ky/v1/me' },
    pathPrefixes: TEST_MANIFEST.pathPrefixes,
    manifestDigest: TEST_MANIFEST_DIGEST,
    now: clock.now,
    ...overrides,
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toThrowError(KyAppError);
  await promise.catch((error: unknown) => {
    expect((error as KyAppError).code).toBe(code);
  });
}

describe('readBearerToken', () => {
  it('只接受 `Bearer <token>` 形态', () => {
    expect(readBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(readBearerToken('bearer abc')).toBeNull();
    expect(readBearerToken('Basic abc')).toBeNull();
    expect(readBearerToken(null)).toBeNull();
    expect(readBearerToken('Bearer  abc')).toBeNull();
  });
});

describe('verifySat 正向', () => {
  it('act=user 取 /me 通过并给出结构化身份', async () => {
    const token = await signer.sign(userClaims(config));
    const identity = await verifySat(token, options());
    expect(identity.act).toBe('user');
    expect(identity.sub).toBe('u_8f3a');
    expect(identity.tadm).toBe(true);
    expect(identity.pfx).toEqual(['/api/app/', '/api/admin/']);
    expect(identity.kid).toBe(signer.kid);
  });

  it('act=agent 调能力端点通过', async () => {
    const token = await signer.sign(agentClaims(config));
    const identity = await verifySat(
      token,
      options({
        request: {
          method: 'POST',
          pathname: '/ky/v1/capabilities/order.search',
          requestId: 'req_x',
        },
      }),
    );
    expect(identity.cap).toBe('order.search');
    expect(identity.lcid).toBe('lc_9c2');
  });

  it('act=platform 带错误 dig 仍然通过（§9.3-2 末条）', async () => {
    const token = await signer.sign(platformClaims(config, { dig: 'f'.repeat(64) }));
    const identity = await verifySat(
      token,
      options({
        request: { method: 'GET', pathname: '/ky/v1/health/ready', requestId: 'req_p' },
      }),
    );
    expect(identity.act).toBe('platform');
    expect(identity.tadm).toBe(false);
  });
});

describe('verifySat 负向（§9.3-2）', () => {
  it('alg=none 拒绝', async () => {
    const claims = userClaims(config);
    const header = Buffer.from(
      JSON.stringify({ alg: 'none', typ: 'ky-sat+jwt', kid: signer.kid }),
    ).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    await expectCode(verifySat(`${header}.${payload}.`, options()), 'unauthorized');
  });

  it('HS256 拒绝', async () => {
    const token = await new SignJWT(userClaims(config))
      .setProtectedHeader({ alg: 'HS256', typ: 'ky-sat+jwt', kid: signer.kid })
      .sign(new Uint8Array(32));
    await expectCode(verifySat(token, options()), 'unauthorized');
  });

  it('header typ 不是 ky-sat+jwt 拒绝', async () => {
    const token = await signer.sign(userClaims(config), { typ: 'JWT' });
    await expectCode(verifySat(token, options()), 'unauthorized');
  });

  it('iss / aud / tid / iid 任一不符即拒', async () => {
    for (const patch of [
      { iss: 'https://evil.example' },
      { aud: 'other-system' },
      { tid: 't_other' },
      { iid: 'tsi_other' },
    ]) {
      const token = await signer.sign(userClaims(config, patch));
      await expectCode(verifySat(token, options()), 'unauthorized');
    }
  });

  it('已过期拒绝', async () => {
    const token = await signer.sign(
      userClaims(config, {
        iat: BASE_NOW_SECONDS - 600,
        nbf: BASE_NOW_SECONDS - 600,
        exp: BASE_NOW_SECONDS - 300,
      }),
    );
    await expectCode(verifySat(token, options()), 'unauthorized');
  });

  it('nbf 在未来（超容忍）拒绝', async () => {
    const token = await signer.sign(
      userClaims(config, { nbf: BASE_NOW_SECONDS + 31, exp: BASE_NOW_SECONDS + 400 }),
    );
    await expectCode(verifySat(token, options()), 'unauthorized');
  });

  it('未知 kid 拒绝', async () => {
    const token = await signer.sign(userClaims(config), { kid: 'k-unknown' });
    await expectCode(verifySat(token, options()), 'unauthorized');
  });

  it('缺必填 claim 拒绝', async () => {
    for (const missing of ['sub', 'tadm', 'pfx', 'jti', 'nbf']) {
      const claims = userClaims(config);
      delete claims[missing];
      const token = await signer.sign(claims);
      await expectCode(verifySat(token, options()), 'unauthorized');
    }
  });

  it('act=foo 拒绝', async () => {
    const token = await signer.sign(userClaims(config, { act: 'foo' }));
    await expectCode(verifySat(token, options()), 'unauthorized');
  });

  it('user 带 cap 拒绝', async () => {
    const token = await signer.sign(userClaims(config, { cap: 'order.search' }));
    await expectCode(verifySat(token, options()), 'unauthorized');
  });

  it('apr 无 aph（以及 aph 无 apr）拒绝', async () => {
    for (const patch of [{ apr: 'apv_1' }, { aph: 'a'.repeat(64) }]) {
      const token = await signer.sign(agentClaims(config, patch));
      await expectCode(
        verifySat(
          token,
          options({
            request: {
              method: 'POST',
              pathname: '/ky/v1/capabilities/order.search',
              requestId: 'req_x',
            },
          }),
        ),
        'unauthorized',
      );
    }
  });

  it('agent 缺 dig / 缺 tadm 拒绝', async () => {
    for (const missing of ['dig', 'tadm']) {
      const claims = agentClaims(config);
      delete claims[missing];
      const token = await signer.sign(claims);
      await expectCode(
        verifySat(
          token,
          options({
            request: {
              method: 'POST',
              pathname: '/ky/v1/capabilities/order.search',
              requestId: 'req_x',
            },
          }),
        ),
        'unauthorized',
      );
    }
  });

  it('agent 的 dig 与当前 manifest 不符 → 409 digest_mismatch', async () => {
    const token = await signer.sign(agentClaims(config, { dig: 'a'.repeat(64) }));
    await expectCode(
      verifySat(
        token,
        options({
          request: {
            method: 'POST',
            pathname: '/ky/v1/capabilities/order.search',
            requestId: 'req_x',
          },
        }),
      ),
      'digest_mismatch',
    );
  });

  it('agent 的 cap / lcid / rid 与路径或请求头不符 → 403', async () => {
    const token = await signer.sign(agentClaims(config));
    await expectCode(
      verifySat(
        token,
        options({
          request: {
            method: 'POST',
            pathname: '/ky/v1/capabilities/order.create',
            requestId: 'req_x',
          },
        }),
      ),
      'forbidden',
    );

    const token2 = await signer.sign(agentClaims(config));
    await expectCode(
      verifySat(
        token2,
        options({
          request: {
            method: 'GET',
            pathname: '/ky/v1/capabilities/order.search/executions/other',
            requestId: 'req_x',
          },
        }),
      ),
      'forbidden',
    );

    const token3 = await signer.sign(agentClaims(config));
    await expectCode(
      verifySat(
        token3,
        options({
          request: {
            method: 'POST',
            pathname: '/ky/v1/capabilities/order.search',
            requestId: 'req_other',
          },
        }),
      ),
      'forbidden',
    );
  });

  it('user 打 admin 前缀但 tadm=false → 403', async () => {
    const token = await signer.sign(userClaims(config, { tadm: false, pfx: ['/api/app/'] }));
    await expectCode(
      verifySat(token, options({ request: { method: 'GET', pathname: '/api/admin/roles' } })),
      'forbidden',
    );
  });
});

describe('§3.1 容忍表边界', () => {
  it('user 的 nbf 容忍 30 s：30 s 内放行，31 s 拒', async () => {
    const ok = await signer.sign(
      userClaims(config, { nbf: BASE_NOW_SECONDS + 30, exp: BASE_NOW_SECONDS + 400 }),
    );
    await expect(verifySat(ok, options())).resolves.toBeDefined();
    const bad = await signer.sign(
      userClaims(config, { nbf: BASE_NOW_SECONDS + 31, exp: BASE_NOW_SECONDS + 400 }),
    );
    await expectCode(verifySat(bad, options()), 'unauthorized');
  });

  it('user 的 exp 容忍 0：exp 恰好等于当前时刻即拒', async () => {
    const token = await signer.sign(
      userClaims(config, {
        iat: BASE_NOW_SECONDS - 300,
        nbf: BASE_NOW_SECONDS - 300,
        exp: BASE_NOW_SECONDS,
      }),
    );
    await expectCode(verifySat(token, options()), 'unauthorized');
  });

  it('agent 的 exp 容忍 10 s：过期不足 10 s 仍放行，满 10 s 拒', async () => {
    const request = {
      method: 'POST',
      pathname: '/ky/v1/capabilities/order.search',
      requestId: 'req_x',
    };
    const ok = await signer.sign(
      agentClaims(config, {
        iat: BASE_NOW_SECONDS - 69,
        nbf: BASE_NOW_SECONDS - 69,
        exp: BASE_NOW_SECONDS - 9,
      }),
    );
    await expect(verifySat(ok, options({ request }))).resolves.toBeDefined();

    const bad = await signer.sign(
      agentClaims(config, {
        iat: BASE_NOW_SECONDS - 70,
        nbf: BASE_NOW_SECONDS - 70,
        exp: BASE_NOW_SECONDS - 10,
      }),
    );
    await expectCode(verifySat(bad, options({ request })), 'unauthorized');
  });

  it('agent 的 nbf 容忍 10 s', async () => {
    const request = {
      method: 'POST',
      pathname: '/ky/v1/capabilities/order.search',
      requestId: 'req_x',
    };
    const ok = await signer.sign(
      agentClaims(config, { nbf: BASE_NOW_SECONDS + 10, exp: BASE_NOW_SECONDS + 70 }),
    );
    await expect(verifySat(ok, options({ request }))).resolves.toBeDefined();
    const bad = await signer.sign(
      agentClaims(config, { nbf: BASE_NOW_SECONDS + 11, exp: BASE_NOW_SECONDS + 70 }),
    );
    await expectCode(verifySat(bad, options({ request })), 'unauthorized');
  });
});

describe('jti 单次消费（§3.1-6）', () => {
  const agentRequest = {
    method: 'POST',
    pathname: '/ky/v1/capabilities/order.search',
    requestId: 'req_x',
  };

  it('agent 串行重放 → 401 token_replayed', async () => {
    const token = await signer.sign(agentClaims(config));
    await expect(verifySat(token, options({ request: agentRequest }))).resolves.toBeDefined();
    await expectCode(verifySat(token, options({ request: agentRequest })), 'token_replayed');
  });

  it('agent 并发 10 次恰 1 次成功', async () => {
    const token = await signer.sign(agentClaims(config));
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => verifySat(token, options({ request: agentRequest }))),
    );
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
  });

  it('platform 同样单次消费', async () => {
    const token = await signer.sign(platformClaims(config));
    const request = { method: 'GET', pathname: '/ky/v1/manifest', requestId: 'req_p' };
    await expect(verifySat(token, options({ request }))).resolves.toBeDefined();
    await expectCode(verifySat(token, options({ request })), 'token_replayed');
  });

  it('user 同一令牌 50 次都通过', async () => {
    const token = await signer.sign(userClaims(config));
    for (let index = 0; index < 50; index += 1) {
      await expect(verifySat(token, options())).resolves.toBeDefined();
    }
    expect(jtiStore.size).toBe(0);
  });

  it('consumeJti:false 时验签不占用，手动调用才占用（占用在输入校验之后）', async () => {
    const token = await signer.sign(agentClaims(config));
    const identity = await verifySat(token, options({ request: agentRequest, consumeJti: false }));
    expect(jtiStore.size).toBe(0);
    await identity.consumeJti();
    expect(jtiStore.size).toBe(1);
    // 幂等：同一身份重复调用不会把自己判成重放。
    await expect(identity.consumeJti()).resolves.toBeUndefined();
  });

  it('过期占用会被清理', async () => {
    const token = await signer.sign(agentClaims(config));
    await verifySat(token, options({ request: agentRequest }));
    expect(jtiStore.size).toBe(1);
    clock.advance(120_000);
    expect(jtiStore.purgeExpired()).toBe(1);
    expect(jtiStore.size).toBe(0);
  });

  it('BASE_NOW_MS 与秒级时钟一致', () => {
    expect(Math.floor(BASE_NOW_MS / 1000)).toBe(BASE_NOW_SECONDS);
  });
});
