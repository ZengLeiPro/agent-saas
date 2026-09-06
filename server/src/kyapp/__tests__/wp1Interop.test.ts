/**
 * WP2a × WP1 联动：平台事件投递 / 健康探测直接打进 `@kaiyan/ky-app-server` 的真实实现。
 *
 * 定制项目端用 SDK 的 `createEventsHandler` + `MemoryInstallationStateStore` + `JwksClient`
 * 起一个内存版 `/ky/v1/events`，再用 SDK 的 `buildHealthLive/buildHealthReady` 造健康响应，
 * 平台侧的 `KyAppEventDispatcher` / `KyAppHealthProber` 真的把 HTTP 打进去。
 * 两侧对 `stateVersion` 序列、`state_gap` 语义、`jwks.probe` 的 `verifiedKid`、
 * `manifestDigest` 比对的理解只要有一处不一致，这个文件就会红。
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  MemoryInstallationStateStore,
  buildHealthLive,
  buildHealthReady,
  createEventsHandler,
  createJwksClient,
  type KyAppConfig as SdkConfig,
} from '@kaiyan/ky-app-server';

import {
  TEST_IID,
  TEST_ORIGIN,
  TEST_SYSTEM,
  TEST_TENANT,
  createKyAppTestRig,
  seedPublishedInstallation,
  type KyAppTestRig,
} from './harness.js';

const JWKS_URL = 'https://api.agent.kaiyan.net/.well-known/ky-app-jwks.json';
const APP_MANIFEST_DIGEST = 'e'.repeat(64);
const rigs: KyAppTestRig[] = [];

afterEach(async () => {
  await Promise.all(rigs.splice(0).map((item) => item.close()));
});

function sdkConfig(): SdkConfig {
  return {
    env: 'prod',
    issuer: 'https://agent.kaiyan.net',
    jwksUrl: JWKS_URL,
    systemId: TEST_SYSTEM,
    tenantId: TEST_TENANT,
    installationId: TEST_IID,
    origin: TEST_ORIGIN,
    serviceCredential: 'unused-in-this-test',
    installationKey: new Uint8Array(32),
    installationKeyVersion: 'v1',
  } as unknown as SdkConfig;
}

/**
 * 组装一个「内存定制项目」：JWKS 从平台真实产出取，事件与健康端点用 SDK 实现。
 * 返回可直接注入平台出站的 fetch。
 */
