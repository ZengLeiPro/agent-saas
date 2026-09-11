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
    <div
      className={cn("h-full shrink-0", props.hidden && "hidden", props.className)}
      style={{ width: props.width }}
      data-testid="deferred-analysis-sidebar-shell"
    >
      <Suspense fallback={<div className="h-full bg-background" aria-label="正在加载分析导航" />}>
        <LazyUnifiedAnalysisSidebar {...props} className={undefined} />
      </Suspense>
    </div>
  );
}
