import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { TaskBoard, TaskBoardExecutionPurpose, TaskBoardStageModels, TaskBoardTask } from "@agent/shared";
import {
  BRAND_SEGMENTED_TABS_LIST_CLASS,
  BRAND_SEGMENTED_TAB_TRIGGER_CLASS,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";

export type TaskDetailTab = "details" | "discussion";

export function taskStageModels(task: TaskBoardTask): TaskBoardStageModels {
  if (task.stageModels && Object.keys(task.stageModels).length > 0) {
    return {
      ...(task.stageModels.work ? { work: task.stageModels.work } : {}),
      ...(task.stageModels.review ? { review: task.stageModels.review } : {}),
    };
  }
  return task.model ? { work: task.model, review: task.model } : {};
}

export function inheritedModelHint(board: TaskBoard | null, purpose: TaskBoardExecutionPurpose) {
  return board?.stageModels?.[purpose] ?? board?.model ?? "未指定时继承看板默认模型";
}

export function useTaskDescriptionResize({
  active,
  open,
  taskId,
}: {
  active: boolean;
  open: boolean;
  taskId?: string;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const resize = useCallback(() => {
    const textarea = textareaRef.current;
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!textarea || !viewport || !content) return;

    textarea.style.height = "auto";
    const styles = window.getComputedStyle(textarea);
    const cssPixels = (value: string) => Number.parseFloat(value) || 0;
    const lineHeight = cssPixels(styles.lineHeight) || 20;
    const verticalChrome = cssPixels(styles.paddingTop) + cssPixels(styles.paddingBottom)
      + cssPixels(styles.borderTopWidth) + cssPixels(styles.borderBottomWidth);
    const minimumHeight = Math.ceil(lineHeight * 3 + verticalChrome);
    const naturalHeight = textarea.scrollHeight;
    textarea.style.height = `${minimumHeight}px`;

    const fixedContentHeight = content.scrollHeight - textarea.offsetHeight;
    const availableHeight = Math.max(minimumHeight, viewport.clientHeight - fixedContentHeight);
    const nextHeight = Math.min(
      Math.max(naturalHeight, minimumHeight),
      availableHeight,
      naturalHeight + lineHeight * 2,
    );
    textarea.style.height = `${Math.max(minimumHeight, nextHeight)}px`;
    textarea.style.overflowY = naturalHeight > nextHeight ? "auto" : "hidden";
  }, []);

  useLayoutEffect(() => resize());
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [active, open, resize, taskId]);

  return { viewportRef, contentRef, textareaRef };
}

export function TaskDetailTabs({
  value,
  commentCount,
  onChange,
}: {
  value: TaskDetailTab;
  commentCount: number;
  onChange: (value: TaskDetailTab) => void;
}) {
  return (
    <Tabs value={value} onValueChange={(next) => onChange(next as TaskDetailTab)} className="shrink-0 border-b px-4 py-2 sm:px-6">
      <TabsList aria-label="任务详情分区" className={`${BRAND_SEGMENTED_TABS_LIST_CLASS} relative grid grid-cols-2`}>
        <span
          aria-hidden="true"
          data-task-detail-tab-indicator
          className="pointer-events-none absolute inset-y-1 left-1 rounded-[7px] bg-background shadow-[0_1px_4px_rgba(15,23,42,0.10)] transition-transform duration-300 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
          style={{ width: "calc((100% - 0.5rem) / 2)", transform: `translateX(${value === "details" ? 0 : 100}%)` }}
        />
        <TabsTrigger value="details" className={`${BRAND_SEGMENTED_TAB_TRIGGER_CLASS} relative z-10`}>详细信息</TabsTrigger>
        <TabsTrigger value="discussion" className={`${BRAND_SEGMENTED_TAB_TRIGGER_CLASS} relative z-10`}>讨论（{commentCount}）</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
