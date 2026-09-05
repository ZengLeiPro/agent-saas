/** §3.1-5 JWKS 客户端：单飞、负缓存、节流、stale-if-error、撤销与响应校验。 */
import { describe, expect, it } from 'vitest';

import { JWKS } from '@kaiyan/ky-app-contract';

import { createJwksClient } from './client.js';
import { createClock, createFakeJwksServer, createSatSigner } from '../__tests__/helpers.js';

async function setup(kids: string[] = ['k1']) {
  const signers = await Promise.all(kids.map((kid) => createSatSigner(kid)));
  const server = createFakeJwksServer(signers.map((signer) => signer.jwk));
  const clock = createClock();
  const client = createJwksClient({
    url: 'https://test.ky.invalid/.well-known/ky-app-jwks.json',
    fetch: server.fetch,
    now: clock.now,
  });
  return { signers, server, clock, client };
}

describe('createJwksClient', () => {
  it('首次取 key 拉一次，缓存期内不再拉', async () => {
    const { server, client } = await setup();
    await client.getKey('k1');
    await client.getKey('k1');
    expect(server.calls).toBe(1);
  });

  it('缓存超过 max-age=600s 后重新拉取', async () => {
    const { server, client, clock } = await setup();
    await client.getKey('k1');
    clock.advance(JWKS.maxAgeSeconds * 1000 + 1);
    await client.getKey('k1');
    expect(server.calls).toBe(2);
  });

  it('未知 kid 并发 10 次只重拉 1 次（单飞）', async () => {
    const { server, client } = await setup();
    server.delayMs = 5;
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => client.getKey('unknown')),
    );
    expect(server.calls).toBe(1);
    expect(results.every((item) => item.status === 'rejected')).toBe(true);
  });

  it('未知 kid 负缓存 60 s：窗口内不再触发拉取，过期后再拉', async () => {
    const { server, client, clock } = await setup();
    await client.getKey('k1');
    await expect(client.getKey('nope')).rejects.toThrow(/未知的 JWKS kid/u);
    const afterFirst = server.calls;
    clock.advance(1000);
    await expect(client.getKey('nope')).rejects.toThrow(/未知的 JWKS kid/u);
    expect(server.calls).toBe(afterFirst);

    clock.advance(JWKS.negativeCacheSeconds * 1000 + 1);
    await expect(client.getKey('nope')).rejects.toThrow();
    expect(server.calls).toBe(afterFirst + 1);
  });

  it('全局重拉 ≤ 1 次 / 10 s', async () => {
    const { server, client, clock } = await setup();
    await client.getKey('k1');
    expect(server.calls).toBe(1);
    // 10 s 内的第二个未知 kid 直接被节流，不触发拉取。
    await expect(client.getKey('a-unknown')).rejects.toThrow();
    expect(server.calls).toBe(1);

    clock.advance(JWKS.refetchMinIntervalMs + 1);
    // 窗口过去后第一个未知 kid 拉一次，紧随其后的另一个未知 kid 又被节流。
    await expect(client.getKey('b-unknown')).rejects.toThrow();
    await expect(client.getKey('d-unknown')).rejects.toThrow();
    expect(server.calls).toBe(2);
    clock.advance(JWKS.refetchMinIntervalMs + 1);
    await expect(client.getKey('c-unknown')).rejects.toThrow();
    expect(server.calls).toBe(3);
  });

  it('拉取失败时 stale-if-error 24 h 内继续用旧快照，超过即 fail-closed', async () => {
    const { server, client, clock } = await setup();
    await client.getKey('k1');
    server.failure = new Error('network down');

    clock.advance(JWKS.maxAgeSeconds * 1000 + 1);
    await expect(client.getKey('k1')).resolves.toBeDefined();

    clock.advance(JWKS.staleIfErrorSeconds * 1000);
    await expect(client.getKey('k1')).rejects.toThrow(/fail-closed/u);
  });

  it('revoke 立即失效并清负缓存', async () => {
    const { client } = await setup();
    await client.getKey('k1');
    expect(client.kids()).toEqual(['k1']);
    client.revoke('k1');
    expect(client.kids()).toEqual([]);
    await expect(client.getKey('k1')).rejects.toThrow(/未知的 JWKS kid/u);
  });

  it('撤销过的 kid 即使重新出现在 JWKS 里也不再启用', async () => {
    const { client, clock } = await setup();
    await client.getKey('k1');
    client.revoke('k1');
    clock.advance(JWKS.refetchMinIntervalMs + 1);
    await expect(client.getKey('k1')).rejects.toThrow();
  });

  it('响应超过 16 KB 拒绝', async () => {
    const { server, client } = await setup();
    server.rawBody = JSON.stringify({ keys: [], padding: 'x'.repeat(JWKS.maxBytes) });
    await expect(client.getKey('k1')).rejects.toThrow(/未知的 JWKS kid/u);
  });

  it('重定向拒绝', async () => {
    const { server, client } = await setup();
    server.redirect = true;
    await expect(client.getKey('k1')).rejects.toThrow(/未知的 JWKS kid/u);
  });

  it('kty / crv / use 不符或 kid 重复一律拒绝整份文档', async () => {
    const cases = [
      { keys: [{ kty: 'RSA', crv: 'P-256', use: 'sig', kid: 'k1' }] },
      { keys: [{ kty: 'EC', crv: 'P-384', use: 'sig', kid: 'k1' }] },
      { keys: [{ kty: 'EC', crv: 'P-256', use: 'enc', kid: 'k1' }] },
      {
        keys: [
          { kty: 'EC', crv: 'P-256', use: 'sig', kid: 'dup' },
          { kty: 'EC', crv: 'P-256', use: 'sig', kid: 'dup' },
        ],
      },
    ];
    for (const body of cases) {
      const { server, client } = await setup();
      server.rawBody = JSON.stringify(body);
      await expect(client.getKey('k1')).rejects.toThrow(/未知的 JWKS kid/u);
      expect(client.kids()).toEqual([]);
    }
  });

  it('prefetch 绕过 10 s 节流并清掉该 kid 的负缓存', async () => {
    const { server, client, signers } = await setup(['k1']);
    await expect(client.getKey('k2')).rejects.toThrow();
    const before = server.calls;
    const extra = await createSatSigner('k2');
    server.keys = [signers[0].jwk, extra.jwk];
    await client.prefetch('k2');
    expect(server.calls).toBe(before + 1);
    await expect(client.getKey('k2')).resolves.toBeDefined();
  });
});
