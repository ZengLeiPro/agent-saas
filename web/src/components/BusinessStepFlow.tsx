import {
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock3,
  ListChecks,
  Loader2,
  Play,
  TriangleAlert,
} from "lucide-react";
import type { BusinessStepEventItem, TodoItem } from "@agent/shared";

import { cn } from "@/lib/utils";
import {
  activityStatusBadgeClass,
  activityStatusIconClass,
  type ActivityStatusTone,
} from "./activityStatusStyles";
import { PresentationDetail } from "./PresentationDetail";
import { PresentationBlocks } from "./presentation/PresentationBlocks";

// ---------------------------------------------------------------------------
// 业务步骤事件渲染（时间线性叙事）
//
// 视觉纪律（对齐场景 demo 的扁平块语言）：
// - 状态色只落在 icon 与小徽标上，容器一律中性（无整卡状态色填充）；
// - 事件行/块之间不做容器嵌套：plan 块、开始行、终态块都是流内并列的一等公民；
// - 开始行是低噪音的单行痕迹，终态块承载业务小结（detail / display / 依据）。
// ---------------------------------------------------------------------------

const TERMINAL_META: Partial<Record<BusinessStepEventItem["kind"], {
  label: string;
  tone: ActivityStatusTone;
  Icon: typeof CircleCheck;
}>> = {
  complete: { label: "已完成", tone: "success", Icon: CircleCheck },
  fail: { label: "失败", tone: "danger", Icon: CircleX },
  block: { label: "已阻断", tone: "danger", Icon: TriangleAlert },
  wait: { label: "等待中", tone: "pending", Icon: Clock3 },
};

function StepBadge({ index, count }: { index?: number; count?: number }) {
  if (!index || !count) return null;
  return (
    <span className="ml-auto shrink-0 pl-2 text-[11px] tabular-nums text-muted-foreground/70">
      第 {index}/{count} 步
    </span>
  );
}

function PlanTodoRow({ todo, isCurrent }: { todo: TodoItem; isCurrent: boolean }) {
  const active = todo.status === "in_progress";
  return (
    <li className="flex items-start gap-2 py-0.5">
      {todo.status === "completed" ? (
        <CircleCheck className={activityStatusIconClass("success", "mt-0.5 size-3.5 shrink-0")} />
      ) : active && isCurrent ? (
        <Loader2 className={activityStatusIconClass("active", "mt-0.5 size-3.5 shrink-0 animate-spin")} />
      ) : (
        <CircleDashed className={activityStatusIconClass(active ? "active" : "neutral", "mt-0.5 size-3.5 shrink-0")} />
      )}
      <span
        className={cn(
          "min-w-0 flex-1 break-words text-sm leading-5",
          todo.status === "completed" && "text-muted-foreground line-through opacity-75",
          active ? "font-medium text-foreground" : "text-muted-foreground",
        )}
      >
        {todo.content}
      </span>
    </li>
  );
}

/** 计划亮相块：Turn 内首个业务快照，只展示计划本身，不承载后续活动。 */
function PlanBlock({ event }: { event: BusinessStepEventItem }) {
  const todos = event.todos ?? [];
  return (
    <section
      className="my-1.5 rounded-lg border border-border/60 px-3.5 py-2.5"
      aria-label="业务计划"
      data-business-step={event.id}
    >
      <header className="mb-1.5 flex items-center gap-2">
        <ListChecks className="size-4 shrink-0 text-primary" />
        <h3 className="text-sm font-medium text-foreground">业务计划</h3>
        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
          共 {event.stepCount ?? todos.length} 步
        </span>
      </header>
      <ol>
        {todos.map((todo, index) => (
          <PlanTodoRow
            key={todo.id || `${index}-${todo.content}`}
            todo={todo}
            isCurrent={event.isCurrent === true}
          />
        ))}
      </ol>
    </section>
  );
}

/** 开始行：低噪音单行痕迹，正在进行时带 spinner。 */
function StartRow({ event }: { event: BusinessStepEventItem }) {
  const todo = event.todo;
  if (!todo) return null;
  const label = event.isCurrent && todo.activeForm ? todo.activeForm : todo.content;
  return (
    <div
      className="my-1 flex items-center gap-2 px-1 text-sm"
      data-business-step={event.id}
    >
      {event.isCurrent ? (
        <Loader2 className={activityStatusIconClass("active", "size-3.5 shrink-0 animate-spin")} />
      ) : (
        <Play className="size-3.5 shrink-0 text-muted-foreground/60" />
      )}
      <span className={cn("min-w-0 break-words", event.isCurrent ? "font-medium text-foreground" : "text-muted-foreground")}>
        {label}
      </span>
      <StepBadge index={event.stepIndex} count={event.stepCount} />
    </div>
  );
}

/** 终态块：步骤的业务小结（detail / display / 依据）。状态色只落 icon 与徽标。 */
function TerminalBlock({ event }: { event: BusinessStepEventItem }) {
  const todo = event.todo;
  const meta = TERMINAL_META[event.kind];
  if (!todo || !meta) return null;
  const { label, tone, Icon } = meta;
  const hasBody = !!todo.detail?.length || !!todo.display?.length || !!todo.evidenceRefs?.length;

  return (
    <section
      className="my-1.5 rounded-lg border border-border/60 px-3.5 py-2.5"
      aria-label={`业务步骤${label}`}
      data-business-step={event.id}
    >
      <header className="flex items-start gap-2">
        <Icon className={activityStatusIconClass(tone, "mt-0.5 size-4 shrink-0")} />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="break-words text-sm font-medium text-foreground">{todo.content}</span>
          <span className={activityStatusBadgeClass(tone)}>{label}</span>
        </div>
        <StepBadge index={event.stepIndex} count={event.stepCount} />
      </header>

      {hasBody ? (
        <div className="mt-2 space-y-2 pl-6">
          {todo.detail?.length ? (
            <PresentationDetail data={{ title: "", detail: todo.detail }} />
          ) : null}
          {todo.display?.length ? (
            <PresentationBlocks blocks={todo.display} ctx={{ readOnly: true }} />
          ) : null}
          {todo.evidenceRefs?.length ? (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>依据</span>
              {todo.evidenceRefs.map((ref) => (
                <span key={ref} className="rounded border border-border/70 bg-muted/30 px-1.5 py-0.5 font-mono">
                  {ref}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** 计划调整行：纯结构增删时的轻量痕迹。 */
function UpdateRow({ event }: { event: BusinessStepEventItem }) {
  return (
    <div
      className="my-1 flex items-center gap-2 px-1 text-xs text-muted-foreground"
      data-business-step={event.id}
    >
      <ListChecks className="size-3.5 shrink-0 text-muted-foreground/60" />
      <span>计划已调整 · 共 {event.stepCount ?? "-"} 步</span>
    </div>
  );
}

export function BusinessStepFlow({ event }: { event: BusinessStepEventItem }) {
  switch (event.kind) {
    case "plan":
      return <PlanBlock event={event} />;
    case "start":
      return <StartRow event={event} />;
    case "update":
      return <UpdateRow event={event} />;
    case "complete":
    case "fail":
    case "block":
    case "wait":
      return <TerminalBlock event={event} />;
    default:
      return null;
  }
}
