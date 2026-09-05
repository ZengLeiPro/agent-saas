/**
 * §9.3-3：端点 × act 全表（含 `local_*` 与公开行）；`pfx` 穿越变体；
 * `tadm=false` 打 admin 前缀 → 403。
 */
import { assert, expectStatus, newRequestId, rawCall } from '../harness/http.js';
import { randomNonce } from '../mockShell/sat.js';
import { disableBreakGlass, enableBreakGlass, loginAsEmployee } from './breakGlass.js';
import {
  adminApiPath,
  firstValidInput,
  fixtureUsers,
  provisionUsers,
  userApiPath,
} from './fixtures.js';
import type { DoctorContext } from './context.js';

type Actor = 'public' | 'user' | 'user_admin' | 'agent' | 'platform' | 'local_admin' | 'local_user';

const ALL_ACTORS: Actor[] = [
  'public',
  'user',
  'user_admin',
  'agent',
  'platform',
  'local_admin',
  'local_user',
];

interface Row {
  label: string;
  method: string;
  path: () => string;
  body?: unknown;
  headers?: Record<string, string>;
  /** 允许访问的主体；其余一律期望 401/403/404。 */
  allowed: Actor[];
  /** 允许访问时可接受的状态码（业务层可能再报别的错，这里只关心不是 401/403）。 */
  okStatuses?: number[];
}

