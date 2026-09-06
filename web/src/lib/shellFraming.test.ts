/**
 * 壳站不得被嵌套（规范 §5.1）。
 *
 * 曾磊已定 ESA/CDN 方案跳过 —— Web 是 OSS 直出，`frame-ancestors 'none'` 与
 * `X-Frame-Options: DENY` 两个响应头都设不了。所以内联 frame-busting 是**唯一**防线，
 * 这里连同 `scripts/check-oss-dist.mjs` 的构建产物断言一起钉死：
 * 源码丢了这段 → 本测试红；构建把它优化掉 → dist 断言红。
 */
import { describe, expect, it } from 'vitest';

import indexHtml from '../../index.html?raw';
import ossDistScript from '../../scripts/check-oss-dist.mjs?raw';
import liveOssScript from '../../scripts/check-live-oss.mjs?raw';

describe('壳站 frame-busting（§5.1）', () => {
  it('index.html 在应用代码之前内联 frame-busting', () => {
    expect(indexHtml).toContain('window.top !== window.self');
    expect(indexHtml).toContain('document.documentElement.style.display = "none"');
    expect(indexHtml).toContain('window.top.location.replace(window.self.location.href)');
    // 必须早于 /src/main.tsx：晚一步点击劫持就已经生效了
    expect(indexHtml.indexOf('window.top !== window.self')).toBeLessThan(
      indexHtml.indexOf('src="/src/main.tsx"'),
    );
  });

  it('顶层跳转被拦时也要藏页面（sandbox 无 allow-top-navigation 的场景）', () => {
    const guard = indexHtml.slice(indexHtml.indexOf('window.top !== window.self'));
    // 先隐藏、后跳转：跳转可能抛异常或被静默拦下，隐藏必须无条件先发生
    expect(guard.indexOf('style.display = "none"')).toBeLessThan(
      guard.indexOf('window.top.location.replace'),
    );
    expect(guard).toContain('try {');
  });

  it('check-oss-dist.mjs 静态断言 frame-busting 存在（构建产物不许丢）', () => {
    expect(ossDistScript).toContain('window.top !== window.self');
    expect(ossDistScript).toContain('§5.1 禁止被嵌套');
  });

  it('线上探活脚本不做嵌套相关的响应头断言（OSS 设不了头，加了会永久红）', () => {
    const lowered = liveOssScript.toLowerCase();
    expect(lowered).not.toContain('frame-ancestors');
    expect(lowered).not.toContain('x-frame-options');
    expect(lowered).not.toContain('content-security-policy');
  });
});
