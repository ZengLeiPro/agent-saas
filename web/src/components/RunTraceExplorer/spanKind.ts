/**
 * 时间线事件的「类型色板」。供 S5-B 的时间线颜色编码 / 耗时条 / 层级缩进使用。
 *
 * 两条设计红线：
 *
 * 1. **类型色不许碰 success / danger**。绿和红在本项目里只表示**结果好坏**
 *    （成功 / 失败）。如果把「工具调用」染成绿色，运维会把「这步是工具」读成
 *    「这步成功了」。因此类型走 S1 的分类色板 `--chart-1..5` + `--info`，
 *    结果好坏仍由 `RunStatusBadge` / `isError` 单独承载，两套颜色语义不重叠。
 * 2. **`approval` 例外地用 `warning`**——它不是「一类事件」而是「真的在等人」，
 *    这是状态语义而非分类语义，用琥珀是正确的而不是浪费颜色预算。
 *
 * 颜色分配（8 类 × 8 种视觉，互不撞色）：
 *
 * | kind | 中文 | token | 覆盖的事件 type |
 * |---|---|---|---|
 * | `user` | 用户输入 | `info` | user_message |
 * | `model` | 模型输出 | `chart-1` | assistant_message / assistant / assistant_stream_event |
 * | `reasoning` | 模型思考 | `chart-2` | assistant_thinking |
 * | `tool` | 工具调用 | `chart-3` | assistant_tool_calls / tool_* |
 * | `subagent` | 子 agent | `chart-4` | subagent* |
 * | `memory` | 记忆检索 | `chart-5` | memory_context / memory_recall |
 * | `approval` | 审批 | `warning` | approval_* |
 * | `lifecycle` | 运行与环境 | 中性 | run_* / hand_* / runtime_status |
 */

export type SpanKind =
  | "user"
  | "model"
  | "reasoning"
  | "tool"
  | "subagent"
  | "memory"
  | "approval"
  | "lifecycle";

export interface SpanKindStyle {
  kind: SpanKind;
  /** 中文名，直接可用于图例与 aria-label */
  label: string;
  /** 实心圆点 / 轴线节点 */
  dot: string;
  /** 浅底之上的文字（已含亮暗两套值，调用点不要再写 dark:） */
  ink: string;
  /** 图标底 / 气泡底 */
  surface: string;
  /** 描边 */
  border: string;
  /** 耗时条（S5-B 时间线横条） */
  bar: string;
}

export const SPAN_KIND_STYLES: Record<SpanKind, SpanKindStyle> = {
  user: {
    kind: "user",
    label: "用户输入",
    dot: "bg-info",
    ink: "text-info-ink",
    surface: "bg-info/15",
    border: "border-info/40",
    bar: "bg-info/70",
  },
  model: {
    kind: "model",
    label: "模型输出",
    dot: "bg-chart-1",
    ink: "text-chart-1",
    surface: "bg-chart-1/15",
    border: "border-chart-1/40",
    bar: "bg-chart-1/70",
  },
  reasoning: {
    kind: "reasoning",
    label: "模型思考",
    dot: "bg-chart-2",
    ink: "text-chart-2",
    surface: "bg-chart-2/15",
    border: "border-chart-2/40",
    bar: "bg-chart-2/70",
  },
  tool: {
    kind: "tool",
    label: "工具调用",
    dot: "bg-chart-3",
    ink: "text-chart-3",
    surface: "bg-chart-3/15",
    border: "border-chart-3/40",
    bar: "bg-chart-3/70",
  },
  subagent: {
    kind: "subagent",
    label: "子 agent",
    dot: "bg-chart-4",
    ink: "text-chart-4",
    surface: "bg-chart-4/15",
    border: "border-chart-4/40",
    bar: "bg-chart-4/70",
  },
  memory: {
    kind: "memory",
    label: "记忆检索",
    dot: "bg-chart-5",
    ink: "text-chart-5",
    surface: "bg-chart-5/15",
    border: "border-chart-5/40",
    bar: "bg-chart-5/70",
  },
  approval: {
    kind: "approval",
    label: "审批",
    dot: "bg-warning",
    ink: "text-warning-ink",
    surface: "bg-warning/15",
    border: "border-warning/40",
    bar: "bg-warning/70",
  },
  lifecycle: {
    kind: "lifecycle",
    label: "运行与环境",
    dot: "bg-muted-foreground/40",
    ink: "text-muted-foreground",
    surface: "bg-muted",
    border: "border-border",
    bar: "bg-muted-foreground/30",
  },
};

/** 图例展示顺序：按一次执行里的自然发生顺序，而不是字母序 */
export const SPAN_KIND_ORDER: readonly SpanKind[] = [
  "user",
  "memory",
  "reasoning",
  "model",
  "tool",
  "subagent",
  "approval",
  "lifecycle",
];

/** 显式映射优先，前缀兜底；未知 type 落 lifecycle（中性，不会误导） */
const EXPLICIT_KIND: Record<string, SpanKind> = {
  user_message: "user",
  memory_context: "memory",
  memory_recall: "memory",
  assistant_thinking: "reasoning",
  assistant_message: "model",
  assistant_stream_event: "model",
  assistant: "model",
  assistant_tool_calls: "tool",
  runtime_status: "lifecycle",
};

const PREFIX_KIND: ReadonlyArray<[string, SpanKind]> = [
  ["subagent", "subagent"],
  ["tool_", "tool"],
  ["approval_", "approval"],
  ["run_", "lifecycle"],
  ["hand_", "lifecycle"],
];

export function spanKindOf(eventType: string | null | undefined): SpanKind {
  if (!eventType) return "lifecycle";
  const explicit = EXPLICIT_KIND[eventType];
  if (explicit) return explicit;
  for (const [prefix, kind] of PREFIX_KIND) {
    if (eventType.startsWith(prefix)) return kind;
  }
  return "lifecycle";
}

export function spanKindStyle(eventType: string | null | undefined): SpanKindStyle {
  return SPAN_KIND_STYLES[spanKindOf(eventType)];
}
