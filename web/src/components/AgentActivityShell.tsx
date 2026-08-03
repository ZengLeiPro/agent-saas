import type { ReactNode } from 'react';
import { ChevronRight, CircleAlert, CircleCheck, CircleX, Clock3, Loader2, PauseCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export type AgentActivityState = 'running' | 'completed' | 'warning' | 'failed' | 'waiting' | 'cancelled';

function StatusIcon({ state }: { state: AgentActivityState }) {
  if (state === 'running') return <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />;
  if (state === 'completed') return <CircleCheck className="size-3.5 shrink-0 text-emerald-500" />;
  if (state === 'warning') return <CircleAlert className="size-3.5 shrink-0 text-amber-500" />;
  if (state === 'failed') return <CircleX className="size-3.5 shrink-0 text-destructive" />;
  if (state === 'cancelled') return <PauseCircle className="size-3.5 shrink-0 text-muted-foreground" />;
  return <Clock3 className="size-3.5 shrink-0 text-amber-500" />;
}

/**
 * 过程痕迹的排版型外壳（2026-08-03 曾磊拍板去卡片化）：
 * - 折叠态 = 一行低噪文字（chevron + 状态 icon + 摘要 + meta），无边框无背景，
 *   与业务步骤的「过程 · N 项」「开始行」同一视觉语言；
 * - 展开区 = 缩进 + 极淡左竖线（timeline 归属语言），不再是 border-t 卡片内区；
 * - 流内骨架永远是排版，只有内容物（原始 JSON / 图片 / callout）允许有背景。
 */
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
    <div className={cn('my-2', className)}>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="group flex min-w-0 flex-1 items-center gap-1.5 py-0.5 text-left"
        >
          <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground/60 transition-transform', expanded && 'rotate-90')} />
          <StatusIcon state={state} />
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground transition-colors group-hover:text-foreground">
            {title}
            {subtitle ? (
              <span className="text-muted-foreground/70">{' · '}{subtitle}</span>
            ) : null}
          </span>
          {meta ? <span className="hidden shrink-0 text-[11px] text-muted-foreground/70 sm:inline">{meta}</span> : null}
        </button>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {expanded && children ? (
        <div className="ml-[7px] mt-1.5 border-l border-border/50 py-0.5 pl-4">{children}</div>
      ) : null}
    </div>
  );
}
