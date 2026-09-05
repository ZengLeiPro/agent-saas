/** §9.3-2：SAT 负向全表 → 401/403；`platform` 带错误 `dig` 仍 200。 */
import { JWT_TYP } from '@kaiyan/ky-app-contract';

import { assert, expectStatus, newRequestId } from '../harness/http.js';
import { agentClaims, platformClaims, userClaims } from '../mockShell/sat.js';
import type { DoctorContext } from './context.js';

interface Negative {
  name: string;
  token: () => Promise<string> | string;
  path?: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  requestId?: string;
}

export async function chapter02(ctx: DoctorContext): Promise<void> {
  const reporter = ctx.reporter;
  reporter.section(2);

  const app = ctx.shell.app;
  const signer = ctx.shell.signer;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const readOnly = ctx.capabilitiesOf('read_only')[0];
  const capabilityPath =
    readOnly === undefined ? null : `/ky/v1/capabilities/${encodeURIComponent(readOnly.id)}`;
  const validInput =
    readOnly === undefined
      ? {}
      : (ctx.conformance.capabilities[readOnly.id]?.validInputs[0]?.input ?? {});

  const cases: Negative[] = [
    { name: 'alg=none', token: () => signer.signNone(userClaims(app)) },
    { name: 'HS256 对称签名', token: () => signer.signHs256(userClaims(app)) },
    { name: '未知 kid', token: () => signer.signUnknownKid(userClaims(app)) },
    {
      name: 'header typ 不是 ky-sat+jwt',
      token: () => signer.sign(userClaims(app), { typ: 'JWT' }),
    },
    {
      name: '错误 iss',
      token: () => signer.sign(userClaims(app, {}, { iss: 'https://evil.invalid' })),
    },
    { name: '错误 aud', token: () => signer.sign(userClaims(app, {}, { aud: 'other-system' })) },
    { name: '错误 tid', token: () => signer.sign(userClaims(app, {}, { tid: 't_other' })) },
    { name: '错误 iid', token: () => signer.sign(userClaims(app, {}, { iid: 'tsi_other' })) },
    {
      name: '已过期（exp 在过去）',
      token: () => signer.sign(userClaims(app, { nowSeconds: nowSeconds - 3600, ttlSeconds: 300 })),
    },
    {
      name: '未来 nbf（超过 30 s 容忍）',
      token: () => signer.sign(userClaims(app, {}, { nbf: nowSeconds + 120 })),
    },
    { name: '缺 sub', token: () => signer.sign(userClaims(app, {}, { sub: undefined })) },
    { name: '缺 tadm', token: () => signer.sign(userClaims(app, {}, { tadm: undefined })) },
    { name: '缺 pfx', token: () => signer.sign(userClaims(app, {}, { pfx: undefined })) },
    { name: '缺 jti', token: () => signer.sign(userClaims(app, {}, { jti: undefined })) },
    { name: '缺 nbf', token: () => signer.sign(userClaims(app, {}, { nbf: undefined })) },
    { name: 'act=foo', token: () => signer.sign(userClaims(app, {}, { act: 'foo' })) },
    {
      name: 'act=user 带 cap',
      token: () => signer.sign(userClaims(app, {}, { cap: 'order.search' })),
    },
    {
      name: 'apr 无 aph',
      token: () => signer.sign(userClaims(app, {}, { apr: 'apv_1' })),
    },
    {
      name: 'aph 无 apr',
      token: () => signer.sign(userClaims(app, {}, { aph: 'a'.repeat(64) })),
    },
  ];

  for (const item of cases) {
    await reporter.check(`GET /ky/v1/me + ${item.name} → 401/403`, async () => {
      const result = await ctx.call({
        method: item.method ?? 'GET',
        path: item.path ?? '/ky/v1/me',
        token: await item.token(),
        ...(item.body === undefined ? {} : { body: item.body }),
        ...(item.headers === undefined ? {} : { headers: item.headers }),
      });
      expectStatus(result, [401, 403], `SAT 负向「${item.name}」`);
    });
  }

  await reporter.check('缺 Authorization → 401', async () => {
    const result = await ctx.call({ path: '/ky/v1/me' });
    expectStatus(result, 401, '无令牌访问 /ky/v1/me');
  });

  if (capabilityPath !== null && readOnly !== undefined) {
    const agentCases: Negative[] = [
      {
        name: 'act=agent 缺 dig',
        token: async () => {
          const rid = newRequestId('neg');
          return signer.sign(
            agentClaims(app, { cap: readOnly.id, lcid: 'lc_neg', rid }, { dig: undefined }),
          );
        },
      },
      {
        name: 'act=agent 缺 tadm',
        token: async () =>
          signer.sign(
            agentClaims(
              app,
              { cap: readOnly.id, lcid: 'lc_neg', rid: 'req_neg' },
              { tadm: undefined },
            ),
          ),
      },
      {
        name: 'act=agent 的 cap 与 URL 能力不符',
        token: async () =>
          signer.sign(agentClaims(app, { cap: 'other.cap', lcid: 'lc_neg', rid: 'req_neg' })),
      },
      {
        name: 'act=agent 的 rid 与 X-KY-Request-Id 不符',
        token: async () =>
          signer.sign(agentClaims(app, { cap: readOnly.id, lcid: 'lc_neg', rid: 'req_other' })),
      },
    ];
    for (const item of agentCases) {
      await reporter.check(`POST ${capabilityPath} + ${item.name} → 401/403`, async () => {
        const result = await ctx.call({
          method: 'POST',
          path: capabilityPath,
          token: await item.token(),
          requestId: 'req_neg',
          headers: { 'X-KY-Idempotency-Key': 'lc_neg' },
          body: { input: validInput },
        });
        expectStatus(result, [401, 403], `SAT 负向「${item.name}」`);
      });
    }
  }

  await reporter.check('act=platform 带错误 dig 仍 200（dig 只在能力端点比对）', async () => {
    const requestId = newRequestId('plat-dig');
    const token = await signer.sign(platformClaims(app, { rid: requestId, dig: 'f'.repeat(64) }));
    const result = await ctx.call({ path: '/ky/v1/manifest', token, requestId });
    expectStatus(result, 200, 'platform + 错误 dig');
  });

  await reporter.check('JWT header typ 常量与契约一致', () => {
    assert(JWT_TYP.sat === 'ky-sat+jwt', `契约的 SAT typ 应为 ky-sat+jwt，实际 ${JWT_TYP.sat}`);
  });
}
