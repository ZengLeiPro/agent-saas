/** Run 追踪详情：时间线各类事件的渲染单元 */
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import {
  TriangleAlert,
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  Database,
  Flag,
  ListTree,
  User,
  Workflow,
  Wrench,
} from "lucide-react";
import { EntityIcons } from "@/lib/icons";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { EntityLink } from "@/components/PlatformAdmin/common";
import { RUN_SHORT_LABEL, formatExecutionTarget, formatFailureClass, formatToolName, formatToolRisk } from "@/components/PlatformAdmin/displayText";
import { formatTokens } from "@/components/UsageDashboard/format";

import { diffMs, formatMs, formatOffset, formatTime } from "./format";
import { SPAN_KIND_STYLES, SPAN_KIND_ORDER, spanKindOf, type SpanKind } from "./spanKind";
import { RUN_STATUS_LABELS, finishSubtypeClass, finishSubtypeLabel } from "./StatusBadge";
import type { TraceEvent } from "./types";

/** 长文本默认折叠阈值（字符） */
const COLLAPSE_THRESHOLD = 500;

// ────────── 时间线坐标系（相对时间 0 点 + 耗时条归一化基准 + 子 agent 下钻） ──────────

/** 子 agent 下钻目标：把父时间线里的一条 subagent 事件换成子 run 自己的时间线 */
export interface SubagentDrillTarget {
  runId: string;
  sessionId?: string;
  agentType?: string;
  description?: string;
}

export interface TimelineFrame {
  /**
   * 相对时间的 0 点（run 起点或首个事件时间戳）。
   * null → 退化为绝对时刻（组件在时间线之外被单独使用时的兜底）。
   */
  origin: string | null;
  /** 耗时条归一化基准（ms）。null → 不画条，只留耗时文字。 */
  basisMs: number | null;
  /** 基准口径的中文说明，进 title——「按什么归一化」必须可查，不能让人自己猜 */
  basisLabel: string;
  /** 子 agent 下钻回调；不传则不渲染下钻按钮（例如脱敏视图拿不到 childRunId） */
  onDrillSubagent?: (target: SubagentDrillTarget) => void;
}

const EMPTY_FRAME: TimelineFrame = { origin: null, basisMs: null, basisLabel: "" };

const TimelineFrameContext = createContext<TimelineFrame>(EMPTY_FRAME);

/**
 * 时间线坐标系 Provider。用 context 而不是逐层传 prop，是因为坐标系对
 * `RunDetailView` 的 13 个分支是**同一份**，逐个透传只会让 switch 变噪音。
 */
export function TimelineFrameProvider({ value, children }: { value: TimelineFrame; children: ReactNode }) {
  return <TimelineFrameContext.Provider value={value}>{children}</TimelineFrameContext.Provider>;
}

function useTimelineFrame(): TimelineFrame {
  return useContext(TimelineFrameContext);
}

/** 时间戳 → 「相对起点偏移」文本 + 「绝对时刻」title（拿不到起点时退化为绝对时刻） */
function useTimestampLabel(timestamp: string): { text: string; title: string } {
  const { origin } = useTimelineFrame();
  const absolute = formatTime(timestamp);
  const offset = diffMs(timestamp, origin);
  if (offset == null || offset < 0) return { text: absolute, title: `绝对时刻 ${absolute}` };
  return { text: formatOffset(offset), title: `相对起点 ${formatOffset(offset)} · 绝对时刻 ${absolute}` };
}

export function TruncatedBadge({ event }: { event: TraceEvent }) {
  if (!event.truncated) return null;
  return (
    <Badge variant="warning" className="text-2xs">已截断</Badge>
  );
}

/**
 * 耗时条：按时间线坐标系的基准归一化，让「哪一步是瓶颈」不用读数字就能看出来。
 * 写法沿用 `RunDetailView` 侧栏工具耗时条（同一视觉语言，不另造一套）。
 */
