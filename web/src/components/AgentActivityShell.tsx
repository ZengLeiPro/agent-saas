import type { ReactNode } from 'react';
import { ChevronRight, CircleAlert, CircleCheck, CircleX, Clock3, Loader2, PauseCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { activityStatusIconClass } from './activityStatusStyles';

export type AgentActivityState = 'running' | 'completed' | 'warning' | 'failed' | 'waiting' | 'cancelled';

function StatusIcon({ state }: { state: AgentActivityState }) {
  if (state === 'running') return <Loader2 className={activityStatusIconClass('active', 'size-3.5 shrink-0 animate-spin')} />;
  if (state === 'completed') return <CircleCheck className={activityStatusIconClass('success', 'size-3.5 shrink-0')} />;
  if (state === 'warning') return <CircleAlert className={activityStatusIconClass('warning', 'size-3.5 shrink-0')} />;
  if (state === 'failed') return <CircleX className={activityStatusIconClass('danger', 'size-3.5 shrink-0')} />;
  if (state === 'cancelled') return <PauseCircle className={activityStatusIconClass('neutral', 'size-3.5 shrink-0')} />;
  return <Clock3 className={activityStatusIconClass('pending', 'size-3.5 shrink-0')} />;
}

/**
 * 过程痕迹的排版型外壳（2026-08-03 曾磊拍板去卡片化）：
 * - 折叠态 = 一行低噪文字（可展开时显示 chevron + 状态 icon + 摘要 + meta），无边框无背景，
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
  disabled = false,
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
  disabled?: boolean;
  onToggle: () => void;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const content = (
    <>
      <StatusIcon state={state} />
      <span className="flex min-w-0 items-baseline gap-2">
        <span className={cn(
          'min-w-0 truncate text-sm leading-5 text-muted-foreground',
          !disabled && 'transition-colors group-hover:text-foreground',
        )}>
          {title}
          {subtitle ? (
            <span className="text-muted-foreground/70">{' · '}{subtitle}</span>
          ) : null}
        </span>
        {meta ? <span className="shrink-0 text-2xs text-muted-foreground/70">{meta}</span> : null}
      </span>
      {!disabled ? (
        <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground/60 transition-transform', expanded && 'rotate-90')} />
      ) : null}
    </>
  );

  return (
    // 不带任何流向外边距（2026-08-04 统一节奏）：块间距一律由容器（ai_bubble 的
    // flex gap / 虚拟行 ROW_GAP / 节内 gap）承担，元素自补 margin 是旧补偿体系的乱源。
    <div className={className}>
      <div className="flex items-center gap-2">
        {disabled ? (
          <div className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left">{content}</div>
        ) : (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className="group flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1 text-left"
          >
            {content}
          </button>
        )}
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {expanded && children ? (
        <div className="ml-[7px] mt-2.5 border-l border-border/50 py-1 pl-5">{children}</div>
      ) : null}
    </div>
  );
}
