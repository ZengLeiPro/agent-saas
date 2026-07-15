/**
 * SW 更新策略：update-on-navigation + 提示条兜底
 *
 * 取代旧的 autoUpdate 强刷模式（新 SW 一激活就 window.location.reload()，
 * 用户正在打字/看输出时页面突然重载）。新策略：
 *
 * 1. registerType 改 prompt：新 SW 进 waiting，不自动接管。
 * 2. 冷启动静默窗口：页面 load 后 30s 内发现更新且用户零交互 → 直接刷，无感。
 * 3. 导航拦截（update-on-navigation）：用户主动跳转（pushUrl / popstate）时
 *    如有 pending 更新且无守门条件 → 整页跳转到目标 URL，体感只是这次跳转慢半拍。
 *    HTML 为 no-cache 且 SW 不拦截导航（见 vite.config.ts），整页跳转必拿新版。
 * 4. 提示条：静置页面显示「新版本可用」，用户可主动点击更新。
 * 5. 多 tab：controllerchange 只标记不 reload（旧的连坐强刷 bug 根源）；
 *    未刷新的旧页面懒加载旧 hash chunk 由服务端旧 release assets fallback 兜底
 *    （server/src/index.ts）。
 *
 * 守门条件（命中则导航不强刷，只留提示条）：
 * - 组件注册的 guard（上传中 / active stream / waiting_approval，见 useChatAppState）
 * - 打开着的 dialog/modal（Radix role=dialog，设置表单无草稿持久化）
 * - 聚焦且非空的输入框（保守：即使聊天主输入框有草稿持久化也守门）
 *
 * 刷新前统一执行 beforeReloadHooks（如聊天草稿同步 flush，绕过 2s debounce）。
 */
import { registerSW } from "virtual:pwa-register";

type Guard = () => boolean;
type Hook = () => void;

const COLD_START_WINDOW_MS = 30_000;
const SW_ACTIVATE_TIMEOUT_MS = 2_000;
const UPDATE_POLL_INTERVAL_MS = 60_000;
const LEGACY_API_CACHE_PREFIX = "api-";

const guards = new Set<Guard>();
const beforeReloadHooks = new Set<Hook>();
const readyListeners = new Set<Hook>();

let updateReady = false;
let applying = false;
let hasInteracted = false;
let swRegistration: ServiceWorkerRegistration | null = null;
const startedAt = Date.now();

/** 清理旧版 SW 创建的未按用户/租户隔离的鉴权 API 缓存。 */
export async function clearLegacyApiCaches(): Promise<void> {
  if (!("caches" in globalThis)) return;
  const names = await globalThis.caches.keys();
  await Promise.all(
    names
      .filter((name) => name.startsWith(LEGACY_API_CACHE_PREFIX))
      .map((name) => globalThis.caches.delete(name)),
  );
}

/** 注册守门条件；返回注销函数。guard 返回 true 表示当前不宜强制刷新。 */
export function registerUpdateGuard(guard: Guard): () => void {
  guards.add(guard);
  return () => guards.delete(guard);
}

/** 注册刷新前钩子（如草稿 flush）；返回注销函数。 */
export function registerBeforeReloadHook(hook: Hook): () => void {
  beforeReloadHooks.add(hook);
  return () => beforeReloadHooks.delete(hook);
}

/** useSyncExternalStore 订阅接口 */
export function subscribeUpdateReady(listener: Hook): () => void {
  readyListeners.add(listener);
  return () => readyListeners.delete(listener);
}

export function isUpdateReady(): boolean {
  return updateReady;
}