export function DurationBar({
  ms,
  kind = "tool",
  failed = false,
  showText = false,
  className,
}: {
  ms: number | null | undefined;
  kind?: SpanKind;
  /** 失败的步骤用 destructive 覆盖类型色——结果好坏优先于类型 */
  failed?: boolean;
  showText?: boolean;
  className?: string;
}) {
  const { basisMs, basisLabel } = useTimelineFrame();
  if (ms == null || !Number.isFinite(ms) || ms < 0 || basisMs == null || basisMs <= 0) return null;
  const ratio = Math.min(ms / basisMs, 1);
  // 0ms 的调用也要看得见「这里有一步」，因此下限 0.8%（不是把它伪装成有耗时）
  const width = `${Math.max(ratio * 100, 0.8).toFixed(1)}%`;
  const percentText = `${(ratio * 100).toFixed(ratio * 100 < 1 ? 1 : 0)}%`;
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div
        className="h-1.5 min-w-12 flex-1 overflow-hidden rounded bg-muted"
        title={`耗时 ${formatMs(ms)} · 占${basisLabel} ${percentText}`}
        role="img"
        aria-label={`耗时 ${formatMs(ms)}，占${basisLabel} ${percentText}`}
      >
        <div
          className={cn("h-full rounded", failed ? "bg-destructive/70" : SPAN_KIND_STYLES[kind].bar)}
          style={{ width }}
        />
      </div>
      {showText && (
        <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">{formatMs(ms)}</span>
      )}
    </div>
  );
}

/** 长文本：超过阈值默认折叠，展开/收起按钮 */
export function CollapsibleText({
  text,
  mono = false,
  className,
}: {
  text: string;
  mono?: boolean;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const needsCollapse = text.length > COLLAPSE_THRESHOLD;
  const shown = expanded || !needsCollapse ? text : `${text.slice(0, COLLAPSE_THRESHOLD)}…`;
  return (
    <div className={className}>
      <pre
        className={cn(
          "max-w-full whitespace-pre-wrap break-words text-xs leading-5",
          mono ? "font-mono" : "font-sans",
        )}
      >
        {shown}
      </pre>
      {needsCollapse && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-xs text-primary hover:underline"
        >
          {expanded ? "收起" : `展开全文（${text.length.toLocaleString()} 字符）`}
        </button>
      )}
    </div>
  );
}

/** JSON 字符串 / 对象 → 尽力 pretty print（解析失败原样展示） */
function prettyJson(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 首行预览（折叠标题用）：压掉换行与连续空白，超长截断 */
function firstLinePreview(text: string, max = 48): string {
  const line = text.trim().split("\n").find((item) => item.trim().length > 0)?.trim().replace(/\s+/g, " ") ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * 折叠区的**内容摘要**（启用 `CollapsedSection` 的 meta 槽）。
 *
 * 改造前标题写的是「（默认收起）」——把交互说明当文案，零信息量：
 * 收起状态下运维完全不知道里面是 2 千字的记忆还是一句话，只能全部点开。
 * 现在给出「多少字符 + 首行是什么」，大部分情况下不点开就能判断要不要看。
 */
export function textMeta(text: string): ReactNode {
  const preview = firstLinePreview(text);
  return (
    <span className="min-w-0 truncate text-2xs font-normal text-muted-foreground">
      · {text.length.toLocaleString()} 字符{preview ? ` · ${preview}` : ""}
    </span>
  );
}

/** 折叠区摘要（结构化入参）：字段个数 + 字段名，比字符数更贴近审批场景 */
export function inputMeta(value: unknown): ReactNode {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown; } catch { return value; } })() : value;
  if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const keys = Object.keys(parsed as Record<string, unknown>);
    if (keys.length > 0) {
      return (
        <span className="min-w-0 truncate text-2xs font-normal text-muted-foreground">
          · {keys.length} 个字段：{keys.slice(0, 4).join("、")}{keys.length > 4 ? "…" : ""}
        </span>
      );
    }
  }
  return textMeta(prettyJson(value));
}

/** 整块默认收起的折叠区（memory_context / assistant_thinking / approval input） */
export function CollapsedSection({
  icon,
  label,
  meta,
  children,
  defaultOpen = false,
}: {
  icon: ReactNode;
  label: string;
  meta?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        {icon}
        <span className="shrink-0 font-medium">{label}</span>
        {meta}
      </button>
      {open && <div className="border-t px-3 py-2">{children}</div>}
    </div>
  );
}

