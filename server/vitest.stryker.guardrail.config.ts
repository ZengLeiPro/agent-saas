/**
 * Stryker 变异测试专用：guardrail 模块（含 webChannelGuardrail 集成测试）。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/__tests__/guardrail*.test.ts',
      'src/__tests__/webChannelGuardrail.test.ts',
    ],
    exclude: ['node_modules', 'dist'],
    environment: 'node',
    globals: true,
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
