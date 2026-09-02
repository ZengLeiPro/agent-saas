import { useMemo, type ReactNode } from "react";
import { ChevronDown, X } from "lucide-react";
import type { RenderItem } from "@agent/shared";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import {
  BusinessStepEvidence,
  BusinessStepResultContent,
  BusinessStepStatusIcon,
} from "./BusinessStepFlow";
import type {
  BusinessStepDetailView,
  BusinessStepFollowMode,
  BusinessStepPlanView,
} from "./businessStepViewModel";

// 面板和 Sheet 共用同一详情主体；默认导出按 open 是否存在分派按需加载后的外壳。
export interface BusinessStepDetailProps {
  detail: BusinessStepDetailView;
  plan: BusinessStepPlanView;
  followMode: BusinessStepFollowMode;
  debugMode: boolean;
  onSelectStep?: (todoKey: string) => void;
  onClose: () => void;
  renderItem: (item: RenderItem) => ReactNode;
}

function uniqueItems(items: RenderItem[]): RenderItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function detailItems(detail: BusinessStepDetailView) {
  const deliverables: RenderItem[] = [];
  const process: RenderItem[] = [];
  let processAnomaly = false;

  for (const section of detail.sections) {
    if (section.processAnomaly) processAnomaly = true;
    const artifactIds = new Set(
      section.items
        .filter((item) => item.type === "file_download" && !!item.artifactId)
        .map((item) => item.id),
    );
    for (const item of section.items) {
      if (artifactIds.has(item.id)) {
        deliverables.push(item);
        continue;
      }
      if (item.type === "permission_request" || item.type === "ask_user") continue;
      process.push(item);
    }
  }

  return {
    deliverables: uniqueItems(deliverables),
    process: uniqueItems(process),
    processAnomaly,
  };
}

function StepTabs({
  detail,
  plan,
  onSelectStep,
}: Pick<BusinessStepDetailProps, "detail" | "plan" | "onSelectStep">) {
  return (
    <div
      className="flex shrink-0 gap-1 overflow-x-auto border-b px-4 py-2"
      role="tablist"
      aria-label="任务步骤"
      data-business-step-tabs
    >
      {plan.details.map((step) => {
        const selected = step.todoKey === detail.todoKey;
        const number = String(step.stepIndex).padStart(2, "0");
        return (
          <button
            key={step.todoKey}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls="business-step-selected-content"
            aria-label={`第 ${number} 步：${step.todo.content}`}
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium tabular-nums outline-none transition-colors",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
              selected
                ? "bg-primary/10 text-foreground shadow-sm"
                : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
            )}
            onClick={() => onSelectStep?.(step.todoKey)}
          >
            <BusinessStepStatusIcon todo={step.todo} className="size-3.5" />
            <span>{number}</span>
          </button>
        );
      })}
    </div>
  );
}

function CollapsibleDetail({
  title,
  children,
  dataAttribute,
}: {
  title: string;
  children: ReactNode;
  dataAttribute: "process" | "evidence";
}) {
  return (
    <details className="group rounded-xl border border-border/70 bg-muted/15" data-business-step-collapsible={dataAttribute}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-sm font-medium outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <span>{title}</span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-border/60 px-3 py-3">{children}</div>
    </details>
  );
}

function BusinessStepDetailBody({
  detail,
  plan,
  onSelectStep,
  renderItem,
}: Pick<BusinessStepDetailProps, "detail" | "plan" | "onSelectStep" | "renderItem">) {
  const items = useMemo(() => detailItems(detail), [detail]);
  const hasResult = !!detail.todo.outcome
    || !!detail.todo.detail?.length
    || !!detail.todo.display?.length
    || items.deliverables.length > 0
    || items.processAnomaly;
  const hasProcess = items.process.length > 0;
  const hasEvidence = !!detail.todo.evidenceRefs?.length;

  const deliverables = items.deliverables.length ? (
    <section className="space-y-2" aria-label="交付物">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">交付物</h3>
      <div className="flex flex-col gap-2">
        {items.deliverables.map((item) => <div key={item.id}>{renderItem(item)}</div>)}
      </div>
    </section>
  ) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <StepTabs detail={detail} plan={plan} onSelectStep={onSelectStep} />
      <div
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-4"
        id="business-step-selected-content"
        role="tabpanel"
        aria-label={`第 ${detail.stepIndex} 步详情`}
        data-business-step-detail-content
      >
        <div className="flex flex-col gap-4">
          <section className="space-y-3" aria-label="步骤结果">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">结果</h2>
            {hasResult ? (
              <BusinessStepResultContent
                todo={detail.todo}
                processAnomaly={items.processAnomaly}
                deliverables={deliverables}
              />
            ) : (
              <p className="text-sm text-muted-foreground">暂无结果</p>
            )}
          </section>
          {hasProcess ? (
            <CollapsibleDetail title="过程" dataAttribute="process">
              <div className="flex flex-col gap-2.5" aria-label="步骤过程" data-business-step-process>
                {items.process.map((item) => <div key={item.id}>{renderItem(item)}</div>)}
              </div>
            </CollapsibleDetail>
          ) : null}
          {hasEvidence ? (
            <CollapsibleDetail title="依据" dataAttribute="evidence">
              <BusinessStepEvidence todo={detail.todo} />
            </CollapsibleDetail>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function BusinessStepDetailPanel(props: BusinessStepDetailProps) {
  const { detail, onClose } = props;
  return (
    <section
      id="business-step-detail-panel"
      className="flex h-full min-h-0 flex-col bg-card"
      aria-label={`步骤详情：${detail.todo.content}`}
      data-business-step-detail-panel
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3">
        <div className="min-w-0 flex-1 truncate text-sm font-medium">任务步骤</div>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          onClick={onClose}
          title="关闭步骤详情"
          aria-label="关闭步骤详情"
        >
          <X className="size-4" />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <BusinessStepDetailBody {...props} />
      </div>
    </section>
  );
}

export function BusinessStepDetailSheet({
  open,
  ...props
}: BusinessStepDetailProps & { open: boolean }) {
  const { onClose } = props;
  return (
    <Sheet open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <SheetContent
        id="business-step-detail-panel"
        side="bottom"
        overlayClassName="z-[110]"
        className="inset-x-0 bottom-0 top-3 z-[111] h-[calc(100dvh-0.75rem)] max-h-none gap-0 rounded-b-none rounded-t-[24px] border-x-0 border-b-0 p-0 pb-[env(safe-area-inset-bottom)]"
        data-business-step-detail-sheet
      >
        <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-t-[24px] bg-card">
          <div className="flex h-5 shrink-0 items-center justify-center" aria-hidden="true">
            <span className="h-1 w-10 rounded-full bg-muted-foreground/30" />
          </div>
          <header className="flex min-h-12 shrink-0 items-center border-b px-4 pb-2 pr-12">
            <SheetTitle className="truncate text-sm font-medium">任务步骤</SheetTitle>
            <SheetDescription className="sr-only">查看并切换任务步骤详情</SheetDescription>
          </header>
          <BusinessStepDetailBody {...props} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

export type BusinessStepDetailSurfaceProps = BusinessStepDetailProps & { open?: boolean };

export default function BusinessStepDetailSurface(props: BusinessStepDetailSurfaceProps) {
  return typeof props.open === "boolean"
    ? <BusinessStepDetailSheet {...props} open={props.open} />
    : <BusinessStepDetailPanel {...props} />;
}
