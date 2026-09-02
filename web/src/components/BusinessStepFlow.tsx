import type { ReactNode } from "react";
import {
  Circle,
  CircleCheck,
  CircleX,
  Clock3,
  ListChecks,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import type {
  BusinessStepEventItem,
  DetailLine,
  RecordsBlock,
  TodoItem,
  TodoOutcome,
} from "@agent/shared";

import { cn } from "@/lib/utils";
import {
  activityStatusBadgeClass,
  activityStatusIconClass,
  type ActivityStatusTone,
} from "./activityStatusStyles";
import { PresentationDetail } from "./PresentationDetail";
import { PresentationBlocks } from "./presentation/PresentationBlocks";
import { statVerdict, visibleOutcomeStats, type OutcomeStat } from "./detailSemantics";
import {
  businessStepSelectionKey,
  detailSelection,
  type BusinessStepSelection,
} from "./businessStepViewModel";

const OUTCOME_TONE_META: Record<NonNullable<TodoOutcome["tone"]>, {
  textClass: string;
  Icon: typeof TriangleAlert | null;
  iconClass: string;
}> = {
  ok: { textClass: "text-foreground", Icon: null, iconClass: "" },
  warn: { textClass: "text-warning", Icon: TriangleAlert, iconClass: "text-warning" },
  fail: { textClass: "text-destructive", Icon: CircleX, iconClass: "text-destructive" },
};

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
    <span className="rounded border border-border/70 bg-muted/30 px-1.5 py-0.5 text-2xs leading-none text-muted-foreground">
      {stat.label} <span className="font-medium text-foreground">{stat.value}</span>
    </span>
  );
}

