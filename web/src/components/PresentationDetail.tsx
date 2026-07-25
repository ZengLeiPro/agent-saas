import type { DetailLine, ToolPresentation } from "@agent/shared";
import { CircleCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { activityStatusBadgeClass, activityStatusTextClass, type ActivityStatusTone } from "./activityStatusStyles";

/**
 * 工具执行摘要（给人看）的渲染器。
 *
 * 与原始 payload 并列存在，不替代它：本组件只渲染业务语义摘要，
 * 原始 JSON / Result 由调用方在 debug 视图另行叠加。
 *
 * 排版形态取自三家客户演示稿的实测统计（键值对齐 60% / 树形 20% /
 * 编号 15% / 判定行 5%），键值列用 grid 对齐而非全角空格填充——
 * 中文与西文混排时空格填充对不齐。
 */

const CIRCLED_DIGITS = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";

function formatOrdinal(no: number): string {
  return no >= 1 && no <= CIRCLED_DIGITS.length ? CIRCLED_DIGITS[no - 1] : `${no}.`;
}

const STATUS_META: Record<NonNullable<ToolPresentation["status"]>, { label: string; tone: ActivityStatusTone } | null> = {
  // ok 是默认预期，不占视觉预算
  ok: null,
  warn: { label: "有风险", tone: "warning" },
  blocked: { label: "已拦截", tone: "danger" },
  waiting: { label: "等待中", tone: "pending" },
};

function KeyValueRow({ k, v, prefix }: { k: string; v: string; prefix?: string }) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3">
      <span className="flex gap-1.5 text-muted-foreground">
        {prefix ? <span className="select-none text-muted-foreground/60">{prefix}</span> : null}
        <span>{k}</span>
      </span>
      <span className="break-words text-foreground">{v}</span>
    </div>
  );
}

function DetailRow({ line }: { line: DetailLine }) {
  if (typeof line === "string") {
    return <div className="break-words text-foreground">{line}</div>;
  }
  if ("tree" in line) {
    return <KeyValueRow k={line.k} v={line.v} prefix={line.tree} />;
  }
  if ("k" in line) {
    return <KeyValueRow k={line.k} v={line.v} />;
  }
  if ("no" in line) {
    return (
      <div className="flex gap-1.5">
        <span className="select-none text-muted-foreground/60">{formatOrdinal(line.no)}</span>
        <span className="break-words text-foreground">{line.text}</span>
      </div>
    );
  }
  return (
    <div className="break-words text-foreground" style={{ paddingLeft: `${line.indent * 0.75}rem` }}>
      {line.text}
    </div>
  );
}

export function PresentationDetail({ data, className }: { data: ToolPresentation; className?: string }) {
  const statusMeta = data.status ? STATUS_META[data.status] : null;
  const hasBody = (data.detail?.length ?? 0) > 0 || !!data.receipt || !!statusMeta;
  if (!hasBody) return null;

  return (
    <div
      className={cn(
        "mt-1 space-y-1 rounded-md px-3 py-2 font-mono text-xs leading-relaxed",
        className,
      )}
      style={{ backgroundColor: "hsl(var(--code-block-bg))" }}
    >
      {statusMeta && (
        <div className="pb-0.5">
          <span className={activityStatusBadgeClass(statusMeta.tone)}>{statusMeta.label}</span>
        </div>
      )}

      {data.detail?.map((line, i) => <DetailRow key={i} line={line} />)}

      {data.receipt && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border pt-1.5">
          <span className="text-muted-foreground">回执</span>
          <span className="text-foreground">{data.receipt.system}</span>
          <span className="break-all text-foreground">{data.receipt.id}</span>
          {data.receipt.readBack && (
            <span className={cn("inline-flex items-center gap-1", activityStatusTextClass("success"))}>
              <CircleCheck className="size-3" />
              回读校验通过
            </span>
          )}
        </div>
      )}
    </div>
  );
}
