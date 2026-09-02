import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const coverageReporters =
  process.env.COVERAGE_REPORT_MODE === 'ci'
    ? ['text', 'lcovonly', 'json-summary']
    : ['text', 'lcov', 'json-summary', 'json', 'html'];

export default defineConfig({
  resolve: {
    alias: {
      '@agent/shared/lib/chatSubmission': fileURLToPath(new URL('../shared/src/lib/chatSubmission.ts', import.meta.url)),
      '@agent/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    // 测试文件匹配模式（server + shared source alias）
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'tests/**/*.{test,spec}.{ts,tsx}'],
    // 排除的目录
    exclude: ['node_modules', 'dist'],
    // 使用 Node.js 环境
    environment: 'node',
    // 全局 API
    globals: true,
    // 覆盖率配置
    // lcov 供 diff coverage 脚本使用；json-summary 供 CI 汇总；text/html 便于本地看
    coverage: {
      provider: 'v8',
      reporter: coverageReporters,
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/__tests__/**',
        'src/**/__mocks__/**',
        // 逻辑层口径：入口装配 / 一次性 CLI 脚本 / DB 迁移(DDL) / 纯类型定义
        // 不纳入单测覆盖率主指标
        'src/index.ts',
        'src/scripts/**',
        'src/data/migrations/**',
        'src/types/**',
      ],
    },
    // 测试超时时间
    testTimeout: 10000,
    // 钩子超时时间
    hookTimeout: 10000,
  },
});
