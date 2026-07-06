import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronDown, CircleDashed, Loader2 } from "lucide-react";
import { extractLatestTodos } from "@agent/shared";
import type { MessageItem, TodoItem, TodoStatus } from "@agent/shared";

import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/useIsMobile";
import { activityStatusIconClass, activityStatusTextClass } from "./activityStatusStyles";

interface TodoPanelProps {
  messages: MessageItem[];
  sessionId?: string | null;
}

function getStatusTone(status: TodoStatus) {
  if (status === "completed") return "success";
  if (status === "in_progress") return "active";
  return "neutral";
}

function TodoStatusIcon({ status, className }: { status: TodoStatus; className?: string }) {
  const baseClass = cn("h-4 w-4 shrink-0", className);

  if (status === "completed") {
    return <CheckCircle2 className={activityStatusIconClass("success", baseClass)} />;
  }

  if (status === "in_progress") {
    return <Loader2 className={activityStatusIconClass("active", cn(baseClass, "animate-spin"))} />;
  }

  return <CircleDashed className={activityStatusIconClass("neutral", baseClass)} />;
}

function buildSummary(todos: TodoItem[]) {
  const total = todos.length;
  const completed = todos.filter((todo) => todo.status === "completed").length;
  const activeTodo = todos.find((todo) => todo.status === "in_progress");
  const pendingTodo = todos.find((todo) => todo.status === "pending");
  const allCompleted = total > 0 && completed === total;

  if (allCompleted) {
    return {
      status: "completed" as TodoStatus,
      text: `已完成 ${total} 项任务`,
      completed,
      total,
      allCompleted,
    };
  }

  if (activeTodo) {
    return {
      status: "in_progress" as TodoStatus,
      text: activeTodo.activeForm || activeTodo.content,
      completed,
      total,
      allCompleted,
    };
  }

  return {
    status: "pending" as TodoStatus,
    text: pendingTodo ? `等待开始：${pendingTodo.content}` : "任务清单待开始",
    completed,
    total,
    allCompleted,
  };
}

export function TodoPanel({ messages, sessionId }: TodoPanelProps) {
  const todos = useMemo(() => extractLatestTodos(messages), [messages]);
  const isMobile = useIsMobile();
  const sessionKey = sessionId || "__local__";
  const [expandedBySession, setExpandedBySession] = useState<Record<string, boolean>>({});

  const expanded = Boolean(expandedBySession[sessionKey]);

  useEffect(() => {
    if (!isMobile) return;

    const handleFocusIn = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLTextAreaElement)) return;
      setExpandedBySession((prev) => (
        prev[sessionKey] ? { ...prev, [sessionKey]: false } : prev
      ));
    };

    document.addEventListener("focusin", handleFocusIn);
    return () => document.removeEventListener("focusin", handleFocusIn);
  }, [isMobile, sessionKey]);

  if (!todos || todos.length === 0) return null;

  const summary = buildSummary(todos);

  return (
    <div className="content-container pt-2">
      <div
        className={cn(
          "overflow-hidden rounded-lg border bg-card text-sm shadow-sm transition-colors",
          summary.allCompleted && "border-success/25 bg-success/5",
        )}
        aria-live="polite"
      >
        <button
          type="button"
          className="flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/40"
          aria-expanded={expanded}
          aria-label={expanded ? "收起任务清单" : "展开任务清单"}
          onClick={() => {
            setExpandedBySession((prev) => ({
              ...prev,
              [sessionKey]: !Boolean(prev[sessionKey]),
            }));
          }}
        >
          <TodoStatusIcon status={summary.status} />
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              activityStatusTextClass(getStatusTone(summary.status)),
              summary.status === "in_progress" && "font-medium",
            )}
            title={summary.text}
          >
            {summary.text}
          </span>
          <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
            {summary.completed}/{summary.total}
          </span>
          <ChevronDown
            className={cn(
              "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-180",
            )}
          />
        </button>

        <div
          className={cn(
            "overflow-hidden transition-all duration-150 ease-out",
            expanded
              ? cn("opacity-100", isMobile ? "max-h-48" : "max-h-56")
              : "max-h-0 opacity-0",
          )}
          aria-hidden={!expanded}
        >
          <div className="border-t border-border px-3 py-2">
            <ul className={cn("space-y-1 overflow-y-auto pr-1", isMobile ? "max-h-40" : "max-h-48")}>
              {todos.map((todo, index) => {
                const tone = getStatusTone(todo.status);
                return (
                  <li key={`${todo.status}-${index}-${todo.content}`} className="flex min-h-7 items-start gap-2">
                    <TodoStatusIcon status={todo.status} className="mt-0.5 h-3.5 w-3.5" />
                    <span
                      className={cn(
                        "min-w-0 flex-1 break-words leading-6",
                        activityStatusTextClass(tone),
                        todo.status === "completed" && "line-through opacity-75",
                        todo.status === "in_progress" && "font-medium",
                      )}
                      title={todo.content}
                    >
                      {todo.content}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
