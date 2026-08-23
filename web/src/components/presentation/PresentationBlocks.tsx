import { memo, useState, type ComponentType } from "react";
import { ChevronRight, Circle, CircleCheck, CircleX, Copy, ExternalLink, TriangleAlert } from "lucide-react";
import type {
  BlockAction,
  CalloutBlock,
  DetailLine,
  GateBlock,
  PresentationBlock,
  PresentationBlockKind,
  RecordItem,
  RecordsBlock,
  PresentationTone,
} from "@agent/shared";
import { Button } from "@/components/ui/button";
import { PresentationDetail } from "@/components/PresentationDetail";
import { cn } from "@/lib/utils";
import {
  activityStatusBadgeClass,
  activityStatusIconClass,
  activityStatusTextClass,
  type ActivityStatusTone,
} from "@/components/activityStatusStyles";

/**
 * 呈现块渲染层。
 *
 * 注册表刻意是**静态 import 的同步 map**，不用 lazy()：会话流里一条消息挂
 * 3 个块就是 3 个 Suspense 边界，而 MessageList 的滚动锚定依赖同步高度，
 * chunk 在滚动完成后 resolve 会导致页面跳。真正重的东西（markdown/katex）
 * 继续走 MessageItem 已有的消息级懒加载。
 */

const TONE_MAP: Record<PresentationTone, ActivityStatusTone> = {
  neutral: "neutral",
  info: "active",
  success: "success",
  warn: "warning",
  danger: "danger",
  muted: "pending",
};

const CHECKLIST_ICON_MAP: Record<PresentationTone, typeof Circle> = {
  neutral: Circle,
  info: Circle,
  success: CircleCheck,
  warn: TriangleAlert,
  danger: CircleX,
  muted: Circle,
};

/** 渲染上下文。回写通道缺省时按钮 disabled——不允许出现「点了没反应」的按钮。 */
export interface BlockContext {
  readOnly?: boolean;
  onAction?: (action: { interactionId: string; label: string }) => void;
}

function ActionButton({ action, ctx }: { action: BlockAction; ctx: BlockContext }) {
  const [copied, setCopied] = useState(false);

  if (action.kind === "link") {
    if (!action.href) return null;
    return (
      <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" asChild>
        <a href={action.href} target="_blank" rel="noreferrer noopener">
          {action.label}
          <ExternalLink className="size-3" />
        </a>
      </Button>
    );
  }

  if (action.kind === "copy") {
    const text = action.copyText;
    if (!text) return null;
    return (
      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1 text-xs"
        onClick={() => {
          void navigator.clipboard?.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        <Copy className="size-3" />
        {copied ? "已复制" : action.label}
      </Button>
    );
  }

  // 无回写通道 = 无法真正生效，渲染为 disabled 而不是假装可点
  const usable = !!action.interactionId && !!ctx.onAction && !ctx.readOnly;
  return (
    <Button
      variant={action.kind === "primary" ? "default" : action.kind === "ghost" ? "ghost" : "outline"}
      size="sm"
      className={cn("h-7 text-xs", action.kind === "danger" && "border-destructive/40 text-destructive")}
      disabled={!usable}
      onClick={usable ? () => ctx.onAction!({ interactionId: action.interactionId!, label: action.label }) : undefined}
    >
      {action.label}
    </Button>
  );
}

function Actions({ actions, ctx }: { actions?: BlockAction[]; ctx: BlockContext }) {
  if (!actions?.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {actions.map((action, i) => <ActionButton key={i} action={action} ctx={ctx} />)}
    </div>
  );
}

function Detail({ lines }: { lines?: DetailLine[] }) {
  if (!lines?.length) return null;
  return <PresentationDetail data={{ title: "", detail: lines }} />;
}

function CalloutView({ block, ctx }: { block: CalloutBlock; ctx: BlockContext }) {
  const [open, setOpen] = useState(block.defaultOpen !== false);
  const tone = TONE_MAP[block.tone];
  const collapsed = block.collapsible && !open;

  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2",
        block.tone === "danger" && "border-destructive/30 bg-destructive/5",
        block.tone === "warn" && "border-warning/30 bg-warning/5",
        block.tone === "success" && "border-success/30 bg-success/5",
        (block.tone === "neutral" || block.tone === "info" || block.tone === "muted") && "border-border bg-muted/30",
      )}
    >
      {block.title ? (
        <button
          type="button"
          onClick={block.collapsible ? () => setOpen((v) => !v) : undefined}
          className={cn("flex w-full items-center gap-1.5 text-left", !block.collapsible && "cursor-default")}
        >
          <span className={cn("min-w-0 flex-1 text-sm font-medium", activityStatusTextClass(tone))}>{block.title}</span>
          {block.collapsible ? <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} /> : null}
        </button>
      ) : null}

      {!collapsed && (
        <>
          {block.body.map((line, i) => (
            <p key={i} className={cn("whitespace-pre-wrap text-sm leading-5", block.title && i === 0 && "mt-1")}>
              {line}
            </p>
          ))}
          <Detail lines={block.detail} />
          <Actions actions={block.actions} ctx={ctx} />
        </>
      )}
    </div>
  );
}

