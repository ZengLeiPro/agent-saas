/**
 * §9.3-6：每个 `external_write` 能力的幂等、状态机、确认绑定与夹具清理。
 *
 * 写能力只在 `KY_ENV=test` 且数据库是测试库时执行（本章开头先自检这两条）。
 */
import { randomBytes } from 'node:crypto';

import { assert, expectErrorCode, expectStatus } from '../harness/http.js';
import { looksLikeTestDatabase } from '../harness/pg.js';
import { fixtureUsers, setCapabilityDelay } from './fixtures.js';
import type { DoctorContext } from './context.js';

function newLcid(): string {
  return `lc_${randomBytes(8).toString('hex')}`;
}

export async function chapter06(ctx: DoctorContext): Promise<void> {
  const reporter = ctx.reporter;
  reporter.section(6);

  const capabilities = ctx.capabilitiesOf('external_write');
  if (capabilities.length === 0) {
    reporter.record(
      '至少一个 external_write 能力',
      'fail',
      'manifest 没有声明 external_write 能力',
    );
    return;
  }
  const users = fixtureUsers(ctx);

  await reporter.check('写能力测试的前置：KY_ENV=test 且数据库是测试库', async () => {
    const probe = await ctx.testHook('clock', { offsetMs: 0 });
    expectStatus(probe, 200, '/ky/v1/test/clock 可达（证明 KY_ENV=test）');
    assert(
      looksLikeTestDatabase(ctx.env.DATABASE_URL),
      `DATABASE_URL 的库名不像测试库：${ctx.env.DATABASE_URL.replace(/:[^:@]*@/u, ':***@')}`,
    );
  });

  for (const capability of capabilities) {
    const fixture = ctx.conformance.capabilities[capability.id];
    if (fixture === undefined) {
      reporter.record(`${capability.id} 的夹具`, 'fail', '附录 J 夹具里没有这个能力');
      continue;
    }
    const input = fixture.validInputs[0].input;
    const otherInput = fixture.validInputs[1]?.input ?? { ...input, __doctorVariant: 1 };
    const cleanupTargets: string[] = [];

    const invoke = async (options: Parameters<DoctorContext['invokeCapability']>[0]) =>
      ctx.invokeCapability({ sub: users.member.sub, ...options });

    await reporter.check(`${capability.id} 缺 X-KY-Idempotency-Key → 400`, async () => {
      const result = await invoke({
        capabilityId: capability.id,
        input,
        lcid: newLcid(),
        idempotencyKey: null,
      });
      expectStatus(result, 400, '缺幂等键');
      expectErrorCode(result, 'invalid_input', '缺幂等键');
    });

    await reporter.check(`${capability.id} 幂等键 ≠ lcid → 400`, async () => {
      const result = await invoke({
        capabilityId: capability.id,
        input,
        lcid: newLcid(),
        idempotencyKey: 'lc_not_matching',
      });
      expectStatus(result, 400, '幂等键与 lcid 不等');
    });

    await reporter.check(`${capability.id} 无 apr/aph → 403 approval_required`, async () => {
      const result = await invoke({
        capabilityId: capability.id,
        input,
        lcid: newLcid(),
        approval: false,
      });
      expectStatus(result, 403, '缺确认绑定');
      expectErrorCode(result, 'approval_required', '缺确认绑定');
    });

    await reporter.check(`${capability.id} 错误 aph → 403 approval_required`, async () => {
      const result = await invoke({
        capabilityId: capability.id,
        input,
        lcid: newLcid(),
        aphOverride: 'a'.repeat(64),
      });
      expectStatus(result, 403, '错误 aph');
      expectErrorCode(result, 'approval_required', '错误 aph');
    });

    await reporter.check(`${capability.id} 跨能力复用确认（cap 与 URL 不符）→ 403`, async () => {
      const result = await ctx.callAsAgent(
        {
          method: 'POST',
          path: `/ky/v1/capabilities/${encodeURIComponent(capability.id)}`,
          body: { input },
          headers: { 'X-KY-Idempotency-Key': 'lc_cross_cap' },
        },
        {
          sub: users.member.sub,
          cap: `${capability.id}.other`,
          lcid: 'lc_cross_cap',
          apr: 'apv_cross',
          aph: ctx.aph(capability.id, input),
        },
      );
      expectStatus(result, 403, '跨能力复用确认');
    });

    await reporter.check(`${capability.id} 过期的 agent SAT → 401/403`, async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const result = await invoke({
        capabilityId: capability.id,
        input,
        lcid: newLcid(),
        claimOverrides: { iat: nowSeconds - 600, nbf: nowSeconds - 600, exp: nowSeconds - 300 },
      });
      expectStatus(result, [401, 403], '过期 SAT 调用写能力');
    });

    await reporter.check(`${capability.id} executions/{lcid} 未开始 → not_started`, async () => {
      const lcid = newLcid();
      const result = await ctx.callAsAgent(
        { path: `/ky/v1/capabilities/${encodeURIComponent(capability.id)}/executions/${lcid}` },
        { sub: users.member.sub, cap: capability.id, lcid },
      );
      expectStatus(result, 200, '查询未开始的执行记录');
      assert(
        (result.json as { status?: string }).status === 'not_started',
        `期望 not_started，实际 ${JSON.stringify(result.json)}`,
      );
    });

    // 主链路：同 lcid 同输入两次同结果 → 不同输入 409 → executions 状态机 → 重启后仍同结果。
    const mainLcid = newLcid();
    let firstResult = '';
    await reporter.check(`${capability.id} 同 lcid 同输入两次 → 同结果`, async () => {
      const first = await invoke({ capabilityId: capability.id, input, lcid: mainLcid });
      expectStatus(first, 200, '首次写入');
      const second = await invoke({ capabilityId: capability.id, input, lcid: mainLcid });
      expectStatus(second, 200, '同 lcid 同输入重放');
      firstResult = JSON.stringify((first.json as { data?: unknown }).data);
      assert(
        firstResult === JSON.stringify((second.json as { data?: unknown }).data),
        `两次结果不同：${firstResult} vs ${JSON.stringify((second.json as { data?: unknown }).data)}`,
      );
      cleanupTargets.push(mainLcid);
    });

    await reporter.check(
      `${capability.id} 同 lcid 不同输入 → 409 idempotency_mismatch`,
      async () => {
        const result = await invoke({
          capabilityId: capability.id,
          input: otherInput,
          lcid: mainLcid,
        });
        expectStatus(result, 409, '同 lcid 不同输入');
        expectErrorCode(result, 'idempotency_mismatch', '同 lcid 不同输入');
      },
    );

    await reporter.check(`${capability.id} executions/{lcid} 已完成 → done`, async () => {
      const result = await ctx.callAsAgent(
        { path: `/ky/v1/capabilities/${encodeURIComponent(capability.id)}/executions/${mainLcid}` },
        { sub: users.member.sub, cap: capability.id, lcid: mainLcid },
      );
      expectStatus(result, 200, '查询已完成的执行记录');
      assert(
        (result.json as { status?: string }).status === 'done',
        `期望 done，实际 ${JSON.stringify(result.json)}`,
      );
    });

    await reporter.check(`${capability.id} executions/{lcid} 跨用户 → 404`, async () => {
      const result = await ctx.callAsAgent(
        { path: `/ky/v1/capabilities/${encodeURIComponent(capability.id)}/executions/${mainLcid}` },
        { sub: users.norole.sub, cap: capability.id, lcid: mainLcid },
      );
      expectStatus(result, 404, '跨用户查询执行记录');
    });

    await reporter.check(`${capability.id} in_progress 并发 → 409 in_progress`, async () => {
      await setCapabilityDelay(ctx, 1200);
      try {
        const lcid = newLcid();
        const [first, second] = await Promise.all([
          invoke({ capabilityId: capability.id, input, lcid }),
          new Promise((resolve) => setTimeout(resolve, 150)).then(async () =>
            invoke({ capabilityId: capability.id, input, lcid }),
          ),
        ]);
        const statuses = [first.status, second.status].sort((a, b) => a - b);
        assert(
          statuses[0] === 200 && statuses[1] === 409,
          `期望一条 200 一条 409，实际 ${statuses.join('/')}`,
        );
        const conflict = first.status === 409 ? first : second;
        expectErrorCode(conflict, 'in_progress', '并发同 lcid');
        cleanupTargets.push(lcid);
      } finally {
        await setCapabilityDelay(ctx, 0);
      }
    });

    await reporter.check(`${capability.id} 存储重启后同 lcid 同输入 → 同结果`, async () => {
      await ctx.restartApp();
      const result = await invoke({ capabilityId: capability.id, input, lcid: mainLcid });
      expectStatus(result, 200, '重启后重放');
      assert(
        JSON.stringify((result.json as { data?: unknown }).data) === firstResult,
        '重启后同 lcid 同输入的结果与首次不同',
      );
    });

    const cleanup = fixture.cleanup;
    await reporter.check(`${capability.id} 夹具清理（cleanup 失败即测试失败）`, async () => {
      assert(cleanup !== undefined, '写能力夹具必须声明 cleanup');
      const result = await ctx.invokeCapability({
        capabilityId: cleanup.capabilityId,
        input: cleanup.input,
        sub: users.member.sub,
        lcid: newLcid(),
      });
      expectStatus(result, 200, `清理能力 ${cleanup.capabilityId}`);
    });
  }
}
