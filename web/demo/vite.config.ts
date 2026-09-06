/**
 * 演示态构建配置（目视验收用，不进生产构建）。
 *
 * 与 `web/vite.config.ts` 的唯一差别：入口换成 `demo/index.html`，
 * 并把两个「壳外部依赖」换成桩 —— 平台 API（`authFetch`）与登录态（`AuthContext`）。
 * 被验收的组件本身一行都不换。
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import { fileURLToPath } from 'node:url';

import baseTailwind from '../tailwind.config';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // 深链 `/apps/<iid>/<path>` 要能直接刷新，资源路径必须是绝对的
  base: '/',
  plugins: [react()],
  resolve: {
    alias: [
      // 桩必须排在 `@` 前面：alias 按顺序匹配
      {
        find: /^@\/lib\/authFetch$/,
        replacement: fileURLToPath(new URL('./stubs/authFetch.ts', import.meta.url)),
      },
      {
        find: /^@\/contexts\/AuthContext$/,
        replacement: fileURLToPath(new URL('./stubs/AuthContext.tsx', import.meta.url)),
      },
      {
        // 壳组件链上有人间接引到 `lib/swUpdate`（PWA 更新条），演示态不需要真的 SW
        find: 'virtual:pwa-register',
        replacement: fileURLToPath(new URL('../src/test/pwaRegisterMock.ts', import.meta.url)),
      },
      { find: '@', replacement: fileURLToPath(new URL('../src', import.meta.url)) },
      {
        find: '@agent/shared',
        replacement: fileURLToPath(new URL('../../shared/src/index.ts', import.meta.url)),
      },
      {
        find: '@kaiyan/ky-app-contract/browser',
        replacement: fileURLToPath(
          new URL('../../packages/ky-app-contract/src/browser.ts', import.meta.url),
        ),
      },
    ],
  },
  css: {
    // vite root 换成了 demo/，postcss 的 tailwind 配置发现会落空（`border-border` 找不到）。
    // 这里显式复用 web 的 tailwind 主题，只把 content 换成绝对路径并补上 demo 自己的文件。
    postcss: {
      plugins: [
        tailwindcss({
          ...baseTailwind,
          content: [
            fileURLToPath(new URL('./index.html', import.meta.url)),
            fileURLToPath(new URL('./main.tsx', import.meta.url)),
            fileURLToPath(new URL('../src/**/*.{ts,tsx}', import.meta.url)),
          ],
        }),
        autoprefixer(),
      ],
    },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        // 壳与 mock 子端各是一个入口；截图脚本把它们挂在两个不同 host 上，形成真跨源
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        mockApp: fileURLToPath(new URL('./mock-app.html', import.meta.url)),
      },
    },
  },
});
