import { useMemo, useRef } from "react";
import { X } from "lucide-react";
import type {
  PanelBadge,
  PanelCard,
  PanelEmpty,
  PanelFeedItem,
  PanelRow,
  PanelStat,
  PanelTableRow,
  PanelTone,
  PanelView,
  PanelWidget,
  SystemPanelSnapshot,
} from "@agent/shared";
import { HTML_SANDBOX_CSP } from "@/components/HtmlPreviewPanel";
import { cn } from "@/lib/utils";
import { activityStatusBadgeClass, activityStatusTextClass, type ActivityStatusTone } from "@/components/activityStatusStyles";

/**
 * 右侧企业系统面板。
 *
 * 数据来自 ToolPresentation.panel/panelBase，与会话流的摘要同源——
 * 面板没有独立数据通道，演示能表达的面板 = 真实工具能产出的面板。
 *
 * 面板主体全部走 React 组件，文本经文本节点自动转义；
 * **本文件禁止出现 dangerouslySetInnerHTML**，唯一的 HTML 逃生口 `custom`
 * 走 iframe + 与文件预览同一份沙箱 CSP，且只接受演示剧本内嵌来源。
 */

const TONE_MAP: Record<PanelTone, ActivityStatusTone> = {
  pass: "success",
  warn: "warning",
  deny: "danger",
  info: "active",
  pending: "pending",
};

function Badge({ badge }: { badge: PanelBadge }) {
  return <span className={activityStatusBadgeClass(badge.tone ? TONE_MAP[badge.tone] : "neutral")}>{badge.text}</span>;
}

function EmptyState({ empty }: { empty?: PanelEmpty }) {
  return (
    <div className="flex h-full min-h-24 flex-col items-center justify-center gap-1 px-4 py-8 text-center">
      <p className="text-sm text-muted-foreground">{empty?.title ?? "暂无内容"}</p>
      {empty?.hint ? <p className="text-xs text-muted-foreground/70">{empty.hint}</p> : null}
    </div>
  );
}

function RowItem({ row }: { row: PanelRow }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b border-border/60 px-3 py-2 last:border-b-0",
        row.state === "hit" && "bg-primary/5",
        row.state === "excluded" && "opacity-55",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className={cn("truncate text-sm", row.state === "excluded" && "line-through", row.tone && activityStatusTextClass(TONE_MAP[row.tone]))}>
          {row.text}
        </div>
        {row.sub ? <div className="truncate text-xs text-muted-foreground">{row.sub}</div> : null}
      </div>
      {row.meta ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{row.meta}</span> : null}
      {row.badge ? <Badge badge={row.badge} /> : null}
    </div>
  );
}

function CardItem({ card }: { card: PanelCard }) {
  return (
    <div className={cn("rounded-md border border-border p-3", card.tone === "deny" && "border-destructive/40")}>
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-sm font-medium">{card.title}</span>
        {card.headBadge ? <Badge badge={card.headBadge} /> : null}
      </div>
      {card.body ? <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">{card.body}</p> : null}
      {card.steps?.length ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {card.steps.map((step, i) => (
            <span key={i} className="flex items-center gap-1.5 text-xs">
              <span className={cn("size-1.5 rounded-full", step.done ? "bg-success" : "bg-muted-foreground/40")} />
              <span className={step.done ? "text-foreground" : "text-muted-foreground"}>{step.label}</span>
              {i < card.steps!.length - 1 ? <span className="text-muted-foreground/40">›</span> : null}
            </span>
          ))}
        </div>
      ) : null}
      {card.meta?.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {card.meta.map((badge, i) => <Badge key={i} badge={badge} />)}
        </div>
      ) : null}
    </div>
  );
}

function StatItem({ stat }: { stat: PanelStat }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <div className="truncate text-xs text-muted-foreground">{stat.k}</div>
      <div className={cn("mt-0.5 truncate text-base font-semibold tabular-nums", stat.tone && activityStatusTextClass(TONE_MAP[stat.tone]))}>
        {stat.v}
      </div>
    </div>
  );
}

