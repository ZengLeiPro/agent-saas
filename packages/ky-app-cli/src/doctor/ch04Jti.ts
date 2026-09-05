/**
 * §9.3-4：`jti`（agent）串行重放 401；并发 10 恰 1；**双进程**；存储重启；
 * `user` 同令牌 50 次 200。
 */
import {
  assert,
  call,
  expectErrorCode,
  expectStatus,
  newRequestId,
  type CallResult,
} from '../harness/http.js';
import { agentClaims } from '../mockShell/sat.js';
import { firstValidInput, fixtureUsers } from './fixtures.js';
import type { DoctorContext } from './context.js';

export async function chapter04(ctx: DoctorContext): Promise<void> {
  const reporter = ctx.reporter;
  reporter.section(4);

  const readOnly = ctx.capabilitiesOf('read_only')[0];
  if (readOnly === undefined) {
    reporter.record('本章需要至少一个 read_only 能力', 'fail', 'manifest 没有 read_only 能力');
    return;
  }
  const users = fixtureUsers(ctx);
  const input = firstValidInput(ctx, readOnly.id);
  const path = `/ky/v1/capabilities/${encodeURIComponent(readOnly.id)}`;

  /** 造一枚可复用的 agent SAT（同一枚令牌重复使用即重放）。 */
  async function agentToken(lcid: string, requestId: string): Promise<string> {
    return ctx.shell.signer.sign(
      agentClaims(ctx.shell.app, { sub: users.member.sub, cap: readOnly.id, lcid, rid: requestId }),
    );
  }

  function invoke(
    baseUrl: string,
    token: string,
    lcid: string,
    requestId: string,
  ): Promise<CallResult> {
    return call(baseUrl, {
      method: 'POST',
      path,
      token,
      requestId,
      headers: { 'X-KY-Idempotency-Key': lcid },
      body: { input },
    });
  }

  await reporter.check('串行重放同一枚 agent SAT → 第二次 401 token_replayed', async () => {
    const requestId = newRequestId('jti-serial');
    const lcid = `lc_${requestId}`;
    const token = await agentToken(lcid, requestId);
    const first = await invoke(ctx.baseUrl, token, lcid, requestId);
    expectStatus(first, 200, '首次调用');
    const second = await invoke(ctx.baseUrl, token, lcid, requestId);
    expectStatus(second, 401, '重放同一枚 SAT');
    expectErrorCode(second, 'token_replayed', '重放同一枚 SAT');
  });

  await reporter.check('并发 10 次同一枚 agent SAT → 恰 1 次成功', async () => {
    const requestId = newRequestId('jti-race');
    const lcid = `lc_${requestId}`;
    const token = await agentToken(lcid, requestId);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => invoke(ctx.baseUrl, token, lcid, requestId)),
    );
    const ok = results.filter((item) => item.status === 200).length;
    const replayed = results.filter((item) => item.errorCode === 'token_replayed').length;
    assert(
      ok === 1,
      `期望恰 1 次 200，实际 ${String(ok)} 次（状态：${results.map((r) => r.status).join(',')}）`,
    );
    assert(replayed === 9, `期望 9 次 token_replayed，实际 ${String(replayed)} 次`);
  });

  await reporter.check('双进程同时消费同一枚 agent SAT → 恰 1 次成功', async () => {
    const second = ctx.secondApp;
    assert(second !== null, '没有启动第二个被测进程，无法验证跨进程原子性');
    const requestId = newRequestId('jti-dual');
    const lcid = `lc_${requestId}`;
    const token = await agentToken(lcid, requestId);
    const results = await Promise.all([
      invoke(ctx.baseUrl, token, lcid, requestId),
      invoke(second.baseUrl, token, lcid, requestId),
      invoke(ctx.baseUrl, token, lcid, requestId),
      invoke(second.baseUrl, token, lcid, requestId),
    ]);
    const ok = results.filter((item) => item.status === 200).length;
    assert(
      ok === 1,
      `两个进程各打两次，期望全局恰 1 次 200，实际 ${String(ok)} 次（状态：${results.map((r) => r.status).join(',')}）`,
    );
  });

  await reporter.check('存储重启后仍拒绝已消费的 jti', async () => {
    const requestId = newRequestId('jti-restart');
    const lcid = `lc_${requestId}`;
    const token = await agentToken(lcid, requestId);
    expectStatus(await invoke(ctx.baseUrl, token, lcid, requestId), 200, '重启前首次调用');
    await ctx.restartApp();
    const after = await invoke(ctx.baseUrl, token, lcid, requestId);
    expectStatus(after, 401, '重启后重放');
    expectErrorCode(after, 'token_replayed', '重启后重放');
  });

  await reporter.check('act=user 同一枚令牌连续 50 次 → 全部 200', async () => {
    const token = await ctx.signUser({ sub: users.member.sub, tadm: false });
    const statuses: number[] = [];
    for (let index = 0; index < 50; index += 1) {
      const result = await ctx.call({ path: '/ky/v1/me', token });
      statuses.push(result.status);
    }
    const bad = statuses.filter((status) => status !== 200);
    assert(
      bad.length === 0,
      `有 ${String(bad.length)} 次不是 200（首个异常状态 ${String(bad[0])}）`,
    );
  });
}
