/**
 * WP2a 事件投递与健康探测（规范 §3.7、§4.6、§8.4、§6.3）。
 * 出站全部走可注入 fetch，不碰真实网络。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  TEST_IID,
  TEST_ORIGIN,
  createKyAppTestRig,
  seedPublishedInstallation,
  type KyAppTestRig,
} from './harness.js';

const rigs: KyAppTestRig[] = [];

afterEach(async () => {
  await Promise.all(rigs.splice(0).map((item) => item.close()));
});

interface FetchCall {
  url: string;
  body: Record<string, unknown>;
}

/** 记录每次出站请求，并按 URL/事件类型分派应答。 */
function recordingFetch(respond: (call: FetchCall) => Response | Promise<Response>): {
  impl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ url, body });
    return respond({ url, body });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function ackResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function rig(options: Parameters<typeof createKyAppTestRig>[0]): Promise<KyAppTestRig> {
  const created = await createKyAppTestRig(options);
  rigs.push(created);
  await seedPublishedInstallation(created);
  return created;
}

describe('事件投递', () => {
  it('按 stateVersion 升序串行投递，200 即标 delivered', async () => {
    const { impl, calls } = recordingFetch((call) =>
      ackResponse({
        eventId: call.body.eventId,
        ack: true,
        stateVersion: call.body.stateVersion,
      }),
    );
    const harness = await rig({ fetchImpl: impl });
    for (const stateVersion of [3, 2]) {
      await harness.eventStore.enqueue({
        installationId: TEST_IID,
        stateVersion,
        type: stateVersion === 2 ? 'installation.disabled' : 'installation.enabled',
        retryWindowMs: 60_000,
      });
    }
    const result = await harness.dispatcher.tick();
    expect(result.delivered).toBe(2);
    expect(calls.map((call) => call.body.stateVersion)).toEqual([2, 3]);
    expect(calls[0]!.url).toBe(`${TEST_ORIGIN}/ky/v1/events`);
    expect(
      [...harness.eventStore.events.values()].every((item) => item.status === 'delivered'),
    ).toBe(true);
  });

  it('对端回 409 state_gap 时立刻重放更早的未 ack 事件', async () => {
    let acceptedStateVersion = 1;
    const { impl, calls } = recordingFetch((call) => {
      const stateVersion = Number(call.body.stateVersion);
      if (stateVersion > acceptedStateVersion + 1) {
        return ackResponse({ ok: false, error: { code: 'state_gap' } }, 409);
      }
      acceptedStateVersion = stateVersion;
      return ackResponse({ eventId: call.body.eventId, ack: true, stateVersion });
    });
    const harness = await rig({ fetchImpl: impl });
    // 先把 v2 塞成「未到期」，让本轮只看得到 v3，从而触发 state_gap。
    const gapped = await harness.eventStore.enqueue({
      installationId: TEST_IID,
      stateVersion: 2,
      type: 'installation.disabled',
      retryWindowMs: 600_000,
    });
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

    const result = await harness.dispatcher.tick();
    expect(result.replayed).toBe(1);
    // v3 先被拒，随后 v2 被补投；下一轮 v3 才成功。
    expect(calls.map((call) => call.body.stateVersion)).toEqual([3, 2]);
    expect(harness.eventStore.events.get(gapped.eventId)!.status).toBe('delivered');

    // v3 自身按退避重排；退避到期后补投即成功。
    const pending = [...harness.eventStore.events.values()].find(
      (item) => item.stateVersion === 3,
    )!;
    expect(pending.status).toBe('pending');
    expect(pending.attempts).toBe(1);
    harness.eventStore.events.set(pending.eventId, {
      ...pending,
      nextAttemptAt: new Date(Date.now() - 1).toISOString(),
    });
    const second = await harness.dispatcher.tick();
    expect(second.delivered).toBe(1);
  });

  it('失败按指数退避重排；超出重试窗口标 abandoned 并告警', async () => {
    const { impl } = recordingFetch(() => ackResponse({ ok: false }, 500));
    const harness = await rig({ fetchImpl: impl });
    const event = await harness.eventStore.enqueue({
      installationId: TEST_IID,
      stateVersion: 2,
      type: 'installation.disabled',
      retryWindowMs: 60_000,
    });
    const first = await harness.dispatcher.tick();
    expect(first.failed).toBe(1);
    const afterFirst = harness.eventStore.events.get(event.eventId)!;
    expect(afterFirst.status).toBe('pending');
    expect(afterFirst.attempts).toBe(1);
    expect(Date.parse(afterFirst.nextAttemptAt)).toBeGreaterThan(Date.parse(afterFirst.occurredAt));

    // 把重试窗口收到已过期，再投一次即放弃。
    harness.eventStore.events.set(event.eventId, {
      ...afterFirst,
      nextAttemptAt: new Date(Date.now() - 1000).toISOString(),
      giveUpAt: new Date(Date.now() - 1).toISOString(),
    });
    const second = await harness.dispatcher.tick();
    expect(second.abandoned).toBe(1);
    expect(harness.eventStore.events.get(event.eventId)!.status).toBe('abandoned');
    expect(harness.alerts).toContainEqual({ kind: 'abandoned', installationId: TEST_IID });
  });

  it('3xx 重定向按 upstream_unavailable 处理，不跟随', async () => {
    const impl = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example.com/' },
      })) as unknown as typeof fetch;
    const harness = await rig({ fetchImpl: impl });
    const event = await harness.eventStore.enqueue({
      installationId: TEST_IID,
      stateVersion: 2,
      type: 'installation.disabled',
      retryWindowMs: 600_000,
    });
    const result = await harness.dispatcher.tick();
    expect(result.failed).toBe(1);
    expect(harness.eventStore.events.get(event.eventId)!.lastError).toContain(
      'upstream_unavailable',
    );
  });

  it('jwks 轮换：广播 rotated + probe，verifiedKid 回写并成为切换证据', async () => {
    const { impl, calls } = recordingFetch((call) => {
      const payload = (call.body.payload ?? {}) as { kid?: string };
      return ackResponse({
        eventId: call.body.eventId,
        ack: true,
        stateVersion: call.body.stateVersion,
        ...(call.body.type === 'jwks.probe' ? { verifiedKid: payload.kid } : {}),
      });
    });
    const harness = await rig({ fetchImpl: impl });
    const rotated = await harness.dispatcher.rotateAndProbe();
    expect(rotated.probed).toBe(1);

    // 未投递前不允许切换。
    await expect(harness.dispatcher.promoteWhenAllVerified(rotated.newKid)).resolves.toMatchObject({
      promoted: false,
      pending: [TEST_IID],
    });

    await harness.dispatcher.tick();
    expect(calls.map((call) => call.body.type)).toEqual(['jwks.rotated', 'jwks.probe']);
    const probe = [...harness.eventStore.events.values()].find(
      (item) => item.type === 'jwks.probe',
    )!;
    expect(probe.verifiedKid).toBe(rotated.newKid);

    const promoted = await harness.dispatcher.promoteWhenAllVerified(rotated.newKid);
    expect(promoted.promoted).toBe(true);
    expect((await harness.signingKeys.findByStatus('active'))!.kid).toBe(rotated.newKid);
    // 旧键进入 retiring，仍在 JWKS 里（24 小时窗口）。
    expect((await harness.keys.jwks()).keys).toHaveLength(2);
  });

  it('紧急撤销广播 jwks.revoke 并把密钥移出 JWKS', async () => {
    const { impl } = recordingFetch((call) =>
      ackResponse({
        eventId: call.body.eventId,
        ack: true,
        stateVersion: call.body.stateVersion,
      }),
    );
    const harness = await rig({ fetchImpl: impl });
    const active = (await harness.signingKeys.findByStatus('active'))!;
    expect(await harness.dispatcher.broadcastRevoke(active.kid)).toBe(1);
    await harness.keys.revoke(active.kid);
    expect((await harness.keys.jwks()).keys).toHaveLength(0);
    const revokeEvent = [...harness.eventStore.events.values()].find(
      (item) => item.type === 'jwks.revoke',
    );
    expect(revokeEvent?.payload).toEqual({ kid: active.kid });
  });
});

