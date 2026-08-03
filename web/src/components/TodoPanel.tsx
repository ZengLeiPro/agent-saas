import { useEffect, useMemo, useState } from "react";
import {
  ChevronUp,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock3,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import { extractLatestTodos } from "@agent/shared";
import type { MessageItem, TodoItem, TodoStatus } from "@agent/shared";

import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/useIsMobile";
import {
  activityStatusIconClass,
  activityStatusTextClass,
  type ActivityStatusTone,
} from "./activityStatusStyles";

interface TodoPanelProps {
  messages: MessageItem[];
  sessionId?: string | null;
  runActive?: boolean;
}

const STATUS_TONE: Record<TodoStatus, ActivityStatusTone> = {
  pending: "neutral",
  in_progress: "active",
  waiting: "pending",
  blocked: "danger",
  completed: "success",
  failed: "danger",
};

function getStatusTone(status: TodoStatus, runActive = true): ActivityStatusTone {
  if (status === "in_progress" && !runActive) return "neutral";
  return STATUS_TONE[status];
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
  const tone = getStatusTone(status, runActive);

  if (status === "completed") {
    return <CircleCheck className={activityStatusIconClass("success", baseClass)} />;
  }
  if (status === "in_progress" && runActive) {
    return <Loader2 className={activityStatusIconClass("active", cn(baseClass, "animate-spin"))} />;
  }
  if (status === "waiting") {
    return <Clock3 className={activityStatusIconClass("pending", baseClass)} />;
  }
  if (status === "blocked") {
    return <TriangleAlert className={activityStatusIconClass("danger", baseClass)} />;
  }
  if (status === "failed") {
    return <CircleX className={activityStatusIconClass("danger", baseClass)} />;
  }
  return <CircleDashed className={activityStatusIconClass(tone, baseClass)} />;
}

function buildSummary(todos: TodoItem[], runActive: boolean) {
  const total = todos.length;
  const completed = todos.filter((todo) => todo.status === "completed").length;
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

  const highlighted = todos.find((todo) => todo.status === "failed")
    ?? todos.find((todo) => todo.status === "blocked")
    ?? todos.find((todo) => todo.status === "waiting")
    ?? todos.find((todo) => todo.status === "in_progress")
    ?? todos.find((todo) => todo.status === "pending");

  if (!highlighted) {
    return {
      status: "pending" as TodoStatus,
      text: "任务清单待开始",
      completed,
      total,
      allCompleted,
    };
  }

  const text = highlighted.status === "in_progress"
    ? runActive
      ? highlighted.activeForm || highlighted.content
      : `停留在：${highlighted.content}`
    : highlighted.status === "waiting"
      ? `等待：${highlighted.content}`
      : highlighted.status === "blocked"
        ? `已阻断：${highlighted.content}`
        : highlighted.status === "failed"
          ? `失败：${highlighted.content}`
          : `等待开始：${highlighted.content}`;

  return {
    status: highlighted.status,
    text,
    completed,
    total,
    allCompleted,
  };
}

function SimpleTodoItem({ todo, runActive }: { todo: TodoItem; runActive: boolean }) {
  const active = todo.status === "in_progress" && runActive;
  const tone = getStatusTone(todo.status, runActive);

  return (
    <li className="flex min-h-7 items-start gap-2">
      <TodoStatusIcon status={todo.status} runActive={runActive} className="mt-[3px] size-3.5" />
      <span
        className={cn(
          "min-w-0 flex-1 break-words leading-5",
          activityStatusTextClass(tone),
          todo.status === "completed" && "opacity-75",
          active && "font-medium",
        )}
        title={todo.content}
      >
        {todo.content}
      </span>
    </li>
  );
}

export function TodoPanel({ messages, sessionId, runActive = false }: TodoPanelProps) {
  // 全量 todos（含 business 步骤）：TodoPanel 是常驻总览导航（吸附在输入框上方），
  // 流内的业务步骤事件负责叙事，这里负责「我在哪、还剩什么」。
  const todos = useMemo(() => {
    const latest = extractLatestTodos(messages);
    return latest?.length ? latest : null;
  }, [messages]);
  const isMobile = useIsMobile();
  const sessionKey = sessionId || "__local__";
  const [expandedBySession, setExpandedBySession] = useState<Record<string, boolean>>({});
  const expanded = expandedBySession[sessionKey] ?? false;

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

  if (!todos) return null;

  const summary = buildSummary(todos, runActive);
  const summaryActive = summary.status === "in_progress" && runActive;

  return (
    <div className="relative z-0 mx-6 -mb-px">
      <div
        // 视觉纪律：容器不承状态色（无整条绿/红填充），状态语义由 icon 与文字色表达。
        className="overflow-hidden rounded-t-lg rounded-b-none border bg-card text-sm shadow-sm transition-colors"
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
              [sessionKey]: !expanded,
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
          <ChevronUp
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-180",
            )}
          />
        </button>

        <div
          className={cn(
            "overflow-hidden transition-all duration-150 ease-out",
            expanded ? "max-h-56 opacity-100" : "max-h-0 opacity-0",
          )}
          aria-hidden={!expanded}
        >
          <div className="border-t border-border px-3 py-2">
            <ul className="max-h-48 space-y-1 overflow-y-auto pr-1">
              {todos.map((todo, index) => (
                <SimpleTodoItem key={todo.id || `${todo.status}-${index}-${todo.content}`} todo={todo} runActive={runActive} />
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
