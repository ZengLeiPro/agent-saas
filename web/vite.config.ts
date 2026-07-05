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
        // HTML 不缓存：服务端已设 no-cache 头，始终从网络获取，确保版本一致
        globPatterns: ["**/*.{js,css,ico,svg,woff2}", "*.png"],
        // 不使用 navigateFallback：服务端已处理 SPA 路由（非 API 请求返回 index.html），
        // SW 不拦截导航请求，避免 frp 慢时回退到缓存中的旧 HTML 导致版本不一致
        navigateFallbackDenylist: [/^\/preview\//],
        // 运行时缓存策略（具体规则在前，兜底在后）
        runtimeCaching: [
          // 会话列表：先展示缓存，后台静默刷新
          {
            urlPattern: ({ url }: { url: URL }) =>
              url.pathname === "/api/sessions" && !url.searchParams.has("fresh"),
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "api-sessions-list",
              expiration: { maxEntries: 1, maxAgeSeconds: 300 },
            },
          },
          // 会话详情：优先网络，超时用缓存兜底
          {
            urlPattern: /\/api\/sessions\/[^/?]+$/,
            handler: "NetworkFirst",
            options: {
              cacheName: "api-session-detail",
              expiration: { maxEntries: 20, maxAgeSeconds: 600 },
              networkTimeoutSeconds: 5,
            },
          },
          // Cron 状态 & 任务列表
          // 锚定 jobs/status 结尾，避免误匹配 /jobs/:id、/jobs/:id/runs 等子路径
          // （子路径含动态 id 缓存价值低；含错误响应被缓回去更难调试）
          {
            urlPattern: /\/api\/cron\/(jobs|status)(\?.*)?$/,
            method: "GET",
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "api-cron",
              expiration: { maxEntries: 2, maxAgeSeconds: 300 },
            },
          },
          // 模型列表 & 健康检查（变化极少）
          {
            urlPattern: /\/api\/(models|health)$/,
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "api-static",
              expiration: { maxEntries: 2, maxAgeSeconds: 3600 },
            },
          },
          // 其余 API（SSE 流、认证、TTS 等写操作）不缓存
          {
            urlPattern: /\/api\//,
            handler: "NetworkOnly",
          },
        ],
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