function OutcomeLine({ outcome, stats }: { outcome: TodoOutcome; stats: OutcomeStat[] }) {
  const meta = OUTCOME_TONE_META[outcome.tone ?? "ok"];
  const Icon = meta.Icon;
  return (
    <div className="space-y-2">
      <p className={cn("flex items-start gap-2 text-sm leading-5", meta.textClass)}>
        {Icon ? <Icon className={cn("mt-[3px] size-3.5 shrink-0", meta.iconClass)} /> : null}
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

const VERDICT_RECORD_TONE = {
  pass: "success",
  fail: "danger",
  warn: "warn",
  pending: "muted",
} as const;

type SectionDetailLine = Extract<DetailLine, { section: string }>;
type VerdictDetailLine = Extract<DetailLine, { verdict: string }>;

type StepDetailPart =
  | { kind: "detail"; lines: DetailLine[] }
  | { kind: "records"; block: RecordsBlock };

function isSectionDetailLine(line: DetailLine | undefined): line is SectionDetailLine {
  return typeof line === "object" && line !== null && "section" in line;
}

function isVerdictDetailLine(line: DetailLine | undefined): line is VerdictDetailLine {
  return typeof line === "object" && line !== null && "verdict" in line;
}

function migrateLegacySectionVerdicts(detail: DetailLine[] | undefined): StepDetailPart[] {
  if (!detail?.length) return [];
  const parts: StepDetailPart[] = [];
  let plainLines: DetailLine[] = [];
  const flushPlainLines = () => {
    if (!plainLines.length) return;
    parts.push({ kind: "detail", lines: plainLines });
    plainLines = [];
  };

  for (let index = 0; index < detail.length;) {
    const section = detail[index];
    if (!isSectionDetailLine(section) || !isVerdictDetailLine(detail[index + 1])) {
      plainLines.push(section);
      index += 1;
      continue;
    }

    flushPlainLines();
    index += 1;
    const items: RecordsBlock["items"] = [];
    while (true) {
      const verdict = detail[index];
      if (!isVerdictDetailLine(verdict)) break;
      items.push({
        label: verdict.text,
        tone: VERDICT_RECORD_TONE[verdict.verdict],
        ...(verdict.note ? { note: verdict.note } : {}),
      });
      index += 1;
    }
    parts.push({
      kind: "records",
      block: { kind: "records", layout: "checklist", title: section.section, items },
    });
  }

  flushPlainLines();
  return parts;
}

function StepSummaryBody({ todo }: { todo: TodoItem }) {
  const detailParts = migrateLegacySectionVerdicts(todo.detail);
  return (
    <div className="flex flex-col gap-3">
      {detailParts.map((part, index) => part.kind === "detail" ? (
        <PresentationDetail key={index} data={{ title: "", detail: part.lines }} className="mt-0" variant="plain" />
      ) : (
        <PresentationBlocks key={index} blocks={[part.block]} ctx={{ readOnly: true }} />
      ))}
      {todo.display?.length ? <PresentationBlocks blocks={todo.display} ctx={{ readOnly: true }} /> : null}
    </div>
  );
}

export function BusinessStepResultContent({
  todo,
  deliverables,
  processAnomaly,
}: {
  todo: TodoItem;
  deliverables?: ReactNode;
  processAnomaly?: boolean;
}) {
  return (
    <div className="flex flex-col gap-4" data-business-step-result>
      {todo.outcome ? (
        <OutcomeLine
          outcome={todo.outcome}
          stats={visibleOutcomeStats(todo.outcome.stat, todo.detail)}
        />
      ) : null}
      {todo.detail?.length || todo.display?.length ? <StepSummaryBody todo={todo} /> : null}
      {processAnomaly ? (
        <div className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>步骤结果已完成，但过程记录中仍有异常，请以平台执行事实为准。</span>
        </div>
      ) : null}
      {deliverables}
    </div>
  );
}

export function BusinessStepEvidence({ todo }: { todo: TodoItem }) {
  if (!todo.evidenceRefs?.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground" data-business-step-evidence>
      {todo.evidenceRefs.map((ref) => (
        <span key={ref} className="rounded border border-border/70 bg-muted/30 px-1.5 py-0.5 font-mono">
          {ref}
        </span>
      ))}
    </div>
  );
}

function statusMeta(todo: TodoItem): {
  label: string;
  tone: ActivityStatusTone;
  Icon: typeof Circle;
  spin?: boolean;
} {
  if (todo.status === "completed" && todo.outcome?.tone === "fail") {
    return { label: "完成结果异常", tone: "danger", Icon: CircleX };
  }
  switch (todo.status) {
    case "in_progress":
      return { label: "进行中", tone: "active", Icon: Loader2, spin: true };
    case "waiting":
      return { label: "等待中", tone: "pending", Icon: Clock3 };
    case "blocked":
      return { label: "已阻断", tone: "danger", Icon: TriangleAlert };
    case "completed":
      return { label: "已完成", tone: "success", Icon: CircleCheck };
    case "failed":
      return { label: "失败", tone: "danger", Icon: CircleX };
    default:
      return { label: "待处理", tone: "neutral", Icon: Circle };
  }
}

export function BusinessStepStatusIcon({ todo, className }: { todo: TodoItem; className?: string }) {
  const meta = statusMeta(todo);
  return (
    <span className="inline-flex shrink-0" title={meta.label} aria-label={meta.label}>
      <meta.Icon className={activityStatusIconClass(meta.tone, cn("size-4", meta.spin && "animate-spin", className))} />
    </span>
  );
}

export interface BusinessStepOverallStatus {
  completed: number;
  label: "运行中" | "已阻断" | "有失败" | "等待中" | "已完成" | "已结束" | "待处理";
  tone: ActivityStatusTone;
}

export function businessStepOverallStatus(
  todos: TodoItem[],
  planClosed = false,
): BusinessStepOverallStatus {
  const completed = todos.filter((todo) => todo.status === "completed").length;
  if (!planClosed && todos.some((todo) => todo.status === "in_progress")) {
    return { completed, label: "运行中", tone: "active" };
  }
  if (todos.some((todo) => todo.status === "blocked")) {
    return { completed, label: "已阻断", tone: "danger" };
  }
  if (todos.some((todo) => todo.status === "failed")) {
    return { completed, label: "有失败", tone: "danger" };
  }
  if (todos.some((todo) => todo.status === "waiting")) {
    return { completed, label: "等待中", tone: "pending" };
  }
  if (todos.length > 0 && completed === todos.length) {
    return { completed, label: "已完成", tone: "success" };
  }
  if (planClosed) {
    return { completed, label: "已结束", tone: "neutral" };
  }
  return { completed, label: "待处理", tone: "neutral" };
}

function PlanTodoRow({
  todo,
  index,
  isFirst,
  isLast,
  planId,
  sessionId,
  runId,
  selected,
  detailPanelId,
  planClosed,
  generationId,
  onSelect,
}: {
  todo: TodoItem;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  planId: string;
  sessionId?: string | null;
  runId?: string | null;
  selected: BusinessStepSelection | null;
  detailPanelId: string;
  planClosed?: boolean;
  generationId?: string;
  onSelect?: (selection: BusinessStepSelection) => void;
}) {
  const selection = detailSelection(
    sessionId,
    runId,
    planId,
    todo.id ? `id:${todo.id}` : `legacy:${todo.content}`,
    generationId,
  );
  const selectionKey = businessStepSelectionKey(selection);
  const isSelected = selected?.planId === planId && selected.todoKey === selection.todoKey;
  const endedWithoutTerminal = planClosed && todo.status === "in_progress";
  const isCurrent = !planClosed && todo.status === "in_progress";

  return (
    <li
      className={cn(
        "relative",
        !isFirst
          && "before:absolute before:left-[1.375rem] before:top-[-0.125rem] before:h-[1.375rem] before:w-px before:-translate-x-1/2 before:bg-border/70",
        !isLast
          && "after:absolute after:bottom-[-0.125rem] after:left-[1.375rem] after:top-5 after:w-px after:-translate-x-1/2 after:bg-border/70",
      )}
      data-business-step-connect-before={!isFirst ? "true" : "false"}
      data-business-step-connect-after={!isLast ? "true" : "false"}
    >
      <button
        type="button"
        className={cn(
          "group relative flex w-full items-start gap-2 rounded-xl px-3 py-2.5 text-left outline-none transition-colors",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          "before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-transparent",
          isSelected && "before:bg-primary",
          isCurrent
            ? "bg-primary/5 hover:bg-primary/10"
            : isSelected
              ? "bg-primary/5 hover:bg-primary/10"
              : "hover:bg-muted/70",
        )}
        aria-selected={isSelected}
        aria-current={isCurrent ? "step" : undefined}
        aria-controls={detailPanelId}
        data-business-step-select-key={selectionKey}
        data-business-step-current={isCurrent ? "true" : "false"}
        onClick={() => onSelect?.(selection)}
      >
        <span className={cn(
          "relative z-10 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-card",
          isCurrent && "shadow-[0_0_0_3px_hsl(var(--primary)/0.08)]",
        )}>
          {endedWithoutTerminal ? (
            <span className="inline-flex shrink-0" title="已结束" aria-label="已结束">
              <Circle className={activityStatusIconClass("neutral", "size-4")} />
            </span>
          ) : <BusinessStepStatusIcon todo={todo} />}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 break-words text-sm font-medium [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden",
            todo.status === "pending" ? "text-muted-foreground" : "text-foreground",
          )}
          title={todo.content}
        >
          {todo.content}
        </span>
        <span className="w-5 shrink-0 pt-0.5 text-right text-2xs tabular-nums text-muted-foreground/60">
          {String(index).padStart(2, "0")}
        </span>
      </button>
    </li>
  );
}

export function BusinessStepFlow({
  event,
  sessionId,
  selected,
  detailPanelId = "business-step-detail-panel",
  onSelect,
}: {
  event: BusinessStepEventItem;
  sessionId?: string | null;
  selected: BusinessStepSelection | null;
  detailPanelId?: string;
  onSelect?: (selection: BusinessStepSelection) => void;
}) {
  if (event.kind !== "plan") return null;
  const todos = event.todos ?? [];
  const overall = businessStepOverallStatus(todos, event.isClosed);
  return (
    <section
      aria-label="业务步骤"
      className="w-full min-w-0 max-w-full rounded-2xl border border-border/70 bg-card p-2 shadow-sm md:w-fit md:min-w-[min(520px,100%)] md:max-w-[min(760px,100%)]"
      data-business-step={event.id}
      data-business-step-plan
    >
      <header className="flex items-center gap-2 border-b border-border/50 px-2 pb-2 pt-0.5">
        <ListChecks className={activityStatusIconClass(overall.tone, "size-4 shrink-0")} />
        <h3 className="min-w-0 flex-1 text-sm font-semibold text-foreground">任务步骤</h3>
        <span className="text-2xs tabular-nums text-muted-foreground">
          {overall.completed}/{todos.length}
        </span>
        <span className={activityStatusBadgeClass(overall.tone)}>{overall.label}</span>
      </header>
      <ol
        className="relative mt-0.5 space-y-0.5"
        data-business-step-list
        data-business-step-connected={todos.length > 1 ? "true" : "false"}
      >
        {todos.map((todo, index) => (
          <PlanTodoRow
            key={todo.id || `${index}-${todo.content}`}
            todo={todo}
            index={index + 1}
            isFirst={index === 0}
            isLast={index === todos.length - 1}
            planId={event.id}
            sessionId={sessionId}
            runId={event.runId}
            selected={selected}
            detailPanelId={detailPanelId}
            planClosed={event.isClosed}
            generationId={event.generationId}
            onSelect={onSelect}
          />
        ))}
      </ol>
    </section>
  );
}

export function BusinessStepProcessEvent({ event }: { event: BusinessStepEventItem }) {
  if (event.kind !== "update") return null;
  return (
    <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <ListChecks className="size-3.5 shrink-0" />
      <span>计划已调整 · 共 {event.stepCount ?? "-"} 步</span>
    </div>
  );
}
