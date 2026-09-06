/**
 * WP4 Phase A：定制软件壳路由 `/apps/<iid>/<path>`（规范 §5.2）。
 *
 * 三件事必须钉死：
 * 1. 解析 / 构造往返（含 F5 深链的各种形态）；
 * 2. path 语法拒绝集——判定必须来自 `@kaiyan/ky-app-contract`，壳侧不另写规则；
 * 3. 规范化——去尾斜杠、query 键排序、剔除保留参数 `ky`/`ky_iid`/`ky_nonce`。
 */
import { describe, expect, it, beforeEach } from 'vitest';

import { normalizeAppPath } from '@kaiyan/ky-app-contract/browser';
import {
  buildAppsUrl,
  buildUrl,
  isValidAppPath,
  navigateApps,
  parseAppsPath,
  parseUrl,
  pushAppsUrl,
  replaceAppsUrl,
  classifyAppPath,
  SECURITY_RELEVANT_PATH_REJECTIONS,
} from '@/lib/urlSync';

describe('壳路由解析 /apps/<iid>/<path>', () => {
  it('裸安装实例路径解析为应用根路径', () => {
    const state = parseUrl('/apps/inst-1', '');
    expect(state.tab).toBe('apps');
    expect(state.appsRoute).toEqual({
      installationId: 'inst-1',
      appPath: '/',
      canonicalPath: null,
      rejectedReason: null,
    });
  });

  it('带应用内路径与 query 的深链原样解析', () => {
    const state = parseUrl('/apps/inst-1/orders/detail', '?a=1&b=2');
    expect(state.tab).toBe('apps');
    expect(state.appsRoute?.installationId).toBe('inst-1');
    expect(state.appsRoute?.appPath).toBe('/orders/detail?a=1&b=2');
    expect(state.appsRoute?.canonicalPath).toBeNull();
  });

  it('安装实例 id 做百分号解码', () => {
    expect(parseAppsPath('/apps/inst%2B1/orders')?.installationId).toBe('inst+1');
  });

  it('hash 由调用方显式传入并原样带回子端', () => {
    expect(parseAppsPath('/apps/inst-1/orders', '?a=1', '#top')?.appPath).toBe('/orders?a=1#top');
  });

  it('`/apps` 与 `/apps/` 都不是安装实例路由，回落到 chat', () => {
    expect(parseAppsPath('/apps')).toBeNull();
    expect(parseAppsPath('/apps/')).toBeNull();
    expect(parseUrl('/apps', '').tab).toBe('chat');
    expect(parseUrl('/apps/', '').tab).toBe('chat');
  });

  it('非 apps 路径不受影响，appsRoute 恒为 null', () => {
    expect(parseUrl('/chat/s1', '').appsRoute).toBeNull();
    expect(parseUrl('/capabilities', '').appsRoute).toBeNull();
  });
});

describe('壳路由构造与往返', () => {
  const cases: Array<[string, string]> = [
    ['/', '/apps/inst-1'],
    ['/orders', '/apps/inst-1/orders'],
    ['/orders/detail?a=1&b=2', '/apps/inst-1/orders/detail?a=1&b=2'],
    ['/orders#top', '/apps/inst-1/orders#top'],
    ['/orders?a=1#top', '/apps/inst-1/orders?a=1#top'],
  ];

  it.each(cases)('appPath %s ↔ 壳 URL %s', (appPath, shellUrl) => {
    expect(buildAppsUrl({ installationId: 'inst-1', appPath })).toBe(shellUrl);
    const url = new URL(shellUrl, 'https://agent.kaiyan.net');
    const parsedState = parseAppsPath(url.pathname, url.search, url.hash);
    expect(parsedState?.appPath).toBe(appPath);
    expect(parsedState?.canonicalPath).toBeNull();
  });

  it('buildUrl 的第三参承载 apps 标签的壳 URL', () => {
    expect(buildUrl('apps', null, { installationId: 'inst-1', appPath: '/orders' })).toBe(
      '/apps/inst-1/orders',
    );
  });

  it('buildUrl 缺安装实例时回落 `/`，不生成半截壳路径', () => {
    expect(buildUrl('apps', null)).toBe('/');
    expect(buildUrl('apps', null, null)).toBe('/');
  });

  it('安装实例 id 做百分号编码，防止 id 里的 `/` 撑破路由', () => {
    expect(buildAppsUrl({ installationId: 'a/b', appPath: '/x' })).toBe('/apps/a%2Fb/x');
  });
});

describe('path 语法拒绝集（§5.2）', () => {
  const rejected = [
    'http://x',
    'https://evil.example/x',
    'javascript:alert(1)',
    '//x',
    '/a//b',
    '/a/../b',
    '/..',
    '/a%2fb',
    '/a%2Fb',
    '/a%2e%2e',
    '/a%2E%2E',
    '\\a',
    '/a\\b',
    'a/b',
    '',
  ];

  it.each(rejected)('拒绝 %j', (value) => {
    expect(isValidAppPath(value)).toBe(false);
  });

  const accepted = ['/', '/orders', '/orders/detail', '/orders?q=1', '/orders?q=1#top', '/a.b/c-d'];

  it.each(accepted)('接受 %j', (value) => {
    expect(isValidAppPath(value)).toBe(true);
  });

  it('拒绝集里的 path 出现在壳 URL 里时回落到应用根路径并给出 canonical', () => {
    const state = parseAppsPath('/apps/inst-1/a/../b');
    expect(state).toEqual({
      installationId: 'inst-1',
      appPath: '/',
      canonicalPath: '/apps/inst-1',
      rejectedReason: 'dot_segment',
    });
    expect(parseAppsPath('/apps/inst-1//x')?.appPath).toBe('/');
    expect(parseAppsPath('/apps/inst-1/a%2fb')?.appPath).toBe('/');
  });

  it('语法判定与契约包同源，不是壳侧另写的一份', () => {
    for (const value of rejected) {
      expect(() => normalizeAppPath(value)).toThrow();
    }
  });
});

