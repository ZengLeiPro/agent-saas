import { assert, expectStatus } from '../harness/http.js';
import { looksLikeTestDatabase } from '../harness/pg.js';
import type { DoctorContext } from './context.js';

/** 测试钩子只能清理本次逻辑调用，并必须返回数据库回读结果。 */
export async function cleanupTestExecutions(
  ctx: DoctorContext,
  capabilityId: string,
  sub: string,
  lcids: string[],
): Promise<void> {
  assert(
    ctx.env.KY_ENV === 'test' && looksLikeTestDatabase(ctx.env.DATABASE_URL),
    '测试清理钩子只允许独立测试环境',
  );
  const result = await ctx.testHook('provision', {
    cleanupExecutions: { capabilityId, sub, lcids },
  });
  expectStatus(result, 200, '测试清理钩子');
  const envelope = result.json as {
    ok?: boolean;
    result?: { cleanupConfirmed?: boolean; remaining?: number };
  };
  const summary = envelope.result;
  assert(
    envelope.ok === true && summary?.cleanupConfirmed === true && summary.remaining === 0,
    '测试清理必须明确确认且回读无剩余记录',
  );
}
