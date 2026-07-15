/** Run 追踪详情：时间线各类事件的渲染单元 */
import { useMemo, useState, type ReactNode } from "react";
import {
  TriangleAlert,
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  Database,
  Flag,
  User,
  Wrench,
} from "lucide-react";
import { EntityIcons } from "@/lib/icons";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { RUN_SHORT_LABEL, formatExecutionTarget, formatFailureClass, formatToolName, formatToolRisk } from "@/components/PlatformAdmin/displayText";

import { formatMs, formatTime } from "./format";
import { RUN_STATUS_LABELS, finishSubtypeClass, finishSubtypeLabel } from "./StatusBadge";
import type { TraceEvent } from "./types";

/** 长文本默认折叠阈值（字符） */
const COLLAPSE_THRESHOLD = 500;

export function TruncatedBadge({ event }: { event: TraceEvent }) {
  if (!event.truncated) return null;
  return (
    <Badge className="border-0 bg-amber-500/15 text-[10px] text-amber-700 dark:text-amber-300">已截断</Badge>
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
        <span className="font-medium">{label}</span>
        {meta}
      </button>
      {open && <div className="border-t px-3 py-2">{children}</div>}
    </div>
  );
}

/** 事件卡通用外壳：左侧 icon 竖线 + 时间戳 */
export function EventShell({
  icon,
  iconClass,
  title,
  timestamp,
  badges,
  children,
  bodyClass,
}: {
  icon: ReactNode;
  iconClass?: string;
  title: string;
  timestamp: string;
  badges?: ReactNode;
  children?: ReactNode;
  bodyClass?: string;
}) {
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div className={cn("flex size-6 shrink-0 items-center justify-center rounded-full", iconClass ?? "bg-muted text-muted-foreground")}>
          {icon}
        </div>
        <div className="w-px flex-1 bg-border" />
      </div>
      <div className="min-w-0 flex-1 pb-4">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium">{title}</span>
          {badges}
          <span className="ml-auto text-muted-foreground tabular-nums">{formatTime(timestamp)}</span>
        </div>
        {children && <div className={cn("mt-1.5", bodyClass)}>{children}</div>}
      </div>
    </div>
  );
}