/**
 * 从属关系的一级缩进（工具调用挂在 assistant 步骤下、子 agent 挂在派生它的工具调用下）。
 * 缩进 + 左边框让层级在视觉上成立，而不是所有事件一律平级。
 */
export function NestedGroup({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("ml-6 space-y-1.5 border-l border-border/70 pl-3", className)}>{children}</div>
  );
}

/**
 * 事件卡通用外壳：左侧 icon + 连续时间轴竖线 + 右侧内容（相对时间在行尾）。
 *
 * 轴线连续性：竖线由每个节点自己画满整行高度，相邻节点首尾相接；
 * 只有**最后一个**节点不画（`isLast`），否则时间线尾部会拖出一条没有终点的线。
 */
export function EventShell({
  icon,
  kind,
  eventType,
  iconClass,
  title,
  timestamp,
  badges,
  children,
  bodyClass,
  isLast = false,
}: {
  icon: ReactNode;
  /** 显式指定类型色；不传则按 eventType 推导（spanKind 色板） */
  kind?: SpanKind;
  eventType?: string;
  /** 覆盖类型色——仅用于「结果好坏」优先于「事件类型」的场合（执行故障 / 运行终态） */
  iconClass?: string;
  title: string;
  timestamp: string;
  badges?: ReactNode;
  children?: ReactNode;
  bodyClass?: string;
  isLast?: boolean;
}) {
  const style = SPAN_KIND_STYLES[kind ?? spanKindOf(eventType)];
  const { text: timeText, title: timeTitle } = useTimestampLabel(timestamp);
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div className={cn("flex size-6 shrink-0 items-center justify-center rounded-full", iconClass ?? cn(style.surface, style.ink))}>
          {icon}
        </div>
        {!isLast && <div className="w-px flex-1 bg-border" />}
      </div>
      <div className="min-w-0 flex-1 pb-4">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium">{title}</span>
          {badges}
          <span className="ml-auto text-muted-foreground tabular-nums" title={timeTitle}>{timeText}</span>
        </div>
        {children && <div className={cn("mt-1.5", bodyClass)}>{children}</div>}
      </div>
    </div>
  );
}

/**
 * 细分隔线节点（run_state_changed / run_enqueued 等轻量事件）。
 * 自己画同一根轴（`absolute left-3`），否则每出现一个轻量事件时间轴就断一次。
 */
export function DividerNode({
  timestamp,
  children,
  tone = "muted",
  isLast = false,
}: {
  timestamp: string;
  children: ReactNode;
  tone?: "muted" | "warn";
  isLast?: boolean;
}) {
  const { text: timeText, title: timeTitle } = useTimestampLabel(timestamp);
  return (
    <div className="relative flex items-center gap-2 py-1 pl-3 text-2xs">
      {!isLast && <span aria-hidden className="absolute left-3 top-0 h-full w-px -translate-x-1/2 bg-border" />}
      <div className={cn("h-px w-4 shrink-0", tone === "warn" ? "bg-warning" : "bg-border")} />
      <span className={cn(tone === "warn" ? "text-warning-ink" : "text-muted-foreground")}>{children}</span>
      <span className="text-muted-foreground/70 tabular-nums" title={timeTitle}>{timeText}</span>
    </div>
  );
}

/**
 * 类型色图例。只列**本次运行实际出现过**的类型，避免摆一排用不上的颜色。
 * 有图例颜色编码才成立——否则运维只知道「有颜色」，不知道颜色是什么意思。
 */
export function SpanKindLegend({ kinds, className }: { kinds: Iterable<SpanKind>; className?: string }) {
  const present = useMemo(() => {
    const set = new Set(kinds);
    return SPAN_KIND_ORDER.filter((kind) => set.has(kind));
  }, [kinds]);
  if (present.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground", className)}>
      <span>类型：</span>
      {present.map((kind) => (
        <span key={kind} className="flex items-center gap-1">
          <span className={cn("size-1.5 rounded-full", SPAN_KIND_STYLES[kind].dot)} aria-hidden />
          {SPAN_KIND_STYLES[kind].label}
        </span>
      ))}
    </div>
  );
}

