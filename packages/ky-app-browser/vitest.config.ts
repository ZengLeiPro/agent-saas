import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// 走兄弟包 src/ 而不是 dist/ 或 injectWorkspacePackages 复制出来的注入副本，避免过期解析。
export default defineConfig({
  resolve: {
    alias: {
      '@kaiyan/ky-app-contract': fileURLToPath(
        new URL('../ky-app-contract/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'jsdom',
  },
});
