import { useEffect, useState, type ReactNode } from "react";
import {
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock3,
  ListChecks,
  Loader2,
  Play,
  TriangleAlert,
} from "lucide-react";
import type { BusinessStepEventItem, BusinessStepSection, TodoItem, TodoOutcome } from "@agent/shared";

import { cn } from "@/lib/utils";
import {
  activityStatusBadgeClass,
  activityStatusIconClass,
  type ActivityStatusTone,
} from "./activityStatusStyles";
import { PresentationDetail } from "./PresentationDetail";
import { PresentationBlocks } from "./presentation/PresentationBlocks";

// ---------------------------------------------------------------------------
// 业务步骤渲染（时间线性叙事 + 章节化）
//
// 视觉纪律（曾磊 08-03 拍板）：
// - 全面去框：计划块、步骤节、终态小结都不用四边框；「有框 = 机器容器
//   （活动组/工具块），无框 = 业务叙事」是刻意的视觉分层。
// - 状态色只落在 icon 与小徽标上，容器一律融入背景。
// - 归属感由缩进 + 极淡左竖线表达（timeline 语言），不靠边框。
// - 节内过程（工具/思考/正文）在步骤完成后自动折叠为一行；outcome 与
//   业务小结（detail/display/依据）常显——折的是过程，不折结论。
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

const OUTCOME_TONE_META: Record<NonNullable<TodoOutcome["tone"]>, {
  textClass: string;
  Icon: typeof TriangleAlert | null;
  iconClass: string;
}> = {
  ok: { textClass: "text-foreground", Icon: null, iconClass: "" },
  warn: { textClass: "text-warning", Icon: TriangleAlert, iconClass: "text-warning" },
  fail: { textClass: "text-destructive", Icon: CircleX, iconClass: "text-destructive" },
};

function StepBadge({ index, count }: { index?: number; count?: number }) {
  if (!index || !count) return null;
  return (
    <span className="ml-auto shrink-0 pl-2 text-[11px] tabular-nums text-muted-foreground/70">
      第 {index}/{count} 步
    </span>
  );
}

