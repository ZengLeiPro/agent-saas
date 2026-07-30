import type { DetailLine, ToolPresentation } from "@agent/shared";
import { Circle, CircleCheck, CircleX, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { activityStatusBadgeClass, activityStatusIconClass, activityStatusTextClass, type ActivityStatusTone } from "./activityStatusStyles";

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

const VERDICT_META: Record<"pass" | "fail" | "warn" | "pending", { tone: ActivityStatusTone; Icon: typeof CircleCheck }> = {
  pass: { tone: "success", Icon: CircleCheck },
  fail: { tone: "danger", Icon: CircleX },
  warn: { tone: "warning", Icon: TriangleAlert },
  pending: { tone: "pending", Icon: Circle },
};

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
  if ("indent" in line) {
    return (
      <div className="break-words text-foreground" style={{ paddingLeft: `${line.indent * 0.75}rem` }}>
        {line.text}
      </div>
    );
  }
  if ("section" in line) {
    return (
      <div className="mt-1.5 border-b border-border/60 pb-0.5 font-medium text-muted-foreground first:mt-0">
        {line.section}
      </div>
    );
  }
  // warn 行不在此渲染：PresentationDetail 把连续 warn 聚合为 WarnGroup 橙底色块
  if ("insight" in line) {
    return (
      <div className="border-l-2 border-primary pl-2">
        {line.label ? <span className="font-medium text-primary">{line.label}：</span> : null}
        <span className="break-words font-medium text-foreground">{line.insight}</span>
      </div>
    );
  }
  if ("risk" in line) {
    return (
      <div className={cn("border-l-2 pl-2", line.risk === "high" ? "border-destructive" : "border-warning")}>
        <span className={activityStatusTextClass(line.risk === "high" ? "danger" : "warning", "break-words font-medium")}>
          {line.text}
        </span>
        {line.action ? (
          <div className="text-muted-foreground">建议 · <span className="text-foreground">{line.action}</span></div>
        ) : null}
      </div>
    );
  }
  if ("verdict" in line) {
    const { tone, Icon } = VERDICT_META[line.verdict];
    return (
      <div className="flex items-start gap-1.5">
        <Icon className={activityStatusIconClass(tone, "mt-0.5 size-3 shrink-0")} />
        <span className="min-w-0 break-words text-foreground">
          {line.text}
          {line.note ? <span className="text-muted-foreground">　{line.note}</span> : null}
        </span>
      </div>
    );
  }
  if ("quote" in line) {
    return (
      <div className="border-l-2 border-border pl-2 text-muted-foreground">
        <span className="break-words">「{line.quote}」</span>
        {line.source ? <span className="whitespace-nowrap text-muted-foreground/70">　出处 {line.source}</span> : null}
      </div>
    );
  }
  if ("original" in line) {
    return (
      <div>
        <div className="break-words text-muted-foreground">{line.original}</div>
        {line.translation ? (
          <div className="mt-0.5 flex items-start gap-1.5">
            <span className={activityStatusBadgeClass("neutral", "mt-px")}>中文摘要</span>
            <span className="min-w-0 break-words text-foreground">{line.translation}</span>
          </div>
        ) : null}
      </div>
    );
  }
  if ("fields" in line) {
    // 字段网格（demo B11）：客户应当记住的硬字段。值刻意放大加粗、
    // 脱离 mono 排版——这是整条摘要里唯一允许「大字」的地方。
    return (
      <div className="grid grid-cols-2 gap-1.5 py-0.5">
        {line.fields.map((field, i) => (
          <div key={i} className="rounded-md border border-border/60 bg-background px-2.5 py-1.5">
            <div className="text-[11px] leading-4 text-muted-foreground">{field.k}</div>
            <div className="break-words font-sans text-sm font-semibold leading-5 text-foreground">
              {field.v || "—"}
            </div>
          </div>
        ))}
      </div>
    );
  }
  return null;
}

/**
 * 连续的缺口/警告行聚合为一个橙底色块（demo B11 缺口区的容器形态）。
 * 紧邻其前的小节标题行被吸收为色块标题；没有则用默认标题。
 * 只影响 warn 行的排版分组，其他行原样保持顺序。
 */
type DetailGroup =
  | { kind: "line"; line: DetailLine }
  | { kind: "warnGroup"; header: string; warns: string[] };

const DEFAULT_WARN_HEADER = "需要注意";

function isWarnLine(line: DetailLine | undefined): line is { warn: string } {
  return typeof line === "object" && line !== null && "warn" in line;
}

export function groupDetailLines(detail: DetailLine[]): DetailGroup[] {
  const groups: DetailGroup[] = [];
  for (let i = 0; i < detail.length; i++) {
    const line = detail[i];
    const isSectionHeader = typeof line === "object" && line !== null && "section" in line;
    if (isSectionHeader && isWarnLine(detail[i + 1])) {
      const warns: string[] = [];
      let j = i + 1;
      for (; isWarnLine(detail[j]); j++) warns.push((detail[j] as { warn: string }).warn);
      groups.push({ kind: "warnGroup", header: (line as { section: string }).section, warns });
      i = j - 1;
    } else if (isWarnLine(line)) {
      const warns: string[] = [line.warn];
      let j = i + 1;
      for (; isWarnLine(detail[j]); j++) warns.push((detail[j] as { warn: string }).warn);
      groups.push({ kind: "warnGroup", header: DEFAULT_WARN_HEADER, warns });
      i = j - 1;
    } else {
      groups.push({ kind: "line", line });
    }
  }
  return groups;
}

function WarnGroup({ header, warns }: { header: string; warns: string[] }) {
  return (
    <div className="space-y-1 rounded-md border border-warning/25 bg-warning/10 px-2.5 py-2">
      <div className={activityStatusTextClass("warning", "text-[11px] font-medium leading-4")}>{header}</div>
      {warns.map((warn, i) => (
        <div key={i} className="flex items-start gap-1.5">
          <TriangleAlert className={activityStatusIconClass("warning", "mt-0.5 size-3 shrink-0")} />
          <span className={activityStatusTextClass("warning", "break-words")}>{warn}</span>
        </div>
      ))}
    </div>
  );
}

export function PresentationDetail({
  data,
  className,
  hideStatus,
}: {
  data: ToolPresentation;
  className?: string;
  /** 调用方已在别处表达了状态时置真，避免同一条信息说两遍 */
  hideStatus?: boolean;
}) {
  const statusMeta = !hideStatus && data.status ? STATUS_META[data.status] : null;
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

      {groupDetailLines(data.detail ?? []).map((group, i) =>
        group.kind === "warnGroup"
          ? <WarnGroup key={i} header={group.header} warns={group.warns} />
          : <DetailRow key={i} line={group.line} />,
      )}

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
