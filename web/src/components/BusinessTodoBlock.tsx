import {
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock3,
  ListChecks,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import type {
  BusinessTodoGroup,
  TodoItem,
  TodoStatus,
  TodoToolActivity,
} from "@agent/shared";

import { cn } from "@/lib/utils";
import {
  activityStatusBadgeClass,
  activityStatusIconClass,
  activityStatusTextClass,
  type ActivityStatusTone,
} from "./activityStatusStyles";
import { ActivityGroupBlock } from "./ActivityGroupBlock";
import { PresentationDetail } from "./PresentationDetail";
import { PresentationBlocks } from "./presentation/PresentationBlocks";

const STATUS_META: Record<TodoStatus, { label: string; tone: ActivityStatusTone }> = {
  pending: { label: "待开始", tone: "neutral" },
  in_progress: { label: "进行中", tone: "active" },
  waiting: { label: "等待中", tone: "pending" },
  blocked: { label: "已阻断", tone: "danger" },
  completed: { label: "已完成", tone: "success" },
  failed: { label: "失败", tone: "danger" },
};

function getTone(status: TodoStatus, runActive: boolean): ActivityStatusTone {
  if (status === "in_progress" && !runActive) return "neutral";
  return STATUS_META[status].tone;
}

function StatusIcon({ status, runActive, className }: {
  status: TodoStatus;
  runActive: boolean;
  className?: string;
}) {
  const baseClass = cn("size-4 shrink-0", className);
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
  return <CircleDashed className={activityStatusIconClass(getTone(status, runActive), baseClass)} />;
}

function activityStatus(activity: TodoToolActivity): TodoStatus {
  if (activity.status === "completed") return "completed";
  if (activity.status === "failed" || activity.status === "cancelled") return "failed";
  if (activity.status === "running") return "in_progress";
  return "pending";
}

function ToolActivityList({ activities, runActive }: {
  activities: TodoToolActivity[];
  runActive: boolean;
}) {
  if (!activities.length) return null;

  return (
    <details className="mt-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2">
      <summary className="cursor-pointer select-none text-xs text-muted-foreground">
        执行详情（{activities.length}）
      </summary>
      <ul className="mt-2 space-y-1.5 border-t border-border/50 pt-2">
        {activities.map((activity, index) => {
          const status = activityStatus(activity);
          return (
            <li key={`${activity.id}-${index}`} className="flex items-start gap-2 text-xs">
              <StatusIcon status={status} runActive={runActive} className="mt-0.5 size-3" />
              <span className="min-w-0 flex-1 break-words text-muted-foreground">{activity.label}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground/70">{activity.toolName}</span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function BusinessStep({
  todo,
  activities,
  toolMessages,
  runActive,
  debugMode,
}: {
  todo: TodoItem;
  activities: TodoToolActivity[];
  toolMessages: BusinessTodoGroup["toolMessagesByTodo"][string];
  runActive: boolean;
  debugMode: boolean;
}) {
  const active = todo.status === "in_progress" && runActive;
  const tone = getTone(todo.status, runActive);

  return (
    <li
      className={cn(
        "rounded-lg border border-border/70 bg-background px-4 py-3",
        todo.status === "completed" && "border-success/25 bg-success/5",
        todo.status === "waiting" && "border-warning/25 bg-warning/5",
        (todo.status === "blocked" || todo.status === "failed") && "border-destructive/25 bg-destructive/5",
      )}
      data-business-step-id={todo.id}
    >
      <div className="flex items-start gap-2.5">
        <StatusIcon status={todo.status} runActive={runActive} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("break-words font-medium", activityStatusTextClass(tone))}>
              {todo.content}
            </span>
            <span className={activityStatusBadgeClass(tone)}>{STATUS_META[todo.status].label}</span>
          </div>
          {active && todo.activeForm && todo.activeForm !== todo.content ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{todo.activeForm}</p>
          ) : null}
        </div>
      </div>

      {todo.detail?.length ? (
        <div className="ml-6 mt-3">
          <PresentationDetail data={{ title: "", detail: todo.detail }} />
        </div>
      ) : null}

      {todo.display?.length ? (
        <div className="ml-6 mt-3">
          <PresentationBlocks blocks={todo.display} ctx={{ readOnly: true }} />
        </div>
      ) : null}

      {todo.evidenceRefs?.length ? (
        <div className="ml-6 mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span>依据</span>
          {todo.evidenceRefs.map((ref) => (
            <span key={ref} className="rounded border border-border/70 bg-muted/30 px-1.5 py-0.5 font-mono">
              {ref}
            </span>
          ))}
        </div>
      ) : null}

      <div className="ml-6">
        {debugMode && toolMessages.length ? (
          <div className="mt-3">
            <ActivityGroupBlock
              items={toolMessages}
              isActive={runActive}
              isLast={false}
              debugMode
            />
          </div>
        ) : (
          <ToolActivityList activities={activities} runActive={runActive} />
        )}
      </div>
    </li>
  );
}

export function BusinessTodoBlock({
  group,
  debugMode = false,
}: {
  group: BusinessTodoGroup;
  debugMode?: boolean;
}) {
  const completed = group.todos.filter((todo) => todo.status === "completed").length;

  return (
    <section
      className="my-2 rounded-xl border border-border bg-card p-4 shadow-sm"
      aria-label="业务步骤"
      data-business-todo-id={group.id}
    >
      <header className="mb-3 flex items-center gap-2">
        <ListChecks className="size-4 text-primary" />
        <h3 className="text-sm font-medium text-foreground">业务进度</h3>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {completed}/{group.todos.length}
        </span>
      </header>
      <ol className="space-y-2.5">
        {group.todos.map((todo, index) => {
          const key = todo.id || `${index}-${todo.content}`;
          const todoKey = todo.id ? `id:${todo.id}` : `legacy:${todo.content}`;
          return (
            <BusinessStep
              key={key}
              todo={todo}
              activities={group.activitiesByTodo[todoKey] ?? []}
              toolMessages={group.toolMessagesByTodo[todoKey] ?? []}
              runActive={group.isActive}
              debugMode={debugMode}
            />
          );
        })}
      </ol>
    </section>
  );
}