function RecordRow({
  item,
  checklist,
  showValueColumn,
}: {
  item: RecordItem;
  checklist: boolean;
  showValueColumn: boolean;
}) {
  const [open, setOpen] = useState(false);
  const expandable = !!item.detail?.length;
  const itemTone = item.tone ?? "neutral";
  const ChecklistIcon = CHECKLIST_ICON_MAP[itemTone];
  const labelColumn = checklist ? "col-start-2" : "col-start-1";
  const valueColumn = checklist ? "col-start-3" : "col-start-2";
  const tagColumn = checklist
    ? showValueColumn ? "col-start-4" : "col-start-3"
    : showValueColumn ? "col-start-3" : "col-start-2";
  const expandColumn = checklist
    ? showValueColumn ? "col-start-5" : "col-start-4"
    : showValueColumn ? "col-start-4" : "col-start-3";
  return (
    <div className={cn("col-span-full grid grid-cols-[subgrid] border-b border-border/60 px-4 py-2 last:border-b-0", item.tone === "warn" && "bg-warning/5")}>
      <button
        type="button"
        onClick={expandable ? () => setOpen((v) => !v) : undefined}
        className={cn(
          "col-span-full grid grid-cols-[subgrid] items-start text-left",
          !expandable && "cursor-default",
        )}
      >
        {checklist ? (
          <ChecklistIcon className={activityStatusIconClass(TONE_MAP[itemTone], "col-start-1 mt-1 size-3 shrink-0")} aria-hidden="true" />
        ) : null}
        <span className={cn("min-w-0 max-w-80 break-words text-sm", labelColumn, checklist ? "text-foreground" : "text-muted-foreground", !checklist && item.tone === "danger" && "line-through opacity-70", item.mono && "font-mono text-xs")}>
          {item.label}
        </span>
        {showValueColumn ? (
          <span className={cn("min-w-0 max-w-[min(48rem,70vw)] break-words text-left text-sm text-foreground", valueColumn, item.mono && "font-mono text-xs")}>
            {item.value ?? ""}
          </span>
        ) : null}
        {item.tag ? <span className={cn(tagColumn, activityStatusBadgeClass(TONE_MAP[item.tag.tone]))}>{item.tag.text}</span> : null}
        {expandable ? <ChevronRight className={cn(expandColumn, "mt-0.5 size-3.5 shrink-0 transition-transform", open && "rotate-90")} /> : null}
      </button>
      {item.note ? <p className="col-span-full mt-0.5 text-xs text-muted-foreground">{item.note}</p> : null}
      {expandable && open ? <div className="col-span-full"><Detail lines={item.detail} /></div> : null}
    </div>
  );
}

