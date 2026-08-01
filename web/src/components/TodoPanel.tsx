import { useEffect, useMemo, useState } from "react";
import {
  ChevronUp,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock3,
  Loader2,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import {
  extractLatestTodos,
  extractTodoToolActivities,
  isRichTodo,
  todoItemKey,
} from "@agent/shared";
import type {
  MessageItem,
  TodoItem,
  TodoStatus,
  TodoToolActivity,
} from "@agent/shared";

import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/useIsMobile";
import {
  activityStatusBadgeClass,
  activityStatusIconClass,
  activityStatusTextClass,
  type ActivityStatusTone,
} from "./activityStatusStyles";
import { PresentationDetail } from "./PresentationDetail";
import { PresentationBlocks } from "./presentation/PresentationBlocks";

interface TodoPanelProps {
  messages: MessageItem[];
  sessionId?: string | null;
  runActive?: boolean;
}

const STATUS_META: Record<TodoStatus, { label: string; tone: ActivityStatusTone }> = {
  pending: { label: "待开始", tone: "neutral" },
  in_progress: { label: "进行中", tone: "active" },
  waiting: { label: "等待中", tone: "pending" },
  blocked: { label: "已阻断", tone: "danger" },
  completed: { label: "已完成", tone: "success" },
  failed: { label: "失败", tone: "danger" },
};

function getStatusTone(status: TodoStatus, runActive = true): ActivityStatusTone {
  if (status === "in_progress" && !runActive) return "neutral";
  return STATUS_META[status].tone;
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

function toolActivityStatus(activity: TodoToolActivity): TodoStatus {
  if (activity.status === "completed") return "completed";
  if (activity.status === "failed" || activity.status === "cancelled") return "failed";
  if (activity.status === "running") return "in_progress";
  return "pending";
}

function ToolActivities({ activities, runActive }: { activities: TodoToolActivity[]; runActive: boolean }) {
  if (!activities.length) return null;

  return (
    <details className="mt-2 rounded-md border border-border/60 bg-muted/20 px-2.5 py-1.5">
      <summary className="cursor-pointer select-none text-xs text-muted-foreground">
        执行详情（{activities.length}）
      </summary>
      <ul className="mt-1.5 space-y-1 border-t border-border/50 pt-1.5">
        {activities.map((activity, index) => {
          const status = toolActivityStatus(activity);
          return (
            <li key={`${activity.id}-${index}`} className="flex items-start gap-1.5 text-xs">
              <TodoStatusIcon status={status} runActive={runActive} className="mt-0.5 size-3" />
              <span className="min-w-0 flex-1 break-words text-muted-foreground">{activity.label}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground/70">{activity.toolName}</span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function RichTodoItem({
  todo,
  activities,
  runActive,
}: {
  todo: TodoItem;
  activities: TodoToolActivity[];
  runActive: boolean;
}) {
  const active = todo.status === "in_progress" && runActive;
  const tone = getStatusTone(todo.status, runActive);

  return (
    <li
      className={cn(
        "rounded-md border border-border/70 bg-background px-3 py-2",
        todo.status === "completed" && "border-success/25 bg-success/5",
        todo.status === "waiting" && "border-warning/25 bg-warning/5",
        (todo.status === "blocked" || todo.status === "failed") && "border-destructive/25 bg-destructive/5",
      )}
      data-todo-id={todo.id}
    >
      <div className="flex items-start gap-2">
        <TodoStatusIcon status={todo.status} runActive={runActive} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("min-w-0 break-words font-medium", activityStatusTextClass(tone))}>
              {todo.content}
            </span>
            <span className={activityStatusBadgeClass(tone)}>{STATUS_META[todo.status].label}</span>
          </div>
          {active && todo.activeForm && todo.activeForm !== todo.content ? (
            <div className="mt-0.5 text-xs text-muted-foreground">{todo.activeForm}</div>
          ) : null}
        </div>
      </div>

      {todo.detail?.length ? (
        <div className="ml-6 mt-2">
          <PresentationDetail data={{ title: "", detail: todo.detail }} />
        </div>
      ) : null}

      {todo.display?.length ? (
        <div className="ml-6 mt-2">
          <PresentationBlocks blocks={todo.display} ctx={{ readOnly: true }} />
        </div>
      ) : null}

      {todo.evidenceRefs?.length ? (
        <div className="ml-6 mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span>依据</span>
          {todo.evidenceRefs.map((ref) => (
            <span key={ref} className="rounded border border-border/70 bg-muted/30 px-1.5 py-0.5 font-mono">
              {ref}
            </span>
          ))}
        </div>
      ) : null}

      <div className="ml-6">
        <ToolActivities activities={activities} runActive={runActive} />
      </div>
    </li>
  );
}

function SimpleTodoItem({ todo, runActive, index }: { todo: TodoItem; runActive: boolean; index: number }) {
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
}

export function TodoPanel({ messages, sessionId, runActive = false }: TodoPanelProps) {
  const todos = useMemo(() => extractLatestTodos(messages), [messages]);
  const activitiesByTodo = useMemo(() => extractTodoToolActivities(messages), [messages]);
  const isMobile = useIsMobile();
  const sessionKey = sessionId || "__local__";
  const [expandedBySession, setExpandedBySession] = useState<Record<string, boolean>>({});
  const hasRichTodos = !!todos?.some(isRichTodo);
  const expanded = expandedBySession[sessionKey] ?? (!isMobile && hasRichTodos);

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
    <div className="relative z-0 mx-6 -mb-px">
      <div
        className={cn(
          "overflow-hidden rounded-t-lg rounded-b-none border bg-card text-sm shadow-sm transition-colors",
          summary.allCompleted && "border-success/25 bg-success/5",
          summary.status === "blocked" && "border-destructive/25",
          summary.status === "failed" && "border-destructive/25",
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
          {hasRichTodos ? <Wrench className="size-3.5 shrink-0 text-muted-foreground" aria-label="业务步骤" /> : null}
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
            expanded ? "max-h-[60vh] opacity-100" : "max-h-0 opacity-0",
          )}
          aria-hidden={!expanded}
        >
          <div className="border-t border-border px-3 py-2">
            <ul className="max-h-[calc(60vh-3.5rem)] space-y-2 overflow-y-auto pr-1">
              {todos.map((todo, index) => {
                if (!isRichTodo(todo)) {
                  return <SimpleTodoItem key={`${todo.status}-${index}-${todo.content}`} todo={todo} runActive={runActive} index={index} />;
                }
                const key = todoItemKey(todo);
                return (
                  <RichTodoItem
                    key={key}
                    todo={todo}
                    activities={activitiesByTodo[key] ?? []}
                    runActive={runActive}
                  />
                );
              })}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
