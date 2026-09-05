/**
 * §9.3-5：每个 `read_only` 能力 —— 夹具 → 200 / 合 `outputSchema` / ≤ 6,000 字节 / 含 `hasMore`；
 * 非法输入 → 400；`dig` 错误 → 409。
 */
import { CAPABILITY_RESPONSE_MAX_BYTES } from '@kaiyan/ky-app-contract';
import { validateAgainstCapabilitySchema } from '@kaiyan/ky-app-server';

import { assert, expectErrorCode, expectStatus } from '../harness/http.js';
import { fixtureUsers } from './fixtures.js';
import type { DoctorContext } from './context.js';

export async function chapter05(ctx: DoctorContext): Promise<void> {
  const reporter = ctx.reporter;
  reporter.section(5);

  const capabilities = ctx.capabilitiesOf('read_only');
  if (capabilities.length === 0) {
    reporter.record('至少一个 read_only 能力', 'fail', 'manifest 没有声明 read_only 能力');
    return;
  }
  const users = fixtureUsers(ctx);

  for (const capability of capabilities) {
    const fixture = ctx.conformance.capabilities[capability.id];
    if (fixture === undefined) {
      reporter.record(`${capability.id} 的夹具`, 'fail', '附录 J 夹具里没有这个能力');
      continue;
    }

    for (const [index, sample] of fixture.validInputs.entries()) {
      await reporter.check(
        `${capability.id} 合法输入 #${String(index + 1)} → 200 / 合 outputSchema / ≤ ${String(CAPABILITY_RESPONSE_MAX_BYTES)} 字节`,
        async () => {
          const result = await ctx.invokeCapability({
            capabilityId: capability.id,
            input: sample.input,
            sub: users.member.sub,
          });
          expectStatus(result, 200, `调用 ${capability.id}`);
          const bytes = Buffer.byteLength(result.text, 'utf8');
          assert(
            bytes <= CAPABILITY_RESPONSE_MAX_BYTES,
            `响应体 ${String(bytes)} 字节，超过 ${String(CAPABILITY_RESPONSE_MAX_BYTES)}`,
          );
          const data = (result.json as { data?: unknown }).data;
          const check = validateAgainstCapabilitySchema(capability.outputSchema, data, 'data');
          assert(check.ok, `返回值不合 outputSchema：${check.errors.join('；')}`);

          const declaresHasMore =
            typeof capability.outputSchema === 'object' &&
            capability.outputSchema !== null &&
            'properties' in capability.outputSchema &&
            Object.prototype.hasOwnProperty.call(
              (capability.outputSchema as { properties: Record<string, unknown> }).properties,
              'hasMore',
            );
          if (declaresHasMore) {
            assert(
              typeof (data as { hasMore?: unknown }).hasMore === 'boolean',
              'outputSchema 声明了 hasMore，但返回值里没有',
            );
          }
          for (const [key, expected] of Object.entries(sample.expect ?? {})) {
            assert(
              JSON.stringify((data as Record<string, unknown>)[key]) === JSON.stringify(expected),
              `夹具期望 ${key}=${JSON.stringify(expected)}，实际 ${JSON.stringify((data as Record<string, unknown>)[key])}`,
            );
          }
        },
      );
    }

    for (const [index, sample] of (fixture.invalidInputs ?? []).entries()) {
      await reporter.check(
        `${capability.id} 非法输入 #${String(index + 1)} → ${sample.expectCode}`,
        async () => {
          const result = await ctx.invokeCapability({
            capabilityId: capability.id,
            input: sample.input,
            sub: users.member.sub,
          });
          expectErrorCode(result, sample.expectCode, `非法输入调用 ${capability.id}`);
        },
      );
    }
    if ((fixture.invalidInputs ?? []).length === 0) {
      reporter.record(`${capability.id} 声明了 invalidInputs`, 'fail', '夹具缺少非法输入用例');
    }

    await reporter.check(`${capability.id} 的 SAT 带错误 dig → 409 digest_mismatch`, async () => {
      const result = await ctx.invokeCapability({
        capabilityId: capability.id,
        input: fixture.validInputs[0].input,
        sub: users.member.sub,
        claimOverrides: { dig: 'f'.repeat(64) },
      });
      expectStatus(result, 409, `${capability.id} + 错误 dig`);
      expectErrorCode(result, 'digest_mismatch', `${capability.id} + 错误 dig`);
    });
  }
}
