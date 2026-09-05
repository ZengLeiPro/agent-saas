import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.expo/**',
    ],
  },
  {
    files: ['**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    // 注册 @typescript-eslint 插件：仓库里残留的
    // `eslint-disable-next-line @typescript-eslint/no-explicit-any` 注释需要该规则「已定义」，
    // 否则报 "Definition for rule ... was not found"（error 级）拦下提交。
    // no-explicit-any 存量较多，先设 warn（不阻断提交）。
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      'no-debugger': 'warn',
      'no-duplicate-case': 'error',
      'no-unreachable': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // React 相关代码注册 react-hooks 插件：
    // 1. rules-of-hooks 属于真 bug 类，保持 error；
    // 2. exhaustive-deps 存量较多，先设为 warn（不阻断提交），
    //    同时让仓库里残留的 `eslint-disable ... react-hooks/exhaustive-deps`
    //    注释重新有效，避免 "Definition for rule ... was not found" 报错拦下提交。
    files: [
      'web/src/**/*.{ts,tsx,js,jsx}',
      'mobile/src/**/*.{ts,tsx,js,jsx}',
      'mobile/app/**/*.{ts,tsx,js,jsx}',
      'shared/src/**/*.{ts,tsx,js,jsx}',
    ],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
];