function FeedItemView({ item }: { item: PanelFeedItem }) {
  const isAgent = item.from === "ai";
  return (
    <div className="px-3 py-2">
      <div className="flex items-baseline gap-2">
        <span className={cn("text-xs font-medium", isAgent ? "text-primary" : "text-muted-foreground")}>
          {isAgent ? "AI 同事" : item.from}
        </span>
        {item.time ? <span className="text-xs text-muted-foreground/60">{item.time}</span> : null}
      </div>
      <p className="mt-0.5 whitespace-pre-wrap text-sm leading-relaxed">{item.text}</p>
      {item.card ? (
        <div className="mt-1.5 rounded-md border border-border bg-muted/30 p-2">
          <div className="text-xs font-medium">{item.card.title}</div>
          {item.card.body ? <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{item.card.body}</p> : null}
          {item.card.meta?.length ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {item.card.meta.map((badge, i) => <Badge key={i} badge={badge} />)}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TableRowView({ row, cols }: { row: PanelTableRow; cols: PanelView["widget"] extends { cols: infer C } ? C : never }) {
  return (
    <tr className={cn("border-b border-border/60 last:border-b-0", row.tone === "deny" && "bg-destructive/5")}>
      {(cols as Array<{ key: string; align?: "left" | "right" }>).map((col) => {
        const flag = row.flags?.[col.key];
        return (
          <td
            key={col.key}
            className={cn(
              "px-3 py-1.5 text-xs",
              col.align === "right" && "text-right tabular-nums",
              flag && activityStatusTextClass(TONE_MAP[flag.tone]),
              flag && "font-medium",
            )}
          >
            {row.cells[col.key] ?? ""}
            {flag?.flag ? <span className="ml-1 text-[11px]">{flag.flag}</span> : null}
          </td>
        );
      })}
    </tr>
  );
}

function Widget({ widget }: { widget: PanelWidget }) {
  switch (widget.kind) {
    case "rows":
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          {widget.modes?.length ? (
            <div className="flex shrink-0 gap-1 border-b border-border px-3 py-1.5">
              {widget.modes.map((mode) => (
                <span
                  key={mode.key}
                  className={cn(
                    "rounded px-2 py-0.5 text-xs",
                    mode.key === widget.activeMode ? "bg-primary/10 text-primary" : "text-muted-foreground",
                  )}
                >
                  {mode.label}
                </span>
              ))}
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-auto">
            {widget.rows.length ? widget.rows.map((row) => <RowItem key={row.id} row={row} />) : <EmptyState empty={widget.empty} />}
          </div>
        </div>
      );
    case "cards":
      return (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {widget.cards.length
            ? <div className="space-y-2">{widget.cards.map((card) => <CardItem key={card.id} card={card} />)}</div>
            : <EmptyState empty={widget.empty} />}
        </div>
      );
    case "table":
      return (
        <div className="min-h-0 flex-1 overflow-auto">
          {widget.rows.length ? (
            <table className="w-full border-collapse">
              <thead className="sticky top-0 bg-muted/60">
                <tr>
                  {widget.cols.map((col) => (
                    <th
                      key={col.key}
                      className={cn("border-b border-border px-3 py-1.5 text-xs font-medium text-muted-foreground", col.align === "right" ? "text-right" : "text-left")}
                      style={col.width ? { width: col.width } : undefined}
                    >
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {widget.rows.map((row) => <TableRowView key={row.id} row={row} cols={widget.cols as never} />)}
              </tbody>
            </table>
          ) : <EmptyState empty={widget.empty} />}
        </div>
      );
    case "stats":
      return (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <div className={cn("grid gap-2", widget.cols === 4 ? "grid-cols-4" : widget.cols === 2 ? "grid-cols-2" : "grid-cols-3")}>
            {widget.items.map((stat, i) => <StatItem key={i} stat={stat} />)}
          </div>
        </div>
      );
    case "feed":
      return (
        <div className="min-h-0 flex-1 divide-y divide-border/60 overflow-auto">
          {widget.items.length ? widget.items.map((item) => <FeedItemView key={item.id} item={item} />) : <EmptyState empty={widget.empty} />}
        </div>
      );
    case "custom":
      return <CustomFrame html={widget.html} />;
    default:
      return <EmptyState />;
  }
}

/** 逃生口。与文件预览共用同一份沙箱 CSP，绝不同时开 allow-same-origin。 */
function CustomFrame({ html }: { html: string }) {
  const srcDoc = useMemo(
    () => (/<head(\s[^>]*)?>/i.test(html)
      ? html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}<meta http-equiv="Content-Security-Policy" content="${HTML_SANDBOX_CSP}">`)
      : `<meta http-equiv="Content-Security-Policy" content="${HTML_SANDBOX_CSP}">${html}`),
    [html],
  );
  return <iframe title="系统视图" srcDoc={srcDoc} sandbox="allow-scripts" className="min-h-0 flex-1 border-0 bg-white" />;
}

const MAX_INLINE_VIEWS = 4;

function visiblePanelViews(views: PanelView[], activeKey: string): { inline: PanelView[]; overflow: PanelView[] } {
  if (views.length <= MAX_INLINE_VIEWS) return { inline: views, overflow: [] };
  const leading = views.slice(0, MAX_INLINE_VIEWS);
  const inline = leading.some((view) => view.key === activeKey)
    ? leading
    : [...views.slice(0, MAX_INLINE_VIEWS - 1), views.find((view) => view.key === activeKey)!];
  const inlineKeys = new Set(inline.map((view) => view.key));
  return { inline, overflow: views.filter((view) => !inlineKeys.has(view.key)) };
}

export function SystemPanel({
  snapshot,
  onSelectView,
  onClose,
  className,
}: {
  snapshot: SystemPanelSnapshot;
  onSelectView?: (key: string) => void;
  /** 真实会话里提供关闭入口；关闭后本会话不再自动打开 */
  onClose?: () => void;
  className?: string;
}) {
  const overflowDetailsRef = useRef<HTMLDetailsElement>(null);
  const active = snapshot.views.find((view) => view.key === snapshot.activeView) ?? snapshot.views[0];
  if (!active) return null;
  const panelViews = visiblePanelViews(snapshot.views, active.key);

  return (
    <div className={cn("flex min-h-0 flex-col bg-background", className)}>
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        {snapshot.live ? <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-success" /> : null}
        <span className="min-w-0 flex-1 break-words text-sm font-medium leading-5" title={snapshot.title ?? "企业系统实况"}>
          {snapshot.title ?? "企业系统实况"}
        </span>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭企业系统面板"
            className="ml-auto shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        ) : null}
      </div>

      {snapshot.views.length > 1 ? (
        <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
          {panelViews.inline.map((view) => (
            <button
              key={view.key}
              type="button"
              aria-current={view.key === active.key ? "page" : undefined}
              onClick={() => onSelectView?.(view.key)}
              className={cn(
                "min-w-0 flex-1 truncate rounded px-2 py-1 text-xs transition-colors",
                view.key === active.key ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:text-foreground",
              )}
              title={view.label}
            >
              {view.label}
            </button>
          ))}
          {panelViews.overflow.length ? (
            <details ref={overflowDetailsRef} className="relative shrink-0">
              <summary
                role="button"
                className="inline-flex cursor-pointer list-none items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&::-webkit-details-marker]:hidden"
                aria-label={`更多系统视图，共 ${panelViews.overflow.length} 个`}
              >
                <span aria-hidden>···</span>
                更多
              </summary>
              <div role="menu" className="absolute right-0 top-full z-50 mt-1 min-w-32 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
                {panelViews.overflow.map((view) => (
                  <button
                    key={view.key}
                    type="button"
                    role="menuitem"
                    className="flex w-full rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
                    onClick={() => {
                      onSelectView?.(view.key);
                      if (overflowDetailsRef.current) overflowDetailsRef.current.open = false;
                    }}
                  >
                    {view.label}
                  </button>
                ))}
              </div>
            </details>
          ) : null}
        </div>
      ) : null}

      {/* 三个圆点＝「右侧不是聊天的一部分，是被打开的另一个系统」。
          客户演示稿里最有效的一招，成本一行，语义比任何说明文案都直接。 */}
      <div className="flex shrink-0 items-start gap-2 border-b border-border bg-muted/30 px-3 py-2">
        <span aria-hidden className="mt-1 flex shrink-0 items-center gap-1">
          <span className="size-1.5 rounded-full bg-muted-foreground/30" />
          <span className="size-1.5 rounded-full bg-muted-foreground/30" />
          <span className="size-1.5 rounded-full bg-muted-foreground/30" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="break-words text-xs font-medium leading-4" title={active.toolbar?.title ?? active.winTitle}>
            {active.toolbar?.title ?? active.winTitle}
          </div>
          {active.toolbar?.sub ? (
            <div className="mt-0.5 break-words text-[11px] leading-4 text-muted-foreground" title={active.toolbar.sub}>
              {active.toolbar.sub}
            </div>
          ) : null}
        </div>
      </div>

      <Widget widget={active.widget} />

      {snapshot.foot ? (
        <div className="shrink-0 break-words border-t border-border px-3 py-1.5 text-xs leading-4 text-muted-foreground" title={snapshot.foot}>
          {snapshot.foot}
        </div>
      ) : null}
    </div>
  );
}
