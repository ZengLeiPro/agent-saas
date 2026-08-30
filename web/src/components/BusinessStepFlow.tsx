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
  if (todo.status === "completed" && todo.outcome?.tone === "warn") {
    return { label: "已完成，有例外", tone: "warning", Icon: TriangleAlert };
  }
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

function PlanTodoRow({
  todo,
  index,
  count,
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
  count: number;
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
    <li>
      <button
        type="button"
        className={cn(
          "group flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left outline-none transition-colors",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          isSelected
            ? "bg-primary/10 text-foreground ring-1 ring-primary/25"
            : isCurrent
              ? "bg-primary/5 text-foreground hover:bg-primary/10"
              : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
        )}
        aria-selected={isSelected}
        aria-current={isCurrent ? "step" : undefined}
        aria-controls={detailPanelId}
        data-business-step-select-key={selectionKey}
        data-business-step-current={isCurrent ? "true" : "false"}
        onClick={() => onSelect?.(selection)}
      >
        {endedWithoutTerminal ? (
          <span className="inline-flex shrink-0" title="已结束" aria-label="已结束">
            <Circle className={activityStatusIconClass("neutral", "size-4")} />
          </span>
        ) : <BusinessStepStatusIcon todo={todo} />}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{todo.content}</span>
        <span className="shrink-0 text-2xs tabular-nums text-muted-foreground/70">
          {index}/{count}
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
  return (
    <section
      aria-label="业务步骤"
      className="rounded-2xl border border-border/70 bg-card p-2 shadow-sm"
      data-business-step={event.id}
      data-business-step-plan
    >
      <header className="flex items-center gap-2 px-2 pb-1 pt-0.5">
        <ListChecks className="size-4 shrink-0 text-primary" />
        <h3 className="min-w-0 flex-1 text-sm font-semibold text-foreground">任务步骤</h3>
        <span className="text-2xs tabular-nums text-muted-foreground">共 {todos.length} 步</span>
      </header>
      <ol className="space-y-0.5">
        {todos.map((todo, index) => (
          <PlanTodoRow
            key={todo.id || `${index}-${todo.content}`}
            todo={todo}
            index={index + 1}
            count={todos.length}
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