describe('健康探测', () => {
  it('连续 5 次失败告警一次，恢复后再通知一次', async () => {
    const live = vi.fn(async () => new Response(null, { status: 503 }));
    const impl = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/ky/v1/health/live')) return live();
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const harness = await rig({ fetchImpl: impl });

    let clock = Date.parse('2026-09-06T00:00:00.000Z');
    for (let round = 0; round < 5; round += 1) {
      await harness.prober.tick(clock);
      clock += 60_000;
    }
    expect(harness.runtimeStore.records.get(TEST_IID)!.consecutiveFailures).toBe(5);
    expect(
      harness.alerts.filter((item) => item.kind === 'ky_app_installation_unhealthy'),
    ).toHaveLength(1);

    // 继续失败不再重复告警。
    await harness.prober.tick(clock);
    clock += 60_000;
    expect(
      harness.alerts.filter((item) => item.kind === 'ky_app_installation_unhealthy'),
    ).toHaveLength(1);

    live.mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await harness.prober.tick(clock);
    expect(
      harness.alerts.filter((item) => item.kind === 'ky_app_installation_recovered'),
    ).toHaveLength(1);
    expect(harness.runtimeStore.records.get(TEST_IID)!.consecutiveFailures).toBe(0);
  });

  it('ready 上报写运行状态表并比对 digest', async () => {
    const digest = 'd'.repeat(64);
    const impl = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/ky/v1/health/live')) {
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          status: 'ok',
          contractVersion: 1,
          appVersion: '1.2.3',
          manifestDigest: digest,
          installationState: 'enabled',
          deps: {
            db: true,
            executionStore: true,
            jtiStore: true,
            directorySync: { checkpoint: 42, ageSeconds: 12 },
          },
          jwksKids: ['ky-20260906-aaaaaaaa'],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const harness = await rig({ fetchImpl: impl });

    const first = await harness.prober.tick(Date.parse('2026-09-06T00:00:00.000Z'));
    expect(first.readyProbed).toBe(1);
    const record = harness.runtimeStore.records.get(TEST_IID)!;
    expect(record.readyStatus).toBe('ok');
    expect(record.manifestDigest).toBe(digest);
    expect(record.appVersion).toBe('1.2.3');
    expect(record.jwksKids).toEqual(['ky-20260906-aaaaaaaa']);
    expect(record.directoryCheckpoint).toBe('42');
    // 尚未登记 registeredDigest → 不算不一致。
    expect(first.digestMismatches).toBe(0);

    // 登记一个不同的 digest 后再探 → 记为不一致。
    await harness.systems.setRegisteredDigest({
      installationId: TEST_IID,
      digest: (await harness.systems.listVersions('demo-erp'))[0]!.digest,
      observedDigest: (await harness.systems.listVersions('demo-erp'))[0]!.digest,
      expectedRegisteredDigest: null,
      actor: 'u_seed',
    });
    const second = await harness.prober.tick(Date.parse('2026-09-06T00:10:00.000Z'));
    expect(second.digestMismatches).toBe(1);
    expect(harness.runtimeStore.records.get(TEST_IID)!.lastError).toContain(
      'manifestDigest 与登记不一致',
    );
  });

  it('maintenance 不计失败', async () => {
    const impl = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/ky/v1/health/live')) {
        return new Response(JSON.stringify({ status: 'maintenance', etaMinutes: 5 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 500 });
    }) as unknown as typeof fetch;
    const harness = await rig({ fetchImpl: impl });
    await harness.prober.tick(Date.parse('2026-09-06T00:00:00.000Z'));
    const record = harness.runtimeStore.records.get(TEST_IID)!;
    expect(record.liveStatus).toBe('maintenance');
    expect(record.consecutiveFailures).toBe(0);
    expect(harness.alerts).toHaveLength(0);
  });
});

