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
    <Suspense fallback={(
      <aside
        className={cn("h-full shrink-0 border-r border-black/[0.08] bg-background", props.hidden && "hidden", props.className)}
        style={{ width: props.width }}
        aria-label="正在加载设置导航"
      />
    )}>
      <LazyUnifiedSettingsSidebar {...props} />
    </Suspense>
  );
}
