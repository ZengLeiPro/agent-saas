import { defineConfig } from 'vitest/config';

const coverageReporters =
  process.env.COVERAGE_REPORT_MODE === 'ci'
    ? ['text', 'lcovonly', 'json-summary']
    : ['text', 'lcov', 'json-summary', 'html'];

export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['node_modules', 'dist'],
    environment: 'node',
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: coverageReporters,
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
