import { lazy, Suspense } from "react";

import { cn } from "@/lib/utils";
import type { UnifiedSettingsSidebarProps } from "@/components/UnifiedSettingsSidebar";

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
      style={{ width: props.width }}
      data-testid="deferred-settings-sidebar-shell"
    >
      <Suspense fallback={<div className="h-full bg-background" aria-label="正在加载设置导航" />}>
        <LazyUnifiedSettingsSidebar {...props} className={undefined} />
      </Suspense>
    </div>
  );
}
