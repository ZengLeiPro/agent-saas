import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * mobile vitest 配置（M00-01 返工新增）。
 *
 * 运行时门禁测试（v1RouteGate.runtime.test.tsx）需要真实 import 应用
 * 路由组件（app/oauth/callback 等），而 react-native 的 Flow 入口
 * （`import typeof ...`）无法被 Vite/Rollup SSR transform 解析。
 * 这里将 react-native 统一 alias 到本地 stub（纯 DOM 实现），
 * 使组件模块在 jsdom 中可加载；具体行为断言仍由测试文件内的
 * vi.mock 精确控制。
 *
 * 注：此前 7 个测试文件均为纯函数/文件扫描测试，未触发该问题；
 * 新增运行时渲染测试后此配置为必需品。
 */
export default defineConfig({
  esbuild: {
    // 应用组件部分未显式 import React（依赖 Metro 的自动 JSX 转换）
    jsx: 'automatic',
  },
  resolve: {
    alias: [
      { find: /^@agent\/shared$/, replacement: resolve(__dirname, '../shared/src/index.ts') },
      { find: 'react-native', replacement: resolve(__dirname, './src/test/reactNativeStub.tsx') },
    ],
  },
  test: {
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    environment: 'node',
    // 确保 react 解析到 development 构建（含 React.act，@testing-library/react 依赖）
    env: { NODE_ENV: 'test' },
  },
});
