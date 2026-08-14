import { useState } from "react";
import { Clock, Loader2, Pencil, RotateCcw, X } from "lucide-react";
import type { QueuedInterjection } from "@/hooks/useChatAppState";
import { cn } from "@/lib/utils";

/**
 * 插话队列区（2026-08-04 终态设计）。
 *
 * 运行中发送的消息不进时间线，在输入框上方排队展示；被目标 run 消费或回退接管时
 * 由上层状态移除并进入时间线。条目支持撤回/编辑（排队中）与重发/移除（已取消/失败）。
 */
export function QueuedMessageBar({
  entries,
  onCancel,
  onEdit,
  onResend,
  onDismiss,
}: {
  entries: QueuedInterjection[];
  onCancel: (clientMsgId: string) => Promise<boolean>;
  onEdit: (clientMsgId: string) => Promise<void>;
  onResend: (clientMsgId: string) => void;
  onDismiss: (clientMsgId: string) => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [lateId, setLateId] = useState<string | null>(null);
  if (entries.length === 0) return null;

  const withBusy = async (clientMsgId: string, run: () => Promise<boolean | void>) => {
    if (busyId) return;
    setBusyId(clientMsgId);
    try {
      const result = await run();
      if (result === false) {
        // 撤回失败（已被消费）：提示一下，条目随后会被消费信号自然移除
        setLateId(clientMsgId);
        setTimeout(() => setLateId((current) => (current === clientMsgId ? null : current)), 3000);
      }
    } finally {
      setBusyId((current) => (current === clientMsgId ? null : current));
    }
  };

  return (
    <div className="space-y-1.5" data-testid="queued-message-bar">
      {entries.map((entry) => {
        const isPendingState = entry.status === "sending" || entry.status === "verifying" || entry.status === "queued";
        const isBusy = busyId === entry.clientMsgId;
        const statusLabel = entry.status === "sending"
          ? "发送中"
          : entry.status === "verifying"
            ? (entry.reason || "正在核验服务端状态")
            : entry.status === "queued"
              ? entry.deliveryMode === "steer"
                ? "显式插话，将在安全边界处理"
                : `已排队${entry.queuePosition ? ` · 第 ${entry.queuePosition} 位` : ""}`
              : entry.status === "cancelled"
                ? (entry.reason || "已撤销")
                : (entry.reason || "发送失败");
        return (
          <div
            key={entry.clientMsgId}
            className={cn(
              "flex items-center gap-2 rounded-xl border px-3 py-2 text-sm",
              isPendingState
                ? "border-border/70 bg-muted/50"
                : "border-border/50 bg-muted/30 opacity-80",
            )}
          >
            {entry.status === "sending" || entry.status === "verifying" ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground/70" />
            ) : (
              <Clock className={cn("size-3.5 shrink-0", isPendingState ? "text-muted-foreground" : "text-muted-foreground/50")} />
            )}
            <span className={cn("min-w-0 flex-1 truncate", !isPendingState && "line-through decoration-muted-foreground/40")}>
              {entry.content}
              {entry.attachments && entry.attachments.length > 0 && (
                <span className="ml-1 text-xs text-muted-foreground">（{entry.attachments.length} 个附件）</span>
              )}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {lateId === entry.clientMsgId ? "已开始处理，无法撤回" : statusLabel}
            </span>
            <div className="flex shrink-0 items-center gap-1">
              {entry.status === "queued" && (
                <>
                  <button
                    type="button"
                    title="编辑（撤回并放回输入框）"
                    disabled={isBusy}
                    onClick={() => void withBusy(entry.clientMsgId, async () => {
                      await onEdit(entry.clientMsgId);
                    })}
                    className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/[0.08] hover:text-foreground disabled:opacity-50"
                  >
                    {isBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Pencil className="size-3.5" />}
                  </button>
                  <button
                    type="button"
                    title="撤回"
                    disabled={isBusy}
                    onClick={() => void withBusy(entry.clientMsgId, () => onCancel(entry.clientMsgId))}
                    className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/[0.08] hover:text-foreground disabled:opacity-50"
                  >
                    <X className="size-3.5" />
                  </button>
                </>
              )}
              {(entry.status === "cancelled" || entry.status === "failed") && (
                <>
                  <button
                    type="button"
                    title="重新发送"
                    onClick={() => onResend(entry.clientMsgId)}
                    className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
                  >
                    <RotateCcw className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    title="移除"
                    onClick={() => onDismiss(entry.clientMsgId)}
                    className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
