import type { ReactNode } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * 能力中心表面语言
 *
 * 能力中心整体已被 DesktopLayout 套进一块浮动白框（bg-card + ring + 双层阴影），
 * 所以框内的任何区块都不再自带阴影——白底上叠白卡加阴影会糊成一片。
 * 统一规则：内部区块 = 圆角 xl + 极淡描边；只有可点的卡片在 hover 时才浮起来。
 * 工作流页（scenarios/*）与技能、连接器、专家目录共用这三档，别再各写各的。
 */
export const CAPABILITY_SURFACE = "rounded-xl bg-card ring-1 ring-border/60";
export const CAPABILITY_SURFACE_HOVER =
  "transition-all hover:-translate-y-0.5 hover:ring-brand-200 hover:shadow-[0_6px_18px_-8px_rgba(15,23,42,0.18)]";
/** 空态 / 提示位：不承载操作，用虚线描边而非实线，底色比白框略深一档 */
export const CAPABILITY_EMPTY_SURFACE = "rounded-xl border border-dashed border-border/70 bg-muted/20";
/** 框内次级容器（说明块、分组底）：无描边，仅靠底色与白框区分 */
export const CAPABILITY_SUBTLE_SURFACE = "rounded-xl bg-muted/40";

export type CapabilitySource = "platform" | "organization" | "personal";

const SOURCE_META: Record<CapabilitySource, { label: string; className: string }> = {
  platform: {
    label: "平台提供",
    className: "bg-brand-50 text-brand-700 dark:bg-brand-900/35 dark:text-brand-200",
  },
  organization: {
    label: "组织提供",
    className: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300",
  },
  personal: {
    label: "我创建的",
    className: "bg-muted text-muted-foreground",
  },
};

export function CapabilitySourceBadge({ source }: { source: CapabilitySource }) {
  const meta = SOURCE_META[source];
  return (
    <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium", meta.className)}>
      {meta.label}
    </span>
  );
}

export function CapabilityLogo({
  label,
  children,
  className,
}: {
  label: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-brand-50 text-base font-semibold text-brand-700 ring-1 ring-inset ring-brand-100 dark:bg-brand-900/35 dark:text-brand-200 dark:ring-brand-800",
        className,
      )}
      aria-hidden="true"
    >
      {children ?? label.trim().slice(0, 1).toUpperCase()}
    </span>
  );
}

export interface CatalogFilterOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

export function CapabilityFilterTabs<T extends string>({
  ariaLabel,
  options,
  value,
  onValueChange,
  className,
}: {
  ariaLabel: string;
  options: CatalogFilterOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        "flex gap-1.5 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={selected}
            className={cn(
              "shrink-0 rounded-full border border-transparent px-3 py-1.5 text-sm transition-colors",
              selected
                ? "bg-primary text-primary-foreground"
                : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
            onClick={() => onValueChange(option.value)}
          >
            {option.label}
            {typeof option.count === "number" ? <span className="ml-1 text-xs opacity-70">{option.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function CatalogHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {description ? <p className="mt-1 text-sm leading-5 text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function CatalogToolbar<T extends string>({
  query,
  onQueryChange,
  searchPlaceholder,
  filters,
  activeFilter,
  onFilterChange,
  actions,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  searchPlaceholder: string;
  filters?: CatalogFilterOption<T>[];
  activeFilter?: T;
  onFilterChange?: (filter: T) => void;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1 sm:max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            name="capability-catalog-search"
            autoComplete="off"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="h-10 rounded-xl border-transparent bg-muted/50 pl-9 shadow-none focus-visible:bg-card"
          />
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {filters && activeFilter && onFilterChange ? (
        <CapabilityFilterTabs
          ariaLabel="能力来源筛选"
          options={filters}
          value={activeFilter}
          onValueChange={onFilterChange}
        />
      ) : null}
    </div>
  );
}

export function CapabilityDetailDrawer({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        style={{ top: 0, bottom: 0 }}
        className="left-auto right-0 h-dvh w-[min(440px,100vw)] max-w-none translate-x-0 translate-y-0 content-start overflow-y-auto rounded-none border-y-0 border-r-0 p-0 data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:rounded-none"
      >
        <DialogHeader className="border-b px-6 py-5 pr-16">
          <DialogTitle className="text-xl">{title}</DialogTitle>
          {description ? <DialogDescription className="leading-6">{description}</DialogDescription> : null}
        </DialogHeader>
        <div className="space-y-5 px-6 py-5">{children}</div>
      </DialogContent>
    </Dialog>
  );
}
