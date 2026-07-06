import { type ReactNode } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function MetricCard({
  title,
  value,
  description,
  tone = "default",
  onClick,
}: {
  title: string;
  value: ReactNode;
  description?: ReactNode;
  tone?: "default" | "good" | "warn" | "bad";
  onClick?: () => void;
}) {
  const toneClass = tone === "bad"
    ? "text-destructive"
    : tone === "warn"
      ? "text-amber-700 dark:text-amber-300"
      : tone === "good"
        ? "text-emerald-700 dark:text-emerald-300"
        : "";
  return (
    <Card
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      className={cn(onClick && "cursor-pointer transition-colors hover:bg-muted/30")}
      onClick={onClick}
      onKeyDown={(event) => {
        if (!onClick) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
    >
      <CardHeader className="pb-2">
        <CardTitle className="text-sm text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className={cn("text-2xl font-semibold tabular-nums", toneClass)}>{value}</div>
        {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
      </CardContent>
    </Card>
  );
}
