import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
export { SETTINGS_CONTENT_WIDTH } from "@/components/SettingsCenter/settingsLayout";

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
 * 标题位置抬高与左侧大标题对齐（外层 main 用 pt-5）；页面说明只放进标题旁 Info，
 * hover / 键盘聚焦时显示，点击不会钉住。右侧 actions 插槽保持不变。
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
      </div>
      {actions ? <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2 pt-0.5">{actions}</div> : null}
    </div>
  );
}

export function DescriptionTip({ description }: { description: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="查看说明"
        onPointerEnter={() => setOpen(true)}
        onPointerLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onPointerDown={(event) => {
          // 鼠标点击不要聚焦，避免指针离开后因 focus 残留而钉住说明。
          event.preventDefault();
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <Info className="size-3.5" aria-hidden="true" />
      </button>
      {open ? (
        <span
          role="tooltip"
          className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 w-max max-w-sm -translate-y-1/2 rounded-md border bg-popover px-2.5 py-1.5 text-xs leading-5 text-popover-foreground shadow-md"
        >
          {description}
        </span>
      ) : null}
    </span>
  );
}
