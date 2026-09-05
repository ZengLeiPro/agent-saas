import type { ActivityStatusTone } from "@agent/shared";

import { cn } from "@/lib/utils";

// 语气枚举与耗时格式化已下沉 shared（PR #476），本文件只保留 Tailwind class 映射。
export { formatActivityDuration } from "@agent/shared";
export type { ActivityStatusTone };

const toneStyles: Record<ActivityStatusTone, { icon: string; text: string; badge: string }> = {
  active: {
    icon: "text-primary",
    text: "text-primary",
    badge: "border-primary/20 bg-primary/10 text-primary",
  },
  pending: {
    icon: "text-muted-foreground/70",
    text: "text-muted-foreground",
    badge: "border-border bg-muted text-muted-foreground",
  },
  success: {
    icon: "text-success",
    text: "text-success",
    badge: "border-success/20 bg-success/10 text-success",
  },
  warning: {
    icon: "text-warning",
    text: "text-warning",
    badge: "border-warning/25 bg-warning/10 text-warning",
  },
  danger: {
    icon: "text-destructive",
    text: "text-destructive",
    badge: "border-destructive/25 bg-destructive/10 text-destructive",
  },
  neutral: {
    icon: "text-muted-foreground/70",
    text: "text-muted-foreground",
    badge: "border-border bg-muted text-muted-foreground",
  },
};

export function activityStatusIconClass(tone: ActivityStatusTone, className?: string) {
  return cn(toneStyles[tone].icon, className);
}

export function activityStatusTextClass(tone: ActivityStatusTone, className?: string) {
  return cn(toneStyles[tone].text, className);
}

export function activityStatusBadgeClass(tone: ActivityStatusTone, className?: string) {
  return cn(
    "shrink-0 rounded border px-1.5 py-0.5 text-2xs leading-none",
    toneStyles[tone].badge,
    className,
  );
}
