/**
 * 时间线渲染单元的行为契约（S5-B）。
 *
 * 这些断言锁的是四件「改造前没有、回退了就等于白做」的事：
 *  1. 时间是**相对起点的偏移**，绝对时刻退到 title（不再是一列读不出快慢的绝对时钟）；
 *  2. 耗时**有条**且按同一把尺子归一化——「哪一步是瓶颈」不用读数字；
 *  3. 折叠标题给**内容摘要**而不是「（默认收起）」这种零信息量的交互说明；
 *  4. 类型色走 spanKind 色板，且**永不占用 success / danger**（绿红只表示结果好坏）。
 *
 * 另外锁住子 agent 下钻：`subagent_started/finished` 后端一直在写，改造前 UI 完全没渲染。
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { formatTime } from "./format";

import {
  ApprovalPairItem,
  AssistantMessageItem,
  MemoryContextItem,
  SpanKindLegend,
  SubagentPairItem,
  ThinkingItem,
  TimelineFrameProvider,
  ToolCallsItem,
  UserMessageItem,
  type TimelineFrame,
} from "./TimelineItems";
import type { TraceEvent } from "./types";

const T0 = "2026-07-25T10:00:00.000Z";
const T1_5 = "2026-07-25T10:00:01.500Z";
const T3 = "2026-07-25T10:00:03.000Z";

const FRAME: TimelineFrame = { origin: T0, basisMs: 10_000, basisLabel: "本次运行总耗时" };

function frame(overrides: Partial<TimelineFrame> = {}): TimelineFrame {
  return { ...FRAME, ...overrides };
}

function renderInFrame(node: React.ReactNode, value: TimelineFrame = FRAME) {
  return render(<TimelineFrameProvider value={value}>{node}</TimelineFrameProvider>);
}

function event(overrides: Partial<TraceEvent> & { type: string }): TraceEvent {
  return { id: `e-${overrides.type}`, timestamp: T1_5, ...overrides };
}

/** 事件卡左侧的类型色圆底 */
function iconClasses(container: HTMLElement): string {
  return container.querySelector("div.size-6.rounded-full")?.getAttribute("class") ?? "";
}

describe("时间线：相对时间轴", () => {
  it("显示相对起点的偏移，绝对时刻退到 title", () => {
    renderInFrame(<UserMessageItem event={event({ type: "user_message", content: "你好" })} />);
    const stamp = screen.getByText("+1.50s");
    expect(stamp.getAttribute("title")).toContain("绝对时刻");
    expect(stamp.getAttribute("title")).toContain("相对起点 +1.50s");
  });

  it("拿不到起点时退回绝对时刻（组件在时间线之外被单独使用）", () => {
    render(<UserMessageItem event={event({ type: "user_message", content: "你好" })} />);
    expect(screen.queryByText("+1.50s")).toBeNull();
    expect(screen.getByText(formatTime(T1_5))).toBeTruthy();
  });
});

describe("时间线：耗时条", () => {
  const toolCallsEvent = event({
    type: "assistant_tool_calls",
    toolCalls: [{ id: "call-1", name: "Bash", arguments: "{}" }],
  });

  it("按坐标系基准归一化，口径写进 aria-label 与 title", () => {
    const { container } = renderInFrame(
      <ToolCallsItem
        event={toolCallsEvent}
        resultByCallId={new Map()}
        auditByCallId={new Map([["call-1", event({ type: "tool_audit", durationMs: 5000, status: "ok" })]])}
      />,
    );
    const bar = screen.getByRole("img", { name: /耗时 5\.0 秒/ });
    expect(bar.getAttribute("aria-label")).toContain("占本次运行总耗时 50%");
    expect(bar.getAttribute("title")).toContain("占本次运行总耗时 50%");
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("50%");
    // 类型色走工具档，不占绿/红
    expect(container.innerHTML).toContain("bg-chart-3/70");
  });

  it("失败的调用用 destructive 覆盖类型色（结果好坏优先于类型）", () => {
    const { container } = renderInFrame(
      <ToolCallsItem
        event={toolCallsEvent}
        resultByCallId={new Map()}
        auditByCallId={new Map([["call-1", event({ type: "tool_audit", durationMs: 2000, status: "error" })]])}
      />,
    );
    expect(container.innerHTML).toContain("bg-destructive/70");
  });

  it("0 毫秒也留一根可见的线，但比例文本仍是真实值", () => {
    renderInFrame(
      <ToolCallsItem
        event={toolCallsEvent}
        resultByCallId={new Map()}
        auditByCallId={new Map([["call-1", event({ type: "tool_audit", durationMs: 0, status: "ok" })]])}
      />,
    );
    const bar = screen.getByRole("img", { name: /耗时/ });
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("0.8%");
    expect(bar.getAttribute("aria-label")).toContain("0.0%");
  });

  it("拿不到归一化基准时只留耗时文字，不画假条", () => {
    renderInFrame(
      <ToolCallsItem
        event={toolCallsEvent}
        resultByCallId={new Map()}
        auditByCallId={new Map([["call-1", event({ type: "tool_audit", durationMs: 5000 })]])}
      />,
      frame({ basisMs: null }),
    );
    expect(screen.queryByRole("img", { name: /耗时/ })).toBeNull();
    expect(screen.getByText("5.0 秒")).toBeTruthy();
  });

  it("审批等待时长与工具耗时用同一把尺子（看得出慢在人还是慢在机器）", () => {
    renderInFrame(
      <ApprovalPairItem
        event={event({ id: "a1", type: "approval_requested", approvalId: "ap-1", toolName: "Bash" })}
        resolved={event({ id: "a2", type: "approval_resolved", approvalId: "ap-1", timestamp: T3, decision: "approve" })}
      />,
    );
    const bar = screen.getByRole("img", { name: /耗时 1\.5 秒/ });
    expect(bar.getAttribute("aria-label")).toContain("占本次运行总耗时 15%");
  });
});