/** 一句话业务结果：折叠态的信息主体。tone 修正语义色（完成但有例外 = 橙色警示）。 */
function OutcomeLine({ outcome }: { outcome: TodoOutcome }) {
  const meta = OUTCOME_TONE_META[outcome.tone ?? "ok"];
  const Icon = meta.Icon;
  return (
    <div className="space-y-1">
      <p className={cn("flex items-start gap-1.5 text-sm leading-5", meta.textClass)}>
        {Icon ? <Icon className={cn("mt-0.5 size-3.5 shrink-0", meta.iconClass)} /> : null}
        <span className="min-w-0 break-words">{outcome.text}</span>
      </p>
      {outcome.stat?.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {outcome.stat.map((entry) => (
            <span
              key={`${entry.label}-${entry.value}`}
              className="rounded border border-border/70 bg-muted/30 px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground"
            >
              {entry.label} <span className="font-medium text-foreground">{entry.value}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 终态小结正文：detail / display / 依据。 */
function StepSummaryBody({ todo }: { todo: TodoItem }) {
  const hasBody = !!todo.detail?.length || !!todo.display?.length || !!todo.evidenceRefs?.length;
  if (!hasBody) return null;
  return (
    <div className="space-y-2.5">
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

/** 计划亮相块：Turn 内首个业务快照。无框，融入背景。 */
function PlanBlock({ event }: { event: BusinessStepEventItem }) {
  const todos = event.todos ?? [];
  return (
    <section className="my-4" aria-label="业务计划" data-business-step={event.id}>
      <header className="flex items-center gap-2">
        <ListChecks className="size-4 shrink-0 text-primary" />
        <h3 className="text-sm font-medium text-foreground">业务计划</h3>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          共 {event.stepCount ?? todos.length} 步
        </span>
      </header>
      <ol className="ml-[7px] mt-1.5 border-l border-border/50 pl-4">
        {todos.map((todo, index) => (
          <PlanTodoRow key={todo.id || `${index}-${todo.content}`} todo={todo} isCurrent={false} />
        ))}
      </ol>
    </section>
  );
}

/** 开始行：低噪音单行痕迹（无节归属时的扁平流渲染，mobile / 特殊 fallback 用）。 */
function StartRow({ event }: { event: BusinessStepEventItem }) {
  const todo = event.todo;
  if (!todo) return null;
  const label = event.isCurrent && todo.activeForm ? todo.activeForm : todo.content;
  return (
    <div className="my-1.5 flex items-center gap-2 px-1 text-sm" data-business-step={event.id}>
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

/** 终态块（无节归属时的扁平流渲染）。无框，左竖线归属。 */
function TerminalBlock({ event }: { event: BusinessStepEventItem }) {
  const todo = event.todo;
  const meta = TERMINAL_META[event.kind];
  if (!todo || !meta) return null;
  const { label, tone, Icon } = meta;

  return (
    <section className="my-4" aria-label={`业务步骤${label}`} data-business-step={event.id}>
      <header className="flex items-start gap-2">
        <Icon className={activityStatusIconClass(tone, "mt-0.5 size-4 shrink-0")} />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="break-words text-sm font-medium text-foreground">{todo.content}</span>
          <span className={activityStatusBadgeClass(tone)}>{label}</span>
        </div>
        <StepBadge index={event.stepIndex} count={event.stepCount} />
      </header>
      <div className="ml-[7px] mt-2 space-y-2.5 border-l border-border/50 pl-4">
        {todo.outcome ? <OutcomeLine outcome={todo.outcome} /> : null}
        <StepSummaryBody todo={todo} />
      </div>
    </section>
  );
}

/** 计划调整行：纯结构增删时的轻量痕迹。 */
function UpdateRow({ event }: { event: BusinessStepEventItem }) {
  return (
    <div className="my-1 flex items-center gap-2 px-1 text-xs text-muted-foreground" data-business-step={event.id}>
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

function countSectionProcessItems(section: BusinessStepSection): number {
  let count = 0;
  for (const item of section.items) {
    if (item.type === "activity_group") count += item.items.length;
    else count += 1;
  }
  return count;
}

/**
 * 业务步骤节：标题行（步骤名 + 状态）+ 过程区（children，完成后自动折叠）
 * + 业务小结（outcome/detail/display/依据，常显）。
 * children 由 MessageList 用完整消息渲染逻辑生成，本组件只提供节壳。
 */
export function BusinessStepSectionView({
  section,
  debugMode,
  children,
}: {
  section: BusinessStepSection;
  debugMode: boolean;
  children: ReactNode;
}) {
  const { start, terminal, isActive } = section;
  const terminalMeta = terminal ? TERMINAL_META[terminal.kind] : undefined;
  const todo = terminal?.todo ?? start.todo;
  const processCount = countSectionProcessItems(section);
  const hasProcess = processCount > 0;

  const [processOpen, setProcessOpen] = useState(!terminal);
  // 步骤完成瞬间自动折叠过程；折的是过程，outcome 与小结常显。
  const terminalKey = terminal?.id ?? null;
  useEffect(() => {
    if (terminalKey) setProcessOpen(false);
  }, [terminalKey]);

  if (!todo) return <>{children}</>;

  const titleLabel = !terminal && isActive && todo.activeForm ? todo.activeForm : todo.content;

  return (
    <section
      className="my-4"
      aria-label={terminalMeta ? `业务步骤${terminalMeta.label}` : "业务步骤"}
      data-business-step-section={section.id}
    >
      <header className="flex items-start gap-2">
        {terminalMeta ? (
          <terminalMeta.Icon className={activityStatusIconClass(terminalMeta.tone, "mt-0.5 size-4 shrink-0")} />
        ) : isActive ? (
          <Loader2 className={activityStatusIconClass("active", "mt-0.5 size-4 shrink-0 animate-spin")} />
        ) : (
          <Play className="mt-0.5 size-4 shrink-0 text-muted-foreground/60" />
        )}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className={cn(
              "break-words text-sm font-medium",
              terminal || isActive ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {titleLabel}
          </span>
          {terminalMeta ? (
            <span className={activityStatusBadgeClass(terminalMeta.tone)}>{terminalMeta.label}</span>
          ) : isActive ? (
            <span className={activityStatusBadgeClass("active")}>进行中</span>
          ) : null}
        </div>
        <StepBadge index={terminal?.stepIndex ?? start.stepIndex} count={terminal?.stepCount ?? start.stepCount} />
      </header>

      <div className="ml-[7px] mt-2 space-y-2.5 border-l border-border/50 pl-4">
        {terminal?.todo?.outcome ? <OutcomeLine outcome={terminal.todo.outcome} /> : null}

        {hasProcess ? (
          terminal ? (
            <div>
              <button
                type="button"
                disabled={!debugMode}
                className={cn(
                  "flex items-center gap-1 text-xs text-muted-foreground",
                  debugMode ? "cursor-pointer transition-colors hover:text-foreground" : "cursor-default",
                )}
                aria-expanded={debugMode && processOpen}
                onClick={debugMode ? () => setProcessOpen((open) => !open) : undefined}
              >
                <ChevronRight className={cn("size-3.5 transition-transform", debugMode && processOpen && "rotate-90")} />
                过程 · {processCount} 项
              </button>
              {debugMode && processOpen ? <div className="mt-2">{children}</div> : null}
            </div>
          ) : (
            <div>{children}</div>
          )
        ) : null}

        {terminal?.todo ? <StepSummaryBody todo={terminal.todo} /> : null}
      </div>
    </section>
  );
}
