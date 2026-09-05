/** §3.7 / §9.3-13 平台事件处理。 */
import { beforeEach, describe, expect, it } from 'vitest';

import { createJwksClient, type JwksClient } from '../jwks/client.js';
import { createEventsHandler, type EventsHandler } from './handler.js';
import { MemoryInstallationStateStore } from './store.js';
import {
  BASE_NOW_SECONDS,
  createClock,
  createFakeJwksServer,
  createSatSigner,
  createTestConfig,
  platformClaims,
  type SatSigner,
} from '../__tests__/helpers.js';

const config = createTestConfig();

let clock: ReturnType<typeof createClock>;
let store: MemoryInstallationStateStore;
let jwks: JwksClient;
let handler: EventsHandler;
let signer: SatSigner;
let server: ReturnType<typeof createFakeJwksServer>;

beforeEach(async () => {
  clock = createClock();
  signer = await createSatSigner('k-probe');
  server = createFakeJwksServer([signer.jwk]);
  jwks = createJwksClient({ url: config.jwksUrl, fetch: server.fetch, now: clock.now });
  store = new MemoryInstallationStateStore();
  handler = createEventsHandler({ config, store, jwks, now: clock.now });
});

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: 'ev_1',
    iid: config.installationId,
    stateVersion: 1,
    type: 'installation.disabled',
    occurredAt: '2026-09-05T00:00:00.000Z',
    ...overrides,
  };
}

describe('stateVersion 顺序（§3.7）', () => {
  it('只接受本地 + 1', async () => {
    const ack = await handler.handle(event());
    expect(ack).toMatchObject({ eventId: 'ev_1', ack: true, stateVersion: 1 });
    expect(await handler.state()).toMatchObject({ state: 'disabled', stateVersion: 1 });
  });

  it('更小的 stateVersion 忽略并 ack', async () => {
    await handler.handle(event());
    const ack = await handler.handle(
      event({ eventId: 'ev_old', stateVersion: 1, type: 'installation.enabled' }),
    );
    expect(ack.stateVersion).toBe(1);
    expect(await handler.state()).toMatchObject({ state: 'disabled', stateVersion: 1 });
  });

  it('跳号 → 409 state_gap', async () => {
    await expect(handler.handle(event({ stateVersion: 3 }))).rejects.toMatchObject({
      code: 'state_gap',
      status: 409,
    });
  });

  it('enabled 恢复', async () => {
    await handler.handle(event());
    await handler.handle(event({ eventId: 'ev_2', stateVersion: 2, type: 'installation.enabled' }));
    expect(await handler.state()).toMatchObject({ state: 'enabled', stateVersion: 2 });
  });

  it('deleted 是吸收终态', async () => {
    await handler.handle(event({ type: 'installation.deleted' }));
    await handler.handle(event({ eventId: 'ev_2', stateVersion: 2, type: 'installation.enabled' }));
    expect(await handler.state()).toMatchObject({ state: 'deleted' });
  });

  it('eventId 幂等：重复投递返回同一 ack 且不重复应用', async () => {
    const first = await handler.handle(event());
    const second = await handler.handle(event({ stateVersion: 9, type: 'installation.enabled' }));
    expect(second).toEqual(first);
    expect(await handler.state()).toMatchObject({ state: 'disabled', stateVersion: 1 });
  });
});

describe('jwks.* 事件', () => {
  it('jwks.rotated 预取', async () => {
    const before = server.calls;
    await handler.handle(event({ type: 'jwks.rotated', payload: { newKid: 'k-probe' } }));
    expect(server.calls).toBe(before + 1);
  });

  it('jwks.revoke 清缓存与负缓存', async () => {
    await jwks.getKey('k-probe');
    expect(jwks.kids()).toEqual(['k-probe']);
    await handler.handle(event({ type: 'jwks.revoke', payload: { kid: 'k-probe' } }));
    expect(jwks.kids()).toEqual([]);
  });

  it('jwks.probe 验签成功后回 verifiedKid', async () => {
    const probeSat = await signer.sign(platformClaims(config, {}, BASE_NOW_SECONDS));
    const ack = await handler.handle(
      event({ type: 'jwks.probe', payload: { kid: 'k-probe', probeSat } }),
    );
    expect(ack.verifiedKid).toBe('k-probe');
  });

  it('jwks.probe 验签失败不回 verifiedKid（仍 ack）', async () => {
    const other = await createSatSigner('k-probe');
    const probeSat = await other.sign(platformClaims(config, {}, BASE_NOW_SECONDS));
    const ack = await handler.handle(
      event({ type: 'jwks.probe', payload: { kid: 'k-probe', probeSat } }),
    );
    expect(ack.ack).toBe(true);
    expect(ack.verifiedKid).toBeUndefined();
  });
});

describe('入参校验', () => {
  it('iid 不符 / 未知类型 / stateVersion 非法一律 400', async () => {
    for (const patch of [
      { iid: 'tsi_other' },
      { type: 'installation.exploded' },
      { stateVersion: -1 },
      { eventId: '' },
    ]) {
      await expect(handler.handle(event(patch))).rejects.toMatchObject({ code: 'invalid_input' });
    }
    await expect(handler.handle('nope')).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