describe('域名归属周期复验（§2.5）', () => {
  const READY_OK = JSON.stringify({
    status: 'ok',
    contractVersion: 1,
    appVersion: '1.0.0',
    manifestDigest: 'f'.repeat(64),
    installationState: 'enabled',
    deps: { db: true, executionStore: true, jtiStore: true, directorySync: { checkpoint: 1, ageSeconds: 1 } },
    jwksKids: [],
  });

  function healthyFetch(): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/ky/v1/health/live')) {
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(READY_OK, { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
  }

  it('TXT 记录漂移时告警并写运行状态，但不改实例状态机', async () => {
    let txt = 'placeholder-token-value-long-enough';
    const harness = await rig({ fetchImpl: healthyFetch(), resolveTxt: async () => [[txt]] });
    // 让实例带上一个与 DNS 不匹配的验证令牌。
    await harness.systems.createInstallation({
      installationId: 'tsi_dns_probe',
      tenantId: 't_demo',
      systemId: 'demo-erp',
      baseUrl: TEST_ORIGIN,
      origin: TEST_ORIGIN,
      techContactUserId: 'u_tech',
      domainVerificationToken: 'expected-token-value-long-enough',
      actor: 'u_seed',
    });
    await harness.systems.updateInstallationStatus({
      installationId: 'tsi_dns_probe', status: 'enabled', actor: 'u_seed',
    });

    const drifted = await harness.prober.tick(Date.parse('2026-09-06T00:00:00.000Z'));
    expect(drifted.domainDrifts).toBe(1);
    expect(harness.runtimeStore.records.get('tsi_dns_probe')!.lastError)
      .toContain('域名归属周期复验未通过');
    // 只告警、不下线。
    expect((await harness.systems.getInstallation('tsi_dns_probe'))!.status).toBe('enabled');
    expect(harness.alerts.some((item) => item.installationId === 'tsi_dns_probe')).toBe(true);

    txt = 'expected-token-value-long-enough';
    const recovered = await harness.prober.tick(Date.parse('2026-09-06T00:10:00.000Z'));
    expect(recovered.domainDrifts).toBe(0);
  });
});

describe('无安装实例时的密钥轮换', () => {
  it('没有 enabled 实例时「全部已验证」为空真，允许切换（否则全新环境永远无法轮换）', async () => {
    const { impl } = recordingFetch(() => ackResponse({ ok: true }));
    const harness = await rig({ fetchImpl: impl });
    // 把唯一的实例停用，模拟「还没有任何定制项目」的环境。
    await harness.systems.updateInstallationStatus({
      installationId: TEST_IID, status: 'disabled', actor: 'u_seed',
    });
    const rotated = await harness.dispatcher.rotateAndProbe();
    expect(rotated.probed).toBe(0);
    const promoted = await harness.dispatcher.promoteWhenAllVerified(rotated.newKid);
    expect(promoted).toEqual({ promoted: true, pending: [] });
    expect((await harness.signingKeys.findByStatus('active'))!.kid).toBe(rotated.newKid);
  });
});
