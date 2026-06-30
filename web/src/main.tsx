// Platform init must be the very first import
import "./platform/init";

import React from "react";
import ReactDOM from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { AuthProvider } from "./contexts/AuthContext";
import { AuthGate } from "./components/AuthGate";
import "./index.css";

// 注册 Service Worker，autoUpdate 模式下自动更新
// - 每 60 秒主动检查 SW 是否有新版本（浏览器默认 24h 才检查一次）
// - 检测到新 SW 激活后自动 reload 加载新代码
registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return;
    // 定期检查 SW 更新，解决长期开着页面不刷新的问题
    setInterval(() => {
      registration.update().catch(() => {});
    }, 60_000);
  },
});

// 新 SW 接管后自动 reload：controllerchange 在 skipWaiting+clientsClaim 后触发
// 首次注册不触发（此时 controller 从 null 变为 SW，无需 reload）
if (navigator.serviceWorker) {
  let hasController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hasController) {
      // 已有旧 SW 被新 SW 替换 → 版本更新，需要 reload 加载新代码
      window.location.reload();
    }
    hasController = true;
  });
}

// 一次性迁移：将输入草稿从 sessionStorage 迁移到 localStorage
{
  const DRAFT_KEY = "agentChat.inputDraft";
  const old = sessionStorage.getItem(DRAFT_KEY);
  if (old && !localStorage.getItem(DRAFT_KEY)) {
    localStorage.setItem(DRAFT_KEY, old);
  }
  sessionStorage.removeItem(DRAFT_KEY);
}

// iOS standalone PWA: 系统已将 fixed 元素约束在安全区域内，
// 但 env(safe-area-inset-bottom) 仍返回完整值，需归零 --sab 避免叠加。
const isStandalone =
  (navigator as unknown as { standalone?: boolean }).standalone === true ||
  window.matchMedia("(display-mode: standalone)").matches;
if (isStandalone) {
  document.documentElement.style.setProperty("--sab", "0px");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AuthProvider>
        <AuthGate />
      </AuthProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
