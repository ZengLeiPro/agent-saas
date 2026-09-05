/**
 * §9.3-7：页面 API ↔ 能力一致性。
 *
 * 夹具 `pageApiEquivalence{ method, path, query, idField, capabilityInput }`：
 * 同一个测试用户下，页面接口与能力返回的 `idField` 集合必须相等
 * （§9.2「能力 handler 与页面 API 共用 service 函数」的可执行判据）。
 */
import { assert, expectStatus } from '../harness/http.js';
import { fixtureUsers, provisionUsers } from './fixtures.js';
import type { DoctorContext } from './context.js';

/** 在任意 JSON 里找出第一处「元素带 idField 的对象数组」，返回排序后的 id 列表。 */
export function collectIds(value: unknown, idField: string): string[] | null {
  if (Array.isArray(value)) {
    const ids = value
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => item[idField])
      .filter((id): id is string | number => typeof id === 'string' || typeof id === 'number');
    if (ids.length === value.length) return ids.map(String).sort((a, b) => a.localeCompare(b));
    return null;
  }
  if (typeof value === 'object' && value !== null) {
    for (const nested of Object.values(value)) {
      const found = collectIds(nested, idField);
      if (found !== null) return found;
    }
  }
  return null;
}

function withQuery(path: string, query: Record<string, unknown> | undefined): string {
  if (query === undefined || Object.keys(query).length === 0) return path;
  const url = new URL(path, 'http://placeholder.invalid');
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  return `${url.pathname}${url.search}`;
}

export async function chapter07(ctx: DoctorContext): Promise<void> {
  const reporter = ctx.reporter;
  reporter.section(7);

  const users = fixtureUsers(ctx);
  await provisionUsers(ctx, [{ sub: users.member.sub, roles: users.member.roles }]);

  const pairs = Object.entries(ctx.conformance.capabilities).filter(
    ([, fixture]) => fixture.pageApiEquivalence !== undefined,
  );
  if (pairs.length === 0) {
    reporter.record(
      '至少一组 pageApiEquivalence 夹具',
      'fail',
      '附录 J 夹具里没有声明页面 API 等价关系',
    );
    return;
  }

  for (const [capabilityId, fixture] of pairs) {
    const equivalence = fixture.pageApiEquivalence;
    if (equivalence === undefined) continue;
    await reporter.check(
      `${capabilityId} 与 ${equivalence.method} ${equivalence.path} 的 ${equivalence.idField} 集合相等`,
      async () => {
        const page = await ctx.callAsUser(
          {
            method: equivalence.method,
            path: withQuery(equivalence.path, equivalence.query),
            ...(equivalence.method === 'POST' ? { body: equivalence.query ?? {} } : {}),
          },
          { sub: users.member.sub, tadm: users.member.tadm },
        );
        expectStatus(page, 200, `页面接口 ${equivalence.path}`);
        const pageIds = collectIds(page.json, equivalence.idField);
        assert(pageIds !== null, `页面接口响应里找不到带 ${equivalence.idField} 的数组`);

        const capability = await ctx.invokeCapability({
          capabilityId,
          input: equivalence.capabilityInput,
          sub: users.member.sub,
          tadm: users.member.tadm,
        });
        expectStatus(capability, 200, `能力 ${capabilityId}`);
        const capabilityIds = collectIds(
          (capability.json as { data?: unknown }).data,
          equivalence.idField,
        );
        assert(capabilityIds !== null, `能力返回值里找不到带 ${equivalence.idField} 的数组`);

        assert(
          JSON.stringify(pageIds) === JSON.stringify(capabilityIds),
          `集合不等：页面 ${JSON.stringify(pageIds)}，能力 ${JSON.stringify(capabilityIds)}`,
        );
      },
    );
  }
}
