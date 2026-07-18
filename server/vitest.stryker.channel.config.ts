/**
 * Stryker 变异测试专用：channels/web/channel.ts。
 * 相关测试较分散，覆盖 web channel、reconnect、guardrail、execution target 等。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/__tests__/webChannel*.test.ts',
      'src/__tests__/wsHandler*.test.ts',
      'src/__tests__/wsReconnect*.test.ts',
      'src/__tests__/wsEventProcessor*.test.ts',
      'src/__tests__/wsServer*.test.ts',
      'src/__tests__/interactionStore*.test.ts',
    ],
    exclude: ['node_modules', 'dist'],
    environment: 'node',
    globals: true,
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
