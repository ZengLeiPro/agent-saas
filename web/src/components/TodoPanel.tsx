import { useEffect, useMemo, useState } from "react";
import { CircleCheck, ChevronDown, CircleDashed, Loader2 } from "lucide-react";
import { extractLatestTodos } from "@agent/shared";
import type { MessageItem, TodoItem, TodoStatus } from "@agent/shared";

import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/useIsMobile";
import { activityStatusIconClass, activityStatusTextClass } from "./activityStatusStyles";

interface TodoPanelProps {
  messages: MessageItem[];
  sessionId?: string | null;
  runActive?: boolean;
}

function getStatusTone(status: TodoStatus, runActive = true) {
  if (status === "completed") return "success";
  if (status === "in_progress" && runActive) return "active";
  return "neutral";
}

function TodoStatusIcon({
  status,
  runActive = true,
  className,
}: {
  status: TodoStatus;
  runActive?: boolean;
  className?: string;
}) {
  const baseClass = cn("size-4 shrink-0", className);

  if (status === "completed") {
    return <CircleCheck className={activityStatusIconClass("success", baseClass)} />;
  }

  if (status === "in_progress" && runActive) {
    return <Loader2 className={activityStatusIconClass("active", cn(baseClass, "animate-spin"))} />;
  }

  return <CircleDashed className={activityStatusIconClass("neutral", baseClass)} />;
}

function buildSummary(todos: TodoItem[], runActive: boolean) {
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
      text: runActive ? activeTodo.activeForm || activeTodo.content : `停留在：${activeTodo.content}`,
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

export function TodoPanel({ messages, sessionId, runActive = false }: TodoPanelProps) {
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

  const summary = buildSummary(todos, runActive);
  const summaryActive = summary.status === "in_progress" && runActive;

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
          <TodoStatusIcon status={summary.status} runActive={runActive} />
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              activityStatusTextClass(getStatusTone(summary.status, runActive)),
              summaryActive && "font-medium",
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
              "size-4 shrink-0 text-muted-foreground transition-transform",
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
                const active = todo.status === "in_progress" && runActive;
                const tone = getStatusTone(todo.status, runActive);
                return (
                  <li key={`${todo.status}-${index}-${todo.content}`} className="flex min-h-7 items-start gap-2">
                    <TodoStatusIcon status={todo.status} runActive={runActive} className="mt-0.5 size-3.5" />
                    <span
                      className={cn(
                        "min-w-0 flex-1 break-words leading-6",
                        activityStatusTextClass(tone),
                        todo.status === "completed" && "line-through opacity-75",
                        active && "font-medium",
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
