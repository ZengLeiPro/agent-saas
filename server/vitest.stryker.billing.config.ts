/**
 * Stryker 变异测试专用：billing 模块。
 * 只跑 billing 相关测试，避开硬编码 agent-saas/server/config 路径的 azeroth 注入测试
 * （在 stryker sandbox 目录下会失败）。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/billing*.test.ts'],
    exclude: ['node_modules', 'dist'],
    environment: 'node',
    globals: true,
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
