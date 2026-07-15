import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath } from "node:url";

const hoistedReact = fileURLToPath(new URL("../node_modules/react", import.meta.url));
const hoistedReactJsxRuntime = fileURLToPath(new URL("../node_modules/react/jsx-runtime.js", import.meta.url));
const hoistedReactJsxDevRuntime = fileURLToPath(new URL("../node_modules/react/jsx-dev-runtime.js", import.meta.url));
const hoistedReactDom = fileURLToPath(new URL("../node_modules/react-dom", import.meta.url));
const hoistedReactDomClient = fileURLToPath(new URL("../node_modules/react-dom/client.js", import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // prompt 模式：新 SW 进 waiting，由 lib/swUpdate.ts 决定激活时机
      // （update-on-navigation + 提示条），不再自动接管强刷所有 tab
      registerType: "prompt",
      // 使用已有的 manifest.webmanifest，不让插件生成
      manifest: false,
      workbox: {
        // 预缓存 app shell 静态资源（排除 html）
        // HTML 不缓存：托管侧（ECS express / OSS 对象 meta）设 no-cache 头，
        // 始终从网络获取，确保版本一致
        globPatterns: ["**/*.{js,css,ico,svg,png,woff2}"],
        // PDF.js 主包与 worker 只在用户点“查看完整目录”时加载；worker 为 .mjs，
        // 主包 chunk 需显式排除，避免 PWA 安装时提前下载到普通聊天首屏。
        globIgnores: ["assets/PdfJsReader-*.js"],
        // SPA 路由由托管侧处理，SW 明确不缓存也不拦截 HTML 导航。
        // null 必须显式设置；仅配置 denylist 仍会生成 index.html navigation route。
        navigateFallback: null,
        // 不缓存任何 API：CacheStorage 按 origin 共享，不带 tenant/user 身份维度。
        // hash 静态资源由 precache 负责，鉴权数据始终交给网络和应用层状态管理。
        runtimeCaching: [],
        // 不自动 skipWaiting：等待页面发 SKIP_WAITING 消息（swUpdate.ts applyUpdate）。
        // 保留 clientsClaim：激活后接管所有 tab，各 tab 通过 controllerchange 感知
        // 「新版本已就绪」，但只标记不 reload（见 swUpdate.ts 多 tab 说明）。
        skipWaiting: false,
        clientsClaim: true,
      },
    }),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@agent/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
      "react/jsx-dev-runtime": hoistedReactJsxDevRuntime,
      "react/jsx-runtime": hoistedReactJsxRuntime,
      "react-dom/client": hoistedReactDomClient,
      "react-dom": hoistedReactDom,
      react: hoistedReact,
    },
  },
  build: {
    modulePreload: {
      resolveDependencies: (_filename, deps) =>
        deps.filter((d) => !d.includes("vendor-markdown")),
    },
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-markdown": ["react-markdown", "remark-gfm"],
          "vendor-radix": [
            "@radix-ui/react-checkbox",
            "@radix-ui/react-dialog",
            "@radix-ui/react-label",
            "@radix-ui/react-scroll-area",
            "@radix-ui/react-select",
            "@radix-ui/react-separator",
            "@radix-ui/react-slot",
            "@radix-ui/react-tabs",
          ],
        },
      },
    },
  },
  server: {
    port: 5174,
    allowedHosts: ["agent.frp.kaiyan.net", "ai.kaiyan.net"],
    proxy: {
      "/api": {
        target: "http://localhost:3200",
        changeOrigin: true,
        configure: (proxy) => {
          // 后端未就绪时发送 502（语义正确），优先于 vite 默认的 500
          proxy.on("error", (_err, _req, res) => {
            if ("writeHead" in res && !(res as import("http").ServerResponse).headersSent) {
              (res as import("http").ServerResponse).writeHead(502).end();
            }
          });
        },
      },
      "/ws": {
        target: "ws://localhost:3200",
        ws: true,
      },
    },
  },
});