/** 细分隔线节点（run_state_changed / run_enqueued 等轻量事件） */
export function DividerNode({
  timestamp,
  children,
  tone = "muted",
}: {
  timestamp: string;
  children: ReactNode;
  tone?: "muted" | "warn";
}) {
  return (
    <div className="flex items-center gap-2 py-1 pl-9 text-[11px]">
      <div className={cn("h-px w-4", tone === "warn" ? "bg-amber-400" : "bg-border")} />
      <span className={cn(tone === "warn" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground")}>{children}</span>
      <span className="text-muted-foreground/70 tabular-nums">{formatTime(timestamp)}</span>
    </div>
  );
}

// ────────── 各类型事件 ──────────

export function UserMessageItem({ event }: { event: TraceEvent }) {
  return (
    <EventShell
      icon={<User className="size-3.5" />}
      iconClass="bg-blue-500/15 text-blue-700 dark:text-blue-300"
      title="用户消息"
      timestamp={event.timestamp}
      badges={<TruncatedBadge event={event} />}
    >
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-900/40 dark:bg-blue-950/30">
        <CollapsibleText text={event.content ?? ""} />
      </div>
    </EventShell>
  );
}

export function MemoryContextItem({ event }: { event: TraceEvent }) {
  return (
    <EventShell
      icon={<Database className="size-3.5" />}
      title="记忆上下文"
      timestamp={event.timestamp}
      badges={<TruncatedBadge event={event} />}
    >
      <CollapsedSection icon={<Database className="size-3.5" />} label="注入的记忆内容（默认收起）">
        <CollapsibleText text={event.content ?? ""} mono />
      </CollapsedSection>
    </EventShell>
  );
}

export function ThinkingItem({ event }: { event: TraceEvent }) {
  return (
    <EventShell
      icon={<Brain className="size-3.5" />}
      title="思考"
      timestamp={event.timestamp}
      badges={<TruncatedBadge event={event} />}
    >
      <CollapsedSection icon={<Brain className="size-3.5" />} label="思考内容（默认收起）">
        <CollapsibleText text={event.content ?? ""} className="text-muted-foreground" />
      </CollapsedSection>
    </EventShell>
  );
}

export function AssistantMessageItem({ event }: { event: TraceEvent }) {
  return (
    <EventShell
      icon={<Bot className="size-3.5" />}
      iconClass="bg-primary/10 text-primary"
      title="助手回复"
      timestamp={event.timestamp}
      badges={
        <>
          {event.model && <Badge variant="outline" className="font-mono text-[10px]">{event.model}</Badge>}
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
}: {
  callId: string;
  name: string;
  args: string;
  result?: TraceEvent;
  audit?: TraceEvent;
}) {
  const [open, setOpen] = useState(false);
  const failed = audit?.status === "error" || result?.isError === true;
  const finished = audit != null || result != null;
  const dotClass = failed ? "bg-destructive" : finished ? "bg-emerald-500" : "bg-muted-foreground/40";
  const prettyArgs = useMemo(() => prettyJson(args), [args]);
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
        {formatToolName(name) !== name && <span className="font-mono text-[10px] text-muted-foreground">{name}</span>}
        {audit?.skillName && <Badge variant="outline" className="font-mono text-[10px]">技能：{audit.skillName}</Badge>}
        {audit?.durationMs != null && (
          <span className="text-muted-foreground tabular-nums">{formatMs(audit.durationMs)}</span>
        )}
        {audit?.risk && (
          <Badge variant="outline" className="text-[10px]">风险：{formatToolRisk(audit.risk)}</Badge>
        )}
        {audit?.executionTarget && (
          <Badge variant="outline" className="text-[10px]">{formatExecutionTarget(audit.executionTarget)}</Badge>
        )}
        {failed && <Badge className="border-0 bg-destructive/15 text-[10px] text-destructive">失败</Badge>}
        {!finished && <span className="text-[10px] text-muted-foreground">无结果记录</span>}
      </button>
      {open && (
        <div className="space-y-2 border-t px-2.5 py-2">
          <div>
            <div className="mb-1 text-[11px] font-medium text-muted-foreground">参数（调用 ID：{callId}）</div>
            <CollapsibleText text={prettyArgs} mono className="rounded bg-muted/40 p-2" />
          </div>
          {result && (
            <div>
              <div className="mb-1 flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
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
}: {
  event: TraceEvent;
  resultByCallId: Map<string, TraceEvent>;
  auditByCallId: Map<string, TraceEvent>;
}) {
  const calls = event.toolCalls ?? [];
  return (
    <EventShell
      icon={<Wrench className="size-3.5" />}
      iconClass="bg-violet-500/15 text-violet-700 dark:text-violet-300"
      title={`工具调用 × ${calls.length}`}
      timestamp={event.timestamp}
      badges={
        <>
          {event.model && <Badge variant="outline" className="font-mono text-[10px]">{event.model}</Badge>}
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
        {calls.map((call) => (
          <ToolCallRow
            key={call.id}
            callId={call.id}
            name={call.name}
            args={call.arguments}
            result={resultByCallId.get(call.id)}
            audit={auditByCallId.get(call.id)}
          />
        ))}
      </div>
    </EventShell>
  );
}

/** 游离的 tool_result / tool_audit（没有对应 assistant_tool_calls 时兜底展示） */
export function OrphanToolEventItem({ event }: { event: TraceEvent }) {
  const failed = event.status === "error" || event.isError === true;
  return (
    <EventShell
      icon={<Wrench className="size-3.5" />}
      title={event.type === "tool_audit" ? "工具审计" : "工具结果"}
      timestamp={event.timestamp}
      badges={
        <>
          <span>{formatToolName(event.toolName)}</span>
          {event.skillName && <Badge variant="outline" className="font-mono text-[10px]">技能：{event.skillName}</Badge>}
          {event.durationMs != null && <span className="text-muted-foreground tabular-nums">{formatMs(event.durationMs)}</span>}
          {failed && <Badge className="border-0 bg-destructive/15 text-[10px] text-destructive">失败</Badge>}
          <TruncatedBadge event={event} />
        </>
      }
    >
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
export function ApprovalPairItem({ event, resolved }: { event: TraceEvent; resolved?: TraceEvent }) {
  const waitMs =
    resolved != null
      ? new Date(resolved.timestamp).getTime() - new Date(event.timestamp).getTime()
      : null;
  const approved = resolved?.decision === "approve" || resolved?.decision === "approved" || resolved?.decision === "allow";
  return (
    <EventShell
      icon={<EntityIcons.admin className="size-3.5" />}
      iconClass="bg-amber-500/15 text-amber-700 dark:text-amber-300"
      title="审批"
      timestamp={event.timestamp}
      badges={
        <>
          <span>{event.toolName ? formatToolName(event.toolName) : ""}</span>
          {resolved ? (
            <Badge
              className={cn(
                "border-0 text-[10px]",
                approved
                  ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                  : "bg-destructive/15 text-destructive",
              )}
            >
              {decisionLabel(resolved.decision)}
            </Badge>
          ) : (
            <Badge className="border-0 bg-amber-500/15 text-[10px] text-amber-700 dark:text-amber-300">未决</Badge>
          )}
          {waitMs != null && waitMs >= 0 && (
            <span className="text-muted-foreground">等待 {formatMs(waitMs)}</span>
          )}
        </>
      }
    >
      {event.input != null && (
        <CollapsedSection icon={<Wrench className="size-3.5" />} label="审批入参（默认收起）">
          <CollapsibleText text={prettyJson(event.input)} mono />
        </CollapsedSection>
      )}
    </EventShell>
  );
}

export function HandFailureItem({ event }: { event: TraceEvent }) {
  return (
    <EventShell
      icon={<TriangleAlert className="size-3.5" />}
      iconClass="bg-destructive/15 text-destructive"
      title="执行环境故障"
      timestamp={event.timestamp}
      badges={
        <>
          {event.classifiedAs && <Badge className="border-0 bg-destructive/15 text-[10px] text-destructive">{formatFailureClass(event.classifiedAs)}</Badge>}
          {event.toolName && <span>{formatToolName(event.toolName)}</span>}
        </>
      }
    >
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
        {event.error ?? "（无错误详情）"}
        {event.handId != null && <div className="mt-1 font-mono text-[11px] opacity-80">执行环境：{String(event.handId)}</div>}
      </div>
    </EventShell>
  );
}

export function RunStateChangedNode({ event }: { event: TraceEvent }) {
  const status = event.status ?? "";
  const isWaiting = status.startsWith("waiting_");
  const prev = event.previousStatus ? RUN_STATUS_LABELS[event.previousStatus] ?? event.previousStatus : null;
  const curr = RUN_STATUS_LABELS[status] ?? status;
  return (
    <DividerNode timestamp={event.timestamp} tone={isWaiting ? "warn" : "muted"}>
      状态变更：{prev ? `${prev} → ` : ""}
      <span className="font-medium">{curr}</span>
      {isWaiting && "（等待态）"}
      {event.reason && ` · ${event.reason}`}
    </DividerNode>
  );
}

export function RunFinishedItem({ event }: { event: TraceEvent }) {
  return (
    <EventShell
      icon={<Flag className="size-3.5" />}
      iconClass={cn(
        event.subtype === "success"
          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
          : event.subtype === "error"
            ? "bg-destructive/15 text-destructive"
            : "bg-amber-500/15 text-amber-700 dark:text-amber-300",
      )}
      title="运行结束"
      timestamp={event.timestamp}
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
export function GenericEventNode({ event }: { event: TraceEvent }) {
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
  return <DividerNode timestamp={event.timestamp}>{label}</DividerNode>;
}
