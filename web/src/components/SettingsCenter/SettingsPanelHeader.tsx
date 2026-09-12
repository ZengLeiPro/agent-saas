import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * 设置类面板的内容区宽度。
 *
 * 抽成常量而不是各处写 `max-w-5xl`：改造前 AdminShells、SystemSettingsPanel、
 * UsageDashboard 三处各写一遍，改宽度得记得同时改三处，漏一处就会出现同一个
 * 抽屉里两块内容左右边界对不齐。
 *
 * 默认取 6xl（72rem）：在 1366px 及以上桌面多利用一档横向空间，同时小屏仍由
 * 外层 padding 和 w-full 自适应。表单内部继续自行约束字段宽度，避免输入框无意义拉长。
 * 数据密集型页面（列表 / 看板 / trace）不适用，那些走 fullWidth。
 */
export const SETTINGS_CONTENT_WIDTH = "mx-auto w-full max-w-6xl";

interface SettingsPanelHeaderProps {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

const StickyHeaderContext = createContext(false);

const HeaderPortalContext = createContext<HTMLElement | null | undefined>(undefined);

export function SettingsPanelHeaderStickyProvider({ children }: { children: ReactNode }) {
  return <StickyHeaderContext.Provider value>{children}</StickyHeaderContext.Provider>;
}

/**
 * 管理工作区由外层壳统一渲染标题时，子页面仍可声明自己的 actions。
 * 子页面标题会被收口，actions 则挂载到壳级标题右侧，避免重复标题和操作丢失。
 */
export function SettingsPanelHeaderPortalProvider({ target, children }: { target: HTMLElement | null; children: ReactNode }) {
  return <HeaderPortalContext.Provider value={target}>{children}</HeaderPortalContext.Provider>;
}

/**
 * 设置中心各子面板统一的标题区。
 * 标题位置抬高与左侧大标题对齐（外层 main 用 pt-5），描述常驻在标题下方，
 * 同时保留 Info 按钮供键盘/触屏用户展开完整说明。右侧 actions 插槽保持不变。
 */
export function SettingsPanelHeader({ title, description, actions, className }: SettingsPanelHeaderProps) {
  const sticky = useContext(StickyHeaderContext);
  const headerPortal = useContext(HeaderPortalContext);

  if (headerPortal !== undefined) {
    return actions && headerPortal ? createPortal(actions, headerPortal) : null;
  }

  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4",
        sticky ? "mb-4 shrink-0 md:mb-6 md:pr-10" : "mb-4 md:mb-6",
        className,
      )}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <h2 className="truncate text-xl font-semibold tracking-tight md:text-2xl">{title}</h2>
          {description ? <DescriptionTip description={description} /> : null}
        </div>
        {description ? (
          <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2 pt-0.5">{actions}</div> : null}
    </div>
  );
}

export function DescriptionTip({ description }: { description: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="查看说明"
        >
          <Info className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="right" align="center" className="w-max max-w-sm text-xs leading-5">
        {description}
      </PopoverContent>
    </Popover>
  );
}
