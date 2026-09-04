import type { ReactNode } from 'react';
import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * 能力中心统一页头（09-04 曾磊定稿）：只露大标题；页面说明默认不占版面，
 * 收进标题右侧的信息按钮里，hover / 聚焦时以 tooltip 显示。
 *
 * 独立成文件而不放在 CatalogUi：CatalogUi 的表面常量被聊天主视图（空会话推荐位）引用，
 * 页头一旦同文件就会把 radix Tooltip 一起拖进启动包（CI web startup 预算实测超 5KB gzip）。
 */
export function CatalogHeader({
  title,
  description,
  actions,
  level = 2,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  /** 页面级入口用 1（与旧自写页头的 h1 对齐），分区标题保持 2 */
  level?: 1 | 2;
}) {
  const Heading = level === 1 ? 'h1' : 'h2';
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-1.5">
        <Heading className="truncate text-xl font-semibold tracking-tight">{title}</Heading>
        {description ? (
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="页面说明"
                  className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
                >
                  <Info className="size-4" aria-hidden="true" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="start" className="max-w-xs leading-5">
                {description}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
