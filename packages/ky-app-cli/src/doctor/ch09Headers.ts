/**
 * §9.3-9：响应头（对附录 J `endpoints` 逐个 GET，打的是**生产构建产物**）。
 *
 * `frame-ancestors https://agent.kaiyan.net`、无 `X-Frame-Options`、
 * CSP 无 `unsafe-inline` 脚本、兜底关闭时无 `Set-Cookie`。
 */
import { SHELL_ORIGIN } from '@kaiyan/ky-app-server/hono';

import { assert } from '../harness/http.js';
import { fixtureUsers } from './fixtures.js';
import type { DoctorContext } from './context.js';

/** 从 CSP 里取某个指令的取值列表。 */
export function cspDirective(csp: string, directive: string): string[] | null {
  for (const part of csp.split(';')) {
    const tokens = part
      .trim()
      .split(/\s+/u)
      .filter((token) => token !== '');
    if (tokens.length === 0) continue;
    if (tokens[0].toLowerCase() !== directive) continue;
    return tokens.slice(1);
  }
  return null;
}

/** 测试环境允许额外放行本地 mock 壳；除本地地址外不得有别的来源。 */
function extraSourcesAreLocalOnly(sources: string[]): boolean {
  return sources
    .filter((source) => source !== SHELL_ORIGIN)
    .every((source) => /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/u.test(source));
}

export async function chapter09(ctx: DoctorContext): Promise<void> {
  const reporter = ctx.reporter;
  reporter.section(9);

  const users = fixtureUsers(ctx);
  const endpoints = ctx.conformance.endpoints;
  assert(endpoints.length > 0, '夹具没有声明 endpoints');

  for (const endpoint of endpoints) {
    await reporter.check(`GET ${endpoint} 的响应头合 §5.1`, async () => {
      // 业务前缀内的端点要带 user 令牌，其余按公开访问。
      const needsToken = [
        ...ctx.manifest.pathPrefixes.user,
        ...ctx.manifest.pathPrefixes.admin,
      ].some((prefix) => endpoint.startsWith(prefix));
      const isAdmin = ctx.manifest.pathPrefixes.admin.some((prefix) => endpoint.startsWith(prefix));
      const result = needsToken
        ? await ctx.callAsUser(
            { path: endpoint, raw: true },
            isAdmin ? { sub: users.admin.sub, tadm: true } : { sub: users.member.sub, tadm: false },
          )
        : await ctx.call({ path: endpoint, raw: true });

      assert(
        result.status < 400,
        `期望可访问，实际 HTTP ${String(result.status)}（生产构建产物是否已 build？）`,
      );

      const csp = result.headers.get('content-security-policy');
      assert(csp !== null && csp !== '', '缺少 Content-Security-Policy');
      const frameAncestors = cspDirective(csp, 'frame-ancestors');
      assert(frameAncestors !== null, 'CSP 缺少 frame-ancestors');
      assert(
        frameAncestors.includes(SHELL_ORIGIN),
        `frame-ancestors 不含壳站 ${SHELL_ORIGIN}：${frameAncestors.join(' ')}`,
      );
      assert(
        extraSourcesAreLocalOnly(frameAncestors),
        `frame-ancestors 里出现了非本地的额外来源：${frameAncestors.join(' ')}`,
      );

      const scriptSrc = cspDirective(csp, 'script-src') ?? cspDirective(csp, 'default-src') ?? [];
      assert(
        !scriptSrc.includes("'unsafe-inline'") && !scriptSrc.includes("'unsafe-eval'"),
        `script-src 不得含 unsafe-inline / unsafe-eval：${scriptSrc.join(' ')}`,
      );

      assert(
        result.headers.get('x-frame-options') === null,
        '不得设置 X-Frame-Options（壳的跨源 iframe 会被拦掉）',
      );
      assert(result.headers.get('set-cookie') === null, '兜底关闭时不得下发 Set-Cookie');
    });
  }

  await reporter.check('HTML 入口带 HSTS', async () => {
    const html =
      endpoints.find((endpoint) => endpoint === '/' || endpoint.endsWith('.html')) ?? '/';
    const result = await ctx.call({ path: html, raw: true });
    assert(
      (result.headers.get('strict-transport-security') ?? '').includes('max-age='),
      '缺少 Strict-Transport-Security',
    );
  });

  await reporter.check('HTML 入口返回的是生产构建产物（含带指纹的资源引用）', async () => {
    const result = await ctx.call({ path: '/', raw: true });
    assert(result.status === 200, `GET / 返回 ${String(result.status)}`);
    assert(
      /<script[^>]+src="[^"]*assets\/[^"]+\.js"/u.test(result.text),
      'HTML 入口里没有指向 assets/*.js 的外链脚本，看起来不是 vite build 产物',
    );
    assert(
      !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/u.test(result.text),
      "HTML 入口含内联脚本，与 CSP script-src 'self' 冲突",
    );
  });
}
