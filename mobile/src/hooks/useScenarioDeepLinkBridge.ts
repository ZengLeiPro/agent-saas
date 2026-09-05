/**
 * 场景直达 deep link 的原生桥接 —— 对齐 Web `useScenarioDeepLink` 消费的
 * `?scenario=<id>` / `?workflow=<id>&intent=<intent>` 同名参数，
 * 原生侧走 `agent-saas://` scheme（scheme 来自 release-manifest.identity）。
 *
 * 结构沿用 `useNativeOAuthCallbackBridge`：冷启动 `getInitialURL` + 热态 `url`
 * 事件两条入口；参数解析交给 shared `parseScenarioDeepLink`，投递给
 * `scenarioDeepLinkInbox` 后跳到新建会话流程，由会话页取走并预填输入框。
 */
import { useEffect } from 'react';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import type { ScenarioDeepLinkParams } from '@agent/shared';
import { publishScenarioDeepLink } from '../lib/scenarioDeepLinkInbox';

export function useScenarioDeepLinkBridge(enabled: boolean): void {
  const router = useRouter();

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const route = (url: string | null) => {
      if (!active || !url) return;
      let params: ScenarioDeepLinkParams;
      try {
        params = (Linking.parse(url).queryParams ?? {}) as ScenarioDeepLinkParams;
      } catch {
        return; // 非法 URL 直接放弃，不影响其它 deep link 分支
      }
      if (!publishScenarioDeepLink(url, params)) return;
      router.push('/chat/new');
    };
    void Linking.getInitialURL().then(route);
    const subscription = Linking.addEventListener('url', (event) => route(event.url));
    return () => {
      active = false;
      subscription.remove();
    };
  }, [enabled, router]);
}
