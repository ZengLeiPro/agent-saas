/**
 * WP4 Phase A：双标签壳骨架的接线，以及移动端的显式排除（规范 §5.5、§10、§14.1）。
 *
 * 沿用本目录既有的 `?raw` 源码断言约定（`DesktopLayout.initialWiring.test.ts`）：
 * 这些是「接线是否按约定写」的结构约束，行为侧由
 * `components/AppHost/AppHost.test.tsx` 与 `components/AppsSidebarPanel.test.tsx` 覆盖。
 */
import { describe, expect, it } from 'vitest';

import source from './DesktopLayout.tsx?raw';
import mobileSource from './MobileLayout.tsx?raw';
import mobileSessionListSource from '@/components/MobileSessionList.tsx?raw';
import appHostSource from '@/components/AppHost/index.tsx?raw';
import sidebarSource from '@/components/DesktopSessionSidebar.tsx?raw';

describe('桌面双标签壳骨架', () => {
  it('AppHost 走 lazy() + Suspense，不进 startup chunk', () => {
    expect(source).toContain('const AppHostPanel = lazy(() => import("@/components/AppHost")');
    expect(source).toContain('<Suspense fallback={SuspenseFallback}>\n              <AppHostPanel');
    // 直接 import 会把握手状态机与契约包拖进主 chunk（largestJsGzipBytes 只剩约 95 KB 余量）
    expect(source).not.toContain('import { AppHost }');
  });

  it('沿用 mount-once-visited：首次切到 apps 后永久挂载', () => {
    expect(source).toContain('const [appsMounted, setAppsMounted] = useState(false);');
    expect(source).toContain('if (activeTab === "apps" && !appsMounted) setAppsMounted(true);');
    expect(source).toContain('{appsMounted && (');
  });

  it('切走只隐藏不卸载（§5.5）', () => {
    expect(source).toContain('activeTab !== "apps" && "hidden"');
    // 若写成 activeTab === "apps" && <AppHostPanel /> 就成了条件卸载
    expect(source).not.toContain('activeTab === "apps" && (\n          <div');
  });

  it('壳路由不经 useChatAppState，走独立的 useAppsShellState', () => {
    expect(source).toContain('import { useAppsShellState } from "@/hooks/useAppsShellState";');
    expect(source).toContain('const { appsRoute } = useAppsShellState();');
    expect(source).toContain('<AppHostPanel appsRoute={appsRoute} />');
  });

  it('左栏定制软件入口挂在两处 SidebarNav 之后', () => {
    expect(sidebarSource).toContain(
      'import { AppsSidebarPanel } from "@/components/AppsSidebarPanel";',
    );
    expect(sidebarSource.match(/<AppsSidebarPanel\b/g)).toHaveLength(2);
  });

  it('Phase A 只放占位，不预先猜 Phase B 的实现', () => {
    for (const forbidden of ['postMessage', 'init.ack', '<iframe', 'sandbox=']) {
      expect(appHostSource).not.toContain(forbidden);
    }
  });
});

describe('移动端显式排除定制软件（§10）', () => {
  it('MobileLayout 不出现 apps 入口', () => {
    expect(mobileSource).not.toContain('AppsSidebarPanel');
    expect(mobileSource).not.toContain('AppHost');
    expect(mobileSource).not.toContain('/apps/');
    expect(mobileSource).toContain("if (tab === 'apps') return;");
  });

  it('MobileSessionList 不出现 apps 入口，pill tabs 只来自 getSidebarNavItems', () => {
    expect(mobileSessionListSource).not.toContain('AppsSidebarPanel');
    expect(mobileSessionListSource).not.toContain('AppHost');
    expect(mobileSessionListSource).not.toContain("'apps'");
    expect(mobileSessionListSource).not.toContain('"apps"');
    expect(mobileSessionListSource).toContain(
      'getSidebarNavItems({ isAdmin, personalAgentEnabled })',
    );
  });
});
