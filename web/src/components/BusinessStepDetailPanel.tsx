import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, LocateFixed } from "lucide-react";
import type { RenderItem } from "@agent/shared";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { RightPanelFrame } from "./RightPanelFrame";
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
type DetailTab = "result" | "process" | "evidence";

export interface BusinessStepDetailProps {
  detail: BusinessStepDetailView;
  plan: BusinessStepPlanView;
  followMode: BusinessStepFollowMode;
  debugMode: boolean;
  onPrevious?: () => void;
  onNext?: () => void;
  onReturnCurrent?: () => void;
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

function HeaderActions({
  onPrevious,
  onNext,
}: {
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  return (
    <div className="flex items-center gap-0.5">
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        disabled={!onPrevious}
        onClick={onPrevious}
        title="上一步"
        aria-label="上一步"
      >
        <ArrowUp className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        disabled={!onNext}
        onClick={onNext}
        title="下一步"
        aria-label="下一步"
      >
        <ArrowDown className="size-4" />
      </Button>
    </div>
  );
}

function FollowBar({
  detail,
  plan,
  followMode,
  onReturnCurrent,
}: Pick<BusinessStepDetailProps, "detail" | "plan" | "followMode" | "onReturnCurrent">) {
  const fixedAwayFromCurrent = followMode === "fixed"
    && !!plan.currentTodoKey
    && plan.currentTodoKey !== detail.todoKey;

  return (
    <div className="flex min-h-9 shrink-0 items-center justify-between gap-3 border-b bg-muted/20 px-4 py-1.5 text-xs text-muted-foreground">
      <span>{followMode === "follow" ? "正在跟随当前步骤" : "已暂停跟随"}</span>
      {fixedAwayFromCurrent && onReturnCurrent ? (
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={onReturnCurrent}>
          <LocateFixed className="size-3.5" />
          返回当前步骤
        </Button>
      ) : null}
    </div>
  );
}

function BusinessStepDetailBody({
  detail,
  plan,
  followMode,
  onReturnCurrent,
  renderItem,
}: Pick<
  BusinessStepDetailProps,
  "detail" | "plan" | "followMode" | "onReturnCurrent" | "renderItem"
>) {
  const items = useMemo(() => detailItems(detail), [detail]);
  const hasResult = !!detail.todo.outcome
    || !!detail.todo.detail?.length
    || !!detail.todo.display?.length
    || items.deliverables.length > 0
    || items.processAnomaly;
  const hasProcess = items.process.length > 0;
  const hasEvidence = !!detail.todo.evidenceRefs?.length;
  const tabs = useMemo<DetailTab[]>(() => [
    ...(hasResult ? ["result" as const] : []),
    ...(hasProcess ? ["process" as const] : []),
    ...(hasEvidence ? ["evidence" as const] : []),
  ], [hasEvidence, hasProcess, hasResult]);
  const [activeTab, setActiveTab] = useState<DetailTab>("result");

  useEffect(() => {
    setActiveTab(tabs.includes("result") ? "result" : (tabs[0] ?? "result"));
  }, [detail.planId, detail.todoKey, tabs]);

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
      <FollowBar
        detail={detail}
        plan={plan}
        followMode={followMode}
        onReturnCurrent={onReturnCurrent}
      />
      {tabs.length > 1 ? (
        <div className="flex shrink-0 gap-1 border-b px-4 pt-2" role="tablist" aria-label="步骤详情分区">
          {tabs.map((tab) => {
            const labels: Record<DetailTab, string> = { result: "结果", process: "过程", evidence: "依据" };
            return (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={activeTab === tab}
                className={cn(
                  "border-b-2 px-3 py-2 text-sm transition-colors",
                  activeTab === tab
                    ? "border-primary font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setActiveTab(tab)}
              >
                {labels[tab]}
              </button>
            );
          })}
        </div>
      ) : null}
      <div
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-4"
        role="tabpanel"
        data-business-step-detail-tab={activeTab}
      >
        {activeTab === "result" ? (
          <BusinessStepResultContent
            todo={detail.todo}
            processAnomaly={items.processAnomaly}
            deliverables={deliverables}
          />
        ) : null}
        {activeTab === "process" ? (
          <div className="flex flex-col gap-2.5" aria-label="步骤过程" data-business-step-process>
            {items.process.map((item) => <div key={item.id}>{renderItem(item)}</div>)}
          </div>
        ) : null}
        {activeTab === "evidence" ? <BusinessStepEvidence todo={detail.todo} /> : null}
      </div>
    </div>
  );
}

export function BusinessStepDetailPanel(props: BusinessStepDetailProps) {
  const { detail, onPrevious, onNext, onClose } = props;
  return (
    <div id="business-step-detail-panel" className="h-full min-h-0" data-business-step-detail-panel>
      <RightPanelFrame
        title={detail.todo.content}
        ariaLabel={`步骤详情：${detail.todo.content}`}
        subtitle={`第 ${detail.stepIndex} / ${detail.stepCount} 步`}
        leading={<BusinessStepStatusIcon todo={detail.todo} />}
        onClose={onClose}
        closeLabel="关闭步骤详情"
        actions={<HeaderActions onPrevious={onPrevious} onNext={onNext} />}
      >
        <BusinessStepDetailBody {...props} />
      </RightPanelFrame>
    </div>
  );
}

export function BusinessStepDetailSheet({
  open,
  ...props
}: BusinessStepDetailProps & { open: boolean }) {
  const { detail, onClose, onPrevious, onNext } = props;
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
          <header className="flex min-h-12 shrink-0 items-center gap-2 border-b px-4 pb-2 pr-12">
            <BusinessStepStatusIcon todo={detail.todo} />
            <div className="min-w-0 flex-1">
              <SheetTitle className="truncate text-sm font-medium">{detail.todo.content}</SheetTitle>
              <SheetDescription className="truncate text-xs">第 {detail.stepIndex} / {detail.stepCount} 步</SheetDescription>
            </div>
            <HeaderActions onPrevious={onPrevious} onNext={onNext} />
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
