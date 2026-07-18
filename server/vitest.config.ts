import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 测试文件匹配模式
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
      reporter: ['text', 'lcov', 'json-summary', 'json', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/__tests__/**',
        'src/**/__mocks__/**',
      ],
    },
    // 测试超时时间
    testTimeout: 10000,
    // 钩子超时时间
    hookTimeout: 10000,
  },
});