export async function chapter03(ctx: DoctorContext): Promise<void> {
  const reporter = ctx.reporter;
  reporter.section(3);

  const users = fixtureUsers(ctx);
  await provisionUsers(ctx, [
    { sub: users.admin.sub, roles: users.admin.roles, isTenantAdmin: true },
    { sub: users.member.sub, roles: users.member.roles },
  ]);

  const session = await enableBreakGlass(ctx, users.admin.sub);
  const localUserToken = await loginAsEmployee(ctx, session, {
    loginId: users.member.sub,
    sub: users.member.sub,
  });

  const readOnly = ctx.capabilitiesOf('read_only')[0];
  const userApi = userApiPath(ctx);
  const adminApi = adminApiPath(ctx);

  /** 造某个主体的令牌（`public` 返回 undefined）。 */
  async function tokenFor(
    actor: Actor,
    requestId: string,
    capabilityId?: string,
  ): Promise<string | undefined> {
    switch (actor) {
      case 'public':
        return undefined;
      case 'user':
        return ctx.signUser({ sub: users.member.sub, tadm: false });
      case 'user_admin':
        return ctx.signUser({ sub: users.admin.sub, tadm: true });
      case 'agent':
        return ctx.signAgent({
          sub: users.member.sub,
          cap: capabilityId ?? readOnly?.id ?? 'unknown',
          lcid: `lc_${requestId}`,
          rid: requestId,
        });
      case 'platform':
        return ctx.signPlatform({ rid: requestId });
      case 'local_admin':
        return session.adminToken;
      case 'local_user':
        return localUserToken;
    }
  }

  const rows: Row[] = [
    {
      label: 'GET /ky/v1/health/live（公开行）',
      method: 'GET',
      path: () => '/ky/v1/health/live',
      allowed: ALL_ACTORS,
      okStatuses: [200],
    },
    {
      label: 'GET /ky/v1/attest（公开行）',
      method: 'GET',
      path: () => `/ky/v1/attest?nonce=${randomNonce()}`,
      allowed: ALL_ACTORS,
      okStatuses: [200],
    },
    {
      label: 'GET /ky/v1/health/ready（platform）',
      method: 'GET',
      path: () => '/ky/v1/health/ready',
      allowed: ['platform'],
      okStatuses: [200, 503],
    },
    {
      label: 'GET /ky/v1/manifest（platform）',
      method: 'GET',
      path: () => '/ky/v1/manifest',
      allowed: ['platform'],
      okStatuses: [200],
    },
    {
      label: 'GET /ky/v1/me（user / local_*）',
      method: 'GET',
      path: () => '/ky/v1/me',
      allowed: ['user', 'user_admin', 'local_admin', 'local_user'],
      okStatuses: [200],
    },
  ];

  if (readOnly !== undefined) {
    rows.push({
      label: `POST /ky/v1/capabilities/${readOnly.id}（agent）`,
      method: 'POST',
      path: () => `/ky/v1/capabilities/${encodeURIComponent(readOnly.id)}`,
      body: { input: firstValidInput(ctx, readOnly.id) },
      headers: { 'X-KY-Idempotency-Key': 'lc_matrix' },
      allowed: ['agent'],
      okStatuses: [200, 400, 409],
    });
    rows.push({
      label: `GET /ky/v1/capabilities/${readOnly.id}/executions/{lcid}（agent）`,
      method: 'GET',
      path: () => `/ky/v1/capabilities/${encodeURIComponent(readOnly.id)}/executions/lc_matrix`,
      allowed: ['agent'],
      okStatuses: [200],
    });
  }

  if (userApi !== null) {
    rows.push({
      label: `GET ${userApi}（pathPrefixes.user）`,
      method: 'GET',
      path: () => userApi,
      allowed: ['user', 'user_admin', 'local_admin', 'local_user'],
      okStatuses: [200],
    });
  }
  if (adminApi !== null) {
    rows.push({
      label: `GET ${adminApi}（pathPrefixes.admin，仅 tadm 与 local_admin）`,
      method: 'GET',
      path: () => adminApi,
      allowed: ['user_admin', 'local_admin'],
      okStatuses: [200],
    });
  }

  for (const row of rows) {
    for (const actor of ALL_ACTORS) {
      const expectedOk = row.allowed.includes(actor);
      await reporter.check(
        `${row.label} × ${actor} → ${expectedOk ? '放行' : '拒绝'}`,
        async () => {
          const requestId = newRequestId('matrix');
          const capabilityId = readOnly?.id;
          const token = await tokenFor(actor, requestId, capabilityId);
          const result = await ctx.call({
            method: row.method,
            path: row.path(),
            ...(token === undefined ? {} : { token }),
            ...(row.body === undefined ? {} : { body: row.body }),
            ...(row.headers === undefined ? {} : { headers: row.headers }),
            requestId,
          });
          if (expectedOk) {
            expectStatus(result, row.okStatuses ?? [200], `${row.label} × ${actor}`);
          } else {
            expectStatus(result, [401, 403, 404], `${row.label} × ${actor}`);
          }
        },
      );
    }
  }

  // ---- pfx 穿越变体（§9.3-3）----
  if (userApi !== null) {
    const userPrefix = ctx.manifest.pathPrefixes.user[0];
    const adminPrefix = ctx.manifest.pathPrefixes.admin[0];
    const variants: Array<{ name: string; rawPath: string }> = [
      { name: '%2f', rawPath: `${userPrefix}%2f..${adminPrefix}roles` },
      { name: '%252f（双重编码）', rawPath: `${userPrefix}%252fadmin` },
      { name: '..', rawPath: `${userPrefix}../${adminPrefix.replace(/^\//u, '')}roles` },
      { name: '// + ..', rawPath: `${userPrefix}/..${adminPrefix}roles` },
      { name: '反斜杠', rawPath: `${userPrefix}\\..${adminPrefix}roles` },
      { name: '/api/apps（非 segment 前缀）', rawPath: `${userPrefix.replace(/\/$/u, '')}s` },
    ];
    for (const variant of variants) {
      await reporter.check(`pfx 变体 ${variant.name} → 403/404`, async () => {
        const token = await ctx.signUser({ sub: users.member.sub, tadm: false });
        const result = await rawCall(ctx.baseUrl, variant.rawPath, { token });
        assert(
          result.status === 403 || result.status === 404,
          `${variant.rawPath} 期望 403/404，实际 ${String(result.status)}`,
        );
      });
    }

    await reporter.check('tadm=false 的 user 打 admin 前缀 → 403', async () => {
      if (adminApi === null) throw new Error('夹具没有声明 pathPrefixes.admin 内的接口');
      const result = await ctx.callAsUser(
        { path: adminApi },
        { sub: users.member.sub, tadm: false },
      );
      expectStatus(result, 403, `tadm=false 访问 ${adminApi}`);
    });
  }

  await reporter.check('/ky/v1/test/* 在 KY_ENV=test 下公开可达', async () => {
    const result = await ctx.testHook('clock', { offsetMs: 0 });
    expectStatus(result, 200, 'POST /ky/v1/test/clock');
  });

  await disableBreakGlass(ctx);
  await reporter.check('兜底关闭后 local_admin 令牌立即失效（模式级撤销）', async () => {
    const result = await ctx.call({ path: '/ky/v1/me', token: session.adminToken });
    expectStatus(result, [401, 403], '兜底关闭后使用 local_admin 令牌');
  });
}
