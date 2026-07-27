import type { ReactNode } from 'react';
import { ChevronRight, CircleAlert, CircleCheck, CircleX, Clock3, Loader2, PauseCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export type AgentActivityState = 'running' | 'completed' | 'warning' | 'failed' | 'waiting' | 'cancelled';

const STATE_LABELS: Record<AgentActivityState, string> = {
  running: '运行中',
  completed: '已完成',
  warning: '有异常',
  failed: '失败',
  waiting: '等待中',
  cancelled: '已取消',
};

function StatusIcon({ state }: { state: AgentActivityState }) {
  if (state === 'running') return <Loader2 className="size-4 animate-spin text-primary" />;
  if (state === 'completed') return <CircleCheck className="size-4 text-emerald-500" />;
  if (state === 'warning') return <CircleAlert className="size-4 text-amber-500" />;
  if (state === 'failed') return <CircleX className="size-4 text-destructive" />;
  if (state === 'cancelled') return <PauseCircle className="size-4 text-muted-foreground" />;
  return <Clock3 className="size-4 text-amber-500" />;
}

export function AgentActivityShell({
  state,
  title,
  subtitle,
  meta,
  expanded,
  onToggle,
  actions,
  children,
  className,
}: {
  state: AgentActivityState;
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('my-1 overflow-hidden rounded-lg border bg-muted/15', className)}>
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <StatusIcon state={state} />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium">{title}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">{STATE_LABELS[state]}</span>
            </span>
            {subtitle ? <span className="block truncate text-[11px] text-muted-foreground">{subtitle}</span> : null}
          </span>
          {meta ? <span className="hidden shrink-0 items-center gap-2 text-[11px] text-muted-foreground sm:flex">{meta}</span> : null}
          <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} />
        </button>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {expanded && children ? <div className="border-t px-3 py-2">{children}</div> : null}
    </div>
  );
}
