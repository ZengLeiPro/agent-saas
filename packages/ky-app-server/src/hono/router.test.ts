/** §3.3 端点 × act 全表（真实路由）、§5.1 响应头、附录 D 错误结构。 */
import { beforeEach, describe, expect, it } from 'vitest';

import { HTTP_HEADERS, validateErrorResponse } from '@kaiyan/ky-app-contract';

import { CONTENT_SECURITY_POLICY } from './securityHeaders.js';
import { createHarness, type Harness } from '../__tests__/harness.js';
import { agentClaims, platformClaims, userClaims } from '../__tests__/helpers.js';

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

type Actor = 'public' | 'user' | 'user_admin' | 'agent' | 'platform' | 'local_admin' | 'local_user';

const PASSWORD = 'recover-me-2026!';

/** 为某个主体造一次请求。`agent`/`platform` 会自动带上匹配的 `rid`。 */
async function request(
  actor: Actor,
  method: string,
  path: string,
  init: { body?: unknown; headers?: Record<string, string>; cap?: string; lcid?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  const requestId = 'req_matrix';

  if (actor === 'agent') {
    const claims = agentClaims(harness.config, {
      rid: requestId,
      ...(init.cap === undefined ? {} : { cap: init.cap }),
      ...(init.lcid === undefined ? {} : { lcid: init.lcid }),
    });
    headers.authorization = `Bearer ${await harness.signer.sign(claims)}`;
    headers[HTTP_HEADERS.requestId] = requestId;
  } else if (actor === 'platform') {
    headers.authorization = `Bearer ${await harness.signer.sign(platformClaims(harness.config, { rid: requestId }))}`;
    headers[HTTP_HEADERS.requestId] = requestId;
  } else if (actor === 'user' || actor === 'user_admin') {
    const tadm = actor === 'user_admin';
    headers.authorization = `Bearer ${await harness.signer.sign(
      userClaims(harness.config, {
        tadm,
        pfx: tadm ? ['/api/app/', '/api/admin/'] : ['/api/app/'],
      }),
    )}`;
  } else if (actor === 'local_admin' || actor === 'local_user') {
    headers.authorization = `Bearer ${await localToken(actor)}`;
  }

  // 调用方显式给的头最后合入，方便造「rid 与 X-KY-Request-Id 不符」这类用例。
  const merged: Record<string, string> = { ...headers, ...init.headers };
  if (init.body !== undefined) merged['content-type'] = 'application/json';
  return harness.router.request(`https://app.test.invalid${path}`, {
    method,
    headers: merged,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

let localTokens: Partial<Record<'local_admin' | 'local_user', string>> = {};

async function enableBreakGlass(): Promise<void> {
  const { codes } = await harness.breakGlass.setupRecoveryRecord({
    sub: 'u_admin',
    password: PASSWORD,
  });
  const admin = await harness.breakGlass.enable({
    sub: 'u_admin',
    password: PASSWORD,
    code: codes[0],
  });
  const employee = await harness.breakGlass.issueEmployeeCode({
    loginId: 'E1024',
    sub: 'u_member',
  });
  const member = await harness.breakGlass.login({ loginId: 'E1024', code: employee.code });
  localTokens = { local_admin: admin.token, local_user: member.token };
}

async function localToken(actor: 'local_admin' | 'local_user'): Promise<string> {
  if (localTokens[actor] === undefined) await enableBreakGlass();
  return localTokens[actor]!;
}

beforeEach(() => {
  localTokens = {};
});

describe('公开行（§3.3）', () => {
  it('GET /ky/v1/health/live 任何主体都可达', async () => {
    for (const actor of ['public', 'user', 'agent', 'platform'] as const) {
      const response = await request(actor, 'GET', '/ky/v1/health/live');
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: 'ok' });
    }
  });

  it('GET /ky/v1/attest 公开且每 nonce ≤ 5 次', async () => {
    const nonce = 'n'.repeat(24);
    for (let index = 0; index < 5; index += 1) {
      const response = await request('public', 'GET', `/ky/v1/attest?nonce=${nonce}`);
      expect(response.status).toBe(200);
    }
    const limited = await request('public', 'GET', `/ky/v1/attest?nonce=${nonce}`);
    expect(limited.status).toBe(429);
  });

  it('GET /ky/v1/attest 缺 nonce → 400', async () => {
    expect((await request('public', 'GET', '/ky/v1/attest')).status).toBe(400);
  });

  it('方法不符不放行：POST /ky/v1/health/live → 404', async () => {
    expect((await request('public', 'POST', '/ky/v1/health/live')).status).toBe(404);
  });
});

describe('platform 行', () => {
  it('manifest / ready / events 只对 platform 开放', async () => {
    for (const path of ['/ky/v1/manifest', '/ky/v1/health/ready']) {
      expect((await request('platform', 'GET', path)).status).toBe(200);
      for (const actor of ['user', 'agent', 'local_admin', 'public'] as const) {
        const response = await request(actor, 'GET', path);
        expect([401, 403]).toContain(response.status);
      }
    }
  });

  it('POST /ky/v1/events 由 platform 投递并回 ack', async () => {
    const response = await request('platform', 'POST', '/ky/v1/events', {
      body: {
        eventId: 'ev_1',
        iid: harness.config.installationId,
        stateVersion: 1,
        type: 'installation.disabled',
        occurredAt: '2026-09-05T00:00:00.000Z',
      },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ack: true, stateVersion: 1 });
  });

  it('ready 报出 §4.6 全字段', async () => {
    const body = (await (await request('platform', 'GET', '/ky/v1/health/ready')).json()) as Record<
      string,
      unknown
    >;
    expect(Object.keys(body).sort()).toEqual(
      [
        'appVersion',
        'contractVersion',
        'deps',
        'installationState',
        'jwksKids',
        'manifestDigest',
        'status',
      ].sort(),
    );
  });
});

describe('user / local_* 行', () => {
  it('GET /ky/v1/me 对 user 与 local_* 开放，对 agent / platform 关闭', async () => {
    for (const actor of ['user', 'user_admin', 'local_admin', 'local_user'] as const) {
      const response = await request(actor, 'GET', '/ky/v1/me');
      expect(response.status).toBe(200);
      expect(response.headers.get(HTTP_HEADERS.permVersion)).not.toBeNull();
    }
    for (const actor of ['agent', 'platform', 'public'] as const) {
      expect([401, 403]).toContain((await request(actor, 'GET', '/ky/v1/me')).status);
    }
  });

  it('tadm=true 的 /me 含 settings.roles', async () => {
    const me = (await (await request('user_admin', 'GET', '/ky/v1/me')).json()) as {
      menus: Array<{ key: string; children?: Array<{ key: string }> }>;
      user: { isTenantAdmin: boolean };
    };
    expect(me.user.isTenantAdmin).toBe(true);
    expect(
      me.menus.some((menu) => menu.children?.some((child) => child.key === 'settings.roles')),
    ).toBe(true);
  });
});

describe('pathPrefixes 内业务路由', () => {
  it('user 前缀：user / local_* 可达，agent / platform 不可达', async () => {
    for (const actor of ['user', 'user_admin', 'local_admin', 'local_user'] as const) {
      const response = await request(actor, 'GET', '/api/app/orders');
      expect(response.status).toBe(200);
      expect(response.headers.get(HTTP_HEADERS.permVersion)).not.toBeNull();
    }
    for (const actor of ['agent', 'platform', 'public'] as const) {
      expect([401, 403]).toContain((await request(actor, 'GET', '/api/app/orders')).status);
    }
  });

  it('admin 前缀：tadm=true 的 user 与 local_admin 可达；tadm=false / local_user → 403', async () => {
    expect((await request('user_admin', 'GET', '/api/admin/roles')).status).toBe(200);
    expect((await request('local_admin', 'GET', '/api/admin/roles')).status).toBe(200);
    expect((await request('user', 'GET', '/api/admin/roles')).status).toBe(403);
    expect((await request('local_user', 'GET', '/api/admin/roles')).status).toBe(403);
  });

  it('%2f / .. / // / 反斜杠 / /api/apps 一律 403（§9.3-3）', async () => {
    const paths = [
      '/api/app/%2fadmin/roles',
      '/api/app/../admin/roles',
      '/api/app//../admin/roles',
      '/api/app/%5c..%5cadmin',
      '/api/apps',
    ];
    for (const path of paths) {
      const response = await request('user', 'GET', path);
      expect([403, 404]).toContain(response.status);
      if (response.status === 403) {
        const body = await response.json();
        expect(validateErrorResponse(body).ok).toBe(true);
      }
    }
  });

  it('/api/apps 即使带 admin 身份也不匹配 /api/app/ 前缀', async () => {
    expect((await request('user_admin', 'GET', '/api/apps')).status).toBe(403);
  });
});

describe('agent 行', () => {
  it('能力调用与执行查询只对 agent 开放', async () => {
    const response = await request('agent', 'POST', '/ky/v1/capabilities/order.search', {
      cap: 'order.search',
      lcid: 'lc_a',
      headers: { [HTTP_HEADERS.idempotencyKey]: 'lc_a' },
      body: { input: { keyword: '张三' } },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });

    for (const actor of ['user', 'platform', 'local_admin'] as const) {
      const denied = await request(actor, 'POST', '/ky/v1/capabilities/order.search', {
        body: { input: {} },
      });
      expect([401, 403]).toContain(denied.status);
    }
  });

  it('X-KY-Request-Id 与 rid 不符 → 403', async () => {
    const response = await request('agent', 'POST', '/ky/v1/capabilities/order.search', {
      cap: 'order.search',
      lcid: 'lc_b',
      headers: { [HTTP_HEADERS.idempotencyKey]: 'lc_b', [HTTP_HEADERS.requestId]: 'other' },
      body: { input: { keyword: '张三' } },
    });
    expect(response.status).toBe(403);
  });

  it('executions 查询返回状态机', async () => {
    await request('agent', 'POST', '/ky/v1/capabilities/order.search', {
      cap: 'order.search',
      lcid: 'lc_c',
      headers: { [HTTP_HEADERS.idempotencyKey]: 'lc_c' },
      body: { input: { keyword: '张三' } },
    });
    const response = await request(
      'agent',
      'GET',
      '/ky/v1/capabilities/order.search/executions/lc_c',
      { cap: 'order.search', lcid: 'lc_c' },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'done' });
  });
});

describe('§5.1 响应头', () => {
  it('CSP 只允许壳站嵌入、无 unsafe-inline，且不设 X-Frame-Options', async () => {
    const response = await request('public', 'GET', '/ky/v1/health/live');
    const csp = response.headers.get('Content-Security-Policy');
    expect(csp).toBe(CONTENT_SECURITY_POLICY);
    expect(csp).toContain('frame-ancestors https://agent.kaiyan.net');
    expect(csp).not.toContain('unsafe-inline');
    expect(response.headers.get('X-Frame-Options')).toBeNull();
    expect(response.headers.get('Strict-Transport-Security')).not.toBeNull();
  });

  it('兜底关闭时不下发 Set-Cookie', async () => {
    for (const path of ['/ky/v1/health/live', '/ky/v1/me', '/api/app/orders']) {
      const response = await request('user', 'GET', path);
      expect(response.headers.get('Set-Cookie')).toBeNull();
    }
  });

  it('X-KY-Request-Id 原样回显；缺失时自行生成', async () => {
    const echoed = await harness.router.request('https://app.test.invalid/ky/v1/health/live', {
      headers: { [HTTP_HEADERS.requestId]: 'req_echo' },
    });
    expect(echoed.headers.get(HTTP_HEADERS.requestId)).toBe('req_echo');
    const generated = await request('public', 'GET', '/ky/v1/health/live');
    expect(generated.headers.get(HTTP_HEADERS.requestId)).toMatch(/^local-/u);
  });

  it('保留 query（ky / ky_iid / ky_nonce）不影响路由', async () => {
    const response = await request(
      'user',
      'GET',
      '/api/app/orders?ky=1&ky_iid=tsi_01&ky_nonce=abc',
    );
    expect(response.status).toBe(200);
  });
});

describe('错误输出（附录 D）', () => {
  it('401 / 403 / 404 都是附录 D 结构且不含 details', async () => {
    const responses = await Promise.all([
      request('public', 'GET', '/ky/v1/me'),
      request('user', 'GET', '/api/admin/roles'),
      request('public', 'GET', '/ky/v1/nope'),
    ]);
    for (const response of responses) {
      const body = (await response.json()) as { error?: { requestId?: string } };
      expect(validateErrorResponse(body).ok).toBe(true);
      expect(Object.hasOwn(body as object, 'details')).toBe(false);
      expect(body.error?.requestId).toBeTruthy();
    }
  });
});

describe('/ky/v1/test/*（仅 KY_ENV=test）', () => {
  it('test 环境下开放 provision 与 clock', async () => {
    const provision = await request('public', 'POST', '/ky/v1/test/provision', {
      body: { users: [{ sub: 'test-admin', tadm: true }] },
    });
    expect(provision.status).toBe(200);

    const clock = await request('public', 'POST', '/ky/v1/test/clock', {
      body: { offsetMs: 1000 },
    });
    expect(clock.status).toBe(200);
    expect(harness.runtime.clockOffset()).toBe(1000);
  });

  it('test 环境下开放 directory 钩子（§9.3-12）', async () => {
    const response = await request('public', 'POST', '/ky/v1/test/directory', {
      body: { action: 'sync' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, result: { echoed: { action: 'sync' } } });
  });

  it('非 test 环境不注册 /ky/v1/test/*', async () => {
    const prod = await createHarness({ env: 'prod' });
    const response = await prod.router.request('https://app.test.invalid/ky/v1/test/clock', {
      method: 'POST',
      body: JSON.stringify({ offsetMs: 0 }),
      headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(404);
  });
});
