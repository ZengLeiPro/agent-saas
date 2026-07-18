/**
 * Stryker 变异测试专用：runtime/rawRuntimeRunDispatch.ts。
 * 排除 rawAgentLoopHandFailureCoverage.test.ts —— 该测试硬编码 agent-saas/server/config
 * 路径，在 stryker sandbox 目录下会失败。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/__tests__/rawRuntime*.test.ts',
      'src/__tests__/rawAgentLoop.test.ts',
      'src/__tests__/runtimeWake.test.ts',
      'src/__tests__/runtimeScheduler.test.ts',
      'src/__tests__/directRuntimeLease.test.ts',
      'src/__tests__/handHealthScanner.test.ts',
      'src/__tests__/pgEventStoreNotify.test.ts',
      'src/__tests__/runtimeEventRetention.test.ts',
      'src/__tests__/runtimeReplay.test.ts',
      'src/__tests__/runtimeSessionProjection.test.ts',
      'src/__tests__/appRuntime.test.ts',
      'src/__tests__/appRuntimeCoverage.test.ts',
    ],
    exclude: [
      'node_modules',
      'dist',
      // 这两个测试硬编码 resolve(cwd, '../workspace-shared')，在 stryker sandbox
      // 目录下相对路径对不上——排除。runtime 主体变异覆盖不依赖它们。
      '**/runtimeStage2.test.ts',
      '**/rawRuntimeOrgAgentDispatch.test.ts',
    ],
    environment: 'node',
    globals: true,
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
