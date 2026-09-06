/**
 * 左栏「定制软件」入口（WP4，规范 §5.2 / §14.1）。
 *
 * 为什么不进 `baseNavItems`：`shared/src/types/sidebar.ts` 的 `baseNavItems` 是
 * 桌面与移动端共用的静态一级导航，而定制软件是**每个安装实例一项**、条目来自
 * `GET /api/systems/mine`，且移动端按 §10 显式排除。所以条目在 web 侧本地拼接，
 * `AppTab` 只多一个 `"apps"` 值用于标识「当前停在定制软件标签」。
 *
 * 点击后走土制路由（`navigateApps` → pushState + 合成 popstate），
 * 由 `useChatUrlSync` 的 popstate 订阅把 `activeTab` 切到 `apps`。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppWindow } from 'lucide-react';

import { cn } from '@/lib/utils';
import { navigateApps } from '@/lib/urlSync';
import { useAppsShellState } from '@/hooks/useAppsShellState';
import {
  fetchMySystems,
  type MySystemInstallation,
  type MySystemsResponse,
} from '@/lib/systemsApi';
import type { AppTab } from '@/types/sidebar';
import { NAV_ITEM_SELECTED, NAV_ITEM_UNSELECTED } from './DesktopSessionSidebarControls';

/** 一个安装实例对应的一条左栏导航项。`tab` 恒为 `"apps"`，实例靠 `installationId` 区分。 */
export interface AppsNavItem {
  tab: Extract<AppTab, 'apps'>;
  installationId: string;
  label: string;
  icon: string | null;
}

/**
 * 安装实例列表 → 左栏导航项。
 *
 * 纯函数，可见性完全由服务端算好（`systemsApi.ts` 的注释），这里不做二次过滤，
 * 只做展示层兜底：名称缺失时回落 `systemId`（`asInstallation()` 已保证非空）。
 */
export function buildAppsNavItems(installations: readonly MySystemInstallation[]): AppsNavItem[] {
  return installations.map((installation) => ({
    tab: 'apps' as const,
    installationId: installation.installationId,
    label: installation.name || installation.systemId,
    icon: installation.icon,
  }));
}

/**
 * manifest 的 `icon` 只约束了「字符串、≤40 字符」，没有约定语义。
 * 这里按「短文本字形（emoji / 一两个汉字）」渲染；带 scheme 或路径分隔符的值
 * 一律回落默认图标，避免把一条 URL 当文字画到导航里。
 */
export function isRenderableIconGlyph(icon: string | null): icon is string {
  if (!icon) return false;
  const trimmed = icon.trim();
  if (trimmed === '' || trimmed.length > 4) return false;
  return !trimmed.includes(':') && !trimmed.includes('/');
}

export interface AppsSidebarPanelProps {
  /** 与其它一级导航一致：跳转前收起展开中的分组。 */
  beforeNavigate?: () => void;
  /** 测试注入点；生产恒为 `fetchMySystems`。 */
  loadInstallations?: () => Promise<MySystemsResponse>;
}

/**
 * 选中态直接读 URL（`useAppsShellState`）而不是 `activeTab` prop：
 * 同一个 `apps` 标签下有多个安装实例，只有 URL 分得清停在哪一个。
 */
export function AppsSidebarPanel({
  beforeNavigate,
  loadInstallations = fetchMySystems,
}: AppsSidebarPanelProps) {
  const { activeInstallationId } = useAppsShellState();
  const [items, setItems] = useState<AppsNavItem[]>([]);
  const [failed, setFailed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const loadRef = useRef(loadInstallations);
  loadRef.current = loadInstallations;

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    loadRef
      .current()
      .then((response) => {
        if (cancelled) return;
        setItems(buildAppsNavItems(response.installations));
      })
      .catch(() => {
        if (cancelled) return;
        // §6.6：客户面不写技术归因，只给「暂时取不到 + 重试」。
        setItems([]);
        setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const handleOpen = useCallback(
    (installationId: string) => {
      beforeNavigate?.();
      navigateApps({ installationId, appPath: '/' });
    },
    [beforeNavigate],
  );

  // 一个可见系统都没有（或未启用定制项目对接）时，左栏不长出第二块区域。
  if (items.length === 0 && !failed) return null;

  return (
    <nav className="flex flex-col gap-1 px-2 pb-3" aria-label="定制软件">
      <div className="px-2 pb-1 text-xs font-medium text-muted-foreground/70">定制软件</div>
      {failed && (
        <button
          type="button"
          className={cn(
            'flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm',
            NAV_ITEM_UNSELECTED,
          )}
          onClick={() => setReloadToken((token) => token + 1)}
        >
          暂时无法加载，点此重试
        </button>
      )}
      {items.map((item) => {
        const selected = activeInstallationId === item.installationId;
        return (
          <button
            key={item.installationId}
            type="button"
            data-testid={`apps-nav-${item.installationId}`}
            className={cn(
              'flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm font-medium transition-colors',
              selected ? NAV_ITEM_SELECTED : NAV_ITEM_UNSELECTED,
            )}
            onClick={() => handleOpen(item.installationId)}
          >
            {isRenderableIconGlyph(item.icon) ? (
              <span
                className="flex size-4 shrink-0 items-center justify-center text-sm leading-none"
                aria-hidden="true"
              >
                {item.icon}
              </span>
            ) : (
              <AppWindow className="size-4 shrink-0" aria-hidden="true" />
            )}
            <span className="min-w-0 truncate">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