// 首列与展开控件列使用固定轨道，避免独立行因内容或 Chevron 宽度不同而破坏纵向对齐。
const COMPARISON_COLUMNS = "sm:grid-cols-[9rem_repeat(3,minmax(8rem,1fr))_0.875rem]";

function ComparisonRow({ item }: { item: RecordItem }) {
  const [open, setOpen] = useState(false);
  const expandable = !!item.detail?.length;
  const tone = item.tone ? TONE_MAP[item.tone] : "neutral";
  return (
    <div
      className={cn(
        "border-b border-border/60 px-4 py-2.5 last:border-b-0",
        item.tone === "warn" && "bg-warning/5",
        item.tone === "danger" && "bg-destructive/5",
      )}
      data-comparison-row
    >
      <button
        type="button"
        onClick={expandable ? () => setOpen((value) => !value) : undefined}
        className={cn(
          "grid w-full grid-cols-1 gap-x-3 gap-y-2 text-left",
          COMPARISON_COLUMNS,
          "sm:items-start",
          !expandable && "cursor-default",
        )}
        data-comparison-track
      >
        <span className="min-w-0 break-words text-sm font-medium text-foreground">{item.label}</span>
        <span className="grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] gap-x-2 text-sm sm:block">
          <span className="text-xs text-muted-foreground sm:hidden">基准/之前</span>
          <span className="break-words text-foreground">{item.baseline ?? "—"}</span>
        </span>
        <span className="grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] gap-x-2 text-sm sm:block">
          <span className="text-xs text-muted-foreground sm:hidden">当前/实际</span>
          <span className="break-words text-foreground">{item.current ?? "—"}</span>
        </span>
        <span className="grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] gap-x-2 text-sm sm:block">
          <span className="text-xs text-muted-foreground sm:hidden">差异</span>
          <span className={cn("break-words font-medium", item.tone ? activityStatusTextClass(tone) : "text-foreground")}>
            {item.delta ?? "—"}
          </span>
        </span>
        {expandable ? <ChevronRight className={cn("hidden size-3.5 shrink-0 transition-transform sm:block", open && "rotate-90")} /> : null}
      </button>
      {item.note ? <p className="mt-1 text-xs text-muted-foreground">{item.note}</p> : null}
      {expandable && open ? <Detail lines={item.detail} /> : null}
    </div>
  );
}

function ComparisonView({ block }: { block: RecordsBlock }) {
  return (
    <div data-comparison-table>
      <div
        className={cn("hidden gap-x-3 border-b border-border/60 px-4 py-2 text-xs font-medium text-muted-foreground sm:grid", COMPARISON_COLUMNS)}
        data-comparison-track
      >
        <span>对照项</span>
        <span>基准/之前</span>
        <span>当前/实际</span>
        <span>差异</span>
        <span aria-hidden="true" />
      </div>
      {block.items.map((item, index) => <ComparisonRow key={index} item={item} />)}
    </div>
  );
}

