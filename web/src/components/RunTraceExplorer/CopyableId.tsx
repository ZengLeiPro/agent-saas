import { useCallback, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { shortId } from "./format";

/**
 * 截断显示 + 点击复制的 id（runId / sessionId 等）。
 * 复制成功后短暂显示对勾反馈。
 */
export function CopyableId({
  value,
  len = 8,
  className,
}: {
  value: string | null | undefined;
  len?: number;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      if (!value) return;
      void navigator.clipboard
        .writeText(value)
        .then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        })
        .catch(() => {
          // 剪贴板不可用（如非 https）时静默失败
        });
    },
    [value],
  );

  if (!value) return <span className={cn("text-muted-foreground", className)}>—</span>;

  return (
    <button
      type="button"
      onClick={onCopy}
      title={`点击复制：${value}`}
      className={cn(
        "inline-flex items-center gap-1 rounded px-1 font-mono text-xs hover:bg-accent hover:text-foreground",
        className,
      )}
    >
      <span className="tabular-nums">{shortId(value, len)}</span>
      {copied ? (
        <Check className="h-3 w-3 shrink-0 text-emerald-600" />
      ) : (
        <Copy className="h-3 w-3 shrink-0 opacity-50" />
      )}
    </button>
  );
}
