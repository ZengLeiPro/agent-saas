import { lazy, Suspense } from "react";

import type { UnifiedAnalysisSidebarProps } from "@/components/UnifiedAnalysisSidebar";
import { cn } from "@/lib/utils";

const loadUnifiedAnalysisSidebar = () => import("@/components/UnifiedAnalysisSidebar");
const LazyUnifiedAnalysisSidebar = lazy(() => loadUnifiedAnalysisSidebar()
  .then((module) => ({ default: module.UnifiedAnalysisSidebar })));

export function preloadUnifiedAnalysisSidebar(): void {
  void loadUnifiedAnalysisSidebar();
}

export function DeferredUnifiedAnalysisSidebar(props: UnifiedAnalysisSidebarProps) {
  return (
    <Suspense fallback={(
      <aside
        className={cn("h-full shrink-0 bg-background", props.hidden && "hidden", props.className)}
        style={{ width: props.width }}
        aria-label="正在加载分析导航"
      />
    )}>
      <LazyUnifiedAnalysisSidebar {...props} />
    </Suspense>
  );
}
