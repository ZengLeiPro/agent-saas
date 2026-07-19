import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";

interface SettingsPanelHeaderProps {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

const StickyHeaderContext = createContext(false);

export function SettingsPanelHeaderStickyProvider({ children }: { children: ReactNode }) {
  return <StickyHeaderContext.Provider value>{children}</StickyHeaderContext.Provider>;
}

/**
 * 设置中心各子面板统一的标题区。
 * 标题位置抬高与左侧大标题对齐（外层 main 用 pt-5），描述统一收敛到标题右侧的 Info 图标按钮，
 * hover 或点击展开气泡。右侧 actions 插槽保持不变，并预留关闭按钮空间。
 */
export function SettingsPanelHeader({
  title,
  description,
  actions,
  className,
}: SettingsPanelHeaderProps) {
  const sticky = useContext(StickyHeaderContext);

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3",
        sticky
          ? "mb-4 shrink-0 md:mb-6 md:pr-10"
          : "mb-4 md:mb-6 md:pr-10",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <h2 className="truncate text-xl font-semibold tracking-tight md:text-2xl">{title}</h2>
        {description ? <DescriptionTip description={description} /> : null}
      </div>
      {actions ? (
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">{actions}</div>
      ) : null}
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
        onClick={() => setOpen(v => !v)}
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