function hasGuardActive(): boolean {
  for (const guard of guards) {
    try {
      if (guard()) return true;
    } catch {
      // guard 抛错视为不守门，避免一个坏 guard 永久卡死更新
    }
  }
  // DOM 兜底一：打开着的 modal/dialog（设置、审批等表单无草稿持久化）
  if (document.querySelector('[role="dialog"], [data-sw-update-guard]')) return true;
  // DOM 兜底二：聚焦且非空的输入框（正在打字）
  const ae = document.activeElement;
  if (
    ae instanceof HTMLInputElement ||
    ae instanceof HTMLTextAreaElement
  ) {
    if (ae.value.trim() !== "") return true;
  } else if (ae instanceof HTMLElement && ae.isContentEditable && ae.textContent?.trim()) {
    return true;
  }
  return false;
}

function runBeforeReloadHooks(): void {
  for (const hook of beforeReloadHooks) {
    try {
      hook();
    } catch {
      // 单个 hook 失败不阻塞刷新
    }
  }
}

/**
 * 激活 waiting SW 并跳转。
 * 顺序：SKIP_WAITING → 等 controllerchange → 跳转；2s 超时兜底直接跳
 * （HTML no-cache + SW 不拦截导航，即使 SW 未接管，整页跳转拿到的也是新版页面）。
 */
function applyUpdate(targetUrl?: string): void {
  if (applying) return;
  applying = true;
  runBeforeReloadHooks();

  const navigate = () => {
    if (targetUrl) window.location.assign(targetUrl);
    else window.location.reload();
  };

  const waiting = swRegistration?.waiting;
  if (waiting && navigator.serviceWorker) {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      navigate();
    };
    navigator.serviceWorker.addEventListener("controllerchange", go, { once: true });
    waiting.postMessage({ type: "SKIP_WAITING" });
    setTimeout(go, SW_ACTIVATE_TIMEOUT_MS);
  } else {
    navigate();
  }
}

function markUpdateReady(): void {
  if (updateReady || applying) return;
  updateReady = true;
  // 冷启动静默窗口：刚打开、零交互、无守门 → 直接刷，用户无感知
  if (Date.now() - startedAt < COLD_START_WINDOW_MS && !hasInteracted && !hasGuardActive()) {
    applyUpdate();
    return;
  }
  readyListeners.forEach((l) => l());
}

/**
 * 导航拦截入口（urlSync pushUrl 层调用）。
 * 有 pending 更新且无守门 → 整页跳转到目标 URL 并返回 true（调用方跳过 pushState）。
 */
export function maybeNavigateWithUpdate(targetUrl: string): boolean {
  if (!updateReady || applying || hasGuardActive()) return false;
  applyUpdate(targetUrl);
  return true;
}

/**
 * popstate 拦截入口（URL 已变，直接原地 reload 即到新版）。
 * 返回 true 表示已接管刷新，调用方应跳过本次 SPA 状态同步。
 */
export function maybeReloadOnPopstate(): boolean {
  if (!updateReady || applying || hasGuardActive()) return false;
  applyUpdate();
  return true;
}

/** 提示条「立即更新」：用户主动触发，跳过守门（用户意志优先），草稿 flush 照跑。 */
export function applyUpdateNow(): void {
  applyUpdate();
}

/** main.tsx 启动时调用一次 */
export function initSWUpdate(): void {
  void clearLegacyApiCaches().catch(() => {});
  if (!("serviceWorker" in navigator)) return;

  const markInteracted = () => {
    hasInteracted = true;
  };
  window.addEventListener("pointerdown", markInteracted, { once: true, capture: true });
  window.addEventListener("keydown", markInteracted, { once: true, capture: true });

  // 另一个 tab 激活了新 SW：本 tab 只标记待更新，不 reload（旧连坐强刷的根源）。
  // 本 tab 自己触发的激活由 applyUpdate 内的 once 监听处理（applying=true 时跳过）。
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (applying) return;
    markUpdateReady();
  });

  registerSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      swRegistration = registration;
      // 定期检查更新（浏览器默认 24h 才检查一次）
      setInterval(() => {
        registration.update().catch(() => {});
      }, UPDATE_POLL_INTERVAL_MS);
    },
    onNeedRefresh() {
      markUpdateReady();
    },
  });
}