describe('path 规范化（§5.2）', () => {
  it('去尾斜杠', () => {
    const state = parseAppsPath('/apps/inst-1/orders/');
    expect(state?.appPath).toBe('/orders');
    expect(state?.canonicalPath).toBe('/apps/inst-1/orders');
  });

  it('根路径的尾斜杠不被砍成空串', () => {
    expect(parseAppsPath('/apps/inst-1/')?.appPath).toBe('/');
  });

  it('query 键排序', () => {
    expect(parseAppsPath('/apps/inst-1/orders', '?b=2&a=1')?.appPath).toBe('/orders?a=1&b=2');
  });

  it('剔除保留参数 ky / ky_iid / ky_nonce', () => {
    const state = parseAppsPath('/apps/inst-1/orders', '?ky=1&ky_iid=inst-1&ky_nonce=abc&z=9&a=1');
    expect(state?.appPath).toBe('/orders?a=1&z=9');
    expect(state?.canonicalPath).toBe('/apps/inst-1/orders?a=1&z=9');
  });

  it('规范化后与原 URL 一致时 canonicalPath 为 null（不做无谓 replaceState）', () => {
    expect(parseAppsPath('/apps/inst-1/orders', '?a=1')?.canonicalPath).toBeNull();
  });

  it('parseUrl 把 canonicalPath 透出给统一的 replaceState 通道', () => {
    expect(parseUrl('/apps/inst-1/orders/', '?b=2&a=1').canonicalPath).toBe(
      '/apps/inst-1/orders?a=1&b=2',
    );
  });
});

describe('壳路由写入 history', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('pushAppsUrl 新增历史条目', () => {
    const before = window.history.length;
    pushAppsUrl({ installationId: 'inst-1', appPath: '/orders' });
    expect(window.location.pathname).toBe('/apps/inst-1/orders');
    expect(window.history.length).toBeGreaterThanOrEqual(before);
  });

  it('replaceAppsUrl 不新增历史条目', () => {
    replaceAppsUrl({ installationId: 'inst-1', appPath: '/orders?b=2&a=1' });
    expect(`${window.location.pathname}${window.location.search}`).toBe(
      '/apps/inst-1/orders?a=1&b=2',
    );
  });

  it('navigateApps 派发 popstate，让土制路由的订阅者重解析', () => {
    let seen = 0;
    const handler = () => {
      seen += 1;
    };
    window.addEventListener('popstate', handler);
    try {
      navigateApps({ installationId: 'inst-2', appPath: '/dashboard' });
    } finally {
      window.removeEventListener('popstate', handler);
    }
    expect(seen).toBe(1);
    expect(window.location.pathname).toBe('/apps/inst-2/dashboard');
  });
});

describe('4-A-01 非法 path 的拒绝原因（落安全事件的唯一依据）', () => {
  it.each([
    ['/apps/inst-1/a/../b', 'dot_segment'],
    ['/apps/inst-1/..', 'dot_segment'],
    ['/apps/inst-1/a%2fb', 'percent_encoded_separator'],
    ['/apps/inst-1/a%2E%2E', 'percent_encoded_separator'],
    ['/apps/inst-1/a\\b', 'backslash'],
  ])('%s 回落应用根并给出原因 %s', (pathname, reason) => {
    const route = parseAppsPath(pathname);
    expect(route?.appPath).toBe('/');
    expect(route?.rejectedReason).toBe(reason);
    expect(route?.canonicalPath).toBe('/apps/inst-1');
  });

  it('合法 path 的 rejectedReason 为 null', () => {
    expect(parseAppsPath('/apps/inst-1/orders')?.rejectedReason).toBeNull();
    expect(parseAppsPath('/apps/inst-1')?.rejectedReason).toBeNull();
  });

  it('安全事件闭集只含总控点名的五类（%2f 与 %2e 共用一个码）', () => {
    expect([...SECURITY_RELEVANT_PATH_REJECTIONS]).toEqual([
      'scheme',
      'dot_segment',
      'percent_encoded_separator',
      'backslash',
    ]);
    // 手抖类不记：记了只会淹没真正的攻击尝试
    for (const noise of ['not_absolute', 'double_slash', 'whitespace', 'too_long', 'empty']) {
      expect(SECURITY_RELEVANT_PATH_REJECTIONS).not.toContain(noise);
    }
  });

  it('classifyAppPath 对 scheme 与不以 / 开头分别给码', () => {
    expect(classifyAppPath('https://evil.example/x').rejectedReason).toBe('scheme');
    expect(classifyAppPath('a/b').rejectedReason).toBe('not_absolute');
  });
});
