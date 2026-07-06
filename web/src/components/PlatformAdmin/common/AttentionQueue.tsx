import { AlertTriangle, CheckCircle2 } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface AttentionItem {
  id: string;
  title: string;
  description?: string;
  severity: "critical" | "warning" | "info";
  actionLabel?: string;
  onAction?: () => void;
}

const severityClass: Record<AttentionItem["severity"], string> = {
  critical: "text-destructive",
  warning: "text-amber-700 dark:text-amber-300",
  info: "text-muted-foreground",
};

export function AttentionQueue({ items }: { items: AttentionItem[] }) {
  const sorted = [...items].sort((a, b) => {
    const rank = { critical: 0, warning: 1, info: 2 };
    return rank[a.severity] - rank[b.severity];
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">异常队列</CardTitle>
      </CardHeader>
      <CardContent>
        {sorted.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            暂无待处理异常
          </div>
        ) : (
          <div className="space-y-2">
            {sorted.map((item) => (
              <div key={item.id} className="flex items-start justify-between gap-3 rounded-lg border p-3">
                <div className="min-w-0">
                  <div className={cn("flex items-center gap-2 text-sm font-medium", severityClass[item.severity])}>
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    <span className="truncate">{item.title}</span>
                  </div>
                  {item.description && <div className="mt-1 text-xs text-muted-foreground">{item.description}</div>}
                </div>
                {item.actionLabel && item.onAction && (
                  <Button variant="outline" size="sm" className="shrink-0" onClick={item.onAction}>
                    {item.actionLabel}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