function RecordsView({ block, ctx }: { block: RecordsBlock; ctx: BlockContext }) {
  const comparison = block.layout === "comparison";
  const tabular = block.layout !== "grid";
  const checklist = block.layout === "checklist";
  const showValueColumn = tabular && block.items.some((item) => item.value !== undefined && item.value !== "");
  const tableColumns = checklist
    ? showValueColumn
      ? "grid-cols-[auto_minmax(0,max-content)_minmax(0,max-content)_auto_auto]"
      : "grid-cols-[auto_minmax(0,max-content)_auto_auto]"
    : showValueColumn
      ? "grid-cols-[minmax(0,max-content)_minmax(0,max-content)_auto_auto]"
      : "grid-cols-[minmax(0,max-content)_auto_auto]";
  return (
    <div
      className={cn(
        "max-w-full overflow-x-auto rounded-xl border border-primary/20 bg-card align-top",
        comparison ? "block w-full" : "inline-block self-start",
      )}
      data-records-block
      tabIndex={tabular ? 0 : undefined}
      aria-label={tabular ? `${block.title ?? "数据表格"}，可横向滚动` : undefined}
    >
      <div className={comparison ? "min-w-0 sm:min-w-[36rem]" : "w-max"}>
        {block.title ? (
          <div
            className="border-b border-primary/15 bg-primary/5 px-4 py-2.5 text-sm font-semibold text-foreground"
            data-records-title
          >
            <span className="break-words">{block.title}</span>
          </div>
        ) : null}
        {block.layout === "grid" ? (
          <div
            className={cn(
              "inline-grid grid-cols-[repeat(2,minmax(0,max-content))] gap-x-8 gap-y-2 p-4",
              block.items.length !== 4 && "sm:grid-cols-[repeat(3,minmax(0,max-content))]",
            )}
            data-records-grid
          >
            {block.items.map((item, i) => (
              <div className="max-w-64" key={i}>
                <div className="break-words text-xs text-muted-foreground">{item.label}</div>
                <div className={cn("break-words text-sm", item.mono && "font-mono text-xs", item.tone && activityStatusTextClass(TONE_MAP[item.tone]))}>
                  {item.value ?? ""}
                </div>
              </div>
            ))}
          </div>
        ) : comparison ? (
          <ComparisonView block={block} />
        ) : (
          <div className={cn("grid w-max gap-x-4", tableColumns)} data-records-table>
            {block.items.map((item, i) => (
              <RecordRow
                key={i}
                item={item}
                checklist={checklist}
                showValueColumn={showValueColumn}
              />
            ))}
          </div>
        )}
        {block.footer ? <div className="border-t border-primary/10 px-4 py-2 text-xs text-muted-foreground">{block.footer}</div> : null}
        <div className="px-4 pb-2.5 empty:hidden">
          <Actions actions={block.actions} ctx={ctx} />
        </div>
      </div>
    </div>
  );
}

function GateView({ block, ctx }: { block: GateBlock; ctx: BlockContext }) {
  return (
    <div className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2">
      <div className={cn("text-sm font-medium", activityStatusTextClass("warning"))}>{block.title}</div>
      {block.body?.map((line, i) => (
        <p key={i} className="mt-1 whitespace-pre-wrap text-sm leading-5">{line}</p>
      ))}
      {block.meta?.length ? (
        <div className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono text-xs">
          {block.meta.map((entry, i) => (
            <div key={i} className="contents">
              <span className="text-muted-foreground">{entry.k}</span>
              <span className="break-words">{entry.v}</span>
            </div>
          ))}
        </div>
      ) : null}
      <Actions actions={block.actions} ctx={ctx} />
    </div>
  );
}

type BlockView<K extends PresentationBlockKind> = ComponentType<{
  block: Extract<PresentationBlock, { kind: K }>;
  ctx: BlockContext;
}>;

/**
 * 声明式渲染注册表。与 shared 的 BLOCK_NORMALIZERS 一一对应，
 * `satisfies` 的映射类型保证联合里新增 kind 时这里编译报错，不会静默漏渲染。
 */
export const BLOCK_VIEWS = Object.freeze({
  callout: CalloutView,
  records: RecordsView,
  gate: GateView,
}) satisfies { [K in PresentationBlockKind]: BlockView<K> };

export const PresentationBlocks = memo(function PresentationBlocks({
  blocks,
  ctx,
}: {
  blocks: PresentationBlock[];
  ctx?: BlockContext;
}) {
  const context = ctx ?? {};
  return (
    <>
      {blocks.map((block, i) => {
        const View = (BLOCK_VIEWS as Record<string, ComponentType<{ block: PresentationBlock; ctx: BlockContext }>>)[block.kind];
        return View ? <View key={i} block={block} ctx={context} /> : null;
      })}
    </>
  );
});
