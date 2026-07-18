import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['node_modules', 'dist'],
    environment: 'node',
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/*.{test,spec}.ts',
        'src/**/__mocks__/**',
        // 逻辑层口径：纯类型定义无运行时代码，不纳入覆盖率
        'src/types/**',
      ],
    },
  },
});
