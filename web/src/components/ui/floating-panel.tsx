import * as React from "react";

import { cn } from "@/lib/utils";

export const FLOATING_PANEL_SURFACE =
  "bg-card ring-1 ring-border/60 shadow-[0_2px_6px_rgba(15,23,42,0.05),0_10px_28px_-10px_rgba(15,23,42,0.10)]";

export const FloatingPanel = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("overflow-hidden rounded-xl", FLOATING_PANEL_SURFACE, className)} {...props} />
  ),
);
FloatingPanel.displayName = "FloatingPanel";