describe("时间线：折叠区标题给内容摘要", () => {
  it("记忆上下文显示字符数 + 首行预览，不再写「（默认收起）」", () => {
    renderInFrame(
      <MemoryContextItem event={event({ type: "memory_context", content: "客户偏好：先给结论\n再给依据" })} />,
    );
    expect(screen.getByText("注入的记忆内容")).toBeTruthy();
    expect(screen.getByText(/14 字符 · 客户偏好：先给结论/)).toBeTruthy();
    expect(screen.queryByText(/默认收起/)).toBeNull();
  });

  it("思考内容同理，并且千分位可读", () => {
    renderInFrame(<ThinkingItem event={event({ type: "assistant_thinking", content: "推".repeat(1200) })} />);
    expect(screen.getByText("思考内容")).toBeTruthy();
    expect(screen.getByText(/1,200 字符/)).toBeTruthy();
  });

  it("审批入参给字段个数与字段名（比字符数更贴近审批场景）", () => {
    renderInFrame(
      <ApprovalPairItem
        event={event({ type: "approval_requested", input: { command: "rm -rf", cwd: "/tmp" } })}
      />,
    );
    expect(screen.getByText("审批入参")).toBeTruthy();
    expect(screen.getByText(/2 个字段：command、cwd/)).toBeTruthy();
  });
});

describe("时间线：spanKind 类型色编码", () => {
  it.each([
    ["user_message", "bg-info/15", UserMessageItem],
    ["assistant_thinking", "bg-chart-2/15", ThinkingItem],
    ["assistant_message", "bg-chart-1/15", AssistantMessageItem],
    ["memory_context", "bg-chart-5/15", MemoryContextItem],
  ] as const)("%s 的类型色为 %s", (type, expected, Component) => {
    const { container } = renderInFrame(<Component event={event({ type, content: "x" })} />);
    expect(iconClasses(container)).toContain(expected);
  });

  it("类型色永不占用 success / danger（绿红只表示结果好坏）", () => {
    const { container } = renderInFrame(
      <ToolCallsItem
        event={event({ type: "assistant_tool_calls", toolCalls: [] })}
        resultByCallId={new Map()}
        auditByCallId={new Map()}
      />,
    );
    const classes = iconClasses(container);
    expect(classes).toContain("bg-chart-3/15");
    expect(classes).not.toContain("success");
    expect(classes).not.toContain("danger");
  });

  it("图例只列本次运行实际出现过的类型", () => {
    render(<SpanKindLegend kinds={["tool", "user"]} />);
    expect(screen.getByText("用户输入")).toBeTruthy();
    expect(screen.getByText("工具调用")).toBeTruthy();
    expect(screen.queryByText("审批")).toBeNull();
  });
});

