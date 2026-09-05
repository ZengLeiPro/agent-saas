import { fileURLToPath } from 'node:url';

import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// 产物由后端托管（§5.1：HTML 入口与重定向终点都要带 CSP），因此固定输出到 web/dist。
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/',
  plugins: [vue()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 内联脚本会被 `script-src 'self'` 拦掉，一律走外链文件。
    assetsInlineLimit: 0,
  },
});
