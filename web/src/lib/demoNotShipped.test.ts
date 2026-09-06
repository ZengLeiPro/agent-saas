/**
 * 演示态 `web/demo/` 留在仓库里，但**绝不能进生产构建**（总控裁决：保留它作为
 * Phase C 的 E2E 对端）。
 *
 * 三道锁，这里全部钉死：
 * 1. **入口图**：`web/vite.config.ts` 不引用 `demo/`，生产入口只有 `web/index.html`；
 *    演示态自带 `web/demo/vite.config.ts`，是另一次独立的 `vite build`。
 * 2. **类型与测试**：`web/tsconfig.json` 与 `web/vitest.config.ts` 都只 include `src`，
 *    所以 demo 既不参与 typecheck 也不参与测试（它引的桩会污染两者）。
 * 3. **构建产物**：`scripts/check-oss-dist.mjs` 断言产物里搜不到演示态桩标记、
 *    也没有 `mock-app.html` / `demo/`。
 *
 * 推论：**startup 预算不受演示态影响** —— `check-web-startup-budget` 量的是
 * `web/dist` 的产物，而 demo 从不进这份产物。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import viteConfig from '../../vite.config.ts?raw';
import vitestConfig from '../../vitest.config.ts?raw';
import tsconfig from '../../tsconfig.json?raw';
import ossDistScript from '../../scripts/check-oss-dist.mjs?raw';
import demoStub from '../../demo/stubs/authFetch.ts?raw';

/** 与 `check-oss-dist.mjs`、`demo/stubs/authFetch.ts` 三处必须完全一致。 */
const DEMO_STUB_MARKER = 'ky-app-demo-stub-do-not-ship';

describe('web/demo 不进生产构建', () => {
  it('生产 vite 配置完全不提 demo（入口仍只有 web/index.html）', () => {
    expect(viteConfig).not.toContain('demo');
  });

  it('typecheck 与测试都只 include src', () => {
    expect(JSON.parse(tsconfig).include).toEqual(['src']);
    expect(vitestConfig).toContain('include: ["src/**/*.{test,spec}.{ts,tsx}"]');
    expect(vitestConfig).not.toContain('demo');
  });

  it('标记串三处一致，dist 断言真的在查它', () => {
    expect(demoStub).toContain(DEMO_STUB_MARKER);
    expect(ossDistScript).toContain(DEMO_STUB_MARKER);
    // 目录与 mock 子端页面也一并拦
    expect(ossDistScript).toContain('mock-app.html');
    expect(ossDistScript).toContain('web/demo 不得进生产构建');
  });

  // 直接读盘而不是 `import.meta.glob('?raw')`：后者会把上千个源文件逐个过一遍 vite 的
  // transform 管线，全量套件并发时轻松超过 5 s 的默认超时。
  it('生产源码里没有人写过这个标记串（否则 dist 断言会假红）', () => {
    // vitest 里 `import.meta.url` 是 http:// 形式，取不到磁盘路径；
    // web 套件的 cwd 恒为 `web/`，从它出发。
    const srcDir = resolve(process.cwd(), 'src');
    const files = readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
      .filter((name) => /\.tsx?$/u.test(name) && !name.endsWith('demoNotShipped.test.ts'));
    expect(files.length).toBeGreaterThan(100);
    for (const name of files) {
      expect(readFileSync(`${srcDir}/${name}`, 'utf8'), name).not.toContain(DEMO_STUB_MARKER);
    }
  });
});
