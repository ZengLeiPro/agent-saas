/** 走真实路由的端到端流程：安装实例状态、兜底登录、目录门禁、jti 重放、能力错误码。 */
import { beforeEach, describe, expect, it } from 'vitest';

import { DIRECTORY_STALENESS_SECONDS, HTTP_HEADERS } from '@kaiyan/ky-app-contract';

import { directoryStalenessGate } from '../directory/staleness.js';
import { createHarness, type Harness } from '../__tests__/harness.js';
import { agentClaims, platformClaims, userClaims } from '../__tests__/helpers.js';

const PASSWORD = 'recover-me-2026!';
const ORIGIN = 'https://app.test.invalid';

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

async function userRequest(path: string, method = 'GET'): Promise<Response> {
  const token = await harness.signer.sign(userClaims(harness.config));
  return harness.router.request(`${ORIGIN}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
}

async function platformRequest(path: string, body?: unknown): Promise<Response> {
  const token = await harness.signer.sign(platformClaims(harness.config, { rid: 'req_platform' }));
  return harness.router.request(`${ORIGIN}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      [HTTP_HEADERS.requestId]: 'req_platform',
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function jsonRequest(path: string, body: unknown): Promise<Response> {
  return harness.router.request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('安装实例状态（§3.7 / §9.3-13）', () => {
  it('disabled 后 SAT 一律 403 installation_disabled，events 与 health 仍可达；enabled 恢复', async () => {
    expect((await userRequest('/ky/v1/me')).status).toBe(200);

    await platformRequest('/ky/v1/events', {
      eventId: 'ev_1',
      iid: harness.config.installationId,
      stateVersion: 1,
      type: 'installation.disabled',
      occurredAt: '2026-09-05T00:00:00.000Z',
    });

    const denied = await userRequest('/ky/v1/me');
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({
      error: { code: 'installation_disabled' },
    });
    expect((await userRequest('/api/app/orders')).status).toBe(403);
    expect((await harness.router.request(`${ORIGIN}/ky/v1/health/live`)).status).toBe(200);

    const ack = await platformRequest('/ky/v1/events', {
      eventId: 'ev_2',
      iid: harness.config.installationId,
      stateVersion: 2,
      type: 'installation.enabled',
      occurredAt: '2026-09-05T00:01:00.000Z',
    });
    expect(ack.status).toBe(200);
    expect((await userRequest('/ky/v1/me')).status).toBe(200);
  });

  it('stateVersion 跳号 → 409 state_gap', async () => {
    const response = await platformRequest('/ky/v1/events', {
      eventId: 'ev_gap',
      iid: harness.config.installationId,
      stateVersion: 5,
      type: 'installation.disabled',
      occurredAt: '2026-09-05T00:00:00.000Z',
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'state_gap' } });
  });
});

describe('兜底登录路由（§3.3 / §9.3-11）', () => {
  it('关闭时 /ky-local/login 404，而 /ky-local/enable 可达', async () => {
    const login = await jsonRequest('/ky-local/login', { loginId: 'E1', code: 'x' });
    expect(login.status).toBe(404);

    const enable = await jsonRequest('/ky-local/enable', {
      sub: 'u_admin',
      password: 'nope-nope-nope',
      code: 'nope',
    });
    expect(enable.status).toBe(401);
  });

  it('具名启用 → local_admin 可签员工码，员工登录拿 local_user', async () => {
    const { codes } = await harness.breakGlass.setupRecoveryRecord({
      sub: 'u_admin',
      password: PASSWORD,
    });
    const enable = await jsonRequest('/ky-local/enable', {
      sub: 'u_admin',
      password: PASSWORD,
      code: codes[0],
    });
    expect(enable.status).toBe(200);
    const { token } = (await enable.json()) as { token: string };

    const issued = await harness.router.request(`${ORIGIN}/ky-local/employee-code`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ loginId: 'E1024', sub: 'u_member' }),
    });
    expect(issued.status).toBe(200);
    const { code } = (await issued.json()) as { code: string };

    const login = await jsonRequest('/ky-local/login', { loginId: 'E1024', code });
    expect(login.status).toBe(200);
    const member = (await login.json()) as { token: string };

    // local_user 只到 pathPrefixes.user
    const allowed = await harness.router.request(`${ORIGIN}/api/app/orders`, {
      headers: { authorization: `Bearer ${member.token}` },
    });
    expect(allowed.status).toBe(200);
    const denied = await harness.router.request(`${ORIGIN}/api/admin/roles`, {
      headers: { authorization: `Bearer ${member.token}` },
    });
    expect(denied.status).toBe(403);

    // local_user 不能签员工码
    const forbidden = await harness.router.request(`${ORIGIN}/ky-local/employee-code`, {
      method: 'POST',
      headers: { authorization: `Bearer ${member.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ loginId: 'E2048', sub: 'u_x' }),
    });
    expect(forbidden.status).toBe(403);
  });

  it('/ky-local/enable 每 IP ≤ 5 次/分钟', async () => {
    let last = 0;
    for (let index = 0; index < 6; index += 1) {
      const response = await harness.router.request(`${ORIGIN}/ky-local/enable`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '9.9.9.9' },
        body: JSON.stringify({ sub: 'u_admin', password: 'x'.repeat(16), code: 'x' }),
      });
      last = response.status;
    }
    expect(last).toBe(429);
  }, 30_000);

  it('4 小时后自动关闭，Local Token 随之失效', async () => {
    const { codes } = await harness.breakGlass.setupRecoveryRecord({
      sub: 'u_admin',
      password: PASSWORD,
    });
    const enable = await jsonRequest('/ky-local/enable', {
      sub: 'u_admin',
      password: PASSWORD,
      code: codes[0],
    });
    const { token } = (await enable.json()) as { token: string };
    expect(
      (
        await harness.router.request(`${ORIGIN}/ky/v1/me`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(200);

    harness.clock.advance(4 * 60 * 60 * 1000 + 1);
    const expired = await harness.router.request(`${ORIGIN}/ky/v1/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(expired.status).toBe(401);
  }, 30_000);
});

describe('目录陈旧度门禁（§3.4 / §9.3-12）', () => {
  it('> 2 小时拒写、> 24 小时连读也拒', async () => {
    let ageSeconds = 0;
    const gated = await createHarness({ staleness: () => directoryStalenessGate(ageSeconds) });
    harness = gated;

    const token = await gated.signer.sign(userClaims(gated.config));
    const call = (method: string) =>
      gated.router.request(`${ORIGIN}/api/app/orders`, {
        method,
        headers: { authorization: `Bearer ${token}` },
      });

    expect((await call('GET')).status).toBe(200);
    expect((await call('POST')).status).toBe(200);

    ageSeconds = DIRECTORY_STALENESS_SECONDS.blockWrite + 1;
    expect((await call('GET')).status).toBe(200);
    const write = await call('POST');
    expect(write.status).toBe(403);
    await expect(write.json()).resolves.toMatchObject({ error: { code: 'directory_stale' } });

    ageSeconds = DIRECTORY_STALENESS_SECONDS.blockRead + 1;
    expect((await call('GET')).status).toBe(403);
    // /me 与只读 health 不受影响
    expect(
      (
        await gated.router.request(`${ORIGIN}/ky/v1/me`, {
          headers: { authorization: `Bearer ${await gated.signer.sign(userClaims(gated.config))}` },
        })
      ).status,
    ).toBe(200);
    expect((await gated.router.request(`${ORIGIN}/ky/v1/health/live`)).status).toBe(200);
  });

  it('兜底模式不受陈旧度门禁约束', async () => {
    const gated = await createHarness({
      staleness: () => directoryStalenessGate(DIRECTORY_STALENESS_SECONDS.blockRead + 1),
    });
    const { codes } = await gated.breakGlass.setupRecoveryRecord({
      sub: 'u_admin',
      password: PASSWORD,
    });
    const enable = await gated.breakGlass.enable({
      sub: 'u_admin',
      password: PASSWORD,
      code: codes[0],
    });
    const response = await gated.router.request(`${ORIGIN}/api/app/orders`, {
      method: 'POST',
      headers: { authorization: `Bearer ${enable.token}` },
    });
    expect(response.status).toBe(200);
  }, 30_000);
});

describe('jti 与能力错误码走真实路由', () => {
  async function invoke(
    token: string,
    init: { lcid: string; idempotencyKey?: string | null; body?: unknown },
  ): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      [HTTP_HEADERS.requestId]: 'req_x',
      'content-type': 'application/json',
    };
    if (init.idempotencyKey !== null && init.idempotencyKey !== undefined) {
      headers[HTTP_HEADERS.idempotencyKey] = init.idempotencyKey;
    }
    return harness.router.request(`${ORIGIN}/ky/v1/capabilities/order.search`, {
      method: 'POST',
      headers,
      body: JSON.stringify(init.body ?? { input: { keyword: '张三' } }),
    });
  }

  it('同一 agent SAT 重放 → 401 token_replayed', async () => {
    const token = await harness.signer.sign(
      agentClaims(harness.config, { cap: 'order.search', lcid: 'lc_r', rid: 'req_x' }),
    );
    expect((await invoke(token, { lcid: 'lc_r', idempotencyKey: 'lc_r' })).status).toBe(200);
    const replay = await invoke(token, { lcid: 'lc_r', idempotencyKey: 'lc_r' });
    expect(replay.status).toBe(401);
    await expect(replay.json()).resolves.toMatchObject({ error: { code: 'token_replayed' } });
  });

  it('缺幂等键 → 400，且不消耗 jti（同一 SAT 补上幂等键后仍可用）', async () => {
    const token = await harness.signer.sign(
      agentClaims(harness.config, { cap: 'order.search', lcid: 'lc_k', rid: 'req_x' }),
    );
    expect((await invoke(token, { lcid: 'lc_k', idempotencyKey: null })).status).toBe(400);
    expect((await invoke(token, { lcid: 'lc_k', idempotencyKey: 'lc_k' })).status).toBe(200);
  });

  it('dig 不符 → 409 digest_mismatch', async () => {
    const token = await harness.signer.sign(
      agentClaims(harness.config, {
        cap: 'order.search',
        lcid: 'lc_d',
        rid: 'req_x',
        dig: 'a'.repeat(64),
      }),
    );
    const response = await invoke(token, { lcid: 'lc_d', idempotencyKey: 'lc_d' });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'digest_mismatch' } });
  });
});
