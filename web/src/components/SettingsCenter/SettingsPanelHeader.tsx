import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";

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
 * 标题位置抬高与左侧大标题对齐（外层 main 用 pt-5），描述统一收敛到标题右侧的 Info 图标按钮，
 * hover 或点击展开气泡。右侧 actions 插槽保持不变，并预留关闭按钮空间。
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
        "flex items-center justify-between gap-3",
        sticky ? "mb-4 shrink-0 md:mb-6 md:pr-10" : "mb-4 md:mb-6 md:pr-10",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <h2 className="truncate text-xl font-semibold tracking-tight md:text-2xl">{title}</h2>
        {description ? <DescriptionTip description={description} /> : null}
      </div>
      {actions ? <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">{actions}</div> : null}
    </div>
  );
}

export function DescriptionTip({ description }: { description: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const visible = open || hover;

  return (
    <span
      ref={containerRef}
      className="relative inline-flex shrink-0"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
          open && "bg-accent text-foreground",
        )}
        aria-label="查看说明"
        aria-expanded={visible}
      >
        <Info className="size-3.5" />
      </button>
      {visible && (
        <div
          role="tooltip"
          className="absolute left-full top-1/2 z-30 ml-2 w-max max-w-sm -translate-y-1/2 rounded-lg border bg-popover px-3 py-2 text-xs leading-5 text-popover-foreground shadow-lg"
        >
          {description}
        </div>
      )}
    </span>
  );
}
