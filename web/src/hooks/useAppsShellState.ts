/**
 * 定制软件壳的路由状态（WP4，规范 §5.2）。
 *
 * 为什么不塞进 `useChatAppState`：壳路由只有左栏入口与 AppHost 两个消费者，
 * 而 `useChatAppState.ts` 的 max-lines 基线余量为 0；同时 §5.2 的 canonical 归属
 * （`ready.path` 作准、回声抑制用 `navId`）与聊天侧的 URL 兜底逻辑是两套规则，
 * 混在一起只会互相覆盖。这里独立订阅同一条「土制路由」popstate 通道。
 *
 * Phase A 只提供路由；安装实例元数据（origin / 名称）由 Phase B 的 AppHost 接入。
 */
import { useEffect, useState } from 'react';

import { parseAppsPath, type AppsRouteState } from '@/lib/urlSync';

export function readAppsRoute(): AppsRouteState | null {
  if (typeof window === 'undefined') return null;
  return parseAppsPath(window.location.pathname, window.location.search, window.location.hash);
}

function sameRoute(left: AppsRouteState | null, right: AppsRouteState | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.installationId === right.installationId && left.appPath === right.appPath;
}

export interface AppsShellState {
  /** 当前壳路由；不在 `/apps/<iid>/*` 上时为 null。 */
  appsRoute: AppsRouteState | null;
  /** 当前停留的安装实例；非定制软件页面为 null。 */
  activeInstallationId: string | null;
}

/**
 * 订阅 `urlSync.notifyRouteChange()` 与浏览器前进/后退派发的同一个 popstate 事件。
 * 只在安装实例或应用内路径真的变了时才更新 state，避免每次合成 popstate 都重渲染。
 */
export function useAppsShellState(): AppsShellState {
  const [appsRoute, setAppsRoute] = useState<AppsRouteState | null>(readAppsRoute);

  useEffect(() => {
    const handler = () => {
      setAppsRoute((previous) => {
        const next = readAppsRoute();
        return sameRoute(previous, next) ? previous : next;
      });
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  return { appsRoute, activeInstallationId: appsRoute?.installationId ?? null };
}
