import { useState } from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CompactionMessageItem } from '@/lib/compaction';

interface CompactionDividerProps {
  item: CompactionMessageItem;
  /** 仅调试用户可见「查看摘要」展开按钮（判定与 MessageList 其余 debugMode 用法一致） */
  debugMode?: boolean;
}

/**
 * 上下文压缩渲染单元（非气泡）：
 * - running：状态条「正在压缩上下文…」，spinner 风格与现有 loading 一致
 * - done：普通模式仅显示水平分界线；
 *   debugMode 用户可查看压缩条数，并展开摘要正文（与思考块的 code-preview 展示一致）
 */
export function CompactionDivider({ item, debugMode }: CompactionDividerProps) {
  const [expanded, setExpanded] = useState(false);

  if (item.status === 'running') {
    return (
      <div className="flex items-center justify-center gap-1.5 py-0.5 text-sm text-muted-foreground">
        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground/70" />
        <span>正在压缩上下文</span>
        <span className="animate-pulse">...</span>
      </div>
    );
  }

  if (debugMode !== true) {
    return <div className="h-px bg-border" aria-hidden="true" />;
  }

  const label = typeof item.coveredEventCount === 'number' && item.coveredEventCount > 0
    ? `已压缩 ${item.coveredEventCount} 条历史消息`
    : '上下文已压缩';
  const canExpand = !!item.summary;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-border" aria-hidden="true" />
        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          {label}
          {canExpand && (
            <button
              type="button"
              onClick={() => setExpanded(v => !v)}
              className="flex items-center gap-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              查看摘要
              <ChevronRight
                className={cn('size-3 shrink-0 transition-transform', expanded && 'rotate-90')}
              />
            </button>
          )}
        </span>
        <div className="h-px flex-1 bg-border" aria-hidden="true" />
      </div>
      {canExpand && expanded && (
        <pre className="code-preview mt-1">{item.summary}</pre>
      )}
    </div>
  );
}
