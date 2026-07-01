import { useState } from "react";
import { Brain, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { activityStatusIconClass, activityStatusTextClass } from "./activityStatusStyles";

interface ThinkingBlockProps {
  content: string;
  streaming?: boolean;
}

export function ThinkingBlock({ content, streaming }: ThinkingBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const tone = streaming ? "active" : "success";

  return (
    <div className="my-0.5">
      <button
        onClick={() => setIsExpanded(v => !v)}
        className="flex items-center gap-1.5 py-0.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <Brain className={activityStatusIconClass(tone, "h-3.5 w-3.5 shrink-0")} />
        <span className={activityStatusTextClass(tone, "min-w-0 truncate")}>
          {streaming ? "思考中" : "已思考"}
          {streaming && <span className="animate-pulse">...</span>}
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
