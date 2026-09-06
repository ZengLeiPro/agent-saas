/**
 * 演示态外壳：用**生产组件**拼出「左栏双标签 + 右侧 AppHost」的最小可视布局。
 *
 * 刻意不引 `DesktopLayout`：那个组件要 60 多个 props 与整套聊天状态，
 * 为了看四张图把它拉起来只会引入一堆与验收无关的桩。这里复用的是
 * 被验收对象本身 —— `SidebarNav`（含积分降级）、`AppsSidebarPanel`、`AppHost`
 * 与 `getDesktopHeaderTitle`，接线方式与 `DesktopLayout` 一致。
 *
 * 标签切换（Phase C 加）照抄 `DesktopLayout.tsx:243/259/631-638` 的三行：
 * 惰性挂载 `appsMounted` + `hidden` 隐藏**不卸载**。§5.5/§11.1 的
 * 「切走再切回保留页面与滚动位置」就是靠这个 + `AppHost` 自己的 `renderRoute`
 * 两段合起来成立，E2E 必须在同一条接线上验。
 */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { AppHost } from '@/components/AppHost';
import { AppsSidebarPanel } from '@/components/AppsSidebarPanel';
import { SidebarNav } from '@/components/DesktopSessionSidebarControls';
import { useAppsShellState } from '@/hooks/useAppsShellState';
import { useMySystems } from '@/hooks/useMySystems';
import { buildAppsHeaderTitle, getDesktopHeaderTitle } from '@/layouts/desktopHeaderTitle';
import { pushAppHistoryState } from '@/lib/appHistory';
import { notifyRouteChange } from '@/lib/urlSync';
import { cn } from '@/lib/utils';
import '@/index.css';

/** 离开 `/apps/**` 回到聊天标签，走与生产同一条「土制路由」通道。 */
function gotoChat(): void {
  pushAppHistoryState({}, '/');
  notifyRouteChange();
}

function Demo() {
  const { appsRoute } = useAppsShellState();
  const { status, installations } = useMySystems();
  const activeTab = appsRoute ? 'apps' : 'chat';
  const [appsMounted, setAppsMounted] = useState(false);
  useEffect(() => {
    if (activeTab === 'apps' && !appsMounted) setAppsMounted(true);
  }, [activeTab, appsMounted]);

  const installation =
    installations.find((item) => item.installationId === appsRoute?.installationId) ?? null;
  // 与 DesktopLayout.tsx 同一条接线：《系统名》，停用时追加「暂不可用」
  const appsTitle = appsRoute
    ? buildAppsHeaderTitle({
        name: installation?.name ?? null,
        state: installation?.state ?? null,
        resolved: status === 'ready',
      })
    : null;
  const headerTitle = getDesktopHeaderTitle({
    activeTab,
    isTrashPreview: false,
    sidebarSessions: [],
    sessionId: null,
    activeOrgAgent: null,
    orgAgentIdentityLoading: false,
    agentProfile: null,
    appsTitle,
  });

  return (
    <div className="flex h-screen bg-background text-foreground">
      <aside className="flex w-64 shrink-0 flex-col border-r bg-muted/20 pt-3">
        <SidebarNav
          navItems={[
            { tab: 'capabilities', label: '能力中心' },
            { tab: 'cron', label: '任务中心' },
          ]}
          activeTab={activeTab}
          isNewSessionActive={activeTab === 'chat'}
          isLoading={false}
          onNew={gotoChat}
          onTabChange={() => {}}
          constrainNewButton={false}
        />
        <AppsSidebarPanel />
        <div className="mt-auto border-t px-3 py-2 text-xs text-muted-foreground">
          <button type="button" data-testid="demo-goto-chat" className="underline" onClick={gotoChat}>
            回 Agent 标签
          </button>
          <span className="ml-2">演示态 · 无后端 · 数据为桩</span>
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 items-center border-b px-4 text-sm font-medium" data-testid="demo-header-title">
          {headerTitle}
        </div>
        <div
          className={cn(
            'flex min-h-0 flex-1 items-center justify-center overflow-hidden text-sm text-muted-foreground',
            activeTab !== 'chat' && 'hidden',
          )}
          data-testid="demo-chat-pane"
        >
          Agent 标签（演示态占位）
        </div>
        {appsMounted && (
          // §5.5：定制软件切走再切回要保留页面与滚动位置 —— 与 DesktopLayout 同款
          // 「惰性挂载 + hidden 隐藏」，**禁止条件卸载 iframe**。
          <div
            className={cn('min-h-0 flex-1 overflow-hidden', activeTab !== 'apps' && 'hidden')}
            data-testid="demo-apps-pane"
          >
            <AppHost appsRoute={appsRoute} />
          </div>
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);
