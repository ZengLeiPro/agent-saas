import type { MouseEventHandler, ReactNode } from 'react';

import { AppsSidebarPanel, DesktopWorkspaceSwitcher } from '@/components/AppsSidebarPanel';
import { cn } from '@/lib/utils';

export function DesktopBusinessWorkspaceSidebar({
  width,
  hidden,
  className,
  header,
  footer,
  onOpenAgent,
  onResizeMouseDown,
  onResizeDoubleClick,
}: {
  width: number;
  hidden: boolean;
  className?: string;
  header: ReactNode;
  footer: ReactNode;
  onOpenAgent: () => void;
  onResizeMouseDown: MouseEventHandler<HTMLDivElement>;
  onResizeDoubleClick: MouseEventHandler<HTMLDivElement>;
}) {
  return (
    <aside
      className={cn(
        'relative flex h-full shrink-0 flex-col bg-background',
        hidden && 'hidden',
        className,
      )}
      style={{ width }}
      {...{ inert: hidden ? true : undefined }}
    >
      {header}
      <DesktopWorkspaceSwitcher active="business" onOpenAgent={onOpenAgent} />
      <AppsSidebarPanel />
      {footer}
      <div
        className="group absolute inset-y-0 right-0 z-20 w-1 cursor-col-resize"
        onMouseDown={onResizeMouseDown}
        onDoubleClick={onResizeDoubleClick}
        title="拖动调整侧边栏宽度,双击恢复默认"
      >
        <div className="pointer-events-none absolute inset-y-0 right-0 w-px bg-transparent transition-colors group-hover:bg-primary/50" />
      </div>
    </aside>
  );
}