describe("时间线：层级与轴线", () => {
  it("工具调用列表缩进 + 左边框，从属于它的 assistant 步骤", () => {
    const { container } = renderInFrame(
      <ToolCallsItem
        event={event({ type: "assistant_tool_calls", toolCalls: [{ id: "c1", name: "Bash", arguments: "{}" }] })}
        resultByCallId={new Map()}
        auditByCallId={new Map()}
      />,
    );
    const nested = container.querySelector("div.ml-6.border-l");
    expect(nested).toBeTruthy();
    expect(within(nested as HTMLElement).getByText("Bash")).toBeTruthy();
  });

  it("最后一个节点不再拖出一条没有终点的轴线", () => {
    const { container: middle } = renderInFrame(<UserMessageItem event={event({ type: "user_message", content: "x" })} />);
    expect(middle.querySelectorAll("div.w-px.flex-1").length).toBe(1);
    const { container: last } = renderInFrame(<UserMessageItem event={event({ type: "user_message", content: "x" })} isLast />);
    expect(last.querySelectorAll("div.w-px.flex-1").length).toBe(0);
  });
});

describe("子 agent：成对渲染 + 下钻", () => {
  const started = event({
    id: "sa-1",
    type: "subagent_started",
    toolCallId: "call-agent",
    agentType: "explore",
    description: "查竞品定价",
    childSessionId: "sess-child",
    childRunId: "run-child",
    model: "gpt-5.5",
  });
  const finished = event({
    id: "sa-2",
    type: "subagent_finished",
    timestamp: T3,
    toolCallId: "call-agent",
    agentType: "explore",
    childSessionId: "sess-child",
    childRunId: "run-child",
    status: "completed",
    durationMs: 1500,
    totalTokens: 12_345,
    toolUseCount: 7,
    turnCount: 3,
    resultPreview: "竞品 A 定价 199 元/席",
  });

  it("把两条事件合成一个节点，展示终态 / 耗时 / 轮次 / 工具次数 / Token", () => {
    renderInFrame(<SubagentPairItem event={started} finished={finished} />);
    expect(screen.getByText("子 agent · 搜索侦察")).toBeTruthy();
    expect(screen.getByText("已完成")).toBeTruthy();
    expect(screen.getByText("3 轮")).toBeTruthy();
    expect(screen.getByText("7 次工具")).toBeTruthy();
    expect(screen.getByText(/委派任务：查竞品定价/)).toBeTruthy();
    expect(screen.getByText("子 agent 回报预览")).toBeTruthy();
  });

  it("点「查看子 agent 时间线」把子 run 交给下钻回调", async () => {
    const onDrillSubagent = vi.fn();
    renderInFrame(<SubagentPairItem event={started} finished={finished} />, frame({ onDrillSubagent }));
    await userEvent.click(screen.getByRole("button", { name: /查看子 agent 时间线/ }));
    expect(onDrillSubagent).toHaveBeenCalledWith({
      runId: "run-child",
      sessionId: "sess-child",
      agentType: "explore",
      description: "查竞品定价",
    });
  });

  it("未结束的子 agent 标「进行中」而不是伪装成完成", () => {
    renderInFrame(<SubagentPairItem event={started} />);
    expect(screen.getByText("进行中")).toBeTruthy();
    expect(screen.queryByText("已完成")).toBeNull();
  });

  it("失败的子 agent 显示运行时错误原文（不从模型文本推断终态）", () => {
    renderInFrame(
      <SubagentPairItem
        event={started}
        finished={event({ ...finished, status: "failed", errorMessage: "subagent hard timeout" })}
      />,
    );
    expect(screen.getByText("失败")).toBeTruthy();
    expect(screen.getByText("subagent hard timeout")).toBeTruthy();
  });

  it("脱敏视图拿不到 childRunId 时明说不可见，而不是给一个点不动的按钮", () => {
    const onDrillSubagent = vi.fn();
    renderInFrame(
      <SubagentPairItem event={event({ type: "subagent_started", agentType: "general" })} />,
      frame({ onDrillSubagent }),
    );
    expect(screen.queryByRole("button", { name: /查看子 agent 时间线/ })).toBeNull();
    expect(screen.getByText(/子执行记录编号在当前视图中不可见/)).toBeTruthy();
  });

  it("派生子 agent 的那次工具调用行上也给出下钻入口", async () => {
    const onDrillSubagent = vi.fn();
    renderInFrame(
      <ToolCallsItem
        event={event({ type: "assistant_tool_calls", toolCalls: [{ id: "call-agent", name: "Agent", arguments: "{}" }] })}
        resultByCallId={new Map()}
        auditByCallId={new Map()}
        subagentByCallId={new Map([["call-agent", started]])}
      />,
      frame({ onDrillSubagent }),
    );
    expect(screen.getByText(/子 agent：查竞品定价/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /查看子 agent 时间线/ }));
    expect(onDrillSubagent).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-child" }));
  });
});