// ────────── 各类型事件 ──────────

export function UserMessageItem({ event, isLast }: { event: TraceEvent; isLast?: boolean }) {
  return (
    <EventShell
      icon={<User className="size-3.5" />}
      eventType={event.type}
      title="用户消息"
      timestamp={event.timestamp}
      isLast={isLast}
      badges={<TruncatedBadge event={event} />}
    >
      <div className="rounded-lg border border-info/30 bg-info-subtle p-3">
        <CollapsibleText text={event.content ?? ""} />
      </div>
    </EventShell>
  );
}

export function MemoryContextItem({ event, isLast }: { event: TraceEvent; isLast?: boolean }) {
  const content = event.content ?? "";
  return (
    <EventShell
      icon={<Database className="size-3.5" />}
      eventType={event.type}
      title="记忆上下文"
      timestamp={event.timestamp}
      isLast={isLast}
      badges={<TruncatedBadge event={event} />}
    >
      <CollapsedSection icon={<Database className="size-3.5" />} label="注入的记忆内容" meta={textMeta(content)}>
        <CollapsibleText text={content} mono />
      </CollapsedSection>
    </EventShell>
  );
}

export function ThinkingItem({ event, isLast }: { event: TraceEvent; isLast?: boolean }) {
  const content = event.content ?? "";
  return (
    <EventShell
      icon={<Brain className="size-3.5" />}
      eventType={event.type}
      title="思考"
      timestamp={event.timestamp}
      isLast={isLast}
      badges={<TruncatedBadge event={event} />}
    >
      <CollapsedSection icon={<Brain className="size-3.5" />} label="思考内容" meta={textMeta(content)}>
        <CollapsibleText text={content} className="text-muted-foreground" />
      </CollapsedSection>
    </EventShell>
  );
}

export function AssistantMessageItem({ event, isLast }: { event: TraceEvent; isLast?: boolean }) {
  return (
    <EventShell
      icon={<Bot className="size-3.5" />}
      eventType={event.type}
      title="助手回复"
      timestamp={event.timestamp}
      isLast={isLast}
      badges={
        <>
          {event.model && <Badge variant="outline" className="font-mono text-2xs">{event.model}</Badge>}
          <TruncatedBadge event={event} />
        </>
      }
    >
      <div className="rounded-lg border bg-card p-3">
        <CollapsibleText text={event.content ?? ""} />
      </div>
    </EventShell>
  );
}

