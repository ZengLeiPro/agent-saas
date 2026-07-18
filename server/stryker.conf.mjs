/**
 * Stryker 变异测试配置。
 *
 * 用法：
 *   STRYKER_MODULE=billing npx stryker run --mutate 'src/data/billing/pgBillingStore.ts'
 *   STRYKER_MODULE=auth    npx stryker run --mutate 'src/routes/auth.ts'
 *   STRYKER_MODULE=guardrail npx stryker run --mutate 'src/agent/guardrail.ts'
 *   STRYKER_MODULE=channel npx stryker run --mutate 'src/channels/web/channel.ts'
 *   STRYKER_MODULE=runtime npx stryker run --mutate 'src/runtime/rawRuntimeRunDispatch.ts'
 *
 * 报告：reports/mutation-<module>/mutation.html 和 mutation.json。
 */
const MODULE = process.env.STRYKER_MODULE || 'billing';

export default {
  packageManager: 'pnpm',
  reporters: ['html', 'json', 'clear-text', 'progress'],
  testRunner: 'vitest',
  vitest: {
    // 每模块单独一份 vitest 配置，只跑与该模块相关的测试
    configFile: `vitest.stryker.${MODULE}.config.ts`,
    // 关掉 related 模式：测试 import 路径带 .js 后缀，related 分析对不上 mutate 的 .ts 路径
    related: false,
  },
  // mutate 通过 CLI --mutate 传入，避免每次改配置
  // 排除运行时/构建产物避免 sandbox 拷贝失败
  ignorePatterns: [
    '.browser-data',
    '.playwright',
    '.playwright-cli',
    '.stryker-tmp',
    '.venv',
    'coverage',
    'dist',
    'reports',
    'node_modules',
  ],
  coverageAnalysis: 'perTest',
  concurrency: 4,
  timeoutMS: 30000,
  disableTypeChecks: 'src/**/*.{js,ts}',
  htmlReporter: {
    fileName: `reports/mutation-${MODULE}/mutation.html`,
  },
  jsonReporter: {
    fileName: `reports/mutation-${MODULE}/mutation.json`,
  },
  tempDirName: '.stryker-tmp',
};
