import { Clock, Loader2, Server, Shield, User } from "lucide-react";
import type { MessageItem } from "./types";

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

export function RuntimeStatusBlock({ status, content }: { status: RuntimeStatus; content?: string }) {
  const meta = getRuntimeStatusMeta(status);
  const iconClass = "h-3.5 w-3.5 shrink-0";
  const icon = meta.icon === "clock"
    ? <Clock className={iconClass} />
    : meta.icon === "server"
      ? <Server className={`${iconClass} text-primary`} />
      : meta.icon === "shield"
        ? <Shield className={`${iconClass} text-primary`} />
        : meta.icon === "user"
          ? <User className={`${iconClass} text-primary`} />
          : <Loader2 className={`${iconClass} animate-spin text-primary`} />;

  return (
    <div className="my-0.5 flex max-w-full items-center gap-1.5 py-0.5 text-sm text-muted-foreground">
      {icon}
      <span className="min-w-0 truncate">{content || meta.label}</span>
    </div>
  );
}
