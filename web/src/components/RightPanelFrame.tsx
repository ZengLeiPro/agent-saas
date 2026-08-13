import type { ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface RightPanelFrameProps {
  title: string;
  subtitle?: string;
  onClose: () => void;
  closeLabel?: string;
  actions?: ReactNode;
  children: ReactNode;
}

/** 文档、文件与详情类右侧窗口共用的标题栏和内容容器。 */
export function RightPanelFrame({
  title,
  subtitle,
  onClose,
  closeLabel = '关闭右侧窗口',
  actions,
  children,
}: RightPanelFrameProps) {
  return (
    <section className="flex h-full min-h-0 flex-col bg-card" aria-label={title}>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-2">
        <Button
          variant="ghost"
          size="icon"
          className="size-9 shrink-0"
          onClick={onClose}
          title={closeLabel}
          aria-label={closeLabel}
        >
          <ChevronLeft className="size-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{title}</div>
          {subtitle ? <div className="truncate text-xs text-muted-foreground">{subtitle}</div> : null}
        </div>
        {actions}
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {children}
      </div>
    </section>
  );
}
