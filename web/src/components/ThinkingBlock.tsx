import { useState } from "react";
import { Brain, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { activityStatusBadgeClass, activityStatusIconClass, formatActivityDuration } from "./activityStatusStyles";

interface ThinkingBlockProps {
  content: string;
  streaming?: boolean;
  durationMs?: number;
}

export function ThinkingBlock({ content, streaming, durationMs }: ThinkingBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const duration = formatActivityDuration(durationMs);

  return (
    <div className="my-0.5">
      <button
        onClick={() => setIsExpanded(v => !v)}
        className="flex items-center gap-1.5 py-0.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <Brain className={activityStatusIconClass(streaming ? "active" : "neutral", "h-3.5 w-3.5 shrink-0")} />
        <span className="min-w-0 truncate">
          {streaming ? "思考中" : "已思考"}
          {streaming && <span className="animate-pulse">...</span>}
        </span>
        <span className={activityStatusBadgeClass(streaming ? "active" : "success")}>
          {streaming ? "思考中" : duration ? `已完成 ${duration}` : "已完成"}
        </span>
        <ChevronRight className={cn(
          "h-3.5 w-3.5 shrink-0 transition-transform",
          isExpanded && "rotate-90",
        )} />
      </button>
      {isExpanded && (
        <pre className="code-preview mt-1">
          {content}
        </pre>
      )}
    </div>
  );
}
