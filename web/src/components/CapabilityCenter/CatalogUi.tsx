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
        "flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-brand-50 text-base font-semibold text-brand-700 ring-1 ring-inset ring-brand-100 dark:bg-brand-900/35 dark:text-brand-200 dark:ring-brand-800",
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
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="h-10 rounded-xl bg-card pl-9 shadow-sm"
          />
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {filters && activeFilter && onFilterChange ? (
        <div className="flex gap-1 overflow-x-auto pb-1" aria-label="能力来源筛选">
          {filters.map((filter) => (
            <button
              key={filter.value}
              type="button"
              className={cn(
                "shrink-0 rounded-lg px-3 py-1.5 text-sm transition-colors",
                activeFilter === filter.value
                  ? "bg-foreground font-medium text-background"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
              onClick={() => onFilterChange(filter.value)}
            >
              {filter.label}
              {typeof filter.count === "number" ? <span className="ml-1 text-xs opacity-70">{filter.count}</span> : null}
            </button>
          ))}
        </div>
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
