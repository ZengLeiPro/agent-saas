import { Clock, Loader2, Server, Shield, User } from "lucide-react";
import { getRuntimeStatusMeta, getRuntimeStatusTone } from "@agent/shared";
import type { RuntimeStatus } from "@agent/shared";
import { activityStatusIconClass, activityStatusTextClass } from "./activityStatusStyles";

export function RuntimeStatusBlock({ status, content }: { status: RuntimeStatus; content?: string }) {
  const meta = getRuntimeStatusMeta(status);
  const tone = status === "running" ? "neutral" : getRuntimeStatusTone(status);
  const iconClass = "size-3.5 shrink-0";
  const icon = meta.icon === "clock"
    ? <Clock className={activityStatusIconClass(tone, iconClass)} />
    : meta.icon === "server"
      ? <Server className={activityStatusIconClass(tone, iconClass)} />
      : meta.icon === "shield"
        ? <Shield className={activityStatusIconClass(tone, iconClass)} />
        : meta.icon === "user"
          ? <User className={activityStatusIconClass(tone, iconClass)} />
          : <Loader2 className={activityStatusIconClass(tone, `${iconClass} animate-spin`)} />;

  return (
    <div className="flex max-w-full items-center gap-1.5 py-0.5 text-sm text-muted-foreground">
      {icon}
      <span className={activityStatusTextClass(tone, "min-w-0 truncate")}>{content || meta.label}</span>
    </div>
  );
}
