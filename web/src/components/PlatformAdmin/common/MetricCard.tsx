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
      ? "text-warning-ink"
      : tone === "good"
        ? "text-success-ink"
        : "";
  return (
    <Card
      density="compact"
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      className={cn(onClick && "cursor-pointer transition-colors hover:bg-muted/50")}
      onClick={onClick}
      onKeyDown={(event) => {
        if (!onClick) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
    >
      <CardHeader className="pb-1.5">
        <CardTitle className="text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className={cn("text-2xl font-semibold tabular-nums", toneClass)}>{value}</div>
        {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
      </CardContent>
    </Card>
  );
}
