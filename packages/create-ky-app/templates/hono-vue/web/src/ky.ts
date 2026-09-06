/**
 * 子端 SDK 接入（§5）。壳里跑时走 `createKyApp` 的握手与令牌；
 * 独立打开（本地开发、兜底登录页）时 `phase` 会是 `standalone`，页面照常可用。
 *
 * `window.__kyApp` 是一致性测试（§9.3-10）驱动子端行为的入口，请勿删。
 */
import { ref } from 'vue';

import { createKyApp, type KyApp, type KyPhase } from '@kaiyan/ky-app-browser';

import manifest from '../../ky-app.manifest.json';
import { currentPath, isKnownRoute, isVisible, landing, menus, setPath } from './router.js';

export const phase = ref<KyPhase>('loading');
export const theme = ref('light');
export const permVersion = ref<string | null>(null);
/** 客户面提示（§6.6：只说人话，不写技术归因）。 */
export const notice = ref<string | null>(null);

const TOKEN_ERROR_TEXT: Record<string, string> = {
  session_expired: '登录已过期，请重新登录后继续。',
  installation_disabled: '该系统已停用，请联系组织管理员。',
  user_disabled: '你的账号已被停用，请联系组织管理员。',
  temporary: '网络不太稳定，正在重试。',
};

export const app: KyApp = createKyApp({
  externalLinkHosts: manifest.externalLinkHosts,
  onPhaseChange: (next) => {
    phase.value = next;
  },
  onInit: (context) => {
    theme.value = context.theme;
  },
  onTheme: (next) => {
    theme.value = next;
  },
  onRoute: (path) => {
    if (!isKnownRoute(path)) return { ok: false, reason: 'not_found' };
    // 菜单里没有的路径视为无权（壳会刷新 /me 并导航到 landing）。
    if (menus.value.length > 0 && path !== '/' && path !== '/local-login' && !isVisible(path)) {
      return { ok: false, reason: 'forbidden' };
    }
    setPath(path);
    return { ok: true, path };
  },
  onPermChanged: (version) => {
    permVersion.value = version;
    void refreshMe();
  },
  onTokenError: (reason) => {
    notice.value = TOKEN_ERROR_TEXT[reason] ?? '暂时无法继续，请稍后再试。';
  },
});

declare global {
  interface Window {
    /** 一致性测试用：§9.3-10 需要从子端触发 `openLink` / `fetch` 等行为。 */
    __kyApp?: KyApp;
  }
}
window.__kyApp = app;

interface MeResponse {
  user: { id: string; displayName: string; roles: string[]; isTenantAdmin: boolean };
  menus: typeof menus.value;
  landing: string | null;
  permVersion: string;
}

export const me = ref<MeResponse | null>(null);
export const meState = ref<'loading' | 'ready' | 'error'>('loading');

/** 拉一次 `/ky/v1/me`，菜单与 landing 都以它为准。 */
export async function refreshMe(): Promise<void> {
  meState.value = 'loading';
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await app.fetch('/ky/v1/me', { signal: controller.signal });
    if (!response.ok) throw new Error(`me ${response.status}`);
    const body = (await response.json()) as MeResponse;
    me.value = body;
    menus.value = body.menus;
    landing.value = body.landing;
    permVersion.value = body.permVersion;
    notice.value = null;
    meState.value = 'ready';
  } catch {
    meState.value = 'error';
    notice.value = '系统信息暂时没有加载出来，请重试。';
  } finally {
    window.clearTimeout(timeout);
  }
}

/** 用户点击导航：改路径 + `pushState` + 上报 `route.changed`（§5.2 回声抑制）。 */
export function navigate(path: string): void {
  setPath(path);
  app.syncHistory(path, { mode: 'push' });
}

/** 「问 Agent」：只预填，用户自己点发送（§5.4）。 */
export function askAgent(
  prompt: string,
  entity?: { type: string; id: string; label: string },
): void {
  app.openAgent({ prompt, ...(entity === undefined ? {} : { context: { entity } }) });
}

/** 初始化：等握手完成 → 拉 `/me` → 把当前路径校准到 landing。 */
export async function bootstrap(): Promise<void> {
  setPath(window.location.pathname);
  try {
    await app.ready();
  } catch {
    // 握手失败时页面仍然渲染，由 notice 呈现客户面文案。
  }
  await refreshMe();
  if (currentPath.value === '/' && landing.value !== null) {
    setPath(landing.value);
    app.syncHistory(landing.value, { mode: 'replace' });
  }
}