async function buildAppEndpoint(harness: KyAppTestRig): Promise<{
  fetchImpl: typeof fetch;
  store: MemoryInstallationStateStore;
}> {
  const config = sdkConfig();
  const jwks = createJwksClient({
    url: JWKS_URL,
    fetch: (async () =>
      new Response(JSON.stringify(await harness.keys.jwks()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
  });
  const store = new MemoryInstallationStateStore({ state: 'enabled', stateVersion: 1 });
  const handler = createEventsHandler({ config, store, jwks });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/ky/v1/events') {
      const body: unknown = JSON.parse(String(init?.body ?? '{}'));
      try {
        const ack = await handler.handle(body);
        return new Response(JSON.stringify(ack), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      } catch (error) {
        const code = (error as { code?: string }).code ?? 'internal';
        return new Response(
          JSON.stringify({
            ok: false,
            error: { code, retryable: code === 'state_gap', message: '', requestId: '' },
          }),
          {
            status: code === 'state_gap' ? 409 : 400,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
    }
    if (url.pathname === '/ky/v1/health/live') {
      return new Response(JSON.stringify(buildHealthLive()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname === '/ky/v1/health/ready') {
      const state = await handler.state();
      const ready = await buildHealthReady({
        appVersion: '2026.09.06',
        manifestDigest: APP_MANIFEST_DIGEST,
        installationState: state.state,
        deps: { db: () => true, executionStore: () => true, jtiStore: () => true },
        directorySync: async () => ({ checkpoint: 128, ageSeconds: 30 }),
        jwksKids: () => jwks.kids(),
      });
      return new Response(JSON.stringify(ready), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;

  return { fetchImpl, store };
}

/** 先建 rig（拿到 keys）再把 SDK 端点接上去；出站 fetch 由闭包延后取。 */
async function interopRig(): Promise<{
  harness: KyAppTestRig;
  store: MemoryInstallationStateStore;
}> {
  let inner: typeof fetch | null = null;
  const harness = await createKyAppTestRig({
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!inner) throw new Error('定制项目端点尚未装配');
      return inner(input, init);
    }) as unknown as typeof fetch,
  });
  rigs.push(harness);
  await seedPublishedInstallation(harness);
  const endpoint = await buildAppEndpoint(harness);
  inner = endpoint.fetchImpl;
  return { harness, store: endpoint.store };
}

describe('WP2a → WP1 事件闭环', () => {
  it('stateVersion 逐级推进：平台连发 2/3/4，定制项目按序落状态', async () => {
    const { harness, store } = await interopRig();
    for (const [stateVersion, type] of [
      [2, 'installation.disabled'],
      [3, 'installation.enabled'],
      [4, 'installation.deleted'],
    ] as const) {
      await harness.eventStore.enqueue({
        installationId: TEST_IID,
        stateVersion,
        type,
        retryWindowMs: 600_000,
      });
    }
    const result = await harness.dispatcher.tick();
    expect(result.delivered).toBe(3);
    await expect(store.getState()).resolves.toEqual({ state: 'deleted', stateVersion: 4 });
  });

  it('跳号触发对端 state_gap，平台重放缺失事件后序列补齐', async () => {
    const { harness, store } = await interopRig();
    const gapped = await harness.eventStore.enqueue({
      installationId: TEST_IID,
      stateVersion: 2,
      type: 'installation.disabled',
      retryWindowMs: 600_000,
    });
    // 让 v2 本轮不可见，制造真实的跳号。
    harness.eventStore.events.set(gapped.eventId, {
      ...gapped,
      nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await harness.eventStore.enqueue({
      installationId: TEST_IID,
      stateVersion: 3,
      type: 'installation.enabled',
      retryWindowMs: 600_000,
    });

    const first = await harness.dispatcher.tick();
    expect(first.replayed).toBe(1);
    await expect(store.getState()).resolves.toEqual({ state: 'disabled', stateVersion: 2 });

    const pending = [...harness.eventStore.events.values()].find(
      (item) => item.stateVersion === 3,
    )!;
    harness.eventStore.events.set(pending.eventId, {
      ...pending,
      nextAttemptAt: new Date(Date.now() - 1).toISOString(),
    });
    await harness.dispatcher.tick();
    await expect(store.getState()).resolves.toEqual({ state: 'enabled', stateVersion: 3 });
  });

  it('jwks.probe：定制项目用平台 JWKS 真验探针 SAT，回的 verifiedKid 构成切换证据', async () => {
    const { harness } = await interopRig();
    const rotated = await harness.dispatcher.rotateAndProbe();
    await harness.dispatcher.tick();

    const probe = [...harness.eventStore.events.values()].find(
      (item) => item.type === 'jwks.probe',
    )!;
    expect(probe.status).toBe('delivered');
    expect(probe.verifiedKid).toBe(rotated.newKid);

    const promoted = await harness.dispatcher.promoteWhenAllVerified(rotated.newKid);
    expect(promoted.promoted).toBe(true);
    expect((await harness.signingKeys.findByStatus('active'))!.kid).toBe(rotated.newKid);
  });

  it('探针 SAT 用了错的 kid 时定制项目不回 verifiedKid，平台拒绝切换', async () => {
    const { harness } = await interopRig();
    const active = (await harness.signingKeys.findByStatus('active'))!;
    const { newKid } = await harness.keys.rotate();
    // 手工入队一个 kid 与实际签名不匹配的探针：payload 声称是 newKid，签名却是 active。
    const bogus = await harness.issuer.issue({
      act: 'platform',
      tenantId: TEST_TENANT,
      installationId: TEST_IID,
      systemId: TEST_SYSTEM,
      rid: '11111111-1111-4111-8111-111111111111',
      signWithKid: active.kid,
    });
    await harness.eventStore.enqueue({
      installationId: TEST_IID,
      stateVersion: 9,
      type: 'jwks.probe',
      payload: { kid: newKid, probeSat: bogus.token },
      retryWindowMs: 600_000,
    });
    await harness.dispatcher.tick();
    const probe = [...harness.eventStore.events.values()].find(
      (item) => item.type === 'jwks.probe',
    )!;
    expect(probe.status).toBe('delivered');
    expect(probe.verifiedKid).toBeNull();
    await expect(harness.dispatcher.promoteWhenAllVerified(newKid)).resolves.toMatchObject({
      promoted: false,
      pending: [TEST_IID],
    });
  });
});

describe('WP2a → WP1 健康探测闭环', () => {
  it('SDK 的 ready 响应被平台解析，digest 不一致被如实记录', async () => {
    const { harness } = await interopRig();
    const result = await harness.prober.tick(Date.parse('2026-09-06T00:00:00.000Z'));
    expect(result.liveProbed).toBe(1);
    expect(result.readyProbed).toBe(1);
    const record = harness.runtimeStore.records.get(TEST_IID)!;
    expect(record.liveStatus).toBe('ok');
    expect(record.readyStatus).toBe('ok');
    expect(record.manifestDigest).toBe(APP_MANIFEST_DIGEST);
    expect(record.appVersion).toBe('2026.09.06');
    expect(record.contractVersion).toBe(1);
    expect(record.directoryCheckpoint).toBe('128');
    expect(record.directoryAgeSeconds).toBe(30);

    // 平台登记的是自己那份 digest，与部署上报的不同 → 记为不一致。
    const version = (await harness.systems.listVersions(TEST_SYSTEM))[0]!;
    await harness.systems.setRegisteredDigest({
      installationId: TEST_IID,
      digest: version.digest,
      observedDigest: version.digest,
      expectedRegisteredDigest: null,
      actor: 'u_seed',
    });
    const second = await harness.prober.tick(Date.parse('2026-09-06T00:10:00.000Z'));
    expect(second.digestMismatches).toBe(1);
  });
});
