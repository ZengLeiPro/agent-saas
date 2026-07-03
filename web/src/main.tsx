// Platform init must be the very first import
import "./platform/init";

import React from "react";
import ReactDOM from "react-dom/client";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { AuthProvider } from "./contexts/AuthContext";
import { AuthGate } from "./components/AuthGate";
import { UpdateBanner } from "./components/UpdateBanner";
import { initSWUpdate } from "./lib/swUpdate";
import "./index.css";

// SW 更新策略：update-on-navigation + 提示条兜底（详见 lib/swUpdate.ts）。
// 旧的 autoUpdate 全量强刷已移除——用户正在打字/看输出时页面不再突然重载。
initSWUpdate();

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
      <UpdateBanner />
      <AuthProvider>
        <AuthGate />
      </AuthProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
