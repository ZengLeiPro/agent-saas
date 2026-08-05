import { memo, useState, type ComponentType } from "react";
import { ChevronRight, Copy, ExternalLink } from "lucide-react";
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
import { activityStatusBadgeClass, activityStatusTextClass, type ActivityStatusTone } from "@/components/activityStatusStyles";

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

function RecordRow({ item }: { item: RecordItem }) {
  const [open, setOpen] = useState(false);
  const expandable = !!item.detail?.length;
  return (
    <div className={cn("border-b border-border/60 px-4 py-2 last:border-b-0", item.tone === "warn" && "bg-warning/5")}>
      <button
        type="button"
        onClick={expandable ? () => setOpen((v) => !v) : undefined}
        className={cn("flex w-full items-start gap-3 text-left", !expandable && "cursor-default")}
      >
        <span className={cn("min-w-0 flex-1 text-sm text-muted-foreground", item.tone === "danger" && "line-through opacity-70", item.mono && "font-mono text-xs")}>
          {item.label}
        </span>
        {item.value ? <span className={cn("min-w-0 break-words text-left text-sm text-foreground", item.mono && "font-mono text-xs")}>{item.value}</span> : null}
        {item.tag ? <span className={activityStatusBadgeClass(TONE_MAP[item.tag.tone])}>{item.tag.text}</span> : null}
        {expandable ? <ChevronRight className={cn("mt-0.5 size-3.5 shrink-0 transition-transform", open && "rotate-90")} /> : null}
      </button>
      {item.note ? <p className="mt-0.5 text-xs text-muted-foreground">{item.note}</p> : null}
      {expandable && open ? <Detail lines={item.detail} /> : null}
    </div>
  );
}

function RecordsView({ block, ctx }: { block: RecordsBlock; ctx: BlockContext }) {
  return (
    <div className="w-fit max-w-full overflow-hidden rounded-xl border border-primary/20 bg-card" data-records-block>
      {block.title ? (
        <div
          className="border-b border-primary/15 bg-primary/5 px-4 py-2.5 text-sm font-semibold text-foreground"
          data-records-title
        >
          <span className="break-words">{block.title}</span>
        </div>
      ) : null}
      {block.layout === "grid" ? (
        <div className="grid grid-cols-2 gap-x-5 gap-y-2 p-4 sm:grid-cols-3">
          {block.items.map((item, i) => (
            <div key={i}>
              <div className="break-words text-xs text-muted-foreground">{item.label}</div>
              <div className={cn("break-words text-sm", item.mono && "font-mono text-xs", item.tone && activityStatusTextClass(TONE_MAP[item.tone]))}>
                {item.value ?? ""}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div>{block.items.map((item, i) => <RecordRow key={i} item={item} />)}</div>
      )}
      {block.footer ? <div className="border-t border-primary/10 px-4 py-2 text-xs text-muted-foreground">{block.footer}</div> : null}
      <div className="px-4 pb-2.5 empty:hidden">
        <Actions actions={block.actions} ctx={ctx} />
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