/** 工具调用一行：assistant_tool_calls 里的单个 call + 关联 tool_result / tool_audit */
export function ToolCallRow({
  callId,
  name,
  args,
  result,
  audit,
  subagent,
}: {
  callId: string;
  name: string;
  args: string;
  result?: TraceEvent;
  audit?: TraceEvent;
  /** 该工具调用派生的子 agent（Agent 工具）：给出下钻入口 */
  subagent?: TraceEvent;
}) {
  const [open, setOpen] = useState(false);
  const { onDrillSubagent } = useTimelineFrame();
  const failed = audit?.status === "error" || result?.isError === true;
  const finished = audit != null || result != null;
  const dotClass = failed ? "bg-destructive" : finished ? "bg-success" : "bg-muted-foreground/40";
  const prettyArgs = useMemo(() => prettyJson(args), [args]);
  const childRunId = typeof subagent?.childRunId === "string" ? subagent.childRunId : null;
  return (
    <div className="rounded-md border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full flex-wrap items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-muted/40"
      >
        {open ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
        <span className={cn("size-2 shrink-0 rounded-full", dotClass)} />
        <span className="font-medium">{formatToolName(name)}</span>
        {formatToolName(name) !== name && <span className="font-mono text-2xs text-muted-foreground">{name}</span>}
        {audit?.skillName && <Badge variant="outline" className="font-mono text-2xs">技能：{audit.skillName}</Badge>}
        {audit?.durationMs != null && (
          <span className="text-muted-foreground tabular-nums">{formatMs(audit.durationMs)}</span>
        )}
        {audit?.risk && (
          <Badge variant="outline" className="text-2xs">风险：{formatToolRisk(audit.risk)}</Badge>
        )}
        {audit?.executionTarget && (
          <Badge variant="outline" className="text-2xs">{formatExecutionTarget(audit.executionTarget)}</Badge>
        )}
        {subagent && (
          <Badge className={cn("border-0 text-2xs", SPAN_KIND_STYLES.subagent.surface, SPAN_KIND_STYLES.subagent.ink)}>
            子 agent{subagent.description ? `：${firstLinePreview(String(subagent.description), 24)}` : ""}
          </Badge>
        )}
        {failed && <Badge variant="danger" className="text-2xs">失败</Badge>}
        {!finished && <span className="text-2xs text-muted-foreground">无结果记录</span>}
      </button>
      {/* 耗时条：本 run 内横向可比，一眼看出哪个工具调用是瓶颈（视觉审计 Q8 改法 1） */}
      {audit?.durationMs != null && (
        <DurationBar
          ms={audit.durationMs}
          kind="tool"
          failed={failed}
          className="px-2.5 pb-1.5"
        />
      )}
      {childRunId && onDrillSubagent && (
        <div className="px-2.5 pb-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-2xs"
            onClick={() => onDrillSubagent({
              runId: childRunId,
              sessionId: typeof subagent?.childSessionId === "string" ? subagent.childSessionId : undefined,
              agentType: typeof subagent?.agentType === "string" ? subagent.agentType : undefined,
              description: typeof subagent?.description === "string" ? subagent.description : undefined,
            })}
          >
            <ListTree className="mr-1 size-3" />
            查看子 agent 时间线
          </Button>
        </div>
      )}
      {open && (
        <div className="space-y-2 border-t px-2.5 py-2">
          <div>
            <div className="mb-1 text-2xs font-medium text-muted-foreground">参数（调用 ID：{callId}）</div>
            <CollapsibleText text={prettyArgs} mono className="rounded bg-muted/40 p-2" />
          </div>
          {result && (
            <div>
              <div className="mb-1 flex items-center gap-2 text-2xs font-medium text-muted-foreground">
                结果 <TruncatedBadge event={result} />
              </div>
              <CollapsibleText
                text={result.content ?? ""}
                mono
                className={cn("rounded p-2", result.isError ? "bg-destructive/10" : "bg-muted/40")}
              />
            </div>
          )}
          {audit?.error && (
            <div className="rounded bg-destructive/10 p-2 text-xs text-destructive">{audit.error}</div>
          )}
        </div>
      )}
    </div>
  );
}

export function ToolCallsItem({
  event,
  resultByCallId,
  auditByCallId,
  subagentByCallId,
  isLast,
}: {
  event: TraceEvent;
  resultByCallId: Map<string, TraceEvent>;
  auditByCallId: Map<string, TraceEvent>;
  subagentByCallId?: Map<string, TraceEvent>;
  isLast?: boolean;
}) {
  const calls = event.toolCalls ?? [];
  return (
    <EventShell
      icon={<Wrench className="size-3.5" />}
      eventType={event.type}
      title={`工具调用 × ${calls.length}`}
      timestamp={event.timestamp}
      isLast={isLast}
      badges={
        <>
          {event.model && <Badge variant="outline" className="font-mono text-2xs">{event.model}</Badge>}
          <TruncatedBadge event={event} />
        </>
      }
    >
      <div className="space-y-1.5">
        {event.content && event.content.trim().length > 0 && (
          <div className="rounded-lg border bg-card p-3">
            <CollapsibleText text={event.content} />
          </div>
        )}
        {/* 缩进 + 左边框：工具调用从属于这个 assistant 步骤，而不是与它平级（视觉审计 Q8 改法 3） */}
        <NestedGroup>
          {calls.map((call) => (
            <ToolCallRow
              key={call.id}
              callId={call.id}
              name={call.name}
              args={call.arguments}
              result={resultByCallId.get(call.id)}
              audit={auditByCallId.get(call.id)}
              subagent={subagentByCallId?.get(call.id)}
            />
          ))}
        </NestedGroup>
      </div>
    </EventShell>
  );
}

/** 游离的 tool_result / tool_audit（没有对应 assistant_tool_calls 时兜底展示） */
export function OrphanToolEventItem({ event, isLast }: { event: TraceEvent; isLast?: boolean }) {
  const failed = event.status === "error" || event.isError === true;
  return (
    <EventShell
      icon={<Wrench className="size-3.5" />}
      eventType={event.type}
      title={event.type === "tool_audit" ? "工具审计" : "工具结果"}
      timestamp={event.timestamp}
      isLast={isLast}
      badges={
        <>
          <span>{formatToolName(event.toolName)}</span>
          {event.skillName && <Badge variant="outline" className="font-mono text-2xs">技能：{event.skillName}</Badge>}
          {event.durationMs != null && <span className="text-muted-foreground tabular-nums">{formatMs(event.durationMs)}</span>}
          {failed && <Badge variant="danger" className="text-2xs">失败</Badge>}
          <TruncatedBadge event={event} />
        </>
      }
    >
      {event.durationMs != null && <DurationBar ms={event.durationMs} kind="tool" failed={failed} className="mb-1.5" />}
      {event.content && (
        <CollapsibleText text={event.content} mono className="rounded bg-muted/40 p-2" />
      )}
      {event.error && <div className="mt-1 rounded bg-destructive/10 p-2 text-xs text-destructive">{event.error}</div>}
    </EventShell>
  );
}

function decisionLabel(decision?: string): string {
  if (decision === "approve" || decision === "approved" || decision === "allow") return "通过";
  if (decision === "deny" || decision === "denied" || decision === "reject") return "拒绝";
  return decision ?? "未决";
}

/** 审批对：approval_requested + 匹配的 approval_resolved */
export function ApprovalPairItem({ event, resolved, isLast }: { event: TraceEvent; resolved?: TraceEvent; isLast?: boolean }) {
  const waitMs =
    resolved != null
      ? new Date(resolved.timestamp).getTime() - new Date(event.timestamp).getTime()
      : null;
  const approved = resolved?.decision === "approve" || resolved?.decision === "approved" || resolved?.decision === "allow";
  return (
    <EventShell
      icon={<EntityIcons.admin className="size-3.5" />}
      eventType={event.type}
      title="审批"
      timestamp={event.timestamp}
      isLast={isLast}
      badges={
        <>
          <span>{event.toolName ? formatToolName(event.toolName) : ""}</span>
          {resolved ? (
            <Badge
              className={cn(
                "border-0 text-2xs",
                approved
                  ? "bg-success/15 text-success-ink"
                  : "bg-danger/15 text-danger-ink",
              )}
            >
              {decisionLabel(resolved.decision)}
            </Badge>
          ) : (
            <Badge variant="warning" className="text-2xs">未决</Badge>
          )}
          {waitMs != null && waitMs >= 0 && (
            <span className="text-muted-foreground">等待 {formatMs(waitMs)}</span>
          )}
        </>
      }
    >
      {/* 等人也是耗时：审批等待与工具耗时同一把尺子，才能看出「慢在机器还是慢在人」 */}
      {waitMs != null && waitMs >= 0 && <DurationBar ms={waitMs} kind="approval" className="mb-1.5" />}
      {event.input != null && (
        <CollapsedSection icon={<Wrench className="size-3.5" />} label="审批入参" meta={inputMeta(event.input)}>
          <CollapsibleText text={prettyJson(event.input)} mono />
        </CollapsedSection>
      )}
    </EventShell>
  );
}

// ────────── 子 agent（Agent 工具派生的子 run） ──────────

/** 子 agent 类型的人话名（后端 agentTypes.ts 的两个内置类型） */
const AGENT_TYPE_LABELS: Record<string, string> = {
  general: "通用执行",
  explore: "搜索侦察",
};

export function formatAgentType(agentType: string | null | undefined): string {
  if (!agentType) return "未知类型";
  return AGENT_TYPE_LABELS[agentType] ?? agentType;
}

/** 子 agent 终态（后端 runtime outcome 枚举，绝不从模型文本推断） */
const SUBAGENT_STATUS: Record<string, { label: string; variant: "success" | "danger" | "warning" | "muted" }> = {
  completed: { label: "已完成", variant: "success" },
  failed: { label: "失败", variant: "danger" },
  cancelled: { label: "已取消", variant: "muted" },
  timeout: { label: "超时", variant: "warning" },
};

/**
 * 子 agent 对：subagent_started + 匹配的 subagent_finished。
 *
 * 这两类事件后端早就在写（父 session 上），但改造前 UI 完全没渲染——
 * 一次 fan-out 出去 4 个子 agent 的执行在父时间线上是**不可见的黑洞**：
 * 只看到一次 Agent 工具调用和一段结果文本，中间到底跑了什么、慢在哪、
 * 谁失败了全都看不见。这里把它渲染成成对节点（同审批对的处理方式），
 * 并给出「点进去看子 agent 自己的时间线」——子 run 有独立 runId，
 * `/runs/:runId/events` 直接就能拉到它的完整时间线，不需要 span 树改造。
 */
export function SubagentPairItem({
  event,
  finished,
  isLast,
}: {
  event: TraceEvent;
  finished?: TraceEvent;
  isLast?: boolean;
}) {
  const { onDrillSubagent } = useTimelineFrame();
  const outcome = finished?.status ? SUBAGENT_STATUS[finished.status] : undefined;
  const durationMs = typeof finished?.durationMs === "number" ? finished.durationMs : null;
  const childRunId = typeof event.childRunId === "string" ? event.childRunId : null;
  const childSessionId = typeof event.childSessionId === "string" ? event.childSessionId : null;
  const description = typeof event.description === "string" ? event.description : "";
  const resultPreview = typeof finished?.resultPreview === "string" ? finished.resultPreview : "";
  const errorMessage = typeof finished?.errorMessage === "string" ? finished.errorMessage : "";
  return (
    <EventShell
      icon={<Workflow className="size-3.5" />}
      eventType={event.type}
      title={`子 agent · ${formatAgentType(event.agentType)}`}
      timestamp={event.timestamp}
      isLast={isLast}
      badges={
        <>
          {outcome ? (
            <Badge variant={outcome.variant} className="text-2xs">{outcome.label}</Badge>
          ) : (
            <Badge variant="info" className="text-2xs">进行中</Badge>
          )}
          {durationMs != null && <span className="text-muted-foreground tabular-nums">{formatMs(durationMs)}</span>}
          {finished?.turnCount != null && <span className="text-muted-foreground tabular-nums">{finished.turnCount} 轮</span>}
          {finished?.toolUseCount != null && <span className="text-muted-foreground tabular-nums">{finished.toolUseCount} 次工具</span>}
          {finished?.totalTokens != null && (
            <span className="text-muted-foreground tabular-nums">{formatTokens(finished.totalTokens)} Token</span>
          )}
          {event.model && <Badge variant="outline" className="font-mono text-2xs">{event.model}</Badge>}
        </>
      }
    >
      {/* 子 agent 的执行细节在它自己的 session 里，父时间线只呈现「委派了什么 + 结果如何 + 入口」 */}
      <NestedGroup className="space-y-2">
        {description && <div className="text-xs">委派任务：{description}</div>}
        {durationMs != null && (
          <DurationBar ms={durationMs} kind="subagent" failed={finished?.status === "failed"} showText />
        )}
        {errorMessage && (
          <div className="rounded bg-destructive/10 p-2 text-xs text-destructive">{errorMessage}</div>
        )}
        {resultPreview && (
          <CollapsedSection
            icon={<Workflow className="size-3.5" />}
            label="子 agent 回报预览"
            meta={textMeta(resultPreview)}
          >
            <CollapsibleText text={resultPreview} />
          </CollapsedSection>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
          {childRunId && onDrillSubagent && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-2xs"
              onClick={() => onDrillSubagent({
                runId: childRunId,
                sessionId: childSessionId ?? undefined,
                agentType: typeof event.agentType === "string" ? event.agentType : undefined,
                description: description || undefined,
              })}
            >
              <ListTree className="mr-1 size-3" />
              查看子 agent 时间线
            </Button>
          )}
          {childRunId && (
            <span className="flex items-center gap-1">子执行记录 <EntityLink kind="run" id={childRunId} short={10} /></span>
          )}
          {childSessionId && (
            <span className="flex items-center gap-1">子对话 <EntityLink kind="session" id={childSessionId} short={10} /></span>
          )}
          {!childRunId && <span>子执行记录编号在当前视图中不可见（脱敏视图不返回该字段）</span>}
        </div>
      </NestedGroup>
    </EventShell>
  );
}

export function HandFailureItem({ event, isLast }: { event: TraceEvent; isLast?: boolean }) {
  return (
    <EventShell
      icon={<TriangleAlert className="size-3.5" />}
      eventType={event.type}
      // 执行环境故障是「结果坏了」而不是「一类事件」，红色优先于类型色
      iconClass="bg-danger/15 text-danger-ink"
      title="执行环境故障"
      timestamp={event.timestamp}
      isLast={isLast}
      badges={
        <>
          {event.classifiedAs && <Badge className="border-0 bg-destructive/15 text-2xs text-destructive">{formatFailureClass(event.classifiedAs)}</Badge>}
          {event.toolName && <span>{formatToolName(event.toolName)}</span>}
        </>
      }
    >
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
        {event.error ?? "（无错误详情）"}
        {event.handId != null && <div className="mt-1 font-mono text-2xs opacity-80">执行环境：{String(event.handId)}</div>}
      </div>
    </EventShell>
  );
}

export function RunStateChangedNode({ event, isLast }: { event: TraceEvent; isLast?: boolean }) {
  const status = event.status ?? "";
  const isWaiting = status.startsWith("waiting_");
  const prev = event.previousStatus ? RUN_STATUS_LABELS[event.previousStatus] ?? event.previousStatus : null;
  const curr = RUN_STATUS_LABELS[status] ?? status;
  return (
    <DividerNode timestamp={event.timestamp} tone={isWaiting ? "warn" : "muted"} isLast={isLast}>
      状态变更：{prev ? `${prev} → ` : ""}
      <span className="font-medium">{curr}</span>
      {isWaiting && "（等待态）"}
      {event.reason && ` · ${event.reason}`}
    </DividerNode>
  );
}

export function RunFinishedItem({ event, isLast }: { event: TraceEvent; isLast?: boolean }) {
  return (
    <EventShell
      icon={<Flag className="size-3.5" />}
      eventType={event.type}
      // 运行终态同理：绿/红/琥珀表达的是终态好坏，不是事件类型
      iconClass={cn(
        event.subtype === "success"
          ? "bg-success/15 text-success-ink"
          : event.subtype === "error"
            ? "bg-danger/15 text-danger-ink"
            : "bg-warning/15 text-warning-ink",
      )}
      title="运行结束"
      timestamp={event.timestamp}
      isLast={isLast}
    >
      <div className={cn("rounded-lg border p-3 text-xs", finishSubtypeClass(event.subtype))}>
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-medium">终态：{finishSubtypeLabel(event.subtype)}</span>
          {event.numTurns != null && <span>轮次：{event.numTurns}</span>}
        </div>
        {event.error && <div className="mt-1.5 whitespace-pre-wrap break-words">{event.error}</div>}
      </div>
    </EventShell>
  );
}

/** 其余轻量 / 未知事件统一用细节点表示 */
export function GenericEventNode({ event, isLast }: { event: TraceEvent; isLast?: boolean }) {
  let label: string;
  switch (event.type) {
    case "run_enqueued":
      label = `${RUN_SHORT_LABEL}入队`;
      break;
    case "run_lease_acquired":
      label = `执行器领取${event.workerId ? `（${String(event.workerId)}）` : ""}`;
      break;
    case "hand_provisioned":
      label = `执行环境就绪${event.handId ? `（${String(event.handId)}）` : ""}`;
      break;
    case "run_started":
      label = `${RUN_SHORT_LABEL}开始`;
      break;
    default:
      label = event.type;
  }
  return <DividerNode timestamp={event.timestamp} isLast={isLast}>{label}</DividerNode>;
}
