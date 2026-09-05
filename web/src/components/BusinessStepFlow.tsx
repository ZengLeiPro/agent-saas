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
import {
  businessStepOverallStatus,
  isEndedWithoutTerminal,
  migrateLegacySectionVerdicts,
  outcomeToneMeta,
  todoAccessibleStatus,
  todoStatusMeta,
} from "@agent/shared";
import type {
  BusinessStepEventItem,
  BusinessStepIcon,
  BusinessStepOverallStatus,
  TodoItem,
  TodoOutcome,
} from "@agent/shared";

import { cn } from "@/lib/utils";
import "./businessStepRecords.css";
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

/**
 * 语气位由 shared `outcomeToneMeta` 裁定，这里只做 Web 的渲染映射。
 *
 * 注意 ok（tone=neutral）用的是正文色 text-foreground，而不是
 * activityStatusTextClass("neutral") 的 text-muted-foreground——一句业务结果是
 * 正文而非辅助信息，故保留本地 class 表而不复用活动状态色板。
 */
type OutcomeTone = Extract<ActivityStatusTone, "neutral" | "warning" | "danger">;

const OUTCOME_TONE_CLASS: Record<OutcomeTone, { textClass: string; iconClass: string }> = {
  neutral: { textClass: "text-foreground", iconClass: "" },
  warning: { textClass: "text-warning", iconClass: "text-warning" },
  danger: { textClass: "text-destructive", iconClass: "text-destructive" },
};

/** shared 的图标语义位 → lucide 组件。两端各自挑实现，语义键一致。 */
const STEP_ICONS: Record<BusinessStepIcon, typeof Circle> = {
  progress: Loader2,
  clock: Clock3,
  alert: TriangleAlert,
  check: CircleCheck,
  x: CircleX,
  circle: Circle,
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
  const { tone, icon } = outcomeToneMeta(outcome);
  const meta = OUTCOME_TONE_CLASS[tone as OutcomeTone];
  const Icon = icon ? STEP_ICONS[icon] : null;
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

// 详情侧栏使用独立容器断点；主会话里的 PresentationBlocks 保持原布局。
function StepSummaryBody({ todo }: { todo: TodoItem }) {
  const detailParts = migrateLegacySectionVerdicts(todo.detail);
  return (
    <div className="business-step-records-container flex flex-col gap-3">
      {detailParts.map((part, index) => part.kind === "detail" ? (
        <PresentationDetail key={index} data={{ title: "", detail: part.lines }} className="mt-0" variant="plain" />
      ) : (
        <PresentationBlocks key={index} blocks={[part.block]} ctx={{ readOnly: true, recordsSurface: "business-step" }} />
      ))}
      {todo.display?.length ? <PresentationBlocks blocks={todo.display} ctx={{ readOnly: true, recordsSurface: "business-step" }} /> : null}
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

export function BusinessStepStatusIcon({ todo, className }: { todo: TodoItem; className?: string }) {
  const meta = todoStatusMeta(todo);
  const Icon = STEP_ICONS[meta.icon];
  return (
    <span className="inline-flex shrink-0" aria-label={meta.label}>
      <Icon aria-hidden="true" className={activityStatusIconClass(meta.tone, cn("size-4", meta.spin && "animate-spin", className))} />
    </span>
  );
}

// 步骤状态语义已下沉 shared；保留此处导出，既有调用点与单测的导入路径不变。
export { businessStepOverallStatus };
export type { BusinessStepOverallStatus };

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
  const endedWithoutTerminal = isEndedWithoutTerminal(todo, planClosed);
  const isCurrent = !planClosed && todo.status === "in_progress";
  const accessibleStatus = todoAccessibleStatus(todo, planClosed);

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
          "group relative flex min-h-11 w-full items-start gap-2 rounded-xl px-3 py-2.5 text-left outline-none transition-colors",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          isSelected ? "bg-primary/5 hover:bg-primary/10" : "hover:bg-muted/70",
        )}
        aria-label={[todo.content, accessibleStatus, todo.outcome?.text].filter(Boolean).join("，")}
        aria-selected={isSelected}
        aria-current={isCurrent ? "step" : undefined}
        aria-controls={detailPanelId}
        data-business-step-select-key={selectionKey}
        data-business-step-selected={isSelected ? "true" : "false"}
        data-business-step-current={isCurrent ? "true" : "false"}
        onClick={() => onSelect?.(selection)}
      >
        <span
          className={cn(
            "relative z-10 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-card",
            isCurrent && "shadow-[0_0_0_3px_hsl(var(--primary)/0.08)]",
          )}
        >
          {endedWithoutTerminal ? (
            <span className="inline-flex shrink-0" title="已结束" aria-label="已结束">
              <Circle aria-hidden="true" className={activityStatusIconClass("neutral", "size-4")} />
            </span>
          ) : (
            <BusinessStepStatusIcon todo={todo} />
          )}
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
