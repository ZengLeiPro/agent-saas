import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * `containerClassName` 用于给滚动容器加 `max-h-*`。
 * 只有容器高度受限时 `TableHeader` 的 sticky 才会生效——不传就退化为整页滚动，
 * 行为与改造前完全一致。
 *
 * `data-admin-table` 供 index.css 挂中英混排规则（th/td keep-all、th nowrap）。
 */
function Table({
  className,
  containerClassName,
  ...props
}: React.ComponentProps<"table"> & { containerClassName?: string }) {
  return (
    <div className={cn("relative w-full overflow-auto", containerClassName)}>
      <table
        data-admin-table=""
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  );
}

/**
 * 粘性表头：滚到第 50 / 100 行时仍能看到列含义。
 * Tailwind preflight 默认 `border-collapse: collapse`，此时 sticky thead 的下边框
 * 会被滚动内容盖掉，因此额外用 th 的 inset 阴影补一条线——不滚动时它与
 * tr 的 border-b 重合在同一像素，视觉上无变化。
 */
function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      className={cn(
        "sticky top-0 z-10 bg-card [&_th]:shadow-[inset_0_-1px_0_0_hsl(var(--border))] [&_tr]:border-b",
        className
      )}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      className={cn("border-t bg-muted/50 font-medium [&>tr]:last:border-b-0", className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      className={cn(
        "border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted",
        className
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      className={cn(
        "h-10 px-2 text-left align-middle font-medium text-muted-foreground [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      className={cn("p-2 align-middle [&:has([role=checkbox])]:pr-0", className)}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption className={cn("mt-4 text-sm text-muted-foreground", className)} {...props} />
  );
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
};
