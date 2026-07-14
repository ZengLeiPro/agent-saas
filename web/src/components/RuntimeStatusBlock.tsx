import { Clock, Loader2, Server, Shield, User } from "lucide-react";
import type { MessageItem } from "./types";
import { activityStatusIconClass, activityStatusTextClass, type ActivityStatusTone } from "./activityStatusStyles";

type RuntimeStatus = Extract<MessageItem, { type: "runtime_status" }>["status"];

function getRuntimeStatusMeta(status: RuntimeStatus): { label: string; icon: "loader" | "clock" | "server" | "shield" | "user" } {
  switch (status) {
    case "sending":
      return { label: "正在发送消息", icon: "loader" };
    case "queued":
      return { label: "已进入队列", icon: "clock" };
    case "running":
      return { label: "正在思考", icon: "loader" };
    case "waiting_hand":
      return { label: "正在准备工作区", icon: "server" };
    case "waiting_approval":
      return { label: "等待授权", icon: "shield" };
    case "waiting_user":
      return { label: "等待补充信息", icon: "user" };
    case "reconnecting":
      return { label: "正在恢复连接", icon: "loader" };
    default:
      return { label: "正在处理", icon: "loader" };
  }
}

function getRuntimeStatusTone(status: RuntimeStatus): ActivityStatusTone {
  switch (status) {
    case "queued":
      return "pending";
    case "waiting_approval":
    case "waiting_user":
      return "warning";
    case "sending":
    case "running":
    case "waiting_hand":
    case "reconnecting":
    default:
      return "active";
  }
}

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
    <div className="my-0.5 flex max-w-full items-center gap-1.5 py-0.5 text-sm text-muted-foreground">
      {icon}
      <span className={activityStatusTextClass(tone, "min-w-0 truncate")}>{content || meta.label}</span>
    </div>
  );
}
