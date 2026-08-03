import { useEffect, useState, type ReactNode } from "react";
import {
  ChevronRight,
  CircleCheck,
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
import { statVerdict, visibleOutcomeStats, type OutcomeStat } from "./detailSemantics";

// ---------------------------------------------------------------------------
// 业务步骤渲染（时间线性叙事 + 章节化）
//
// 视觉纪律（曾磊 08-03 拍板）：
// - 全面去框：计划块、步骤节、终态小结都不用四边框；「有框 = 机器容器
//   （活动组/工具块），无框 = 业务叙事」是刻意的视觉分层。
// - 状态色只落在 icon 与小徽标上，容器一律融入背景。
// - 归属感由缩进 + 极淡左竖线表达（timeline 语言），不靠边框。
// - 步骤完成后常显标题、状态、outcome 与业务详情；只有调试过程按需展开。
//   运行中的步骤保持展开。
//
// 内容纪律（08-03 二轮：样式对齐 demo + 槽位去重）：
// - 「业务详情」用白卡键值（PresentationDetail variant="card"）：白底 + 细行分隔
//   线，字段名灰、值深、关键值配主题强调色。去框只约束**步骤章节骨架**，
//   内容块该是卡片就是卡片。
// - 标签分两类：判定类（✓/✗/通过/失败）走绿红语义色，中性键值保持灰。
// - 槽位去重是渲染层硬约束而非提示语约定：与详情键值行同键同值的中性标签
//   隐藏；判定类标签任何时候都不隐藏。
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

/**
 * 分流计数徽标。判定类（✓/✗/通过/失败……）走绿红语义色，中性键值保持灰。
 * 判别只看 value 且含数字即判中性，取舍理由见 detailSemantics.statVerdict。
 */
function StatChip({ stat }: { stat: OutcomeStat }) {
  const verdict = statVerdict(stat);
  if (verdict) {
    return (
      <span className={activityStatusBadgeClass(verdict === "pass" ? "success" : "danger")}>
        {stat.label} <span className="font-medium">{stat.value}</span>
      </span>
    );
  }
  return (
    <span className="rounded border border-border/70 bg-muted/30 px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground">
      {stat.label} <span className="font-medium text-foreground">{stat.value}</span>
    </span>
  );
}

/**
 * 一句话业务结果。tone 修正语义色（完成但有例外 = 橙色警示）。
 * stats 由调用方按常显的业务详情过滤后传入——同一组数字不在一屏里出现两遍。
 */
function OutcomeLine({ outcome, stats }: { outcome: TodoOutcome; stats: OutcomeStat[] }) {
  const meta = OUTCOME_TONE_META[outcome.tone ?? "ok"];
  const Icon = meta.Icon;
  return (
    <div className="space-y-2">
      <p className={cn("flex items-start gap-2 text-sm leading-6", meta.textClass)}>
        {Icon ? <Icon className={cn("mt-0.5 size-3.5 shrink-0", meta.iconClass)} /> : null}
        <span className="min-w-0 break-words">{outcome.text}</span>
      </p>
      {stats.length ? (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="outcome-stats">
          {stats.map((entry) => <StatChip key={`${entry.label}-${entry.value}`} stat={entry} />)}
        </div>
      ) : null}
    </div>
  );
}

/** 终态小结正文：业务详情（白卡键值）/ display / 依据。 */
function hasStepSummaryBody(todo: TodoItem): boolean {
  return !!todo.detail?.length || !!todo.display?.length || !!todo.evidenceRefs?.length;
}

function StepSummaryBody({ todo }: { todo: TodoItem }) {
  if (!hasStepSummaryBody(todo)) return null;
  return (
    <div className="space-y-3">
      {todo.detail?.length ? (
        <PresentationDetail data={{ title: "", detail: todo.detail }} variant="card" />
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

function DisclosureButton({
  label,
  open,
  onToggle,
}: {
  label: ReactNode;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="flex items-center gap-1 py-0.5 text-xs leading-5 text-muted-foreground transition-colors hover:text-foreground"
      aria-expanded={open}
      onClick={onToggle}
    >
      {label}
      <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
    </button>
  );
}

function PlanTodoRow({ todo, index }: { todo: TodoItem; index: number }) {
  return (
    <li className="flex items-start gap-2.5 py-1">
      <span className="min-w-4 shrink-0 text-right text-sm leading-5 tabular-nums text-muted-foreground">
        {index}.
      </span>
      <span className="min-w-0 flex-1 break-words text-sm leading-5 text-muted-foreground">
        {todo.content}
      </span>
    </li>
  );
}

/** 计划亮相块：Turn 内首个业务快照。无框，融入背景。 */
function PlanBlock({ event }: { event: BusinessStepEventItem }) {
  const todos = event.todos ?? [];
  return (
    <section className="my-6" aria-label="业务计划" data-business-step={event.id}>
      <header className="flex items-center gap-2.5">
        <ListChecks className="size-4 shrink-0 text-primary" />
        <h3 className="text-sm font-medium text-foreground">业务计划</h3>
      </header>
      <ol className="ml-[7px] mt-2.5 border-l border-border/50 pl-5">
        {todos.map((todo, index) => (
          <PlanTodoRow key={todo.id || `${index}-${todo.content}`} todo={todo} index={index + 1} />
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
    <section className="my-6" aria-label={`业务步骤${label}`} data-business-step={event.id}>
      <header className="flex items-start gap-2.5">
        <Icon className={activityStatusIconClass(tone, "mt-0.5 size-4 shrink-0")} />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="break-words text-sm font-medium leading-5 text-foreground">{todo.content}</span>
          <span className={activityStatusBadgeClass(tone)}>{label}</span>
        </div>
        <StepBadge index={event.stepIndex} count={event.stepCount} />
      </header>
      <div className="ml-[7px] mt-3 space-y-3 border-l border-border/50 pl-5">
        {todo.outcome ? (
          <OutcomeLine
            outcome={todo.outcome}
            stats={visibleOutcomeStats(todo.outcome.stat, todo.detail)}
          />
        ) : null}
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
 * 业务步骤节：标题行、outcome 与业务详情常显；调试过程按需展开。
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
  // 步骤完成瞬间收起调试过程；业务详情始终直接可见。
  const terminalKey = terminal?.id ?? null;
  useEffect(() => {
    if (!terminalKey) return;
    setProcessOpen(false);
  }, [terminalKey]);

  if (!todo) return <>{children}</>;

  const titleLabel = !terminal && isActive && todo.activeForm ? todo.activeForm : todo.content;

  return (
    <section
      className="my-6"
      aria-label={terminalMeta ? `业务步骤${terminalMeta.label}` : "业务步骤"}
      data-business-step-section={section.id}
    >
      <header className="flex items-start gap-2.5">
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
              "break-words text-sm font-medium leading-5",
              terminal || isActive ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {titleLabel}
          </span>
          {terminalMeta ? (
            <>
              <span className={activityStatusBadgeClass(terminalMeta.tone)}>{terminalMeta.label}</span>
              {section.processAnomaly ? (
                // 跨层矛盾角标：平台事实（区间内同类操作最后一次仍失败）压过模型
                // 干净完成叙事。浅色低重量，不改写模型文本。
                <span className={activityStatusBadgeClass("warning", "opacity-75")}>过程有异常</span>
              ) : null}
            </>
          ) : isActive ? (
            <span className={activityStatusBadgeClass("active")}>进行中</span>
          ) : null}
        </div>
        <StepBadge index={terminal?.stepIndex ?? start.stepIndex} count={terminal?.stepCount ?? start.stepCount} />
      </header>

      <div className="ml-[7px] mt-3 space-y-3.5 border-l border-border/50 pl-5">
        {terminal?.todo?.outcome ? (
          <OutcomeLine
            outcome={terminal.todo.outcome}
            stats={visibleOutcomeStats(terminal.todo.outcome.stat, terminal.todo.detail)}
          />
        ) : null}

        {terminal && debugMode && hasProcess ? (
          <DisclosureButton
            label={<>过程 · {processCount} 项</>}
            open={processOpen}
            onToggle={() => setProcessOpen((open) => !open)}
          />
        ) : null}

        {terminal?.todo ? <StepSummaryBody todo={terminal.todo} /> : null}
        {terminal && debugMode && processOpen ? <div>{children}</div> : null}
        {!terminal && hasProcess ? <div>{children}</div> : null}
      </div>
    </section>
  );
}
