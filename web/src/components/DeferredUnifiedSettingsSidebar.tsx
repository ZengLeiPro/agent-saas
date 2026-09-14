import { lazy, Suspense } from "react";

import { cn } from "@/lib/utils";
import type { UnifiedSettingsSidebarProps } from "@/components/UnifiedSettingsSidebar";
import { SETTINGS_SIDEBAR_WIDTH } from "@/components/SettingsCenter/settingsLayout";

const loadUnifiedSettingsSidebar = () => import("@/components/UnifiedSettingsSidebar");
const LazyUnifiedSettingsSidebar = lazy(() => loadUnifiedSettingsSidebar()
  .then((module) => ({ default: module.UnifiedSettingsSidebar })));

export function preloadUnifiedSettingsSidebar(): void {
  void loadUnifiedSettingsSidebar();
}

export function DeferredUnifiedSettingsSidebar(props: UnifiedSettingsSidebarProps) {
  return (
    <div
      className={cn("h-full shrink-0", props.hidden && "hidden", props.className)}
      style={{ width: SETTINGS_SIDEBAR_WIDTH }}
      data-layout-width={SETTINGS_SIDEBAR_WIDTH}
      data-testid="deferred-settings-sidebar-shell"
    >
      <Suspense fallback={<div className="h-full bg-background" aria-label="正在加载设置导航" />}>
        <LazyUnifiedSettingsSidebar {...props} className={undefined} />
      </Suspense>
    </div>
  );
}
