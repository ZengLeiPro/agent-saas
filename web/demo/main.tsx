/**
 * 演示态外壳：用**生产组件**拼出「左栏双标签 + 右侧 AppHost」的最小可视布局。
 *
 * 刻意不引 `DesktopLayout`：那个组件要 60 多个 props 与整套聊天状态，
 * 为了看四张图把它拉起来只会引入一堆与验收无关的桩。这里复用的是
 * 被验收对象本身 —— `SidebarNav`（含积分降级）、`AppsSidebarPanel`、`AppHost`
 * 与 `getDesktopHeaderTitle`，接线方式与 `DesktopLayout` 一致。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { AppHost } from '@/components/AppHost';
import { AppsSidebarPanel } from '@/components/AppsSidebarPanel';
import { SidebarNav } from '@/components/DesktopSessionSidebarControls';
import { useAppsShellState } from '@/hooks/useAppsShellState';
import { useMySystems } from '@/hooks/useMySystems';
import { buildAppsHeaderTitle, getDesktopHeaderTitle } from '@/layouts/desktopHeaderTitle';
import '@/index.css';

function Demo() {
  const { appsRoute } = useAppsShellState();
  const { status, installations } = useMySystems();
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
    activeTab: appsRoute ? 'apps' : 'chat',
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
          activeTab={appsRoute ? 'apps' : 'chat'}
          isNewSessionActive={!appsRoute}
          isLoading={false}
          onNew={() => {}}
          onTabChange={() => {}}
          constrainNewButton={false}
        />
        <AppsSidebarPanel />
        <div className="mt-auto border-t px-3 py-2 text-xs text-muted-foreground">
          演示态 · 无后端 · 数据为桩
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 items-center border-b px-4 text-sm font-medium">
          {headerTitle}
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <AppHost appsRoute={appsRoute} />
        </div>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);
