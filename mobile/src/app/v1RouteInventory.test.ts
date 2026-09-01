/**
 * M00-01：路由可达性/完整性清单测试。
 *
 * 扫描 mobile/app 目录推导全部 expo-router 路由 pattern，断言：
 *   1. 每个真实存在的路由都被能力清单分类（allowed 或 deferred），
 *      新增路由未登记清单时测试失败（防止未分类路由混入生产）；
 *   2. 清单中没有指向不存在路由的条目（防止清单腐烂）；
 *   3. Spike 与旧 workspace HTML preview 路由已从代码库删除；
 *   4. Mobile WebView 不执行 workspace HTML，生产 allowlist 无占位。
 *
 * 路由 pattern 推导与 expo-router useSegments() 约定一致：
 * 相对 app/ 的路径去掉 .tsx、去掉尾部 /index，动态段保留 [name]。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  V1_ALLOWED_ROUTES,
  V1_DEFERRED_ROUTES,
  classifyV1Route,
} from './v1Capabilities';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(HERE, '..', '..', 'app');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith('.tsx') || entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** app 文件路径 -> 路由 pattern（与 useSegments 一致）。 */
function fileToRoutePattern(appDir: string, file: string): string | null {
  const rel = relative(appDir, file);
  const withoutExt = rel.replace(/\.(tsx|ts)$/, '');
  if (withoutExt.endsWith('/_layout') || withoutExt === '_layout') return null;
  let pattern = withoutExt.split(/[\\/]/).join('/');
  if (pattern === 'index') return '';
  if (pattern.endsWith('/index')) pattern = pattern.slice(0, -'/index'.length);
  return pattern;
}

function discoverRoutes(): string[] {
  return walk(APP_DIR)
    .map((file) => fileToRoutePattern(APP_DIR, file))
    .filter((pattern): pattern is string => pattern !== null)
    .sort();
}

describe('M00-01 路由清单完整性', () => {
  const routes = discoverRoutes();

  it('能够发现路由（防止扫描路径失效导致空跑）', () => {
    expect(routes.length).toBeGreaterThan(10);
    expect(routes).toContain('login');
    expect(routes).toContain('(tabs)/chat');
  });

  it('每个真实路由都已分类：未分类路由一律 fail closed，不得混入', () => {
    const unclassified = routes.filter(
      (route) => classifyV1Route(route) === 'unclassified',
    );
    expect(
      unclassified,
      `以下路由未登记到 V1 能力清单：\n${unclassified.join('\n')}`,
    ).toEqual([]);
  });

  it('清单条目全部对应真实路由（无腐烂条目）', () => {
    const routeSet = new Set(routes);
    const stale = [...V1_ALLOWED_ROUTES, ...Object.keys(V1_DEFERRED_ROUTES)].filter(
      (route) => !routeSet.has(route),
    );
    expect(stale, `清单中存在不存在的路由：\n${stale.join('\n')}`).toEqual([]);
  });

  it('已关闭的 WebView/HTML preview 路由不在 Mobile route manifest', () => {
    expect(routes).not.toContain('webview-spike');
    expect(routes).not.toContain('chat/html-preview');
    expect(existsSync(join(APP_DIR, 'webview-spike.tsx'))).toBe(false);
    expect(existsSync(join(APP_DIR, 'chat/html-preview.tsx'))).toBe(false);
    expect(existsSync(join(APP_DIR, '../src/services/previewTokenCache.ts'))).toBe(false);
  });

  it('Mobile WebView 代码不执行 workspace HTML 或 preview URL', () => {
    const srcDir = join(APP_DIR, '..', 'src');
    const thisTest = fileURLToPath(import.meta.url);
    const webViewSources = [...walk(APP_DIR), ...walk(srcDir)]
      .filter((file) => file !== thisTest)
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return source.includes('react-native-webview') || source.includes('<WebView');
      });
    expect(webViewSources.map((file) => relative(join(APP_DIR, '..'), file))).toEqual([
      'src/components/chat/TextSelectModal.tsx',
    ]);
    // The remaining local text-selection WebView must not consume file paths or remote preview URLs.
    const remaining = readFileSync(webViewSources[0], 'utf8');
    expect(remaining).not.toMatch(/filePath|preview-token|\/preview\/|authFetch|source=\{\{\s*uri/);
  });

  it('生产 allowlist 路由源码中无「正在开发中」占位文案', () => {
    const offenders: string[] = [];
    for (const route of V1_ALLOWED_ROUTES) {
      const candidates =
        route === ''
          ? ['index.tsx']
          : [`${route}.tsx`, join(route, 'index.tsx')];
      for (const rel of candidates) {
        const file = join(APP_DIR, rel);
        if (!existsSync(file)) continue;
        if (readFileSync(file, 'utf8').includes('正在开发中')) {
          offenders.push(rel);
        }
      }
    }
    expect(offenders, `生产可见路由含占位文案：${offenders.join(', ')}`).toEqual([]);
  });
});
