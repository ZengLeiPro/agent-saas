import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// 走兄弟包 src/ 而不是 dist/ 或 injectWorkspacePackages 复制出来的注入副本，避免过期解析。
export default defineConfig({
  resolve: {
    alias: {
      '@kaiyan/ky-app-contract': fileURLToPath(
        new URL('../ky-app-contract/src/index.ts', import.meta.url),
      ),
      // 子路径入口必须排在裸包名前面，否则 '@kaiyan/ky-app-server/hono' 会被拼成 src/index.ts/hono。
      '@kaiyan/ky-app-server/hono': fileURLToPath(
        new URL('../ky-app-server/src/hono/index.ts', import.meta.url),
      ),
      '@kaiyan/ky-app-contract/browser': fileURLToPath(
        new URL('../ky-app-contract/src/browser.ts', import.meta.url),
      ),
      '@kaiyan/ky-app-server': fileURLToPath(
        new URL('../ky-app-server/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
