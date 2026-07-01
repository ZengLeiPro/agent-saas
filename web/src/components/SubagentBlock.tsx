import { Bot, CheckCircle2, Loader2 } from "lucide-react";
import { activityStatusIconClass } from "./activityStatusStyles";

interface SubagentBlockProps {
  agentType: string;
  status: "running" | "completed";
}

export function SubagentBlock({ agentType, status }: SubagentBlockProps) {
  return (
    <div className="my-0.5 flex items-center gap-1.5 py-0.5 text-sm text-muted-foreground">
      <Bot className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 truncate">子任务 {agentType}</span>
      {status === "running" ? (
        <Loader2 className={activityStatusIconClass("active", "ml-auto h-3.5 w-3.5 shrink-0 animate-spin")} />
      ) : (
        <CheckCircle2 className={activityStatusIconClass("success", "ml-auto h-3.5 w-3.5 shrink-0")} />
      )}
    </div>
  );
}
